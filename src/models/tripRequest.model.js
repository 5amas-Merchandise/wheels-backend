// models/tripRequest.model.js
const mongoose = require('mongoose');
const CandidateSchema = new mongoose.Schema({
driverId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
distanceMeters: { type: Number },
status: { type: String, enum: ['pending', 'offered', 'accepted', 'rejected'], default: 'pending' },
offeredAt: { type: Date }
}, { _id: false });
const TripRequestSchema = new mongoose.Schema({
passengerId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
pickup: {
type: { type: String, enum: ['Point'], default: 'Point' },
coordinates: { type: [Number], required: true }
  },
serviceType: { type: String, required: true },
paymentMethod: { type: String, enum: ['wallet','cash'], default: 'wallet' },
status: { type: String, enum: ['searching', 'assigned', 'no_drivers', 'cancelled'], default: 'searching' },
candidates: [CandidateSchema],
assignedDriverId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
expiresAt: { type: Date },
createdAt: { type: Date, default: Date.now }
});
TripRequestSchema.index({ pickup: '2dsphere' });
module.exports = mongoose.model('TripRequest', TripRequestSchema);