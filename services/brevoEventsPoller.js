/**
 * services/brevoEventsPoller.js
 *
 * Polls Brevo's GET /v3/smtp/statistics/events API for open events and updates
 * EmailLog and Campaign records accordingly, with idempotent matching and counting.
 *
 * Exported:
 *   pollBrevoOpens(options)
 *     → { accountsChecked, eventsFetched, matched, updated, unmatched, errors, duration }
 */

const axios = require('axios');
const EmailLog = require('../models/EmailLog');
const Campaign = require('../models/Campaign');
const Project = require('../models/Project');
const EmailApiAccount = require('../models/EmailApiAccount');

const BREVO_API_BASE = 'https://api.brevo.com/v3';
const REQUEST_TIMEOUT = 15000; // 15 seconds per request

/**
 * Normalize brevoMessageId for comparison (strip angle brackets, lowercase).
 * Brevo sends messageId as "<something>" in some contexts.
 */
function normalizeMessageId(id) {
  if (!id) return null;
  return id.replace(/[<>]/g, '').toLowerCase();
}

/**
 * Mask email for logging (e.g., "john@gmail.com" → "j***@gmail.com").
 */
function maskEmail(email) {
  if (!email || email.length < 2) return email;
  const [localPart, domain] = email.split('@');
  if (!domain) return email;
  return localPart[0] + '*'.repeat(Math.max(1, localPart.length - 1)) + '@' + domain;
}

/**
 * Fetch open events from Brevo for one account.
 * Returns { success, events, error }.
 */
async function fetchBrevoOpens(apiKey, daysBack = 2) {
  try {
    const events = [];
    let offset = 0;
    const limit = 2500; // max Brevo allows

    // Paginate until we get fewer results than limit (indicates last page)
    while (true) {
      try {
        const response = await axios.get(
          `${BREVO_API_BASE}/smtp/statistics/events`,
          {
            headers: {
              'api-key': apiKey,
              'Content-Type': 'application/json'
            },
            params: {
              event: 'opened',
              days: daysBack,
              limit,
              offset
            },
            timeout: REQUEST_TIMEOUT
          }
        );

        const pageEvents = response.data.events || [];
        if (pageEvents.length === 0) {
          break; // No more events
        }

        events.push(...pageEvents);

        if (pageEvents.length < limit) {
          break; // Last page
        }

        offset += limit;
      } catch (pageError) {
        // Treat pagination errors as partial success if we got at least some events
        if (events.length > 0) {
          console.warn(`[brevoEventsPoller] Pagination stopped at offset ${offset}:`, pageError.message);
          break;
        }
        throw pageError;
      }
    }

    return { success: true, events, error: null };
  } catch (error) {
    let errorMsg = error.message;
    if (error.response?.status === 401 || error.response?.status === 403) {
      errorMsg = `Auth failed (${error.response.status})`;
    } else if (error.response?.status === 429) {
      errorMsg = `Rate limited (429)`;
    } else if (error.code === 'ECONNABORTED') {
      errorMsg = 'Timeout';
    }
    return { success: false, events: [], error: errorMsg };
  }
}

/**
 * Retry a Brevo call once if it's a 429 or timeout, with a short backoff.
 */
async function fetchBrevoOpensWithRetry(apiKey, daysBack = 2) {
  let result = await fetchBrevoOpens(apiKey, daysBack);

  if (!result.success) {
    const error = result.error || '';
    // Retry on rate limit or timeout
    if (error.includes('429') || error.includes('Timeout')) {
      console.log(`[brevoEventsPoller] Retrying after ${error}...`);
      await new Promise(r => setTimeout(r, 2000)); // 2 second backoff
      result = await fetchBrevoOpens(apiKey, daysBack);
    }
  }

  return result;
}

/**
 * Find EmailLog matching the open event using multiple strategies.
 * Returns { log, matchMethod } or { log: null, matchMethod: null }.
 */
async function findEmailLogForEvent(event, accountId, daysBack = 7) {
  const messageId = event['message-id'];
  const email = event.email;
  const tags = event.tags || [];

  // Strategy 1: Match by brevoMessageId
  if (messageId) {
    const normalizedId = normalizeMessageId(messageId);
    const log = await EmailLog.findOne({
      brevoMessageId: { $regex: `^${normalizedId}$`, $options: 'i' },
      status: 'sent'
    }).populate('campaignId');

    if (log) {
      return { log, matchMethod: 'brevoMessageId' };
    }
  }

  // Strategy 2: Match by tracking tag (tid_<trackingId>)
  const tidTag = tags.find(t => typeof t === 'string' && t.startsWith('tid_'));
  if (tidTag) {
    const trackingId = tidTag.slice(4); // strip "tid_"
    const log = await EmailLog.findOne({
      trackingId,
      status: 'sent'
    }).populate('campaignId');

    if (log) {
      return { log, matchMethod: 'tag' };
    }
  }

  // Strategy 3: Match by email + account + last 7 days (only if exactly one candidate)
  // First, get the campaign IDs for this account
  const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
  const campaignIds = await Campaign.find(
    { projectId: { $in: [accountId] } },
    '_id'
  ).lean();

  if (campaignIds.length > 0) {
    const candidates = await EmailLog.find({
      email: email.toLowerCase(),
      campaignId: { $in: campaignIds.map(c => c._id) },
      status: 'sent',
      sentAt: { $gte: sevenDaysAgo }
    }).populate('campaignId');

    if (candidates.length === 1) {
      return { log: candidates[0], matchMethod: 'emailFallback' };
    }
  }

  return { log: null, matchMethod: null };
}

/**
 * Update EmailLog and Campaign for one open event, idempotently.
 * Returns { updated, campaignIncremented }.
 */
async function processOpenEvent(event, log) {
  if (!log) {
    return { updated: false, campaignIncremented: false };
  }

  // Check if already marked as opened (idempotent)
  if (log.status === 'opened') {
    return { updated: false, campaignIncremented: false };
  }

  // Prevent overwriting higher-priority statuses
  if (['unsubscribed', 'bounced'].includes(log.status)) {
    return { updated: false, campaignIncremented: false };
  }

  const openedAt = new Date(event.date);
  const campaignId = log.campaignId;

  // Atomically update: only if status is still "sent"
  const updated = await EmailLog.findOneAndUpdate(
    {
      _id: log._id,
      status: 'sent'
    },
    {
      status: 'opened',
      openedAt
    },
    { new: true }
  );

  if (!updated) {
    // Race condition: another process already updated this log
    return { updated: false, campaignIncremented: false };
  }

  // Increment campaign openedCount only if we actually changed the log
  await Campaign.findByIdAndUpdate(
    campaignId,
    { $inc: { openedCount: 1 } }
  );

  return { updated: true, campaignIncremented: true };
}

/**
 * Main polling function.
 * Options:
 *   - daysNormal: days to look back on each normal run (default 2)
 *   - daysWide: days to look back on hourly wide pass (default 7)
 *   - isWidePass: if true, use daysWide; else use daysNormal (default false)
 */
async function pollBrevoOpens(options = {}) {
  const startTime = Date.now();
  const { daysNormal = 2, daysWide = 7, isWidePass = false } = options;
  const daysBack = isWidePass ? daysWide : daysNormal;

  let accountsChecked = 0;
  let eventsFetched = 0;
  let matched = 0;
  let updated = 0;
  let unmatched = 0;
  let errors = 0;

  try {
    // Find all EmailApiAccounts that have sent emails in the last 7 days
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
    const sentEmails = await EmailLog.find(
      {
        status: 'sent',
        brevoMessageId: { $exists: true, $ne: null },
        sentAt: { $gte: sevenDaysAgo }
      },
      'campaignId'
    ).distinct('campaignId');

    const campaigns = await Campaign.find(
      { _id: { $in: sentEmails } },
      'projectId'
    ).distinct('projectId');

    const projects = await Project.find(
      { _id: { $in: campaigns } },
      'emailApiAccountId'
    ).distinct('emailApiAccountId');

    const accounts = await EmailApiAccount.find({ _id: { $in: projects } });

    if (accounts.length === 0) {
      const duration = Date.now() - startTime;
      console.log(
        `[brevoEventsPoller] No accounts with recent sent emails. ` +
        `checked=${accountsChecked} events=${eventsFetched} matched=${matched} ` +
        `updated=${updated} unmatched=${unmatched} errors=${errors} duration=${duration}ms`
      );
      return { accountsChecked, eventsFetched, matched, updated, unmatched, errors, duration };
    }

    // Process each account
    for (const account of accounts) {
      accountsChecked++;

      const result = await fetchBrevoOpensWithRetry(account.apiKey, daysBack);

      if (!result.success) {
        console.log(
          `[brevoEventsPoller] Account error: ${result.error} (account: ${account._id})`
        );
        errors++;
        continue;
      }

      const pageEvents = result.events || [];
      eventsFetched += pageEvents.length;

      // Get this account's projects for email fallback matching
      const thisProjectIds = (await Project.find(
        { emailApiAccountId: account._id },
        '_id'
      )).map(p => p._id);

      // Process each event
      for (const event of pageEvents) {
        const emailLog = await findEmailLogForEvent(event, thisProjectIds, daysBack);

        if (emailLog.log) {
          matched++;
          const processResult = await processOpenEvent(event, emailLog.log);
          if (processResult.campaignIncremented) {
            updated++;
          }
        } else {
          unmatched++;
        }
      }
    }

    const duration = Date.now() - startTime;
    console.log(
      `[brevoEventsPoller] Pass complete (${isWidePass ? 'wide' : 'normal'}): ` +
      `checked=${accountsChecked} events=${eventsFetched} matched=${matched} ` +
      `updated=${updated} unmatched=${unmatched} errors=${errors} duration=${duration}ms`
    );

    return { accountsChecked, eventsFetched, matched, updated, unmatched, errors, duration };
  } catch (err) {
    const duration = Date.now() - startTime;
    console.error('[brevoEventsPoller] Fatal error:', err.message);
    return { accountsChecked, eventsFetched, matched, updated, unmatched, errors: errors + 1, duration };
  }
}

module.exports = { pollBrevoOpens };
