// models/subscription.model.js

const mongoose = require('mongoose');

const SubscriptionSchema = new mongoose.Schema({
  // Driver reference
  driverId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },

  // Vehicle type (determines pricing)
  vehicleType: {
    type: String,
    enum: ['CITY_CAR', 'KEKE', 'BIKE'],
    required: true
  },

  // Subscription plan
  plan: {
    duration: {
      type: String,
      enum: ['daily', 'weekly', 'monthly'],
      required: true
    },
    priceKobo: {
      type: Number,
      required: true,
      min: 0
    },
    durationHours: {
      type: Number,
      required: true
    }
  },

  // Subscription period
  startedAt: {
    type: Date,
    required: true,
    default: Date.now
  },
  expiresAt: {
    type: Date,
    required: true,
    index: true
  },

  // Status
  status: {
    type: String,
    enum: ['active', 'expired', 'cancelled'],
    default: 'active',
    index: true
  },

  // Payment details
  paymentMethod: {
    type: String,
    enum: ['wallet'],
    default: 'wallet'
  },
  transactionId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Transaction'
  },

  // Auto-renewal
  autoRenew: {
    type: Boolean,
    default: false
  },

  // Metadata
  metadata: {
    ipAddress: String,
    userAgent: String,
    renewalCount: {
      type: Number,
      default: 0
    }
  },

  // Timestamps
  createdAt: {
    type: Date,
    default: Date.now
  },
  updatedAt: {
    type: Date,
    default: Date.now
  },
  cancelledAt: {
    type: Date
  }
}, {
  timestamps: true
});

// ==============================
// INDEXES
// ==============================
SubscriptionSchema.index({ driverId: 1, status: 1 });
SubscriptionSchema.index({ expiresAt: 1, status: 1 });
SubscriptionSchema.index({ status: 1, expiresAt: 1 });

// ==============================
// VIRTUAL PROPERTIES
// ==============================

// Check if subscription is currently active
SubscriptionSchema.virtual('isActive').get(function() {
  return this.status === 'active' && new Date(this.expiresAt) > new Date();
});

// Time remaining in milliseconds
SubscriptionSchema.virtual('timeRemaining').get(function() {
  if (this.status !== 'active') return 0;
  const remaining = new Date(this.expiresAt) - new Date();
  return Math.max(0, remaining);
});

// Time remaining in hours
SubscriptionSchema.virtual('hoursRemaining').get(function() {
  return Math.floor(this.timeRemaining / (1000 * 60 * 60));
});

// ==============================
// INSTANCE METHODS
// ==============================

// Cancel subscription
SubscriptionSchema.methods.cancel = async function() {
  this.status = 'cancelled';
  this.cancelledAt = new Date();
  return await this.save();
};

// Mark as expired
SubscriptionSchema.methods.expire = async function() {
  this.status = 'expired';
  return await this.save();
};

// ==============================
// STATIC METHODS
// ==============================

// Find active subscription for a driver
SubscriptionSchema.statics.findActiveForDriver = function(driverId) {
  return this.findOne({
    driverId,
    status: 'active',
    expiresAt: { $gt: new Date() }
  });
};

// Find all expired subscriptions that need processing
SubscriptionSchema.statics.findExpired = function() {
  return this.find({
    status: 'active',
    expiresAt: { $lte: new Date() }
  });
};

// Get subscription history for driver
SubscriptionSchema.statics.getDriverHistory = function(driverId, limit = 10) {
  return this.find({ driverId })
    .sort({ createdAt: -1 })
    .limit(limit)
    .lean();
};

// ==============================
// MIDDLEWARE
// ==============================

// Update timestamps
SubscriptionSchema.pre('save', function(next) {
  this.updatedAt = new Date();
  next();
});

// ==============================
// TO JSON TRANSFORM
// ==============================
SubscriptionSchema.set('toJSON', {
  virtuals: true,
  transform: function(doc, ret) {
    delete ret.__v;
    return ret;
  }
});

module.exports = mongoose.model('Subscription', SubscriptionSchema);