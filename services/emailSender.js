/**
 * services/emailSender.js
 *
 * Shared per-lead email sending logic used by both:
 *   - controllers/campaignController.js  (manual campaign sends)
 *   - services/automationEngine.js       (scheduled automation runs)
 *
 * Exports:
 *   setupTransport(project)
 *     → validates config, creates nodemailer transporter for SMTP projects,
 *       returns { sendingMethod, emailApiAccount, transporter }
 *
 *   sendEmailsToLeads({ project, template, leads, campaign, onLeadSent })
 *     → iterates leads, sends each one, writes EmailLog, updates campaign
 *       progress, calls onLeadSent(lead) after each successful send so callers
 *       can do extra bookkeeping (e.g. automation marks emailedTemplateIds).
 *     → returns { sentCount }
 */

const nodemailer = require('nodemailer');
const crypto     = require('crypto');
const axios      = require('axios');

const EmailLog = require('../models/EmailLog');
const Campaign = require('../models/Campaign');
const {
  assertTemplateVariables,
  replaceTemplateVariables,
} = require('./templateVariables');
const { parseSendSchedule, splitIntoParts } = require('./sendSchedule');

// ─── Small utilities ──────────────────────────────────────────────────────────

const generateTrackingToken = () => crypto.randomBytes(32).toString('hex');

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const withTimeout = (promise, ms, timeoutMessage) =>
  Promise.race([
    promise,
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(timeoutMessage)), ms)
    ),
  ]);

// ─── Low-level send helpers ───────────────────────────────────────────────────

const sendEmailViaBrevo = async (apiKey, emailData) => {
  try {
    const response = await axios.post(
      'https://api.brevo.com/v3/smtp/email',
      emailData,
      { headers: { 'api-key': apiKey, 'Content-Type': 'application/json' } }
    );
    return { success: true, messageId: response.data.messageId };
  } catch (error) {
    console.error('Brevo API error:', error.response?.data || error.message);
    return {
      success: false,
      error: error.response?.data?.message || error.message || 'Unknown Brevo API error',
    };
  }
};

const sendEmailViaSMTP = async (transporter, emailData) => {
  try {
    const result = await transporter.sendMail(emailData);
    return { success: true, messageId: result.messageId };
  } catch (error) {
    console.error('SMTP error:', error.message);
    return { success: false, error: error.message };
  }
};

// ─── Exported: setupTransport ─────────────────────────────────────────────────

/**
 * Validates the project's sending config and (for SMTP) creates + verifies a
 * nodemailer transporter.
 *
 * Returns:
 *   { sendingMethod, emailApiAccount, transporter }
 *
 * Throws an Error with a human-readable message on misconfiguration so callers
 * can surface it as an HTTP 400/500 or log it in the automation engine.
 */
const setupTransport = async (project, { skipVerify = false } = {}) => {
  const sendingMethod = project.sendingMethod || 'brevo_api';
  let emailApiAccount = null;
  let transporter = null;

  if (sendingMethod === 'brevo_api') {
    // project must already have emailApiAccountId populated
    emailApiAccount = project.emailApiAccountId;
    if (!emailApiAccount || !emailApiAccount.apiKey) {
      throw new Error(
        'No Brevo API account linked to this project. Please configure one in Settings.'
      );
    }
  } else if (sendingMethod === 'smtp') {
    if (!project.smtpHost || !project.smtpUser || !project.smtpPassword) {
      throw new Error(
        'SMTP configuration is incomplete. Please configure SMTP settings in project settings.'
      );
    }

    const smtpPort = Number(project.smtpPort) || 587;
    const useSsl = smtpPort === 465;

    transporter = nodemailer.createTransport({
      host: project.smtpHost,
      port: smtpPort,
      secure: useSsl,
      requireTLS: !useSsl,
      auth: { user: project.smtpUser, pass: project.smtpPassword },
      connectionTimeout: 15_000,
      greetingTimeout: 10_000,
      socketTimeout: 20_000,
      tls: { minVersion: 'TLSv1.2' },
    });

    if (!skipVerify) {
      try {
        await withTimeout(
          transporter.verify(),
          25_000,
          'SMTP connection timed out. Check Hostinger host/port (try 587), email password, and that sender matches the mailbox.'
        );
      } catch (smtpError) {
        throw new Error('SMTP configuration error: ' + smtpError.message);
      }
    }
  } else {
    throw new Error(`Unknown sendingMethod: "${sendingMethod}"`);
  }

  return { sendingMethod, emailApiAccount, transporter };
};

// ─── Exported: sendEmailsToLeads ─────────────────────────────────────────────

/**
 * Send one email per lead, create EmailLog entries, and keep the campaign's
 * sentCount current throughout the run.
 *
 * @param {object} opts
 * @param {object}   opts.project          - Mongoose Project doc (emailApiAccountId populated)
 * @param {object}   opts.template         - Mongoose Template doc
 * @param {Array}    opts.leads            - Array of Lead docs to send to
 * @param {object}   opts.campaign         - Mongoose Campaign doc (already saved)
 * @param {Function} [opts.onLeadSent]     - async (lead) => void — called after each successful send
 *
 * @returns {{ sentCount: number }}
 */
const sendEmailsToLeads = async ({
  project,
  template,
  leads,
  campaign,
  onLeadSent = null,
  schedule: scheduleInput = null,
}) => {
  const schedule = parseSendSchedule(
    scheduleInput || {
      emailGapSeconds: campaign?.emailGapSeconds,
      partCount: campaign?.partCount,
      partGapMinutes: campaign?.partGapMinutes,
    }
  );
  const parts = splitIntoParts(leads, schedule.partCount);
  const totalToSend = leads.length;
  // Stop before Brevo sees a tag we do not fill (for example {{contact.COMPANY}}).
  assertTemplateVariables(template.subject, template.body);

  const { sendingMethod, emailApiAccount, transporter } = await setupTransport(project, {
    skipVerify: true,
  });

  const PUBLIC_BACKEND_URL = process.env.PUBLIC_BACKEND_URL || 'http://localhost:5000';
  let sentCount = 0;

  console.log(
    `[emailSender] Pace: ${schedule.emailGapSeconds}s between emails, ` +
    `${schedule.partCount} part(s), ${schedule.partGapMinutes}m between parts (${totalToSend} leads)`
  );

  for (let partIndex = 0; partIndex < parts.length; partIndex++) {
    const part = parts[partIndex];
    if (partIndex > 0 && schedule.partGapMs > 0) {
      console.log(`[emailSender] Waiting ${schedule.partGapMinutes}m before part ${partIndex + 1}/${parts.length}`);
      await sleep(schedule.partGapMs);
    }

    for (let i = 0; i < part.length; i++) {
      const lead = part[i];
    try {
      // ── Unique tracking token (collision-safe) ────────────────────────────
      let trackingId;
      let tokenExists = true;
      while (tokenExists) {
        trackingId = generateTrackingToken();
        const existing = await EmailLog.findOne({ trackingId });
        tokenExists = !!existing;
      }

      // ── Personalise content ───────────────────────────────────────────────
      const personalizedSubject = replaceTemplateVariables(template.subject, lead, project);
      const personalizedBody    = replaceTemplateVariables(template.body, lead, project);

      const trackingPixel   = `<img src="${PUBLIC_BACKEND_URL}/api/track/open/${trackingId}" width="1" height="1" style="display:none;" alt="" />`;
      const unsubscribeLink = `<br><br><small><a href="${PUBLIC_BACKEND_URL}/api/track/unsubscribe/${trackingId}">Unsubscribe</a></small>`;
      const finalBody       = personalizedBody + trackingPixel + unsubscribeLink;

      // ── EmailLog stub (saved on success, updated on failure) ──────────────
      const emailLog = new EmailLog({
        campaignId: campaign._id,
        leadId:     lead._id,
        email:      lead.email,
        status:     'sent',
        trackingId,
      });

      // ── Dispatch ──────────────────────────────────────────────────────────
      let emailResult;

      if (sendingMethod === 'brevo_api') {
        const brevoEmailData = {
          sender: {
            name:  project.senderName || project.senderEmail,
            email: project.senderEmail,
          },
          to:          [{ email: lead.email }],
          subject:     personalizedSubject,
          htmlContent: finalBody,
          tags:        [`tid_${trackingId}`], // echoed back in Brevo webhooks
        };
        emailResult = await sendEmailViaBrevo(emailApiAccount.apiKey, brevoEmailData);
      } else {
        const smtpEmailData = {
          from:    `"${project.senderName || project.senderEmail}" <${project.senderEmail}>`,
          to:      lead.email,
          subject: personalizedSubject,
          html:    finalBody,
        };
        emailResult = await sendEmailViaSMTP(transporter, smtpEmailData);
      }

      // ── Persist result ────────────────────────────────────────────────────
      if (emailResult.success) {
        if (sendingMethod === 'brevo_api' && emailResult.messageId) {
          emailLog.brevoMessageId = emailResult.messageId;
        }
        await emailLog.save();
        sentCount++;

        // Caller hook — e.g. automation engine marks emailedTemplateIds
        if (onLeadSent) {
          await onLeadSent(lead);
        }

        console.log(
          `[emailSender] Sent via ${sendingMethod} → ${lead.email} ` +
          `(${sentCount}/${totalToSend}, part ${partIndex + 1}/${parts.length}, campaign: ${campaign._id})`
        );
      } else {
        emailLog.status = 'failed';
        await emailLog.save();
        console.error(
          `[emailSender] Failed → ${lead.email}: ${emailResult.error}`
        );
      }

      // ── Update live campaign progress ─────────────────────────────────────
      campaign.sentCount = sentCount;
      await campaign.save();

    } catch (emailError) {
      console.error(`[emailSender] Unexpected error for ${lead.email}:`, emailError);

      // Persist a failed log so the run is auditable
      try {
        await new EmailLog({
          campaignId: campaign._id,
          leadId:     lead._id,
          email:      lead.email,
          status:     'failed',
          trackingId: generateTrackingToken(),
        }).save();
      } catch (_) { /* swallow secondary error */ }
    }
      if (i < part.length - 1) await sleep(schedule.emailGapMs);
    }
  }

  return { sentCount };
};

// ─── Exports ──────────────────────────────────────────────────────────────────

module.exports = {
  setupTransport,
  sendEmailsToLeads,
  // Also export low-level helpers so existing code that imported them directly
  // (if any) keeps working without changes.
  generateTrackingToken,
  replaceTemplateVariables,
  sendEmailViaBrevo,
  sendEmailViaSMTP,
  sleep,
};
