const express = require('express');
const mongoose = require('mongoose');
const router = express.Router();
const EmailLog = require('../models/EmailLog');
const Campaign = require('../models/Campaign');
const { askAI } = require('../services/aiService');
const { parseSmartSearchInstruction, extractWebsiteSignals } = require('../services/smartSearchService');

// POST /api/test/ai — smoke-test the OpenRouter integration
// Body: { prompt: string, jsonMode?: boolean }
router.post('/ai', async (req, res) => {
  const { prompt, jsonMode = false } = req.body;
  if (!prompt || typeof prompt !== 'string' || !prompt.trim())
    return res.status(400).json({ success: false, error: 'prompt is required.' });
  try {
    const result = await askAI('You are a concise, helpful assistant.', prompt.trim(), { jsonMode });
    return res.json({ success: true, result });
  } catch (err) {
    console.error('[TestAI] askAI error:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/test/smart-search-parse — Step 2: parse free-text into search params
// Body: { instructionText: string }
router.post('/smart-search-parse', async (req, res) => {
  const { instructionText } = req.body;
  if (!instructionText || typeof instructionText !== 'string' || !instructionText.trim())
    return res.status(400).json({ success: false, error: 'instructionText is required.' });
  try {
    const result = await parseSmartSearchInstruction(instructionText.trim());
    return res.json({ success: true, result });
  } catch (err) {
    console.error('[TestSmartParse] error:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

// POST /api/test/website-signals — Step 3: extract factual signals from a URL
// Body: { url: string }
router.post('/website-signals', async (req, res) => {
  const { url } = req.body;
  if (!url || typeof url !== 'string' || !url.trim())
    return res.status(400).json({ success: false, error: 'url is required.' });
  try {
    const result = await extractWebsiteSignals(url.trim());
    return res.json({ success: true, url: url.trim(), result });
  } catch (err) {
    console.error('[TestSignals] error:', err.message);
    return res.status(500).json({ success: false, error: err.message });
  }
});

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