const mongoose = require('mongoose');

const PricingSchema = new mongoose.Schema({
  serviceType: { type: String, required: true, index: true },
  model: { type: String, enum: ['fixed', 'distance', 'rental', 'interstate'], required: true },
  // fixed model: baseFare (in kobo)
  baseFare: { type: Number },
  // distance model: baseFare + perKmRate (in kobo)
  perKmRate: { type: Number },
  // rental model: hourlyRate, dailyRate (in kobo)
  hourlyRate: { type: Number },
  dailyRate: { type: Number },
  // interstate: per-kilometer rate
  interstatePerKmRate: { type: Number },
  active: { type: Boolean, default: true },
  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Pricing', PricingSchema);
