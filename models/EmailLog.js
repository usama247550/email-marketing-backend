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
    enum: ['sent', 'failed', 'opened', 'unsubscribed', 'bounced'],
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
  bouncedAt: {
    type: Date
  },
  trackingId: {
    type: String,
    unique: true,
    required: true
  },
  // Brevo's message ID returned after a successful Brevo API send.
  // Stored so we can correlate webhook events even if the tag lookup fails.
  brevoMessageId: {
    type: String,
    index: true,
    sparse: true
  },
  // 'hardBounce' | 'softBounce' — populated when a bounce webhook arrives
  bounceType: {
    type: String
  }
});

module.exports = mongoose.model('EmailLog', emailLogSchema);