const express = require('express');
const router = express.Router();
const {
  getLeadsByBatch,
  deleteLead
} = require('../controllers/leadController');

// GET /api/leads/batch/:batchId - Get leads by batch ID with pagination
router.get('/batch/:batchId', getLeadsByBatch);

// DELETE /api/leads/:id - Delete a single lead
router.delete('/:id', deleteLead);

module.exports = router;