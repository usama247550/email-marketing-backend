const express = require('express');
const mongoose = require('mongoose');
const router = express.Router();

// GET /api/admin/indexes - List and optionally fix EmailLog indexes
router.get('/indexes', async (req, res) => {
  try {
    const db = mongoose.connection.db;
    const collection = db.collection('emaillogs');

    console.log('=== CURRENT INDEXES ON emaillogs collection ===');
    const indexesBefore = await collection.indexes();
    
    const response = {
      success: true,
      indexesBefore,
      actions: []
    };

    // Check if stale trackingToken_1 index exists and drop it
    const hasStaleIndex = indexesBefore.some(idx => idx.name === 'trackingToken_1');
    
    if (hasStaleIndex) {
      console.log('Found stale trackingToken_1 index, dropping it...');
      try {
        await collection.dropIndex('trackingToken_1');
        response.actions.push('Dropped stale trackingToken_1 index');
        console.log('✅ Successfully dropped trackingToken_1 index');
      } catch (error) {
        response.actions.push(`Error dropping trackingToken_1: ${error.message}`);
        console.error('❌ Error dropping index:', error.message);
      }
    } else {
      response.actions.push('No stale trackingToken_1 index found');
    }

    // Get final index list
    const indexesAfter = await collection.indexes();
    response.indexesAfter = indexesAfter;

    console.log('=== INDEXES AFTER CLEANUP ===');
    indexesAfter.forEach((index, i) => {
      console.log(`${i + 1}. ${index.name}: ${JSON.stringify(index.key)}`);
    });

    res.json(response);

  } catch (error) {
    console.error('❌ Error in admin/indexes:', error);
    res.status(500).json({
      success: false,
      message: 'Failed to check/fix indexes',
      error: error.message
    });
  }
});

module.exports = router;