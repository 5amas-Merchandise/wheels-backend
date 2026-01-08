const mongoose = require('mongoose');

const TransactionSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  type: { type: String, enum: ['topup','trip_payment','commission','payout','subscription'], required: true },
  amount: { type: Number, required: true },
  currency: { type: String, default: 'NGN' },
  reference: { type: String, index: true },
  status: { type: String, enum: ['pending','success','failed'], default: 'pending' },
  meta: { type: Object },
  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Transaction', TransactionSchema);
