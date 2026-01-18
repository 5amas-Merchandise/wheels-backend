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
    enum: ['wallet', 'cash'], 
    default: 'cash' 
  },
  status: {
    type: String,
    enum: ['assigned', 'pending', 'started', 'in_progress', 'completed', 'cancelled'],
    default: 'assigned',
    index: true
  },
  
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
  }, // in kobo
  finalFare: { 
    type: Number 
  }, // in kobo (after actual distance/duration)
  commission: { 
    type: Number, 
    default: 0 
  }, // in kobo (for luxury)
  driverEarnings: { 
    type: Number 
  }, // in kobo (fare - commission)
  
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
  }, // in kobo
  
  // Trip completion notes (for errors or special cases)
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
  }
}, {
  timestamps: true // Adds createdAt and updatedAt automatically
});

// Create indexes for better query performance
TripSchema.index({ passengerId: 1, createdAt: -1 });
TripSchema.index({ driverId: 1, createdAt: -1 });
TripSchema.index({ status: 1, createdAt: -1 });
TripSchema.index({ 'pickupLocation.coordinates': '2dsphere' });
TripSchema.index({ 'dropoffLocation.coordinates': '2dsphere' });
TripSchema.index({ paymentMethod: 1, status: 1 });
TripSchema.index({ completedAt: -1 });
TripSchema.index({ driverId: 1, status: 1 }); // For finding driver's active trips

// Virtual property to get fare in Naira (for easier display)
TripSchema.virtual('fareInNaira').get(function() {
  return this.finalFare ? this.finalFare / 100 : 0;
});

// Virtual property to check if trip is active
TripSchema.virtual('isActive').get(function() {
  return ['assigned', 'started', 'in_progress'].includes(this.status);
});

// Virtual property to check if trip is ended
TripSchema.virtual('isEnded').get(function() {
  return ['completed', 'cancelled'].includes(this.status);
});

// Method to mark trip as completed with cash payment
TripSchema.methods.completeWithCash = async function(cashAmount, driverId) {
  if (this.status === 'completed') {
    throw new Error('Trip already completed');
  }
  
  if (this.status === 'cancelled') {
    throw new Error('Trip was cancelled');
  }
  
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
  
  // For cash trips, driver gets full amount (no commission)
  this.driverEarnings = this.finalFare;
  this.commission = 0;
  
  return this.save();
};

// Method to mark trip as started
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

// Method to cancel trip
TripSchema.methods.cancelTrip = async function(userId, reason) {
  const isDriver = this.driverId.toString() === userId.toString();
  const isPassenger = this.passengerId.toString() === userId.toString();
  
  if (!isDriver && !isPassenger) {
    throw new Error('Unauthorized to cancel this trip');
  }
  
  if (this.isEnded) {
    throw new Error(`Cannot cancel trip that is already ${this.status}`);
  }
  
  this.status = 'cancelled';
  this.cancelledAt = new Date();
  this.cancellationReason = reason || (isPassenger ? 'passenger_cancelled' : 'driver_cancelled');
  
  return this.save();
};

// Static method to find active trips for a driver
TripSchema.statics.findActiveByDriver = function(driverId) {
  return this.find({
    driverId: driverId,
    status: { $in: ['assigned', 'started', 'in_progress'] }
  });
};

// Static method to find completed trips within a date range
TripSchema.statics.findCompletedByDriver = function(driverId, startDate, endDate) {
  const query = {
    driverId: driverId,
    status: 'completed'
  };
  
  if (startDate || endDate) {
    query.completedAt = {};
    if (startDate) query.completedAt.$gte = startDate;
    if (endDate) query.completedAt.$lte = endDate;
  }
  
  return this.find(query).sort({ completedAt: -1 });
};

// Static method to get driver earnings summary
TripSchema.statics.getDriverEarningsSummary = async function(driverId, startDate, endDate) {
  const match = {
    driverId: mongoose.Types.ObjectId(driverId),
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
        cashTrips: { 
          $sum: { 
            $cond: [{ $eq: ['$paymentMethod', 'cash'] }, 1, 0] 
          } 
        },
        walletTrips: { 
          $sum: { 
            $cond: [{ $eq: ['$paymentMethod', 'wallet'] }, 1, 0] 
          } 
        }
      }
    }
  ]);
  
  return result[0] || {
    totalTrips: 0,
    totalEarnings: 0,
    totalCommission: 0,
    totalFare: 0,
    cashTrips: 0,
    walletTrips: 0
  };
};

module.exports = mongoose.model('Trip', TripSchema);