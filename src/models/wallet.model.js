const mongoose = require('mongoose');

const WalletSchema = new mongoose.Schema({
  owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true, unique: true },
  // amount stored in smallest currency unit (kobo for NGN)
  balance: { type: Number, default: 0 },
  currency: { type: String, default: 'NGN' },
  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Wallet', WalletSchema);
