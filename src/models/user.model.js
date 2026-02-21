const mongoose = require('mongoose');
const bcrypt = require('bcrypt');

// Subscription types
const SubscriptionTypes = ['daily', 'weekly', 'monthly', 'none'];

// Driver Profile Schema
const DriverProfileSchema = new mongoose.Schema({
  vehicleMake: { type: String },
  vehicleModel: { type: String },
  vehicleNumber: { type: String },
  vehicleColor: { type: String },
  vehicleYear: { type: Number },
  serviceCategories: [{ type: String }],
  verified: { type: Boolean, default: false },
  verificationState: {
    type: String,
    enum: ['pending', 'approved', 'rejected'],
    default: 'pending'
  },
  profilePicUrl: { type: String },
  carPicUrl: { type: String },
  nin: { type: String },
  ninImageUrl: { type: String },
  licenseNumber: { type: String },
  licenseImageUrl: { type: String },
  vehicleRegistrationUrl: { type: String },
  insuranceUrl: { type: String },
  roadWorthinessUrl: { type: String },
  isAvailable: { type: Boolean, default: true },
  location: {
    type: {
      type: String,
      enum: ['Point'],
      default: 'Point'
    },
    coordinates: {
      type: [Number],
      default: [0, 0]
    }
  },
  lastSeen: { type: Date },
  currentTripId: { type: mongoose.Schema.Types.ObjectId, ref: 'Trip' },
  totalTrips: { type: Number, default: 0 },
  totalEarnings: { type: Number, default: 0 },
  rating: { type: Number, default: 0, min: 0, max: 5 },
  totalReviews: { type: Number, default: 0 },
  driverLicenseClass: { type: String },
  yearsOfExperience: { type: Number, default: 0 }
}, { _id: false });

// Transport Company Profile Schema
const TransportCompanyProfileSchema = new mongoose.Schema({
  companyName: { type: String },
  companyRcNumber: { type: String },
  companyLogo: { type: String },
  companyPhone: { type: String },
  companyEmail: { type: String },
  companyAddress: {
    street: String,
    city: String,
    state: String
  },
  contactPerson: {
    name: String,
    phone: String,
    email: String
  },
  yearsInOperation: { type: Number, default: 0 },
  fleetSize: { type: Number, default: 0 },
  description: { type: String },
  website: { type: String },
  verified: { type: Boolean, default: false },
  verificationStatus: {
    type: String,
    enum: ['pending', 'approved', 'rejected'],
    default: 'pending'
  },
  verificationDocuments: {
    rcCertificate: { type: String },
    taxCertificate: { type: String },
    insuranceCertificate: { type: String }
  },
  totalBookings: { type: Number, default: 0 },
  rating: { type: Number, default: 0, min: 0, max: 5 },
  totalReviews: { type: Number, default: 0 }
}, { _id: false });

// Main User Schema
const UserSchema = new mongoose.Schema({
  name: {
    type: String,
    required: false,
    trim: true
  },
  email: {
    type: String,
    sparse: true,
    unique: false,
    lowercase: true,
    trim: true
  },
  phone: {
    type: String,
    required: true,
    unique: true,
    index: true,
    trim: true
  },

  passwordHash: {
    type: String,
    required: true,
    select: false
  },
  profilePicUrl: {
    type: String,
    default: null
  },

  // Roles
  roles: {
    isUser: { type: Boolean, default: true },
    isDriver: { type: Boolean, default: false },
    isTransportCompany: { type: Boolean, default: false },
    isAdmin: { type: Boolean, default: false }
  },

  // Profiles
  driverProfile: {
    type: DriverProfileSchema,
    default: () => ({})
  },

  transportCompanyProfile: {
    type: TransportCompanyProfileSchema,
    default: () => ({})
  },

  // Subscription
  subscription: {
    type: {
      type: String,
      enum: SubscriptionTypes,
      default: 'none'
    },
    startedAt: { type: Date },
    expiresAt: { type: Date },
    autoRenew: { type: Boolean, default: false }
  },

  // ==========================================
  // REFERRAL FIELDS
  // ==========================================

  // This user's own shareable code
  referralCode: {
    type: String,
    unique: true,
    sparse: true, // allows null/undefined without unique conflict
    uppercase: true,
    trim: true,
    index: true
  },

  // The code this user used when signing up (if any)
  usedReferralCode: {
    type: String,
    uppercase: true,
    trim: true,
    default: null
  },

  // Whether this user's first trip has been completed
  // Used to ensure referral reward fires only once
  hasCompletedFirstTrip: {
    type: Boolean,
    default: false
  },

  // ==========================================
  // OTP
  // ==========================================
  otpCode: {
    type: String,
    select: false
  },
  otpExpiresAt: {
    type: Date,
    select: false
  },

  // Account Status
  isActive: {
    type: Boolean,
    default: true
  },
  phoneVerified: {
    type: Boolean,
    default: false
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
  lastLogin: {
    type: Date,
    default: null
  },

  // Preferences
  preferences: {
    language: { type: String, default: 'en' },
    currency: { type: String, default: 'NGN' },
    notifications: {
      email: { type: Boolean, default: true },
      sms: { type: Boolean, default: true },
      push: { type: Boolean, default: true }
    }
  }
  // NOTE: Wallet field has been removed - use separate Wallet model
}, {
  timestamps: true
});

// ==============================
// MIDDLEWARE
// ==============================

UserSchema.pre('save', function(next) {
  this.updatedAt = Date.now();
  next();
});

// ==============================
// INSTANCE METHODS
// ==============================

UserSchema.methods.comparePassword = async function(candidatePassword) {
  try {
    return await bcrypt.compare(candidatePassword, this.passwordHash);
  } catch (error) {
    return false;
  }
};

// ==============================
// STATIC METHODS
// ==============================

UserSchema.statics.findTransportCompanies = function(verificationStatus = 'approved') {
  return this.find({
    'roles.isTransportCompany': true,
    'isActive': true,
    'transportCompanyProfile.verificationStatus': verificationStatus
  }).sort({ 'transportCompanyProfile.totalBookings': -1 });
};

UserSchema.statics.findByEmailOrPhone = function(email, phone) {
  const query = {};
  if (email) query.email = email.toLowerCase();
  if (phone) query.phone = phone;
  return this.findOne(query);
};

// ==============================
// INDEXES
// ==============================

UserSchema.index({ 'driverProfile.location': '2dsphere' });
UserSchema.index({ 'roles.isDriver': 1 });
UserSchema.index({ 'roles.isTransportCompany': 1 });
UserSchema.index({ 'driverProfile.isAvailable': 1 });
UserSchema.index({ 'driverProfile.lastSeen': -1 });
UserSchema.index({ 'driverProfile.verificationState': 1 });
UserSchema.index({ phone: 1 }, { unique: true });
UserSchema.index({ email: 1 }, { sparse: true });
UserSchema.index({ referralCode: 1 }, { sparse: true });

// ==============================
// TO JSON TRANSFORM
// ==============================

UserSchema.set('toJSON', {
  transform: function(doc, ret) {
    delete ret.passwordHash;
    delete ret.otpCode;
    delete ret.otpExpiresAt;
    delete ret.__v;
    return ret;
  }
});

module.exports = mongoose.model('User', UserSchema);