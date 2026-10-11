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
  // Lead Finder integration
  leadSource: {
    type: String,
    enum: ['existing', 'finder'],
    default: 'existing',
  },
  finder: {
    country:     { type: String, default: null },
    city:        { type: String, default: null },
    allCities:   { type: Boolean, default: false },
    niches:      { type: [String], default: [] },
    leadsPerDay: { type: Number, default: 50 },
  },
  finderCursor: {
    type: mongoose.Schema.Types.Mixed,
    default: null,
  },
  lastRunFoundCount: {
    type: Number,
    default: 0,
  },
  lastRunFinderStatus: {
    type: String,
    enum: ['ok', 'failed', 'skipped', null],
    default: null,
  },
  lastRunFinderMessage: {
    type: String,
    default: null,
  },
  isRunning: {
    type: Boolean,
    default: false,
  },
  runStartedAt: {
    type: Date,
    default: null,
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
