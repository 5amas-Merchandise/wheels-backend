// models/tripRequest.model.js
const mongoose = require('mongoose');

const CandidateSchema = new mongoose.Schema({
  driverId: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'User', 
    required: true 
  },
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
  dropoff: {
    type: { type: String, enum: ['Point'], default: 'Point' },
    coordinates: { type: [Number] }
  },
  pickupAddress: { type: String },
  dropoffAddress: { type: String },
  serviceType: { type: String, required: true },
  paymentMethod: { 
    type: String, 
    // ✅ free_ride added — represents a loyalty redemption; passenger pays nothing
    enum: ['wallet', 'cash', 'free_ride'], 
    default: 'cash' 
  },
  estimatedFare: { type: Number, default: 0 },
  distance: { type: Number, default: 0 },
  duration: { type: Number, default: 0 },
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

  // ── LOYALTY / FREE RIDE FIELDS ─────────────────────────────────────────────
  //
  // isFreeRide:
  //   Set to true by the /trips/request handler when the passenger has an
  //   active, unexpired free-ride entitlement (LoyaltyProgress.freeRideAvailable).
  //   Copied verbatim onto the Trip document when a driver accepts.
  //   The passenger pays ₦0. The driver still gets paid — by the system.
  //
  isFreeRide: {
    type: Boolean,
    default: false,
    index: true
  },

  // Snapshot of the LoyaltyProgress._id at the time of this request.
  // Kept for audit / support — so we can always trace which loyalty doc
  // authorised this free ride even if the progress doc is later modified.
  loyaltyProgressId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'LoyaltyProgress',
    default: null
  },

  // The fare the DRIVER will receive from the system wallet for a free ride.
  // Equals estimatedFare (naira). Stored here so it's locked in at request
  // time and can't be gamed by fare recalculation later.
  freeRideDriverPayoutNaira: {
    type: Number,
    default: 0
  },
  // ─────────────────────────────────────────────────────────────────────────

  expiresAt: { 
    type: Date, 
    required: true,
    index: { expireAfterSeconds: 0 } // 🔥 TTL INDEX — NON-NEGOTIABLE
  },
  createdAt: { type: Date, default: Date.now }
});

// ── Indexes ────────────────────────────────────────────────────────────────
TripRequestSchema.index({ pickup: '2dsphere' });
TripRequestSchema.index({ dropoff: '2dsphere' });
TripRequestSchema.index({ status: 1 });
TripRequestSchema.index({ passengerId: 1 });
TripRequestSchema.index({ createdAt: -1 });
TripRequestSchema.index({ expiresAt: 1 });
TripRequestSchema.index({ 'candidates.driverId': 1 });
TripRequestSchema.index({ 'candidates.status': 1 });
TripRequestSchema.index({ isFreeRide: 1, status: 1 }); // for admin queries

module.exports = mongoose.model('TripRequest', TripRequestSchema);