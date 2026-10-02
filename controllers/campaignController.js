const Campaign = require('../models/Campaign');
const EmailLog = require('../models/EmailLog');
const Project = require('../models/Project');
const Template = require('../models/Template');
const Lead = require('../models/Lead');
const nodemailer = require('nodemailer');
const crypto = require('crypto');

// Helper function to generate unique tracking token
const generateTrackingToken = () => {
  return crypto.randomBytes(32).toString('hex');
};

// Helper function to create delay between emails
const sleep = (ms) => new Promise(resolve => setTimeout(resolve, ms));

// Helper function to replace template variables
const replaceTemplateVariables = (text, lead) => {
  return text
    .replace(/\{\{companyName\}\}/g, lead.company || '[Company]')
    .replace(/\{\{company\}\}/g, lead.company || '[Company]')
    .replace(/\{\{firstName\}\}/g, lead.firstName || '[Name]')
    .replace(/\{\{name\}\}/g, lead.firstName || '[Name]')
    .replace(/\{\{email\}\}/g, lead.email || '[Email]')
    .replace(/\{\{city\}\}/g, lead.city || '[City]')
    .replace(/\{\{website\}\}/g, lead.website || '[Website]');
};

// Create campaign and trigger email sending
exports.createCampaign = async (req, res) => {
  try {
    const { name, projectId, templateId, batchIds } = req.body;

    // Validate required fields
    if (!name || !projectId || !templateId || !batchIds || !Array.isArray(batchIds) || batchIds.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'Name, projectId, templateId, and batchIds are required'
      });
    }

    // Fetch project, template, and leads
    const project = await Project.findById(projectId);
    if (!project) {
      return res.status(404).json({
        success: false,
        message: 'Project not found'
      });
    }

    const template = await Template.findById(templateId);
    if (!template) {
      return res.status(404).json({
        success: false,
        message: 'Template not found'
      });
    }

    // Get all valid leads from selected batches (exclude Unsubscribed and Invalid)
    const validLeads = await Lead.find({
      batchId: { $in: batchIds },
      status: 'Valid',
      email: { $exists: true, $ne: '' }
    });

    if (validLeads.length === 0) {
      return res.status(400).json({
        success: false,
        message: 'No valid leads found in selected batches'
      });
    }

    // Create campaign
    const campaign = new Campaign({
      name,
      projectId,
      templateId,
      batchIds,
      totalRecipients: validLeads.length,
      status: 'sending'
    });

    await campaign.save();

    // Setup nodemailer transport
    const transporter = nodemailer.createTransport({
      host: project.smtpHost,
      port: project.smtpPort,
      secure: project.smtpPort === 465, // true for 465, false for other ports
      auth: {
        user: project.smtpUser,
        pass: project.smtpPassword
      }
    });

    // Verify SMTP connection
    try {
      await transporter.verify();
    } catch (smtpError) {
      console.error('SMTP verification failed:', smtpError);
      campaign.status = 'failed';
      await campaign.save();
      return res.status(500).json({
        success: false,
        message: 'SMTP configuration error: ' + smtpError.message
      });
    }

    let sentCount = 0;
    const PUBLIC_BACKEND_URL = process.env.PUBLIC_BACKEND_URL || 'http://localhost:5000';

    // Send emails with delay between each
    for (const lead of validLeads) {
      try {
        // Generate unique tracking token
        let trackingId;
        let tokenExists = true;
        
        // Ensure unique token (rare collision handling)
        while (tokenExists) {
          trackingId = generateTrackingToken();
          const existingLog = await EmailLog.findOne({ trackingId });
          tokenExists = !!existingLog;
        }

        // Replace template variables
        const personalizedSubject = replaceTemplateVariables(template.subject, lead);
        const personalizedBody = replaceTemplateVariables(template.body, lead);

        // Add tracking pixel and unsubscribe link
        const trackingPixel = `<img src="${PUBLIC_BACKEND_URL}/api/track/open/${trackingId}" width="1" height="1" style="display:none;" alt="" />`;
        const unsubscribeLink = `<br><br><small><a href="${PUBLIC_BACKEND_URL}/api/track/unsubscribe/${trackingId}">Unsubscribe</a></small>`;
        
        const finalBody = personalizedBody + trackingPixel + unsubscribeLink;

        // Create EmailLog entry
        const emailLog = new EmailLog({
          campaignId: campaign._id,
          leadId: lead._id,
          email: lead.email,
          status: 'sent',
          trackingId
        });

        // Send email
        await transporter.sendMail({
          from: `"${project.senderName || project.senderEmail}" <${project.senderEmail}>`,
          to: lead.email,
          subject: personalizedSubject,
          html: finalBody
        });

        // Save EmailLog and increment sent count
        await emailLog.save();
        sentCount++;

        // Update campaign progress
        campaign.sentCount = sentCount;
        await campaign.save();

        console.log(`Email sent to ${lead.email} (${sentCount}/${validLeads.length})`);

        // Add delay between emails (1.5 seconds to avoid spam flags)
        if (sentCount < validLeads.length) {
          await sleep(1500);
        }

      } catch (emailError) {
        console.error(`Failed to send email to ${lead.email}:`, emailError);
        
        // Create failed EmailLog entry
        const failedLog = new EmailLog({
          campaignId: campaign._id,
          leadId: lead._id,
          email: lead.email,
          status: 'failed',
          trackingId: generateTrackingToken()
        });
        await failedLog.save();
      }
    }

    // Update campaign final status
    campaign.status = sentCount > 0 ? 'completed' : 'failed';
    campaign.sentAt = new Date();
    await campaign.save();

    // Return final campaign with populated data
    const finalCampaign = await Campaign.findById(campaign._id)
      .populate('projectId', 'name')
      .populate('templateId', 'name');

    res.status(201).json({
      success: true,
      message: `Campaign created successfully. ${sentCount}/${validLeads.length} emails sent.`,
      data: finalCampaign
    });

  } catch (error) {
    console.error('Campaign creation error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to create campaign',
      error: error.message
    });
  }
};

// Get all campaigns (optionally filtered by project)
exports.getAllCampaigns = async (req, res) => {
  try {
    const filter = {};
    if (req.query.project && req.query.project !== 'all') {
      filter.projectId = req.query.project;
    }

    const campaigns = await Campaign.find(filter)
      .populate('projectId', 'name slug')
      .populate('templateId', 'name')
      .sort({ sentAt: -1, createdAt: -1 });

    res.json({
      success: true,
      count: campaigns.length,
      data: campaigns
    });
  } catch (error) {
    console.error('Error fetching campaigns:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch campaigns',
      error: error.message
    });
  }
};

// Get campaign by ID
exports.getCampaignById = async (req, res) => {
  try {
    const campaign = await Campaign.findById(req.params.id)
      .populate('projectId')
      .populate('templateId')
      .populate('batchIds');

    if (!campaign) {
      return res.status(404).json({
        success: false,
        message: 'Campaign not found'
      });
    }

    // Get email logs for this campaign
    const emailLogs = await EmailLog.find({ campaignId: campaign._id })
      .populate('leadId')
      .sort({ sentAt: -1 });

    res.json({
      success: true,
      data: {
        campaign,
        emailLogs
      }
    });
  } catch (error) {
    console.error('Error fetching campaign:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch campaign',
      error: error.message
    });
  }
};

// Delete campaign
exports.deleteCampaign = async (req, res) => {
  try {
    const campaign = await Campaign.findById(req.params.id);
    
    if (!campaign) {
      return res.status(404).json({
        success: false,
        message: 'Campaign not found'
      });
    }

    // Delete associated EmailLog entries
    await EmailLog.deleteMany({ campaignId: campaign._id });

    // Delete the campaign
    await Campaign.findByIdAndDelete(req.params.id);

    res.json({
      success: true,
      message: 'Campaign and associated email logs deleted successfully'
    });
  } catch (error) {
    console.error('Error deleting campaign:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to delete campaign',
      error: error.message
    });
  }
};