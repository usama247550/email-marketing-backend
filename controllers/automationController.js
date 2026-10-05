const Automation = require('../models/Automation');

// ─── GET /api/automations ─────────────────────────────────────────────────────

exports.getAllAutomations = async (req, res) => {
  try {
    const filter = {};
    if (req.query.projectId) filter.projectId = req.query.projectId;

    const automations = await Automation.find(filter)
      .populate('projectId',  'name senderEmail')
      .populate('templateId', 'name subject')
      .sort({ createdAt: -1 });

    res.json({ success: true, count: automations.length, data: automations });
  } catch (error) {
    console.error('Error fetching automations:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch automations', error: error.message });
  }
};

// ─── GET /api/automations/:id ─────────────────────────────────────────────────

exports.getAutomationById = async (req, res) => {
  try {
    const automation = await Automation.findById(req.params.id)
      .populate('projectId',  'name senderEmail sendingMethod')
      .populate('templateId', 'name subject');

    if (!automation) {
      return res.status(404).json({ success: false, message: 'Automation not found' });
    }

    res.json({ success: true, data: automation });
  } catch (error) {
    console.error('Error fetching automation:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch automation', error: error.message });
  }
};

// ─── POST /api/automations ────────────────────────────────────────────────────

exports.createAutomation = async (req, res) => {
  try {
    const { name, projectId, templateId, dailyLimit, scheduledTime, status } = req.body;

    if (!name || !projectId || !templateId || !scheduledTime) {
      return res.status(400).json({
        success: false,
        message: 'name, projectId, templateId, and scheduledTime are required',
      });
    }

    // Validate HH:mm format
    if (!/^\d{2}:\d{2}$/.test(scheduledTime)) {
      return res.status(400).json({
        success: false,
        message: 'scheduledTime must be in HH:mm format (e.g. "09:00")',
      });
    }

    const automation = new Automation({
      name: name.trim(),
      projectId,
      templateId,
      dailyLimit: dailyLimit ?? 50,
      scheduledTime,
      status: status || 'active',
    });

    await automation.save();

    const populated = await Automation.findById(automation._id)
      .populate('projectId',  'name senderEmail')
      .populate('templateId', 'name subject');

    res.status(201).json({ success: true, data: populated });
  } catch (error) {
    console.error('Error creating automation:', error);
    res.status(500).json({ success: false, message: 'Failed to create automation', error: error.message });
  }
};

// ─── PUT /api/automations/:id ─────────────────────────────────────────────────
// Handles both full edits and simple status toggles (active ↔ paused).

exports.updateAutomation = async (req, res) => {
  try {
    const automation = await Automation.findById(req.params.id);
    if (!automation) {
      return res.status(404).json({ success: false, message: 'Automation not found' });
    }

    const allowed = ['name', 'projectId', 'templateId', 'dailyLimit', 'scheduledTime', 'status'];
    for (const field of allowed) {
      if (req.body[field] !== undefined) {
        automation[field] = req.body[field];
      }
    }

    // Re-validate scheduledTime if it was updated
    if (req.body.scheduledTime && !/^\d{2}:\d{2}$/.test(req.body.scheduledTime)) {
      return res.status(400).json({
        success: false,
        message: 'scheduledTime must be in HH:mm format (e.g. "09:00")',
      });
    }

    await automation.save();

    const populated = await Automation.findById(automation._id)
      .populate('projectId',  'name senderEmail')
      .populate('templateId', 'name subject');

    res.json({ success: true, data: populated });
  } catch (error) {
    console.error('Error updating automation:', error);
    res.status(500).json({ success: false, message: 'Failed to update automation', error: error.message });
  }
};

// ─── DELETE /api/automations/:id ──────────────────────────────────────────────

exports.deleteAutomation = async (req, res) => {
  try {
    const automation = await Automation.findByIdAndDelete(req.params.id);
    if (!automation) {
      return res.status(404).json({ success: false, message: 'Automation not found' });
    }

    res.json({ success: true, message: 'Automation deleted successfully' });
  } catch (error) {
    console.error('Error deleting automation:', error);
    res.status(500).json({ success: false, message: 'Failed to delete automation', error: error.message });
  }
};
