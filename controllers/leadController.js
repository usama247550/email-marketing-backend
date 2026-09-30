const Lead = require('../models/Lead');
const Batch = require('../models/Batch');

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

    // Get leads for the batch
    const leads = await Lead.find({ batchId })
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit)
      .populate('batchId', 'name source');

    const total = await Lead.countDocuments({ batchId });
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

    // Update batch lead count
    const batch = await Batch.findById(lead.batchId);
    if (batch) {
      batch.leadCount = Math.max(0, batch.leadCount - 1);
      await batch.save();
    }

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
  deleteLead
};