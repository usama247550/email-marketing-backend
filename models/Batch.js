const mongoose = require('mongoose');

const batchSchema = new mongoose.Schema({
  name: {
    type: String,
    required: true,
    trim: true
  },
  source: {
    type: String,
    required: true,
    enum: ['CSV Import', 'Lead Finder Agent']
  },
  leadCount: {
    type: Number,
    default: 0
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
});

module.exports = mongoose.model('Batch', batchSchema);