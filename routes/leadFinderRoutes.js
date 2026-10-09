/**
 * routes/leadFinderRoutes.js
 *
 * POST /api/lead-finder/multi-niche-search          — start a multi-niche search job
 * POST /api/lead-finder/smart-search                — start a smart search job
 * POST /api/lead-finder/smart-search/:jobId/stop    — cancel a running smart search
 * POST /api/lead-finder/smart-search/:jobId/save    — save matched leads to a Batch
 * GET  /api/lead-finder/status/:jobId               — poll any job status/progress
 */

'use strict';

const express = require('express');
const router  = express.Router();

const {
  triggerMultiNicheSearch,
  triggerSmartSearch,
  cancelSmartSearch,
  saveSmartSearchResults,
  getJobStatus,
} = require('../controllers/leadFinderController');

router.post('/multi-niche-search',           triggerMultiNicheSearch);
router.post('/smart-search',                 triggerSmartSearch);
router.post('/smart-search/:jobId/stop',     cancelSmartSearch);
router.post('/smart-search/:jobId/save',     saveSmartSearchResults);
router.get('/status/:jobId',                 getJobStatus);

module.exports = router;
