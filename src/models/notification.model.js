const mongoose = require('mongoose');

const NotificationSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
  type: { type: String, enum: ['trip_offered', 'trip_accepted', 'trip_completed', 'payment_received', 'subscription_activated', 'driver_verified', 'driver_rejected'], required: true },
  title: { type: String },
  body: { type: String },
  data: { type: Object },
  read: { type: Boolean, default: false },
  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Notification', NotificationSchema);
