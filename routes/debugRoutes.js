const express = require('express');
const router = express.Router();
const EmailLog = require('../models/EmailLog');
const Campaign = require('../models/Campaign');
const Lead = require('../models/Lead');
const Template = require('../models/Template');
const Project = require('../models/Project');

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

    // Helper function to replace template variables (copied from campaignController)
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

    const personalizedSubject = replaceTemplateVariables(template.subject, lead);
    const personalizedBody = replaceTemplateVariables(template.body, lead);

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

module.exports = router;