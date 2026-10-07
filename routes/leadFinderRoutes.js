/**
 * routes/leadFinderRoutes.js
 *
 * POST /api/lead-finder/multi-niche-search  — start a search job
 * GET  /api/lead-finder/status/:jobId       — poll job status
 */

'use strict';

const express = require('express');
const router  = express.Router();

const {
  triggerMultiNicheSearch,
  getJobStatus,
} = require('../controllers/leadFinderController');

router.post('/multi-niche-search', triggerMultiNicheSearch);
router.get('/status/:jobId',       getJobStatus);

module.exports = router;
