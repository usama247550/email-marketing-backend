const mongoose = require('mongoose');

const projectSchema = new mongoose.Schema({
  name: {
    type: String,
    required: [true, 'Project name is required'],
    trim: true
  },
  senderEmail: {
    type: String,
    required: [true, 'Sender email is required'],
    trim: true,
    lowercase: true
  },
  senderName: {
    type: String,
    trim: true
  },
  niche: {
    type: String,
    trim: true
  },
  websiteUrl: {
    type: String,
    trim: true
  },
  smtpHost: {
    type: String,
    default: 'smtp.gmail.com',
    trim: true
  },
  smtpPort: {
    type: Number,
    default: 465
  },
  smtpUser: {
    type: String,
    trim: true
  },
  smtpPassword: {
    type: String
  },
  createdAt: {
    type: Date,
    default: Date.now
  }
});

module.exports = mongoose.model('Project', projectSchema);