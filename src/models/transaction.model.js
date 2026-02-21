// models/transaction.model.js - UPDATED VERSION
const mongoose = require('mongoose');

const TransactionSchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true
  },
  type: {
    type: String,
    enum: ['credit', 'debit', 'deposit', 'withdrawal', 'transfer', 'referral_reward'],
    required: true
  },
  amount: {
    type: Number,
    required: true,
    min: 1
  },
  description: {
    type: String,
    required: true,
    trim: true
  },
  category: {
    type: String,
    enum: [
      'wallet_funding',
      'admin_credit',
      'admin_debit',
      'ride_payment',        // Passenger paying for a ride (wallet debit)
      'ride_earning',        // Driver earning from a completed ride (wallet credit)
      'referral_reward',     // Referral bonus credited to referrer or referee
      'service_fee',
      'refund',
      'bonus',
      'penalty',
      'other'
    ],
    default: 'other'
  },
  status: {
    type: String,
    enum: ['pending', 'completed', 'failed', 'processing'],
    default: 'pending'
  },
  balanceBefore: {
    type: Number,
    default: 0
  },
  balanceAfter: {
    type: Number,
    default: 0
  },
  paymentGateway: {
    type: String,
    enum: ['paystack', 'flutterwave', 'stripe', null],
    default: null
  },
  paymentReference: {
    type: String,
    sparse: true
  },
  // Link transactions together (e.g. passenger debit ↔ driver credit for same trip)
  relatedTransactionId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'Transaction',
    default: null
  },
  metadata: {
    type: mongoose.Schema.Types.Mixed,
    default: {}
  },
  createdAt: {
    type: Date,
    default: Date.now
  },
  updatedAt: {
    type: Date,
    default: Date.now
  }
});

TransactionSchema.pre('save', function(next) {
  this.updatedAt = Date.now();
  next();
});

TransactionSchema.index({ userId: 1, createdAt: -1 });
TransactionSchema.index({ paymentReference: 1 }, { sparse: true });
TransactionSchema.index({ relatedTransactionId: 1 }, { sparse: true });

module.exports = mongoose.model('Transaction', TransactionSchema);