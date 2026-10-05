const EmailLog = require('../models/EmailLog');
const Campaign = require('../models/Campaign');
const Lead = require('../models/Lead');

// Events Brevo will POST to this endpoint
const KNOWN_EVENTS = new Set([
  'delivered', 'opened', 'click',
  'hardBounce', 'softBounce',
  'unsubscribe', 'spam',
  // Brevo also sends these — handle gracefully
  'blocked', 'invalid', 'deferred', 'complaint',
  'request'
]);

/**
 * Extract our trackingId from the Brevo tag array.
 * We store it as "tid_<trackingId>" so it's unambiguous among other tags.
 *
 * Brevo delivers tags as an array of strings under the `tags` key.
 */
function extractTrackingId(payload) {
  const tags = payload.tags;
  if (!Array.isArray(tags)) return null;

  const tagEntry = tags.find((t) => typeof t === 'string' && t.startsWith('tid_'));
  return tagEntry ? tagEntry.slice(4) : null; // strip "tid_" prefix
}

/**
 * Resolve the EmailLog for this event.
 * Primary:  look up by our trackingId embedded in tags.
 * Fallback: look up by brevoMessageId (the <id> in the message-id header).
 */
async function resolveEmailLog(payload) {
  // 1. Tag-based lookup (most reliable)
  const trackingId = extractTrackingId(payload);
  if (trackingId) {
    const log = await EmailLog.findOne({ trackingId });
    if (log) return log;
  }

  // 2. Brevo messageId fallback  (field name varies across event types)
  const brevoMsgId = payload['message-id'] || payload.messageId || payload['Message-Id'];
  if (brevoMsgId) {
    const log = await EmailLog.findOne({ brevoMessageId: brevoMsgId });
    if (log) return log;
  }

  return null;
}

/**
 * POST /api/webhooks/brevo
 *
 * Brevo posts individual event objects (NOT arrays).
 * We respond with 200 immediately and do the DB work synchronously but
 * without blocking a response — Express will flush the response before the
 * async work completes, keeping Brevo's acknowledgement fast.
 */
exports.handleBrevoWebhook = async (req, res) => {
  // ── 1. Respond to Brevo immediately ─────────────────────────────────────
  res.status(200).json({ received: true });

  // ── 2. Basic payload validation ──────────────────────────────────────────
  const payload = req.body;

  if (!payload || typeof payload !== 'object') {
    console.warn('[Brevo Webhook] Received non-object body — ignoring.');
    return;
  }

  const event = payload.event;
  const recipientEmail = payload.email;
  const timestamp = payload.date || new Date().toISOString();

  // Debug log — every incoming event
  console.log(`[Brevo Webhook] event="${event}" email="${recipientEmail}" date="${timestamp}" tags=${JSON.stringify(payload.tags || [])}`);

  if (!event || !recipientEmail) {
    console.warn('[Brevo Webhook] Missing required fields (event, email) — ignoring.');
    return;
  }

  if (!KNOWN_EVENTS.has(event)) {
    console.log(`[Brevo Webhook] Unknown event type "${event}" — ignoring.`);
    return;
  }

  // ── 3. Route to the correct handler ─────────────────────────────────────
  try {
    switch (event) {
      case 'opened':
        await handleOpened(payload);
        break;

      case 'unsubscribe':
        await handleUnsubscribe(payload);
        break;

      case 'hardBounce':
        await handleBounce(payload, 'hardBounce');
        break;

      case 'softBounce':
        await handleBounce(payload, 'softBounce');
        break;

      case 'delivered':
        // Log for debugging; no status change needed (status stays 'sent')
        console.log(`[Brevo Webhook] Delivered: ${recipientEmail}`);
        break;

      case 'click':
        // Log the click; extend later if you add clickCount to Campaign
        console.log(`[Brevo Webhook] Click: ${recipientEmail} url="${payload.link || payload.url || 'unknown'}"`);
        break;

      case 'spam':
        console.warn(`[Brevo Webhook] Spam complaint: ${recipientEmail}`);
        // Treat like unsubscribe so we stop emailing complainers
        await handleUnsubscribe(payload);
        break;

      default:
        // Already guarded by KNOWN_EVENTS, but safety net
        console.log(`[Brevo Webhook] No handler for event "${event}".`);
    }
  } catch (err) {
    // Never let an error bubble up to Brevo — we already sent 200
    console.error(`[Brevo Webhook] Error processing event "${event}" for ${recipientEmail}:`, err.message);
  }
};

// ── Event handlers ───────────────────────────────────────────────────────────

async function handleOpened(payload) {
  const emailLog = await resolveEmailLog(payload);

  if (!emailLog) {
    console.warn(`[Brevo Webhook] opened — no EmailLog found for email="${payload.email}" tags=${JSON.stringify(payload.tags || [])}`);
    return;
  }

  // Only update + increment once; repeated opens from the same recipient are ignored
  if (emailLog.status !== 'sent') {
    console.log(`[Brevo Webhook] opened — already tracked as "${emailLog.status}" for ${payload.email}, skipping.`);
    return;
  }

  emailLog.status = 'opened';
  emailLog.openedAt = new Date(payload.date || Date.now());
  await emailLog.save();

  await Campaign.findByIdAndUpdate(
    emailLog.campaignId,
    { $inc: { openedCount: 1 } }
  );

  console.log(`[Brevo Webhook] opened ✓ — ${payload.email} (campaign: ${emailLog.campaignId})`);
}

async function handleUnsubscribe(payload) {
  const emailLog = await resolveEmailLog(payload);

  if (!emailLog) {
    console.warn(`[Brevo Webhook] unsubscribe — no EmailLog found for email="${payload.email}" tags=${JSON.stringify(payload.tags || [])}`);
    return;
  }

  const wasAlreadyUnsubscribed = emailLog.status === 'unsubscribed';

  emailLog.status = 'unsubscribed';
  emailLog.unsubscribedAt = new Date(payload.date || Date.now());
  await emailLog.save();

  // Update the Lead to prevent future sends
  if (emailLog.leadId) {
    await Lead.findByIdAndUpdate(
      emailLog.leadId,
      { status: 'Unsubscribed' }
    );
    console.log(`[Brevo Webhook] Lead marked Unsubscribed: leadId=${emailLog.leadId}`);
  }

  // Increment campaign counter only once per email
  if (!wasAlreadyUnsubscribed) {
    await Campaign.findByIdAndUpdate(
      emailLog.campaignId,
      { $inc: { unsubscribedCount: 1 } }
    );
  }

  console.log(`[Brevo Webhook] unsubscribe ✓ — ${payload.email} (campaign: ${emailLog.campaignId})`);
}

async function handleBounce(payload, bounceType) {
  const emailLog = await resolveEmailLog(payload);

  if (!emailLog) {
    console.warn(`[Brevo Webhook] ${bounceType} — no EmailLog found for email="${payload.email}" tags=${JSON.stringify(payload.tags || [])}`);
    return;
  }

  // Don't overwrite a more informative status (e.g. already 'unsubscribed')
  if (['unsubscribed', 'opened'].includes(emailLog.status)) {
    console.log(`[Brevo Webhook] ${bounceType} — skipping status overwrite for ${payload.email} (current: ${emailLog.status})`);
    return;
  }

  emailLog.status = 'bounced';
  emailLog.bounceType = bounceType;
  emailLog.bouncedAt = new Date(payload.date || Date.now());
  await emailLog.save();

  console.log(`[Brevo Webhook] ${bounceType} ✓ — ${payload.email} (campaign: ${emailLog.campaignId})`);
}
