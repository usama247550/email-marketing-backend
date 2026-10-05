const Campaign      = require('../models/Campaign');
const EmailLog      = require('../models/EmailLog');
const Project       = require('../models/Project');
const Template      = require('../models/Template');
const Lead          = require('../models/Lead');
const { setupTransport, sendEmailsToLeads } = require('../services/emailSender');

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

    // All valid leads from the selected batches
    const validLeads = await Lead.find({
      batchId: { $in: batchIds },
      status:  'Valid',
      email:   { $exists: true, $ne: '' },
    });

    if (validLeads.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'No valid leads found in selected batches',
      });
    }

    // Create campaign record
    const campaign = new Campaign({
      name,
      projectId,
      templateId,
      batchIds,
      totalRecipients: validLeads.length,
      status: 'sending',
    });
    await campaign.save();

    // Delegate per-lead sending to the shared service
    const { sentCount } = await sendEmailsToLeads({
      project,
      template,
      leads:    validLeads,
      campaign,
    });

    // Finalise campaign
    campaign.status  = sentCount > 0 ? 'completed' : 'failed';
    campaign.sentAt  = new Date();
    await campaign.save();

    const finalCampaign = await Campaign.findById(campaign._id)
      .populate('projectId',  'name')
      .populate('templateId', 'name');

    const sendingMethod = project.sendingMethod || 'brevo_api';

    res.status(201).json({
      success: true,
      message: `Campaign created successfully using ${sendingMethod.toUpperCase()}. ${sentCount}/${validLeads.length} emails sent.`,
      data:    finalCampaign,
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
