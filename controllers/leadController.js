const Lead = require('../models/Lead');
const Batch = require('../models/Batch');
const { verifyEmailAddress } = require('../services/emailVerification');
const { syncBatchLeadCount, purgeUnverifiedLeads } = require('../services/verifyBatchLeads');

const EMAIL_SYNTAX = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// Get leads by batch ID with pagination
const getLeadsByBatch = async (req, res) => {
  try {
    const batchId = req.params.batchId;
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 15;
    const skip = (page - 1) * limit;

    // Check if batch exists
    const batch = await Batch.findById(batchId);
    if (!batch) {
      return res.status(404).json({ error: 'Batch not found' });
    }

    await purgeUnverifiedLeads(batchId);

    const listFilter = { batchId, emailVerified: true };

    const leads = await Lead.find(listFilter)
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate('batchId', 'name source');

    const total = await Lead.countDocuments(listFilter);
    const totalPages = Math.ceil(total / limit);

    res.json({
      leads,
      batch,
      pagination: {
        currentPage: page,
        totalPages,
        totalItems: total,
        itemsPerPage: limit,
        hasNextPage: page < totalPages,
        hasPrevPage: page > 1
      }
    });
  } catch (error) {
    console.error('Error fetching leads:', error);
    res.status(500).json({ error: 'Failed to fetch leads' });
  }
};

const updateLead = async (req, res) => {
  try {
    const leadId = req.params.id;
    const lead = await Lead.findById(leadId);
    if (!lead) {
      return res.status(404).json({ error: 'Lead not found' });
    }

    const { company, city, website, email } = req.body || {};

    if (company !== undefined) lead.company = String(company).trim();
    if (city !== undefined) lead.city = String(city).trim();
    if (website !== undefined) lead.website = String(website).trim();
    if (email !== undefined) {
      const normalized = String(email).trim().toLowerCase();
      if (normalized && !EMAIL_SYNTAX.test(normalized)) {
        return res.status(400).json({ error: 'Invalid email address' });
      }
      lead.email = normalized;
    }

    if (lead.status !== 'Unsubscribed') {
      if (!lead.email) {
        await Lead.findByIdAndDelete(lead._id);
        await syncBatchLeadCount(lead.batchId);
        return res.json({
          message: 'Lead removed — email is required',
          removed: true,
        });
      }
      const result = await verifyEmailAddress(lead.email, lead.website);
      if (!result.verified) {
        const batchId = lead.batchId;
        await Lead.findByIdAndDelete(lead._id);
        await syncBatchLeadCount(batchId);
        return res.json({
          message: `Lead removed — ${result.reason}`,
          removed: true,
        });
      }
      lead.emailVerified = true;
      lead.emailVerifyNote = result.reason;
      lead.status = 'Valid';
    }

    await lead.save();
    await syncBatchLeadCount(lead.batchId);

    res.json({
      message: 'Lead updated successfully',
      lead,
    });
  } catch (error) {
    console.error('Error updating lead:', error);
    res.status(500).json({ error: 'Failed to update lead' });
  }
};

// Delete a single lead by ID
const deleteLead = async (req, res) => {
  try {
    const leadId = req.params.id;

    const lead = await Lead.findById(leadId);
    if (!lead) {
      return res.status(404).json({ error: 'Lead not found' });
    }

    // Delete the lead
    await Lead.findByIdAndDelete(leadId);

    await syncBatchLeadCount(lead.batchId);

    res.json({
      message: 'Lead deleted successfully',
      deletedLead: lead
    });
  } catch (error) {
    console.error('Error deleting lead:', error);
    res.status(500).json({ error: 'Failed to delete lead' });
  }
};

module.exports = {
  getLeadsByBatch,
  updateLead,
  deleteLead,
};