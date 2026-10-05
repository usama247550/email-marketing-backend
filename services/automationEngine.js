/**
 * services/automationEngine.js
 *
 * Core logic that executes a single Automation run:
 *   1. Loads the Automation + its Project + Template
 *   2. Finds Valid leads in the project's batches that haven't received this
 *      template yet (emailedTemplateIds does NOT contain templateId)
 *   3. Caps the list at automation.dailyLimit
 *   4. Creates a Campaign record for this run (shows up in Campaigns history)
 *   5. Delegates actual sending to services/emailSender.js
 *   6. After each successful send, appends templateId to lead.emailedTemplateIds
 *   7. Updates Automation.lastRunAt and lastRunSentCount
 */

const Automation  = require('../models/Automation');
const Campaign    = require('../models/Campaign');
const Batch       = require('../models/Batch');
const Lead        = require('../models/Lead');
const Project     = require('../models/Project');
const Template    = require('../models/Template');
const { sendEmailsToLeads } = require('./emailSender');

/**
 * Run a single automation by ID.
 *
 * @param {string|ObjectId} automationId
 * @returns {Promise<{ sentCount: number, skipped: boolean }>}
 */
const runAutomation = async (automationId) => {
  // ── 1. Load automation with all relations ─────────────────────────────────
  const automation = await Automation.findById(automationId);
  if (!automation) {
    console.error(`[AutomationEngine] Automation ${automationId} not found.`);
    return { sentCount: 0, skipped: true };
  }

  if (automation.status !== 'active') {
    console.log(`[AutomationEngine] "${automation.name}" is paused — skipping.`);
    return { sentCount: 0, skipped: true };
  }

  const project = await Project.findById(automation.projectId).populate('emailApiAccountId');
  if (!project) {
    console.error(`[AutomationEngine] Project ${automation.projectId} not found for automation "${automation.name}".`);
    return { sentCount: 0, skipped: true };
  }

  const template = await Template.findById(automation.templateId);
  if (!template) {
    console.error(`[AutomationEngine] Template ${automation.templateId} not found for automation "${automation.name}".`);
    return { sentCount: 0, skipped: true };
  }

  // ── 2. Find all batches belonging to this project ─────────────────────────
  const batches = await Batch.find({ projectId: project._id }, '_id');
  const batchIds = batches.map((b) => b._id);

  if (batchIds.length === 0) {
    console.log(`[AutomationEngine] "${automation.name}" — no batches found for project "${project.name}". Skipping.`);
    await _stampRun(automation, 0);
    return { sentCount: 0, skipped: false };
  }

  // ── 3. Query eligible leads ───────────────────────────────────────────────
  // Valid leads in those batches whose emailedTemplateIds does NOT include
  // this template, capped at dailyLimit.
  const leads = await Lead.find({
    batchId:            { $in: batchIds },
    status:             'Valid',
    email:              { $exists: true, $ne: '' },
    emailedTemplateIds: { $nin: [automation.templateId] },
  }).limit(automation.dailyLimit);

  if (leads.length === 0) {
    console.log(`[AutomationEngine] "${automation.name}" — no new leads to send. Stamping run.`);
    await _stampRun(automation, 0);
    return { sentCount: 0, skipped: false };
  }

  console.log(
    `[AutomationEngine] "${automation.name}" starting — ` +
    `${leads.length} lead(s) to send (limit: ${automation.dailyLimit}).`
  );

  // ── 4. Create a Campaign record for this run ──────────────────────────────
  const runDate = new Date().toLocaleDateString('en-US', {
    month: 'short', day: 'numeric', year: 'numeric',
  });
  const campaign = new Campaign({
    name:            `Automation: ${automation.name} — ${runDate}`,
    projectId:       project._id,
    templateId:      template._id,
    batchIds,
    totalRecipients: leads.length,
    status:          'sending',
  });
  await campaign.save();

  // ── 5. Send emails via the shared engine ──────────────────────────────────
  // onLeadSent: after each successful send, mark this template as sent on the lead
  const { sentCount } = await sendEmailsToLeads({
    project,
    template,
    leads,
    campaign,
    onLeadSent: async (lead) => {
      await Lead.findByIdAndUpdate(lead._id, {
        $addToSet: { emailedTemplateIds: automation.templateId },
      });
    },
  });

  // ── 6. Finalise campaign record ───────────────────────────────────────────
  campaign.status = sentCount > 0 ? 'completed' : 'failed';
  campaign.sentAt = new Date();
  await campaign.save();

  // ── 7. Stamp the automation ───────────────────────────────────────────────
  await _stampRun(automation, sentCount);

  console.log(
    `[AutomationEngine] "${automation.name}" finished — ` +
    `${sentCount}/${leads.length} email(s) sent. Campaign: ${campaign._id}`
  );

  return { sentCount, skipped: false };
};

// ── Helpers ───────────────────────────────────────────────────────────────────

async function _stampRun(automation, sentCount) {
  automation.lastRunAt        = new Date();
  automation.lastRunSentCount = sentCount;
  await automation.save();
}

module.exports = { runAutomation };
