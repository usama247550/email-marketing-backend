'use strict';

const Lead = require('../models/Lead');
const Batch = require('../models/Batch');
const { verifyEmailAddress } = require('./emailVerification');

const VERIFY_CONCURRENCY = 8;

async function syncBatchLeadCount(batchId) {
  const count = await Lead.countDocuments({ batchId, emailVerified: true });
  await Batch.updateOne({ _id: batchId }, { leadCount: count });
  return count;
}

/**
 * Check each lead; keep only verified rows (failed rows are deleted).
 * Updates batch.leadCount to match the list you see in the UI.
 */
async function verifyBatchLeads(batchId) {
  const leads = await Lead.find({ batchId });
  if (leads.length === 0) {
    await syncBatchLeadCount(batchId);
    return { verified: 0, removed: 0, total: 0 };
  }

  let verified = 0;
  let removed = 0;

  for (let i = 0; i < leads.length; i += VERIFY_CONCURRENCY) {
    const slice = leads.slice(i, i + VERIFY_CONCURRENCY);
    await Promise.all(slice.map(async (lead) => {
      if (lead.status === 'Unsubscribed') {
        return;
      }
      const result = await verifyEmailAddress(lead.email, lead.website);
      if (result.verified) {
        await Lead.findByIdAndUpdate(lead._id, {
          emailVerified: true,
          emailVerifyNote: result.reason,
          status: 'Valid',
        });
        verified += 1;
      } else {
        await Lead.findByIdAndDelete(lead._id);
        removed += 1;
      }
    }));
  }

  await syncBatchLeadCount(batchId);
  return { verified, removed, failed: removed, total: leads.length };
}

/** Remove any leftover unverified rows and fix batch count (e.g. old imports). */
async function purgeUnverifiedLeads(batchId) {
  const result = await Lead.deleteMany({
    batchId,
    emailVerified: { $ne: true },
    status: { $ne: 'Unsubscribed' },
  });
  await syncBatchLeadCount(batchId);
  return result.deletedCount || 0;
}

module.exports = { verifyBatchLeads, syncBatchLeadCount, purgeUnverifiedLeads };