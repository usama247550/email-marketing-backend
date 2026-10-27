/**
 * services/automationEngine.js
 *
 * Core logic that executes a single Automation run:
 *   1. Atomically claims the automation (isRunning guard)
 *   2. If leadSource is "finder", runs the multi-niche lead finding step first
 *   3. Finds Valid leads in the project's batches that haven't received this
 *      template yet, ordered deterministically: oldest unsent leads first
 *   4. Caps the list at automation.dailyLimit
 *   5. Creates a Campaign record for this run (shows up in Campaigns history)
 *   6. Delegates actual sending to services/emailSender.js
 *   7. Marks template as sent on each lead (emailedTemplateIds)
 *   8. Releases isRunning in a finally block
 */

const Automation  = require('../models/Automation');
const Campaign    = require('../models/Campaign');
const Batch       = require('../models/Batch');
const Lead        = require('../models/Lead');
const Project     = require('../models/Project');
const Template    = require('../models/Template');
const emailSender = require('./emailSender');
const leadFinderService = require('./leadFinderService');

/**
 * Run a single automation by ID.
 *
 * @param {string|ObjectId} automationId
 * @returns {Promise<{ sentCount: number, skipped: boolean }>}
 */
const runAutomation = async (automationId) => {
  const now = new Date();
  const thirtyMinutesAgo = new Date(now.getTime() - 30 * 60 * 1000);

  // ── 1. Atomically claim the automation ──────────────────────────────────
  // Checks isRunning is false or stale (> 30 mins)
  const automation = await Automation.findOneAndUpdate(
    {
      _id: automationId,
      status: 'active',
      $or: [
        { isRunning: false },
        { isRunning: { $exists: false } },
        { runStartedAt: { $lt: thirtyMinutesAgo } },
        { runStartedAt: null },
      ],
    },
    {
      $set: {
        isRunning: true,
        runStartedAt: now,
        lastRunAt: now,
      },
    },
    { new: true }
  );

  if (!automation) {
    console.log(`[AutomationEngine] Could not claim automation ${automationId} (already running, paused, or not found). Skipping.`);
    return { sentCount: 0, skipped: true };
  }

  try {
    // ── 2. Load Project and Template relations ────────────────────────────
    const project = await Project.findById(automation.projectId).populate('emailApiAccountId');
    if (!project) {
      const msg = 'Project was deleted — automation paused automatically';
      console.warn(`[AutomationEngine] Automation "${automation.name}" (${automationId}): ${msg}`);
      await Automation.findByIdAndUpdate(automationId, {
        $set: {
          status: 'paused',
          isRunning: false,
          lastRunFinderMessage: msg,
          orphanReason: msg,
        },
      });
      return { sentCount: 0, skipped: true };
    }

    const template = await Template.findById(automation.templateId);
    if (!template) {
      const msg = 'Template was deleted — automation paused automatically';
      console.warn(`[AutomationEngine] Automation "${automation.name}" (${automationId}): ${msg}`);
      await Automation.findByIdAndUpdate(automationId, {
        $set: {
          status: 'paused',
          isRunning: false,
          lastRunFinderMessage: msg,
          orphanReason: msg,
        },
      });
      return { sentCount: 0, skipped: true };
    }

    // ── 3. Step A: Automatic Lead Finding (if leadSource === 'finder') ─────
    if (automation.leadSource === 'finder' && automation.finder) {
      if (leadFinderService.isLeadFinderActive()) {
        console.log(`[AutomationEngine] "${automation.name}" — another lead finder run in progress. Skipping finder step.`);
        automation.lastRunFinderStatus = 'skipped';
        automation.lastRunFinderMessage = 'Another lead finder run was in progress';
        automation.lastRunFoundCount = 0;
        await automation.save();
      } else {
        try {
          const finderLeadsPerDay = Math.max(5, Math.min(100, Number(automation.finder.leadsPerDay) || 50));
          const finderResult = await leadFinderService.runMultiNicheSearch({
            projectId: automation.projectId.toString(),
            country: automation.finder.country,
            city: automation.finder.allCities ? '' : (automation.finder.city || ''),
            niches: automation.finder.niches,
            totalLeads: finderLeadsPerDay,
            batchNamePrefix: 'Auto',
            cursor: automation.finderCursor,
          });

          if (finderResult.allNichesExhausted) {
            automation.finderCursor = null; // reset to null so a later run re-scans
            automation.lastRunFinderStatus = 'ok';
            automation.lastRunFinderMessage = 'No more new leads available for these settings';
            automation.lastRunFoundCount = finderResult.totalFound || 0;
          } else if (finderResult.stopReason === 'rate_limit') {
            automation.finderCursor = finderResult.endCursor;
            automation.lastRunFinderStatus = 'failed';
            automation.lastRunFinderMessage = 'TomTom credits or rate limit reached';
            automation.lastRunFoundCount = finderResult.totalFound || 0;
          } else if (finderResult.stopReason === 'call_cap') {
            automation.finderCursor = finderResult.endCursor;
            automation.lastRunFinderStatus = 'failed';
            automation.lastRunFinderMessage = 'Reached the search limit for this run';
            automation.lastRunFoundCount = finderResult.totalFound || 0;
          } else {
            automation.finderCursor = finderResult.endCursor;
            automation.lastRunFinderStatus = 'ok';
            automation.lastRunFinderMessage = `Saved ${finderResult.totalFound || 0} of ${finderLeadsPerDay}`;
            automation.lastRunFoundCount = finderResult.totalFound || 0;
          }
          await automation.save();
        } catch (err) {
          console.error(`[AutomationEngine] Lead finding failed for "${automation.name}":`, err.message);
          let failMsg = err.message || 'Lead finding failed';
          const httpStatus = err.response?.status;
          if (httpStatus === 403 || httpStatus === 429) {
            failMsg = 'TomTom credits or rate limit reached';
          }
          if (err.code === 'FINDER_BUSY') {
            automation.lastRunFinderStatus = 'skipped';
            automation.lastRunFinderMessage = 'Another lead finder run was in progress';
          } else {
            automation.lastRunFinderStatus = 'failed';
            automation.lastRunFinderMessage = failMsg;
          }
          automation.lastRunFoundCount = 0;
          await automation.save();
        }
      }
    }

    // ── 4. Step B: Query Batches & Leads (oldest unsent first) ─────────────
    const batches = await Batch.find({ projectId: project._id }, '_id');
    const batchIds = batches.map((b) => b._id);

    if (batchIds.length === 0) {
      console.log(`[AutomationEngine] "${automation.name}" — no batches found for project "${project.name}". Skipping send.`);
      automation.lastRunSentCount = 0;
      await automation.save();
      return { sentCount: 0, skipped: false };
    }

    // Valid leads in those batches whose emailedTemplateIds does NOT include
    // this template, ordered deterministically: oldest unsent leads first
    const leads = await Lead.find({
      batchId:            { $in: batchIds },
      status:             'Valid',
      email:              { $exists: true, $ne: '' },
      emailedTemplateIds: { $nin: [automation.templateId] },
    })
      .sort({ createdAt: 1, _id: 1 })
      .limit(automation.dailyLimit);

    if (leads.length === 0) {
      console.log(`[AutomationEngine] "${automation.name}" — no new leads to send.`);
      automation.lastRunSentCount = 0;
      await automation.save();
      return { sentCount: 0, skipped: false };
    }

    console.log(
      `[AutomationEngine] "${automation.name}" sending — ` +
      `${leads.length} lead(s) to send (limit: ${automation.dailyLimit}).`
    );

    // ── 5. Create a Campaign record for this run ──────────────────────────
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

    // ── 6. Send emails via the shared engine ──────────────────────────────
    const { sentCount } = await emailSender.sendEmailsToLeads({
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

    // ── 7. Finalise campaign and stamp automation ─────────────────────────
    campaign.status = sentCount > 0 ? 'completed' : 'failed';
    campaign.sentAt = new Date();
    await campaign.save();

    automation.lastRunSentCount = sentCount;
    await automation.save();

    console.log(
      `[AutomationEngine] "${automation.name}" finished — ` +
      `${sentCount}/${leads.length} email(s) sent. Campaign: ${campaign._id}`
    );

    return { sentCount, skipped: false };
  } finally {
    // ── 8. Always release isRunning lock ───────────────────────────────────
    await Automation.findByIdAndUpdate(automationId, {
      $set: { isRunning: false },
    });
  }
};

module.exports = { runAutomation };
