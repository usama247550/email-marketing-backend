const mongoose = require('mongoose');

const automationSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true,
  },
  projectId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Project',
    required: true,
  },
  templateId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Template',
    required: true,
  },
  dailyLimit: {
    type: Number,
    default: 50,
    min: 1,
  },
  // "HH:mm" 24-hour format, e.g. "09:00", "14:30"
  scheduledTime: {
    type: String,
    required: true,
    match: [/^\d{2}:\d{2}$/, 'scheduledTime must be in HH:mm format'],
  },
  status: {
    type: String,
    enum: ['active', 'paused'],
    default: 'active',
  },
  lastRunAt: {
    type: Date,
  },
  lastRunSentCount: {
    type: Number,
    default: 0,
  },
  // Set when the automation is auto-paused because its linked Project or
  // Template was deleted.  Cleared when the user updates the automation with
  // a valid replacement.
  orphanReason: {
    type: String,
    default: null,
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
});

// Index used by the scheduler: quickly find active automations at a given time
// that haven't already run today.
automationSchema.index({ status: 1, scheduledTime: 1 });

module.exports = mongoose.model('Automation', automationSchema);
