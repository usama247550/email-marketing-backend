const express = require('express');
const mongoose = require('mongoose');
const router = express.Router();
const EmailLog = require('../models/EmailLog');
const Campaign = require('../models/Campaign');

// GET /api/test/emaillogs/:campaignId - Get EmailLog entries for a campaign
router.get('/emaillogs/:campaignId', async (req, res) => {
  try {
    const { campaignId } = req.params;
    
    const emailLogs = await EmailLog.find({ campaignId })
      .populate('leadId', 'email company')
      .sort({ sentAt: -1 });

    const campaign = await Campaign.findById(campaignId);

    res.json({
      success: true,
      campaign: {
        _id: campaign._id,
        name: campaign.name,
        status: campaign.status,
        sentCount: campaign.sentCount,
        openedCount: campaign.openedCount
      },
      emailLogs: emailLogs.map(log => ({
        _id: log._id,
        email: log.email,
        status: log.status,
        trackingId: log.trackingId,
        sentAt: log.sentAt,
        openedAt: log.openedAt,
        leadInfo: log.leadId
      }))
    });

  } catch (error) {
    console.error('Error fetching email logs:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch email logs',
      error: error.message
    });
  }
});

module.exports = router;