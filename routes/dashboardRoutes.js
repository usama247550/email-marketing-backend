const express = require('express');
const router = express.Router();
const Lead = require('../models/Lead');
const Batch = require('../models/Batch');
const Campaign = require('../models/Campaign');
const EmailLog = require('../models/EmailLog');

// GET /api/dashboard/stats?project=<projectId|all>
router.get('/stats', async (req, res) => {
  try {
    const { project } = req.query;
    const byProject = project && project !== 'all';

    // ── Lead / batch counts ──────────────────────────────────────────────────
    let totalLeads = 0;

    if (byProject) {
      // Sum leadCount only for batches belonging to this project
      const batches = await Batch.find({ projectId: project }, 'leadCount');
      totalLeads = batches.reduce((sum, b) => sum + (b.leadCount || 0), 0);
    } else {
      totalLeads = await Lead.countDocuments();
    }

    // emails found = leads that have a non-empty email address
    let emailsFound = 0;
    if (byProject) {
      const batchIds = (await Batch.find({ projectId: project }, '_id')).map(b => b._id);
      emailsFound = await Lead.countDocuments({
        batchId: { $in: batchIds },
        email: { $exists: true, $ne: '' }
      });
    } else {
      emailsFound = await Lead.countDocuments({ email: { $exists: true, $ne: '' } });
    }

    // ── Campaign / sending counts ────────────────────────────────────────────
    const campaignFilter = byProject ? { projectId: project } : {};
    const campaigns = await Campaign.find(campaignFilter, '_id sentCount openedCount');

    const emailsSent = campaigns.reduce((sum, c) => sum + (c.sentCount || 0), 0);
    const emailsOpened = campaigns.reduce((sum, c) => sum + (c.openedCount || 0), 0);
    const replies = 0; // reply tracking not implemented yet

    // ── Recent campaigns ─────────────────────────────────────────────────────
    const recentCampaigns = await Campaign.find(campaignFilter)
      .populate('projectId', 'name slug')
      .sort({ sentAt: -1, createdAt: -1 })
      .limit(5);

    res.json({
      success: true,
      data: {
        stats: { totalLeads, emailsFound, emailsSent, emailsOpened, replies },
        recentCampaigns
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
