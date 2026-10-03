const mongoose = require('mongoose');

const emailApiAccountSchema = new mongoose.Schema({
  name: {
    type: String,
    required: [true, 'Account name is required'],
    trim: true
  },
  provider: {
    type: String,
    enum: ['brevo'],
    default: 'brevo',
    required: true
  },
  apiKey: {
    type: String,
    required: [true, 'API key is required'],
    trim: true
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
});

module.exports = mongoose.model('EmailApiAccount', emailApiAccountSchema);