require('dotenv').config();
const mongoose = require('mongoose');

(async () => {
  if (!process.env.MONGODB_URI) {
    console.error('MONGODB_URI is missing. Add it to .env; do not paste credentials into source files.');
    process.exitCode = 2;
    return;
  }
  try {
    await mongoose.connect(process.env.MONGODB_URI, { dbName: process.env.MONGODB_DB || 'nigeria_casino', serverSelectionTimeoutMS: 8000 });
    const hello = await mongoose.connection.db.admin().command({ hello: 1 });
    const transactionCapable = Boolean(hello.setName || hello.msg === 'isdbgrid');
    console.log(`MongoDB connected: ${mongoose.connection.name}`);
    console.log(`Topology: ${hello.msg === 'isdbgrid' ? 'mongos' : hello.setName ? `replica set (${hello.setName})` : 'standalone'}`);
    if (!transactionCapable) {
      console.error('This server is standalone; daily bonus, promo, deposit and referral transactions require a replica set.');
      process.exitCode = 3;
    } else {
      console.log('MongoDB transactions are supported.');
    }
  } catch (err) {
    console.error(`MongoDB connection check failed: ${err.message}`);
    process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
  }
})();
