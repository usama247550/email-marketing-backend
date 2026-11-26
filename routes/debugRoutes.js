const express = require('express');
const router = express.Router();
const EmailLog = require('../models/EmailLog');
const Campaign = require('../models/Campaign');
const Lead = require('../models/Lead');
const Template = require('../models/Template');
const Project = require('../models/Project');
const { replaceTemplateVariables, assertTemplateVariables } = require('../services/templateVariables');
const { setupTransport } = require('../services/emailSender');
const { validateBrevoApiKey } = require('../services/brevoClient');
const Batch = require('../models/Batch');

// GET /api/debug/latest-email - Get the most recent email with full HTML content
router.get('/latest-email', async (req, res) => {
  try {
    // Get the most recent EmailLog entry
    const latestEmailLog = await EmailLog.findOne()
      .populate('campaignId')
      .populate('leadId')
      .sort({ sentAt: -1 });

    if (!latestEmailLog) {
      return res.json({
        success: false,
        message: 'No email logs found'
      });
    }

    // Recreate the email HTML that was sent
    const campaign = await Campaign.findById(latestEmailLog.campaignId).populate('templateId').populate('projectId');
    const lead = latestEmailLog.leadId;
    const template = campaign.templateId;
    const project = campaign.projectId;

    const personalizedSubject = replaceTemplateVariables(template.subject, lead, project);
    const personalizedBody = replaceTemplateVariables(template.body, lead, project);

    // Add tracking pixel and unsubscribe link (copied from campaignController)
    const PUBLIC_BACKEND_URL = process.env.PUBLIC_BACKEND_URL || 'http://localhost:5000';
    const trackingPixel = `<img src="${PUBLIC_BACKEND_URL}/api/track/open/${latestEmailLog.trackingId}" width="1" height="1" style="display:none;" alt="" />`;
    const unsubscribeLink = `<br><br><small><a href="${PUBLIC_BACKEND_URL}/api/track/unsubscribe/${latestEmailLog.trackingId}">Unsubscribe</a></small>`;
    
    const finalBody = personalizedBody + trackingPixel + unsubscribeLink;

    res.json({
      success: true,
      emailLog: {
        _id: latestEmailLog._id,
        email: latestEmailLog.email,
        status: latestEmailLog.status,
        trackingId: latestEmailLog.trackingId,
        sentAt: latestEmailLog.sentAt,
        openedAt: latestEmailLog.openedAt
      },
      campaign: {
        name: campaign.name,
        status: campaign.status,
        sentCount: campaign.sentCount,
        openedCount: campaign.openedCount
      },
      emailContent: {
        from: `"${project.senderName || project.senderEmail}" <${project.senderEmail}>`,
        to: lead.email,
        subject: personalizedSubject,
        htmlBody: finalBody
      },
      trackingUrls: {
        pixelUrl: `${PUBLIC_BACKEND_URL}/api/track/open/${latestEmailLog.trackingId}`,
        unsubscribeUrl: `${PUBLIC_BACKEND_URL}/api/track/unsubscribe/${latestEmailLog.trackingId}`
      },
      environment: {
        PUBLIC_BACKEND_URL,
        nodeEnv: process.env.NODE_ENV
      }
    });

  } catch (error) {
    console.error('Error in debug/latest-email:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to get latest email debug info',
      error: error.message
    });
  }
});

// GET /api/debug/send-readiness?projectId=...
router.get('/send-readiness', async (req, res) => {
  try {
    const { projectId, templateId } = req.query;
    if (!projectId) {
      return res.status(400).json({ success: false, message: 'projectId is required' });
    }

    const project = await Project.findById(projectId).populate('emailApiAccountId');
    if (!project) {
      return res.status(404).json({ success: false, message: 'Project not found' });
    }

    const batches = await Batch.find({ projectId }, '_id name');
    const batchIds = batches.map((b) => b._id);

    const sendableLeads = batchIds.length
      ? await Lead.countDocuments({
          batchId: { $in: batchIds },
          status: 'Valid',
          emailVerified: true,
          email: { $exists: true, $ne: '' },
        })
      : 0;

    let templateOk = true;
    let templateError = null;
    if (templateId) {
      const template = await Template.findById(templateId);
      if (!template) {
        templateOk = false;
        templateError = 'Template not found';
      } else {
        try {
          assertTemplateVariables(template.subject, template.body);
        } catch (e) {
          templateOk = false;
          templateError = e.message;
        }
      }
    }

    let transportOk = true;
    let transportError = null;
    try {
      await setupTransport(project);
    } catch (e) {
      transportOk = false;
      transportError = e.message;
    }

    let brevoKeyOk = null;
    let brevoKeyError = null;
    let brevoAccountEmail = null;
    if (project.sendingMethod === 'brevo_api' && project.emailApiAccountId?.apiKey) {
      const check = await validateBrevoApiKey(project.emailApiAccountId.apiKey);
      brevoKeyOk = check.ok;
      brevoKeyError = check.ok ? null : check.message;
      brevoAccountEmail = check.accountEmail;
    } else if (project.sendingMethod === 'brevo_api') {
      brevoKeyOk = false;
      brevoKeyError = 'No Brevo API account linked to this project';
    }

    const recentCampaign = await Campaign.findOne({ projectId })
      .sort({ createdAt: -1 })
      .select('name status sentCount totalRecipients createdAt');

  const failedLogs = recentCampaign
      ? await EmailLog.countDocuments({ campaignId: recentCampaign._id, status: 'failed' })
      : 0;

    return res.json({
      success: true,
      data: {
        project: {
          name: project.name,
          senderEmail: project.senderEmail,
          sendingMethod: project.sendingMethod,
          brevoAccountName: project.emailApiAccountId?.name || null,
        },
        batches: batches.length,
        sendableLeads,
        templateOk,
        templateError,
        transportOk,
        transportError,
        brevoKeyOk,
        brevoKeyError,
        brevoAccountEmail,
        schedulerNote:
          process.env.ENABLE_SCHEDULER === 'false'
            ? 'ENABLE_SCHEDULER is false on this backend — automations will NOT run on a schedule here.'
            : 'Scheduler is enabled on this backend.',
        recentCampaign,
        recentFailedEmailLogs: failedLogs,
      },
    });
  } catch (error) {
    console.error('send-readiness error:', error);
    return res.status(500).json({
      success: false,
      message: error.message,
    });
  }
});

module.exports = router;