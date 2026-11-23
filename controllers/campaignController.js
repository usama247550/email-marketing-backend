const Campaign      = require('../models/Campaign');
const EmailLog      = require('../models/EmailLog');
const Project       = require('../models/Project');
const Template      = require('../models/Template');
const Lead          = require('../models/Lead');
const { setupTransport, sendEmailsToLeads } = require('../services/emailSender');
const { assertTemplateVariables } = require('../services/templateVariables');
const { parseSendSchedule, estimateSendDurationMs } = require('../services/sendSchedule');

async function runCampaignSendInBackground(campaignId) {
  try {
    const campaign = await Campaign.findById(campaignId);
    if (!campaign || campaign.status !== 'sending') return;

    const project = await Project.findById(campaign.projectId).populate('emailApiAccountId');
    const template = await Template.findById(campaign.templateId);
    if (!project || !template) {
      campaign.status = 'failed';
      await campaign.save();
      return;
    }

    const validLeads = await Lead.find({
      batchId:       { $in: campaign.batchIds },
      status:        'Valid',
      emailVerified: true,
      email:         { $exists: true, $ne: '' },
    });

    if (validLeads.length === 0) {
      campaign.status = 'failed';
      await campaign.save();
      return;
    }

    const { sentCount } = await sendEmailsToLeads({
      project,
      template,
      leads:    validLeads,
      campaign,
    });

    campaign.status = sentCount > 0 ? 'completed' : 'failed';
    campaign.sentAt = new Date();
    await campaign.save();
  } catch (error) {
    console.error(`[campaign] Background send failed for ${campaignId}:`, error);
    try {
      await Campaign.findByIdAndUpdate(campaignId, { status: 'failed' });
    } catch (_) { /* ignore */ }
  }
}

// ─── Create campaign and trigger email sending ────────────────────────────────

exports.createCampaign = async (req, res) => {
  try {
    const { name, projectId, templateId, batchIds } = req.body;

    // Validate required fields
    if (
      !name || !projectId || !templateId ||
      !batchIds || !Array.isArray(batchIds) || batchIds.length === 0
    ) {
      return res.status(400).json({
        success: false,
        message: 'Name, projectId, templateId, and batchIds are required',
      });
    }

    // Fetch project (populate emailApiAccountId so setupTransport can read it)
    const project = await Project.findById(projectId).populate('emailApiAccountId');
    if (!project) {
      return res.status(404).json({ success: false, message: 'Project not found' });
    }

    // Validate sending config early — surface the error before we create anything
    try {
      await setupTransport(project);
    } catch (configErr) {
      return res.status(400).json({ success: false, message: configErr.message });
    }

    const template = await Template.findById(templateId);
    if (!template) {
      return res.status(404).json({ success: false, message: 'Template not found' });
    }

    try {
      assertTemplateVariables(template.subject, template.body);
    } catch (variableErr) {
      if (variableErr.code === 'UNKNOWN_TEMPLATE_VARIABLES') {
        return res.status(400).json({ success: false, message: variableErr.message });
      }
      throw variableErr;
    }

    // All valid leads from the selected batches
    const validLeads = await Lead.find({
      batchId:        { $in: batchIds },
      status:         'Valid',
      emailVerified:  true,
      email:          { $exists: true, $ne: '' },
    });

    if (validLeads.length === 0) {
      return res.status(400).json({
        success: false,
        message:
          'No verified leads in these batches. Open Leads, select the batch, and click Verify emails — only verified addresses are sent (helps avoid Brevo blocks).',
      });
    }

    const schedule = parseSendSchedule(req.body);

    const campaign = new Campaign({
      name,
      projectId,
      templateId,
      batchIds,
      totalRecipients: validLeads.length,
      status:          'sending',
      emailGapSeconds:   schedule.emailGapSeconds,
      partCount:         schedule.partCount,
      partGapMinutes:    schedule.partGapMinutes,
    });
    await campaign.save();

    setImmediate(() => {
      runCampaignSendInBackground(campaign._id);
    });

    const estMs = estimateSendDurationMs(validLeads.length, schedule);
    const estimateMinutes = estMs > 0 ? Math.ceil(estMs / 60000) : 0;
    const sendingMethod = project.sendingMethod || 'brevo_api';

    const populated = await Campaign.findById(campaign._id)
      .populate('projectId',  'name')
      .populate('templateId', 'name');

    res.status(202).json({
      success: true,
      startedInBackground: true,
      message:
        `Sending started (${sendingMethod.toUpperCase()}). ` +
        `${validLeads.length} email(s): ${schedule.emailGapSeconds}s between emails, ` +
        `${schedule.partCount} part(s), ${schedule.partGapMinutes}m between parts` +
        (estimateMinutes ? ` (~${estimateMinutes} min pacing).` : '.') +
        ' Open Campaigns to see live progress.',
      data: populated,
      estimateMinutes,
    });

  } catch (error) {
    console.error('Campaign creation error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to create campaign',
      error:   error.message,
    });
  }
};

// ─── Get all campaigns (optionally filtered by project) ───────────────────────

exports.getAllCampaigns = async (req, res) => {
  try {
    const filter = {};
    if (req.query.project && req.query.project !== 'all') {
      filter.projectId = req.query.project;
    }

    const campaigns = await Campaign.find(filter)
      .populate('projectId',  'name slug')
      .populate('templateId', 'name')
      .sort({ sentAt: -1, createdAt: -1 });

    res.json({ success: true, count: campaigns.length, data: campaigns });
  } catch (error) {
    console.error('Error fetching campaigns:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch campaigns',
      error:   error.message,
    });
  }
};

// ─── Get campaign by ID ───────────────────────────────────────────────────────

exports.getCampaignById = async (req, res) => {
  try {
    const campaign = await Campaign.findById(req.params.id)
      .populate('projectId')
      .populate('templateId')
      .populate('batchIds');

    if (!campaign) {
      return res.status(404).json({ success: false, message: 'Campaign not found' });
    }

    const emailLogs = await EmailLog.find({ campaignId: campaign._id })
      .populate('leadId')
      .sort({ sentAt: -1 });

    res.json({ success: true, data: { campaign, emailLogs } });
  } catch (error) {
    console.error('Error fetching campaign:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch campaign',
      error:   error.message,
    });
  }
};

// ─── Delete campaign ──────────────────────────────────────────────────────────

exports.deleteCampaign = async (req, res) => {
  try {
    const campaign = await Campaign.findById(req.params.id);
    if (!campaign) {
      return res.status(404).json({ success: false, message: 'Campaign not found' });
    }

    await EmailLog.deleteMany({ campaignId: campaign._id });
    await Campaign.findByIdAndDelete(req.params.id);

    res.json({
      success: true,
      message: 'Campaign and associated email logs deleted successfully',
    });
  } catch (error) {
    console.error('Error deleting campaign:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to delete campaign',
      error:   error.message,
    });
  }
};
