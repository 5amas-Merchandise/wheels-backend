// db/mongoose.js
const mongoose = require('mongoose');
const config = require('../config');

let cachedConnection = null; // Reuse connection in warm serverless invocations

function _maskedUri(uri) {
  try {
    const u = new URL(uri);
    if (u.password) u.password = '***';
    return u.toString();
  } catch (e) {
    return uri;
  }
}

async function connect() {
  // Reuse cached connection if available and healthy
  if (cachedConnection && mongoose.connection.readyState === 1) {
    console.log('Using cached MongoDB connection');
    return cachedConnection;
  }

  const uri = config.mongoUri;
  if (!uri) {
    throw new Error('MONGO_URI is not set in environment variables');
  }

  try {
    console.log('Connecting to MongoDB at', _maskedUri(uri));

    // REMOVED: bufferMaxEntries and bufferTimeoutMS — no longer supported!
    const conn = await mongoose.connect(uri, {
      maxPoolSize: 10,                 // Still recommended for serverless
      serverSelectionTimeoutMS: 10000, // Fail fast if no server available
      socketTimeoutMS: 45000,          // Close inactive sockets
      // Removed: bufferMaxEntries: 0 and bufferTimeoutMS
    });

    cachedConnection = conn;
    console.log('MongoDB connected successfully');

    // Optional: Disable Mongoose command buffering globally (alternative way)
    mongoose.set('bufferCommands', false);

    return conn;
  } catch (err) {
    console.error('MongoDB connection failed:', err.message || err);
    throw err;
  }
}

// Log disconnection (helps debug cold starts)
mongoose.connection.on('disconnected', () => {
  console.log('MongoDB disconnected');
  cachedConnection = null;
});

module.exports = { connect };