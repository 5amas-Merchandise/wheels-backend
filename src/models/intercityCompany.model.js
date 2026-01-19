const mongoose = require('mongoose');

const intercityCompanySchema = new mongoose.Schema({
  userId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    unique: true
  },
  companyName: {
    type: String,
    required: true,
    trim: true
  },
  companyLogo: {
    type: String, // URL to logo
    default: null
  },
  rcNumber: {
    type: String, // Registration/Corporate number
    required: true,
    unique: true
  },
  contactEmail: {
    type: String,
    required: true,
    lowercase: true,
    trim: true
  },
  contactPhone: {
    type: String,
    required: true,
    trim: true
  },
  address: {
    street: String,
    city: String,
    state: String
  },
  verified: {
    type: Boolean,
    default: false
  },
  verificationStatus: {
    type: String,
    enum: ['pending', 'approved', 'rejected'],
    default: 'pending'
  },
  isActive: {
    type: Boolean,
    default: true
  },
  totalBookings: {
    type: Number,
    default: 0
  },
  rating: {
    type: Number,
    default: 0,
    min: 0,
    max: 5
  },
  totalReviews: {
    type: Number,
    default: 0
  },
  // New fields for enhanced company info
  description: {
    type: String,
    default: ''
  },
  website: {
    type: String,
    default: null
  },
  yearsInOperation: {
    type: Number,
    default: 0
  },
  fleetSize: {
    type: Number,
    default: 0
  },
  // Account status
  accountStatus: {
    type: String,
    enum: ['active', 'suspended', 'deactivated'],
    default: 'active'
  },
  // Payment info (for receiving payments)
  bankAccount: {
    bankName: String,
    accountNumber: String,
    accountName: String
  }
}, {
  timestamps: true
});

// Index for faster queries
intercityCompanySchema.index({ userId: 1 });
intercityCompanySchema.index({ verificationStatus: 1, isActive: 1 });
intercityCompanySchema.index({ companyName: 'text', description: 'text' });

// Virtual for formatted phone
intercityCompanySchema.virtual('formattedPhone').get(function() {
  return this.contactPhone.startsWith('+') ? this.contactPhone : `+${this.contactPhone}`;
});

// Method to update rating
intercityCompanySchema.methods.updateRating = function(newRating) {
  const totalScore = (this.rating * this.totalReviews) + newRating;
  this.totalReviews += 1;
  this.rating = totalScore / this.totalReviews;
  return this.save();
};

// Pre-save validation
intercityCompanySchema.pre('save', function(next) {
  // Ensure email is lowercase
  if (this.contactEmail) {
    this.contactEmail = this.contactEmail.toLowerCase();
  }
  
  // Validate RC number format (optional)
  if (this.rcNumber && !this.rcNumber.match(/^RC-\d{6}$/i)) {
    // You can add more strict validation here
    console.warn(`RC number ${this.rcNumber} doesn't match expected format RC-XXXXXX`);
  }
  
  next();
});

module.exports = mongoose.model('IntercityCompany', intercityCompanySchema);