const mongoose = require('mongoose');
const config = require('../config');

function _maskedUri(uri) {
  try {
    // mask password if present
    const u = new URL(uri);
    if (u.password) u.password = '***';
    return u.toString();
  } catch (e) {
    return uri;
  }
}

async function connect() {
  const uri = config.mongoUri;
  if (!uri) {
    throw new Error('MONGO_URI is not set. Create a .env from .env.example and set MONGO_URI');
  }

  const opts = {
    // Mongoose options kept minimal and compatible with modern drivers
    useNewUrlParser: true,
    useUnifiedTopology: true
  };

  try {
    console.log('Connecting to MongoDB at', _maskedUri(uri));
    await mongoose.connect(uri, opts);
    console.log('MongoDB connected');
    return mongoose.connection;
  } catch (err) {
    console.error('Failed to connect to MongoDB:', err.message || err);
    // rethrow so caller (server) can handle shutdown/logging
    throw err;
  }
}

module.exports = { connect };
