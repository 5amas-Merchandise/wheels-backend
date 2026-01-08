// models/trip.model.js
const mongoose = require('mongoose');
const TripSchema = new mongoose.Schema({
passengerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
driverId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, index: true },
tripRequestId: { type: mongoose.Schema.Types.ObjectId, ref: 'TripRequest' },
serviceType: { type: String, required: true },
paymentMethod: { type: String, enum: ['wallet','cash'], default: 'wallet' },
status: {
type: String,
enum: ['pending', 'started', 'in_progress', 'completed', 'cancelled'],
default: 'pending',
index: true
  },
// Locations
pickupLocation: {
type: { type: String, enum: ['Point'], default: 'Point' },
coordinates: { type: [Number], required: true }
  },
dropoffLocation: {
type: { type: String, enum: ['Point'] },
coordinates: { type: [Number] }
  },
// Trip metrics
distanceKm: { type: Number, default: 0 },
durationMinutes: { type: Number, default: 0 },
// Pricing
estimatedFare: { type: Number }, // in kobo
finalFare: { type: Number }, // in kobo (after actual distance/duration)
commission: { type: Number, default: 0 }, // in kobo (for luxury)
driverEarnings: { type: Number }, // in kobo (fare - commission)
// Timestamps
requestedAt: { type: Date, default: Date.now },
startedAt: { type: Date },
completedAt: { type: Date },
cancelledAt: { type: Date },
cancellationReason: { type: String }
});
TripSchema.index({ passengerId: 1, createdAt: -1 });
TripSchema.index({ driverId: 1, createdAt: -1 });
module.exports = mongoose.model('Trip', TripSchema);