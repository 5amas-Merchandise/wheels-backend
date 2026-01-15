// models/tripRequest.model.js - UPDATED WITH FARE FIELDS

const mongoose = require('mongoose');

const CandidateSchema = new mongoose.Schema({
  driverId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  driverName: { type: String },
  distanceMeters: { type: Number },
  status: { 
    type: String, 
    enum: ['pending', 'offered', 'accepted', 'rejected'], 
    default: 'pending' 
  },
  offeredAt: { type: Date },
  rejectedAt: { type: Date },
  rejectionReason: { type: String }
}, { _id: false });

const TripRequestSchema = new mongoose.Schema({
  passengerId: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'User', 
    required: true 
  },
  pickup: {
    type: { type: String, enum: ['Point'], default: 'Point' },
    coordinates: { type: [Number], required: true }
  },
  dropoff: {  // ✅ FIX: Add dropoff field
    type: { type: String, enum: ['Point'], default: 'Point' },
    coordinates: { type: [Number] }
  },
  pickupAddress: { type: String },  // ✅ FIX: Add address fields
  dropoffAddress: { type: String },
  serviceType: { type: String, required: true },
  paymentMethod: { 
    type: String, 
    enum: ['wallet', 'cash'], 
    default: 'wallet' 
  },
  estimatedFare: { type: Number, default: 0 },  // ✅ FIX: Add fare
  distance: { type: Number, default: 0 },  // ✅ FIX: Add distance (km)
  duration: { type: Number, default: 0 },  // ✅ FIX: Add duration (seconds)
  status: { 
    type: String, 
    enum: ['searching', 'assigned', 'no_drivers', 'cancelled'], 
    default: 'searching' 
  },
  candidates: [CandidateSchema],
  assignedDriverId: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'User' 
  },
  expiresAt: { type: Date },
  createdAt: { type: Date, default: Date.now }
});

TripRequestSchema.index({ pickup: '2dsphere' });
TripRequestSchema.index({ dropoff: '2dsphere' });
TripRequestSchema.index({ status: 1 });
TripRequestSchema.index({ passengerId: 1 });
TripRequestSchema.index({ createdAt: -1 });

module.exports = mongoose.model('TripRequest', TripRequestSchema);