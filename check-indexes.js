const mongoose = require('mongoose');
require('dotenv').config();

async function checkIndexes() {
  try {
    console.log('Connecting to MongoDB...');
    await mongoose.connect(process.env.MONGODB_URI);
    console.log('✅ Connected to MongoDB');

    const db = mongoose.connection.db;
    const collection = db.collection('emaillogs');

    console.log('\n=== CURRENT INDEXES ON emaillogs collection ===');
    const indexes = await collection.indexes();
    indexes.forEach((index, i) => {
      console.log(`${i + 1}. ${JSON.stringify(index, null, 2)}`);
    });

    console.log('\n=== DROPPING STALE trackingToken_1 INDEX ===');
    try {
      await collection.dropIndex('trackingToken_1');
      console.log('✅ Successfully dropped trackingToken_1 index');
    } catch (error) {
      if (error.message.includes('index not found')) {
        console.log('ℹ️  trackingToken_1 index not found (already dropped or never existed)');
      } else {
        console.log('❌ Error dropping index:', error.message);
      }
    }

    console.log('\n=== INDEXES AFTER CLEANUP ===');
    const indexesAfter = await collection.indexes();
    indexesAfter.forEach((index, i) => {
      console.log(`${i + 1}. ${JSON.stringify(index, null, 2)}`);
    });

  } catch (error) {
    console.error('❌ Error:', error);
  } finally {
    await mongoose.disconnect();
    console.log('\n🔌 Disconnected from MongoDB');
  }
}

checkIndexes();