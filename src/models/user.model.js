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
  // Onboarding/verification fields
  profilePicUrl: { type: String },
  carPicUrl: { type: String },
  nin: { type: String },
  ninImageUrl: { type: String },
  licenseNumber: { type: String },
  licenseImageUrl: { type: String },
  vehicleRegistrationUrl: { type: String },
  insuranceUrl: { type: String },
  roadWorthinessUrl: { type: String },
  // availability & location for matching
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
  // Driver stats
  totalTrips: { type: Number, default: 0 },
  totalEarnings: { type: Number, default: 0 },
  rating: { type: Number, default: 0, min: 0, max: 5 },
  totalReviews: { type: Number, default: 0 },
  // Additional driver info
  driverLicenseClass: { type: String },
  yearsOfExperience: { type: Number, default: 0 },
  preferredAreas: [{ type: String }],
  onlineHours: {
    start: { type: String, default: '08:00' },
    end: { type: String, default: '20:00' }
  }
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
  bankAccount: {
    bankName: String,
    accountNumber: String,
    accountName: String
  },
  verified: { type: Boolean, default: false },
  verificationStatus: {
    type: String,
    enum: ['pending', 'approved', 'rejected'],
    default: 'pending'
  },
  verificationDocuments: {
    rcCertificate: { type: String },
    taxCertificate: { type: String },
    insuranceCertificate: { type: String },
    otherDocuments: [{ type: String }]
  },
  totalBookings: { type: Number, default: 0 },
  rating: { type: Number, default: 0, min: 0, max: 5 },
  totalReviews: { type: Number, default: 0 },
  accountStatus: {
    type: String,
    enum: ['active', 'suspended', 'deactivated'],
    default: 'active'
  }
}, { _id: false });

// Main User Schema
const UserSchema = new mongoose.Schema({
  // Basic Info
  name: {
    type: String,
    trim: true
  },
  email: {
    type: String,
    sparse: true,
    lowercase: true,
    trim: true
  },
  phone: {
    type: String,
    required: true,
    unique: true,
    trim: true
  },
  
  // Authentication - FIXED: Single password field
  password: {
    type: String,
    required: true,
    minlength: 6,
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
    isAdmin: { type: Boolean, default: false },
    isAgent: { type: Boolean, default: false }
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
    autoRenew: { type: Boolean, default: false },
    paymentMethod: { type: String }
  },
  
  // OTP for phone verification
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
  },
  
  // Device Info
  deviceInfo: {
    fcmToken: String
  },
  
  // Wallet
  wallet: {
    balance: { type: Number, default: 0 },
    currency: { type: String, default: 'NGN' }
  }
}, {
  timestamps: true,
  toJSON: { virtuals: true },
  toObject: { virtuals: true }
});

// ==============================
// MIDDLEWARE
// ==============================

// Hash password before saving
UserSchema.pre('save', async function(next) {
  if (!this.isModified('password')) return next();
  
  try {
    const salt = await bcrypt.genSalt(10);
    this.password = await bcrypt.hash(this.password, salt);
    next();
  } catch (error) {
    next(error);
  }
});

// ==============================
// INSTANCE METHODS
// ==============================

// Compare password
UserSchema.methods.comparePassword = async function(candidatePassword) {
  try {
    return await bcrypt.compare(candidatePassword, this.password);
  } catch (error) {
    return false;
  }
};

// Update company stats
UserSchema.methods.updateCompanyStats = function(bookingsCount = 0) {
  if (!this.roles.isTransportCompany) return false;
  
  this.transportCompanyProfile.totalBookings += bookingsCount;
  return this.save();
};

// ==============================
// STATIC METHODS
// ==============================

// Find transport companies by verification status
UserSchema.statics.findTransportCompanies = function(verificationStatus = 'approved') {
  return this.find({
    'roles.isTransportCompany': true,
    'isActive': true,
    'transportCompanyProfile.verificationStatus': verificationStatus
  }).sort({ 'transportCompanyProfile.totalBookings': -1 });
};

// Find by email or phone
UserSchema.statics.findByEmailOrPhone = function(email, phone) {
  const query = {};
  if (email) query.email = email.toLowerCase();
  if (phone) query.phone = phone;
  
  return this.findOne(query);
};

// ==============================
// INDEXES
// ==============================

// 2dsphere index for driver location
UserSchema.index({ 'driverProfile.location': '2dsphere' });

// Performance indexes
UserSchema.index({ 'roles.isDriver': 1 });
UserSchema.index({ 'roles.isTransportCompany': 1 });
UserSchema.index({ 'driverProfile.isAvailable': 1 });
UserSchema.index({ phone: 1 }, { unique: true });
UserSchema.index({ email: 1 }, { sparse: true });

// ==============================
// TO JSON TRANSFORM
// ==============================

UserSchema.set('toJSON', {
  virtuals: true,
  transform: function (doc, ret) {
    // Hide sensitive fields
    delete ret.password;
    delete ret.otpCode;
    delete ret.otpExpiresAt;
    delete ret.__v;
    
    return ret;
  }
});

module.exports = mongoose.model('User', UserSchema);