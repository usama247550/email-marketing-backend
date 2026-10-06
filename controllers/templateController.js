const Template   = require('../models/Template');
const Automation = require('../models/Automation');

// @desc    Get all templates
// @route   GET /api/templates
// @access  Public
const getAllTemplates = async (req, res) => {
  try {
    const templates = await Template.find().sort({ updatedAt: -1 });
    res.status(200).json({
      success: true,
      count: templates.length,
      data: templates
    });
  } catch (error) {
    console.error('Error in getAllTemplates:', error);
    res.status(500).json({
      success: false,
      message: 'Server error while fetching templates',
      error: error.message
    });
  }
};

// @desc    Get single template by ID
// @route   GET /api/templates/:id
// @access  Public
const getTemplateById = async (req, res) => {
  try {
    const template = await Template.findById(req.params.id);

    if (!template) {
      return res.status(404).json({
        success: false,
        message: 'Template not found'
      });
    }

    res.status(200).json({
      success: true,
      data: template
    });
  } catch (error) {
    console.error('Error in getTemplateById:', error);
    if (error.name === 'CastError') {
      return res.status(400).json({
        success: false,
        message: 'Invalid template ID format'
      });
    }
    res.status(500).json({
      success: false,
      message: 'Server error while fetching template',
      error: error.message
    });
  }
};

// @desc    Create new template
// @route   POST /api/templates
// @access  Public
const createTemplate = async (req, res) => {
  try {
    const template = await Template.create(req.body);

    res.status(201).json({
      success: true,
      message: 'Template created successfully',
      data: template
    });
  } catch (error) {
    console.error('Error in createTemplate:', error);
    if (error.name === 'ValidationError') {
      const messages = Object.values(error.errors).map(err => err.message);
      return res.status(400).json({
        success: false,
        message: 'Validation error',
        errors: messages
      });
    }
    res.status(500).json({
      success: false,
      message: 'Server error while creating template',
      error: error.message
    });
  }
};

// @desc    Update template
// @route   PUT /api/templates/:id
// @access  Public
const updateTemplate = async (req, res) => {
  try {
    const template = await Template.findByIdAndUpdate(
      req.params.id,
      req.body,
      { new: true, runValidators: true }
    );

    if (!template) {
      return res.status(404).json({
        success: false,
        message: 'Template not found'
      });
    }

    res.status(200).json({
      success: true,
      message: 'Template updated successfully',
      data: template
    });
  } catch (error) {
    console.error('Error in updateTemplate:', error);
    if (error.name === 'CastError') {
      return res.status(400).json({
        success: false,
        message: 'Invalid template ID format'
      });
    }
    if (error.name === 'ValidationError') {
      const messages = Object.values(error.errors).map(err => err.message);
      return res.status(400).json({
        success: false,
        message: 'Validation error',
        errors: messages
      });
    }
    res.status(500).json({
      success: false,
      message: 'Server error while updating template',
      error: error.message
    });
  }
};

// @desc    Delete template
// @route   DELETE /api/templates/:id
// @access  Public
const deleteTemplate = async (req, res) => {
  try {
    const template = await Template.findByIdAndDelete(req.params.id);

    if (!template) {
      return res.status(404).json({
        success: false,
        message: 'Template not found'
      });
    }

    // Cascade: pause any automations that referenced this template.
    // We pause (not delete) so configs are recoverable.
    const affected = await Automation.updateMany(
      { templateId: req.params.id },
      {
        status: 'paused',
        orphanReason: `Template "${template.name}" was deleted`,
      }
    );
    if (affected.modifiedCount > 0) {
      console.log(
        `[deleteTemplate] Auto-paused ${affected.modifiedCount} automation(s) that referenced template "${template.name}"`
      );
    }

    res.status(200).json({
      success: true,
      message: 'Template deleted successfully',
      data: template
    });
  } catch (error) {
    console.error('Error in deleteTemplate:', error);
    if (error.name === 'CastError') {
      return res.status(400).json({
        success: false,
        message: 'Invalid template ID format'
      });
    }
    res.status(500).json({
      success: false,
      message: 'Server error while deleting template',
      error: error.message
    });
  }
};

module.exports = {
  getAllTemplates,
  getTemplateById,
  createTemplate,
  updateTemplate,
  deleteTemplate
};
