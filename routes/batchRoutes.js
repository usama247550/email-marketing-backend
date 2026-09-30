const express = require('express');
const router = express.Router();
const {
  getAllBatches,
  getBatchById,
  deleteBatch,
  importCsv,
  upload
} = require('../controllers/batchController');

// GET /api/batches - Get all batches with pagination
router.get('/', getAllBatches);

// GET /api/batches/:id - Get batch by ID
router.get('/:id', getBatchById);

// DELETE /api/batches/:id - Delete batch and all associated leads
router.delete('/:id', deleteBatch);

// POST /api/batches/import-csv - Import CSV file
router.post('/import-csv', upload.single('csvFile'), importCsv);

module.exports = router;