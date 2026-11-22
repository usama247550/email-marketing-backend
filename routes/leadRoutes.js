const express = require('express');
const router = express.Router();
const {
  getLeadsByBatch,
  updateLead,
  deleteLead,
} = require('../controllers/leadController');

// GET /api/leads/batch/:batchId - Get leads by batch ID with pagination
router.get('/batch/:batchId', getLeadsByBatch);

// PATCH /api/leads/:id - Update a single lead
router.patch('/:id', updateLead);

// DELETE /api/leads/:id - Delete a single lead
router.delete('/:id', deleteLead);

module.exports = router;