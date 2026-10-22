#!/usr/bin/env node

/**
 * backend/scripts/syncOpens.js
 *
 * Manual one-off script to sync opens from Brevo.
 * Usage: node scripts/syncOpens.js
 *
 * This script:
 * 1. Connects to MongoDB using MONGODB_URI
 * 2. Runs the Brevo events poller once with days=7
 * 3. Prints summary and sample results
 * 4. Exits
 */

require('dotenv').config();

const mongoose = require('mongoose');
const { pollBrevoOpens } = require('../services/brevoEventsPoller');
const EmailLog = require('../models/EmailLog');

async function main() {
  const mongoUri = process.env.MONGODB_URI;
  if (!mongoUri) {
    console.error('Error: MONGODB_URI environment variable not set');
    process.exit(1);
  }

  console.log('[syncOpens] Connecting to MongoDB...');
  try {
    await mongoose.connect(mongoUri, {
      useNewUrlParser: true,
      useUnifiedTopology: true
    });
    console.log('[syncOpens] Connected to MongoDB');
  } catch (err) {
    console.error('[syncOpens] Failed to connect:', err.message);
    process.exit(1);
  }

  console.log('[syncOpens] Running Brevo opens poller (days=7)...\n');
  const result = await pollBrevoOpens({ daysNormal: 7 });

  console.log('\n──────────────────────────────────────────────────────────');
  console.log('SUMMARY');
  console.log('──────────────────────────────────────────────────────────');
  console.log(`Accounts checked:    ${result.accountsChecked}`);
  console.log(`Events fetched:      ${result.eventsFetched}`);
  console.log(`Matched:             ${result.matched}`);
  console.log(`Updated:             ${result.updated}`);
  console.log(`Unmatched:           ${result.unmatched}`);
  console.log(`Errors:              ${result.errors}`);
  console.log(`Duration:            ${result.duration}ms`);
  console.log('──────────────────────────────────────────────────────────\n');

  // Show sample of recently opened emails
  console.log('SAMPLE: Recently opened emails (up to 5):');
  console.log('──────────────────────────────────────────────────────────');
  const recentOpens = await EmailLog.find(
    { status: 'opened' },
    { email: 1, openedAt: 1, brevoMessageId: 1 }
  )
    .sort({ openedAt: -1 })
    .limit(5)
    .lean();

  if (recentOpens.length === 0) {
    console.log('(No opens found in database)');
  } else {
    for (const log of recentOpens) {
      const maskedEmail = log.email
        ? log.email.split('@')[0][0] + '*'.repeat(Math.max(1, log.email.split('@')[0].length - 1)) + '@' + log.email.split('@')[1]
        : 'unknown';
      const openedDate = log.openedAt ? new Date(log.openedAt).toISOString() : 'unknown';
      const hasMessageId = log.brevoMessageId ? 'yes' : 'no';
      console.log(`  ${maskedEmail} | opened: ${openedDate} | brevoMessageId: ${hasMessageId}`);
    }
  }
  console.log('──────────────────────────────────────────────────────────\n');

  await mongoose.disconnect();
  console.log('[syncOpens] Disconnected from MongoDB. Done.');
  process.exit(0);
}

main().catch(err => {
  console.error('Fatal error:', err);
  process.exit(1);
});
