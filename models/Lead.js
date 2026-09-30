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
    enum: ['Valid', 'Invalid'],
    default: 'Invalid'
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
});

module.exports = mongoose.model('Lead', leadSchema);