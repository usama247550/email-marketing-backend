const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
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

// GET /api/dashboard/performance?days=14&projectId=<id>
router.get('/performance', async (req, res) => {
  try {
    let days = parseInt(req.query.days, 10);
    if (isNaN(days) || days < 7 || days > 30) {
      days = 14;
    }

    const projectParam = req.query.projectId || req.query.project;
    const byProject = projectParam && projectParam !== 'all';

    // Asia/Karachi timezone is UTC+5 (fixed offset, no DST)
    const KARACHI_OFFSET_MS = 5 * 60 * 60 * 1000;
    const now = new Date();
    const nowKarachi = new Date(now.getTime() + KARACHI_OFFSET_MS);

    const endYear = nowKarachi.getUTCFullYear();
    const endMonth = nowKarachi.getUTCMonth();
    const endDate = nowKarachi.getUTCDate();

    // Generate date strings for the last N days in Asia/Karachi (oldest to newest)
    const dateList = [];
    for (let i = days - 1; i >= 0; i--) {
      const d = new Date(Date.UTC(endYear, endMonth, endDate - i));
      dateList.push(d.toISOString().slice(0, 10));
    }

    // Earliest midnight in Asia/Karachi converted to UTC
    const startUtcTimestamp = Date.UTC(endYear, endMonth, endDate - (days - 1)) - KARACHI_OFFSET_MS;
    const startDateTime = new Date(startUtcTimestamp);

    const matchConditions = {
      sentAt: { $gte: startDateTime },
      status: { $ne: 'failed' }
    };

    const pipeline = [
      { $match: matchConditions }
    ];

    if (byProject) {
      let projectObjId;
      try {
        projectObjId = new mongoose.Types.ObjectId(projectParam);
      } catch (err) {
        return res.status(400).json({
          success: false,
          message: 'Invalid projectId'
        });
      }

      pipeline.push(
        {
          $lookup: {
            from: 'campaigns',
            localField: 'campaignId',
            foreignField: '_id',
            as: 'campaign'
          }
        },
        {
          $unwind: '$campaign'
        },
        {
          $match: {
            'campaign.projectId': projectObjId
          }
        }
      );
    }

    pipeline.push(
      {
        $group: {
          _id: {
            $dateToString: {
              format: '%Y-%m-%d',
              date: '$sentAt',
              timezone: 'Asia/Karachi'
            }
          },
          sent: { $sum: 1 },
          opened: {
            $sum: {
              $cond: [{ $eq: ['$status', 'opened'] }, 1, 0]
            }
          }
        }
      }
    );

    const aggResults = await EmailLog.aggregate(pipeline);

    const countMap = new Map();
    aggResults.forEach((r) => {
      if (r._id) {
        countMap.set(r._id, { sent: r.sent || 0, opened: r.opened || 0 });
      }
    });

    const data = dateList.map((date) => {
      const row = countMap.get(date);
      return {
        date,
        sent: row ? row.sent : 0,
        opened: row ? row.opened : 0
      };
    });

    res.json({
      success: true,
      data
    });
  } catch (error) {
    console.error('Dashboard performance error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch campaign performance',
      error: error.message
    });
  }
});

// GET /api/dashboard/recent-campaigns?limit=5&projectId=<id>
router.get('/recent-campaigns', async (req, res) => {
  try {
    let limit = parseInt(req.query.limit, 10);
    if (isNaN(limit) || limit < 1) limit = 5;
    if (limit > 20) limit = 20;

    const projectParam = req.query.projectId || req.query.project;
    const byProject = projectParam && projectParam !== 'all';

    const pipeline = [];

    if (byProject) {
      let projectObjId;
      try {
        projectObjId = new mongoose.Types.ObjectId(projectParam);
      } catch (err) {
        return res.status(400).json({
          success: false,
          message: 'Invalid projectId'
        });
      }
      pipeline.push({ $match: { projectId: projectObjId } });
    }

    pipeline.push(
      {
        $addFields: {
          effectiveDate: { $ifNull: ['$sentAt', '$createdAt'] }
        }
      },
      {
        $sort: { effectiveDate: -1 }
      },
      {
        $limit: limit
      },
      {
        $lookup: {
          from: 'projects',
          localField: 'projectId',
          foreignField: '_id',
          as: 'projectDoc'
        }
      },
      {
        $unwind: {
          path: '$projectDoc',
          preserveNullAndEmptyArrays: true
        }
      }
    );

    const campaigns = await Campaign.aggregate(pipeline);

    const data = campaigns.map((c) => {
      const sentCount = c.sentCount || 0;
      const openedCount = c.openedCount || 0;
      const unsubscribedCount = c.unsubscribedCount || 0;
      const rate = sentCount > 0 ? (openedCount / sentCount) * 100 : 0;
      const openRate = Math.round(rate * 10) / 10;
      const projectName = c.projectDoc?.name || 'Unknown Project';

      return {
        _id: c._id,
        name: c.name,
        projectName,
        projectId: c.projectId,
        status: c.status,
        sentCount,
        openedCount,
        unsubscribedCount,
        openRate,
        sentAt: c.sentAt || c.createdAt
      };
    });

    res.json({
      success: true,
      data
    });
  } catch (error) {
    console.error('Dashboard recent-campaigns error:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to fetch recent campaigns',
      error: error.message
    });
  }
});

module.exports = router;
