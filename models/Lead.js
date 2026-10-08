const mongoose = require('mongoose');

const leadSchema = new mongoose.Schema({
  batchId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Batch',
    required: true
  },
  company: {
    type: String,
    trim: true
  },
  city: {
    type: String,
    trim: true
  },
  website: {
    type: String,
    trim: true
  },
  email: {
    type: String,
    trim: true,
    lowercase: true
  },
  status: {
    type: String,
    enum: ['Valid', 'Invalid', 'Unsubscribed'],
    default: 'Invalid'
  },
  // Which niche this lead was found under (set by Lead Finder Agent)
  niche: {
    type: String,
    trim: true,
    default: ''
  },
  // Why the AI decided this lead matches the search criteria (Smart Search only)
  matchReason: {
    type: String,
    trim: true,
    default: ''
  },
  // Tracks which templates have already been emailed to this lead.
  // Automations use this to ensure no template is ever sent twice to the same lead.
  emailedTemplateIds: {
    type: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Template' }],
    default: [],
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
});

// Compound index for the automation engine's lead query:
//   find({ status: 'Valid', emailedTemplateIds: { $nin: [templateId] } })
// MongoDB can use this index to quickly filter valid leads and then apply
// the $nin check on the small emailedTemplateIds array per document.
leadSchema.index({ status: 1, batchId: 1 });

// Index for fast email-scoped-to-project deduplication in the Lead Finder.
// Usage: Lead.find({ batchId: { $in: projectBatchIds }, email: '...' })
leadSchema.index({ email: 1, batchId: 1 });

module.exports = mongoose.model('Lead', leadSchema);