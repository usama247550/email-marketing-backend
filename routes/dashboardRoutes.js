const express = require('express');
const router = express.Router();
const Lead = require('../models/Lead');
const Batch = require('../models/Batch');

// GET /api/dashboard/stats - Get dashboard statistics
router.get('/stats', async (req, res) => {
  try {
    // Count total leads across all batches
    // Note: Currently we don't have project linking in Lead/Batch models
    // so we show overall totals regardless of project selection
    const totalLeads = await Lead.countDocuments();
    
    // For now, emails found = total leads (since all imported leads are "found")
    const emailsFound = totalLeads;
    
    // Email sending functionality not implemented yet - return 0
    const emailsSent = 0;
    const emailsOpened = 0;
    const replies = 0;

    const stats = {
      totalLeads,
      emailsFound,
      emailsSent,
      emailsOpened,
      replies
    };

    res.json({
      success: true,
      data: {
        stats,
        recentCampaigns: [] // No campaigns implemented yet - return empty array
      }
    });

  } catch (error) {
    console.error('Dashboard stats error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch dashboard statistics',
      error: error.message
    });
  }
});

module.exports = router;