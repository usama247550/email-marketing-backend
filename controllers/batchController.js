const Batch = require('../models/Batch');
const Lead = require('../models/Lead');
const multer = require('multer');
const { parse } = require('csv-parse');
const fs = require('fs');

// Configure multer for file upload
const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadDir = 'uploads';
    if (!fs.existsSync(uploadDir)) {
      fs.mkdirSync(uploadDir);
    }
    cb(null, uploadDir);
  },
  filename: (req, file, cb) => {
    cb(null, Date.now() + '-' + file.originalname);
  }
});

const upload = multer({ 
  storage,
  fileFilter: (req, file, cb) => {
    if (file.mimetype === 'text/csv' || file.originalname.endsWith('.csv')) {
      cb(null, true);
    } else {
      cb(new Error('Only CSV files are allowed'), false);
    }
  }
});

// Email validation helper
const isValidEmail = (email) => {
  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  return emailRegex.test(email);
};

// Normalize column names for flexible CSV parsing
const normalizeColumnName = (header) => {
  const normalized = header.toLowerCase().trim();
  const columnMap = {
    'company': ['company', 'company name', 'business', 'organization'],
    'city': ['city', 'location', 'town'],
    'website': ['website', 'url', 'web', 'site'],
    'email': ['email', 'e-mail', 'mail', 'email address']
  };
  
  for (const [key, variations] of Object.entries(columnMap)) {
    if (variations.includes(normalized)) {
      return key;
    }
  }
  return normalized;
};

// Get all batches with pagination
const getAllBatches = async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 15;
    const skip = (page - 1) * limit;

    const batches = await Batch.find()
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit);

    const total = await Batch.countDocuments();
    const totalPages = Math.ceil(total / limit);

    res.json({
      batches,
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
    console.error('Error fetching batches:', error);
    res.status(500).json({ error: 'Failed to fetch batches' });
  }
};

// Get batch by ID
const getBatchById = async (req, res) => {
  try {
    const batch = await Batch.findById(req.params.id);
    
    if (!batch) {
      return res.status(404).json({ error: 'Batch not found' });
    }

    res.json(batch);
  } catch (error) {
    console.error('Error fetching batch:', error);
    res.status(500).json({ error: 'Failed to fetch batch' });
  }
};

// Delete batch and all associated leads (cascade delete)
const deleteBatch = async (req, res) => {
  try {
    const batchId = req.params.id;

    // Check if batch exists
    const batch = await Batch.findById(batchId);
    if (!batch) {
      return res.status(404).json({ error: 'Batch not found' });
    }

    // Delete all leads associated with this batch
    const deletedLeads = await Lead.deleteMany({ batchId });
    
    // Delete the batch
    await Batch.findByIdAndDelete(batchId);

    res.json({
      message: 'Batch and associated leads deleted successfully',
      deletedBatch: batch,
      deletedLeadsCount: deletedLeads.deletedCount
    });
  } catch (error) {
    console.error('Error deleting batch:', error);
    res.status(500).json({ error: 'Failed to delete batch' });
  }
};

// Import CSV file
const importCsv = async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: 'No file uploaded' });
    }

    const filePath = req.file.path;
    const fileName = req.file.originalname;
    
    // Create new batch
    const batch = new Batch({
      name: fileName,
      source: 'CSV Import',
      leadCount: 0
    });
    
    await batch.save();

    // Parse CSV file
    const leads = [];
    const csvData = fs.readFileSync(filePath, 'utf8');

    parse(csvData, {
      columns: true,
      skip_empty_lines: true,
      trim: true
    }, async (err, records) => {
      if (err) {
        console.error('CSV parsing error:', err);
        await Batch.findByIdAndDelete(batch._id);
        return res.status(400).json({ error: 'Failed to parse CSV file' });
      }

      try {
        // Process each row
        for (const record of records) {
          const normalizedRecord = {};
          
          // Normalize column names
          Object.keys(record).forEach(key => {
            const normalizedKey = normalizeColumnName(key);
            normalizedRecord[normalizedKey] = record[key];
          });

          // Create lead with normalized data
          const leadData = {
            batchId: batch._id,
            company: normalizedRecord.company || '',
            city: normalizedRecord.city || '',
            website: normalizedRecord.website || '',
            email: normalizedRecord.email || '',
            status: 'Invalid'
          };

          // Validate email if present
          if (leadData.email && isValidEmail(leadData.email)) {
            leadData.status = 'Valid';
          }

          leads.push(leadData);
        }

        // Save all leads to database
        if (leads.length > 0) {
          await Lead.insertMany(leads);
          
          // Update batch lead count
          batch.leadCount = leads.length;
          await batch.save();
        }

        // Clean up uploaded file
        fs.unlinkSync(filePath);

        res.json({
          message: 'CSV imported successfully',
          batch,
          leadsImported: leads.length,
          validLeads: leads.filter(lead => lead.status === 'Valid').length,
          invalidLeads: leads.filter(lead => lead.status === 'Invalid').length
        });

      } catch (dbError) {
        console.error('Database error during CSV import:', dbError);
        // Clean up: delete batch if lead creation failed
        await Batch.findByIdAndDelete(batch._id);
        fs.unlinkSync(filePath);
        res.status(500).json({ error: 'Failed to save leads to database' });
      }
    });

  } catch (error) {
    console.error('Error importing CSV:', error);
    // Clean up uploaded file if it exists
    if (req.file && fs.existsSync(req.file.path)) {
      fs.unlinkSync(req.file.path);
    }
    res.status(500).json({ error: 'Failed to import CSV file' });
  }
};

module.exports = {
  getAllBatches,
  getBatchById,
  deleteBatch,
  importCsv,
  upload
};