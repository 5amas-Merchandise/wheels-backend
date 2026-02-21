// models/referral.model.js
const mongoose = require('mongoose');

const ReferralSchema = new mongoose.Schema({
  // The user who shared their code
  referrerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },

  // The new user who used the code
  refereeId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    unique: true // A user can only be referred once
  },

  // The code that was used
  code: {
    type: String,
    required: true,
    uppercase: true,
    trim: true
  },

  // Reward amounts in kobo (smallest NGN unit)
  referrerReward: {
    type: Number,
    default: 50000 // ₦500
  },
  refereeReward: {
    type: Number,
    default: 30000 // ₦300
  },

  // Status tracking
  status: {
    type: String,
    enum: ['pending', 'rewarded', 'expired', 'cancelled'],
    default: 'pending'
  },

  // The trip that triggered the reward (first completed trip by referee)
  triggerTripId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Trip',
    default: null
  },

  rewardedAt: { type: Date, default: null },
  expiresAt: {
    type: Date,
    default: () => new Date(Date.now() + 90 * 24 * 60 * 60 * 1000) // 90 days
  }
}, {
  timestamps: true
});

ReferralSchema.index({ referrerId: 1, status: 1 });
ReferralSchema.index({ code: 1 });

module.exports = mongoose.model('Referral', ReferralSchema);