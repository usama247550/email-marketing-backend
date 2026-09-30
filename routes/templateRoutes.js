const express = require('express');
const router = express.Router();
const {
  getAllTemplates,
  getTemplateById,
  createTemplate,
  updateTemplate,
  deleteTemplate
} = require('../controllers/templateController');

// @route   GET /api/templates
router.get('/', getAllTemplates);

// @route   GET /api/templates/:id
router.get('/:id', getTemplateById);

// @route   POST /api/templates
router.post('/', createTemplate);

// @route   PUT /api/templates/:id
router.put('/:id', updateTemplate);

// @route   DELETE /api/templates/:id
router.delete('/:id', deleteTemplate);

module.exports = router;