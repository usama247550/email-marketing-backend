const mongoose = require('mongoose');

const emailLogSchema = new mongoose.Schema({
  campaignId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Campaign',
    required: true
  },
  leadId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Lead',
    required: true
  },
  email: {
    type: String,
    required: true,
    trim: true,
    lowercase: true
  },
  status: {
    type: String,
    enum: ['sent', 'failed', 'opened', 'unsubscribed'],
    default: 'sent'
  },
  sentAt: {
    type: Date,
    default: Date.now
  },
  openedAt: {
    type: Date
  },
  unsubscribedAt: {
    type: Date
  },
  trackingId: {
    type: String,
    unique: true,
    required: true
  }
});

module.exports = mongoose.model('EmailLog', emailLogSchema);