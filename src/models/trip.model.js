// models/trip.model.js
const mongoose = require('mongoose');

const TripSchema = new mongoose.Schema({
  passengerId: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'User', 
    required: true, 
    index: true 
  },
  driverId: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'User', 
    required: true, 
    index: true 
  },
  tripRequestId: { 
    type: mongoose.Schema.Types.ObjectId, 
    ref: 'TripRequest' 
  },
  serviceType: { 
    type: String, 
    required: true 
  },
  paymentMethod: { 
    type: String, 
    enum: ['wallet', 'cash', 'free_ride'], 
    default: 'cash' 
  },
  status: {
    type: String,
    enum: ['assigned', 'pending', 'started', 'in_progress', 'completed', 'cancelled'],
    default: 'assigned',
    index: true
  },
  
  // ── LOYALTY PROGRAMME ─────────────────────────────────────────────────────
  // "Ride 5, Get 1 Free" — The Kilometre Club
  isFreeLoyaltyRide: {
    type: Boolean,
    default: false,
    index: true
  },
  // Snapshot of the passenger's loyalty counter AT THE TIME this trip was taken
  // (so history always makes sense even if counter resets later)
  loyaltyTripNumberAtBooking: {
    type: Number,
    default: null
  },
  // Whether the system has already credited the driver wallet for this free ride
  loyaltyDriverCreditProcessed: {
    type: Boolean,
    default: false
  },
  // The transaction ID created when the system credited the driver for this free ride
  loyaltyDriverCreditTxnId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Transaction',
    default: null
  },
  // ─────────────────────────────────────────────────────────────────────────
  
  // Locations
  pickupLocation: {
    type: { 
      type: String, 
      enum: ['Point'], 
      default: 'Point' 
    },
    coordinates: { 
      type: [Number], 
      required: true 
    }
  },
  dropoffLocation: {
    type: { 
      type: String, 
      enum: ['Point'] 
    },
    coordinates: { 
      type: [Number] 
    }
  },
  
  // Trip metrics
  distanceKm: { 
    type: Number, 
    default: 0 
  },
  durationMinutes: { 
    type: Number, 
    default: 0 
  },
  
  // Pricing
  estimatedFare: { 
    type: Number 
  }, // in NAIRA (frontend sends naira)
  finalFare: { 
    type: Number 
  }, // in NAIRA
  commission: { 
    type: Number, 
    default: 0 
  },
  driverEarnings: { 
    type: Number 
  }, // in NAIRA
  
  // Cash payment tracking
  paymentConfirmed: {
    type: Boolean,
    default: false
  },
  cashReceivedAt: {
    type: Date
  },
  cashAmount: {
    type: Number
  },
  
  // Trip completion notes
  completionNotes: {
    type: String
  },
  
  // Timestamps
  requestedAt: { 
    type: Date, 
    default: Date.now 
  },
  startedAt: { 
    type: Date 
  },
  completedAt: { 
    type: Date 
  },
  cancelledAt: { 
    type: Date 
  },
  cancellationReason: { 
    type: String 
  },

  metadata: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  }
}, {
  timestamps: true
});

// ── Indexes ────────────────────────────────────────────────────────────────
TripSchema.index({ passengerId: 1, createdAt: -1 });
TripSchema.index({ driverId: 1, createdAt: -1 });
TripSchema.index({ status: 1, createdAt: -1 });
TripSchema.index({ 'pickupLocation.coordinates': '2dsphere' });
TripSchema.index({ 'dropoffLocation.coordinates': '2dsphere' });
TripSchema.index({ paymentMethod: 1, status: 1 });
TripSchema.index({ completedAt: -1 });
TripSchema.index({ driverId: 1, status: 1 });
TripSchema.index({ isFreeLoyaltyRide: 1, loyaltyDriverCreditProcessed: 1 }); // for credit job queries

// ── Virtuals ───────────────────────────────────────────────────────────────
TripSchema.virtual('fareInNaira').get(function() {
  return this.finalFare ? this.finalFare : 0;
});

TripSchema.virtual('isActive').get(function() {
  return ['assigned', 'started', 'in_progress'].includes(this.status);
});

TripSchema.virtual('isEnded').get(function() {
  return ['completed', 'cancelled'].includes(this.status);
});

// ── Instance methods ───────────────────────────────────────────────────────
TripSchema.methods.completeWithCash = async function(cashAmount, driverId) {
  if (this.status === 'completed') throw new Error('Trip already completed');
  if (this.status === 'cancelled') throw new Error('Trip was cancelled');
  if (this.driverId.toString() !== driverId.toString()) {
    throw new Error('Only the assigned driver can complete the trip');
  }

  this.status = 'completed';
  this.completedAt = new Date();
  this.paymentMethod = 'cash';
  this.paymentConfirmed = true;
  this.cashReceivedAt = new Date();
  this.cashAmount = cashAmount || this.estimatedFare || 0;
  this.finalFare = this.cashAmount;
  this.driverEarnings = this.finalFare;
  this.commission = 0;

  return this.save();
};

TripSchema.methods.startTrip = async function(driverId) {
  if (this.status !== 'assigned') {
    throw new Error(`Cannot start trip with status: ${this.status}`);
  }
  if (this.driverId.toString() !== driverId.toString()) {
    throw new Error('Only the assigned driver can start the trip');
  }

  this.status = 'started';
  this.startedAt = new Date();

  return this.save();
};

TripSchema.methods.cancelTrip = async function(userId, reason) {
  const isDriver = this.driverId.toString() === userId.toString();
  const isPassenger = this.passengerId.toString() === userId.toString();

  if (!isDriver && !isPassenger) throw new Error('Unauthorized to cancel this trip');
  if (this.isEnded) throw new Error(`Cannot cancel trip that is already ${this.status}`);

  this.status = 'cancelled';
  this.cancelledAt = new Date();
  this.cancellationReason = reason || (isPassenger ? 'passenger_cancelled' : 'driver_cancelled');

  return this.save();
};

// ── Static methods ─────────────────────────────────────────────────────────
TripSchema.statics.findActiveByDriver = function(driverId) {
  return this.find({
    driverId,
    status: { $in: ['assigned', 'started', 'in_progress'] }
  });
};

TripSchema.statics.findCompletedByDriver = function(driverId, startDate, endDate) {
  const query = { driverId, status: 'completed' };
  if (startDate || endDate) {
    query.completedAt = {};
    if (startDate) query.completedAt.$gte = startDate;
    if (endDate) query.completedAt.$lte = endDate;
  }
  return this.find(query).sort({ completedAt: -1 });
};

TripSchema.statics.getDriverEarningsSummary = async function(driverId, startDate, endDate) {
  const match = {
    driverId: new mongoose.Types.ObjectId(driverId),
    status: 'completed'
  };
  if (startDate || endDate) {
    match.completedAt = {};
    if (startDate) match.completedAt.$gte = new Date(startDate);
    if (endDate) match.completedAt.$lte = new Date(endDate);
  }

  const result = await this.aggregate([
    { $match: match },
    {
      $group: {
        _id: null,
        totalTrips: { $sum: 1 },
        totalEarnings: { $sum: '$driverEarnings' },
        totalCommission: { $sum: '$commission' },
        totalFare: { $sum: '$finalFare' },
        cashTrips: { $sum: { $cond: [{ $eq: ['$paymentMethod', 'cash'] }, 1, 0] } },
        walletTrips: { $sum: { $cond: [{ $eq: ['$paymentMethod', 'wallet'] }, 1, 0] } },
        freeRides: { $sum: { $cond: [{ $eq: ['$isFreeLoyaltyRide', true] }, 1, 0] } }
      }
    }
  ]);

  return result[0] || {
    totalTrips: 0,
    totalEarnings: 0,
    totalCommission: 0,
    totalFare: 0,
    cashTrips: 0,
    walletTrips: 0,
    freeRides: 0
  };
};

module.exports = mongoose.model('Trip', TripSchema);