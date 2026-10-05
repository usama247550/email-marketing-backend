// deploy test - 2026-10-03 12:21:00 UTC
// DNS fix for MongoDB Atlas connection issues
const dns = require('dns');
dns.setServers(['8.8.8.8', '8.8.4.4']);

const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const connectDB = require('./config/db');

// Import routes
const projectRoutes = require('./routes/projectRoutes');
const templateRoutes = require('./routes/templateRoutes');
const batchRoutes = require('./routes/batchRoutes');
const leadRoutes = require('./routes/leadRoutes');
const dashboardRoutes = require('./routes/dashboardRoutes');
const campaignRoutes = require('./routes/campaignRoutes');
const trackingRoutes = require('./routes/trackingRoutes');
const adminRoutes = require('./routes/adminRoutes');
const testRoutes = require('./routes/testRoutes');
const debugRoutes = require('./routes/debugRoutes');
const emailApiAccountRoutes = require('./routes/emailApiAccountRoutes');
const brevoWebhookRoutes = require('./routes/brevoWebhookRoutes');
const automationRoutes   = require('./routes/automationRoutes');
const { startScheduler } = require('./services/scheduler');

// Load environment variables
dotenv.config();

// Connect to MongoDB, then start the automation scheduler
connectDB();

// Start the cron scheduler once Mongoose has a live connection.
// Using the 'connected' event works whether connectDB() resolved before or
// after this line executes (Mongoose buffers and replays the event).
const mongoose = require('mongoose');
mongoose.connection.once('connected', () => {
  startScheduler();
});

const app = express();

// Middleware
const allowedOrigins = [
  'http://localhost:3000', // Local development
  process.env.FRONTEND_URL, // Production frontend from environment variable
].filter(Boolean); // Remove any undefined values

app.use(cors({
  origin: allowedOrigins,
  credentials: true
}));
app.use(express.json());

// Routes
app.use('/api/projects', projectRoutes);
app.use('/api/templates', templateRoutes);
app.use('/api/batches', batchRoutes);
app.use('/api/leads', leadRoutes);
app.use('/api/dashboard', dashboardRoutes);
app.use('/api/campaigns', campaignRoutes);
app.use('/api/track', trackingRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/test', testRoutes);
app.use('/api/debug', debugRoutes);
app.use('/api/email-api-accounts', emailApiAccountRoutes);
app.use('/api/webhooks',    brevoWebhookRoutes);
app.use('/api/automations', automationRoutes);

// Test route
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    message: 'Backend is running',
    timestamp: new Date().toISOString(),
    version: '1.2.0' // Force Railway redeploy
  });
});

// Default route
app.get('/', (req, res) => {
  res.json({ message: 'Email Dashboard Backend API' });
});

const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  console.log(`📊 Health check: ${process.env.PUBLIC_BACKEND_URL || `http://localhost:${PORT}`}/api/health`);
  console.log(`🌐 Allowed origins: ${allowedOrigins.join(', ')}`);

  // Warn loudly if PUBLIC_BACKEND_URL is misconfigured — tracking pixels won't work
  const publicUrl = process.env.PUBLIC_BACKEND_URL || '';
  if (!publicUrl || publicUrl.includes('localhost') || publicUrl.includes('REPLACE_WITH')) {
    console.warn('⚠️  WARNING: PUBLIC_BACKEND_URL is set to a localhost or placeholder value.');
    console.warn('⚠️  Email tracking pixels will NOT work until you set it to your public Railway URL.');
    console.warn(`⚠️  Current value: "${publicUrl}"`);
  } else {
    console.log(`✅ Tracking pixel base URL: ${publicUrl}`);
  }
});