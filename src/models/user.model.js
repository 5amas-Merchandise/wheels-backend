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
  // Business info
  yearsInOperation: { type: Number, default: 0 },
  fleetSize: { type: Number, default: 0 },
  description: { type: String },
  website: { type: String },
  // Bank account for payments
  bankAccount: {
    bankName: String,
    accountNumber: String,
    accountName: String
  },
  // Verification
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
  // Stats
  totalBookings: { type: Number, default: 0 },
  rating: { type: Number, default: 0, min: 0, max: 5 },
  totalReviews: { type: Number, default: 0 },
  // Account status
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
  
  // Authentication
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
  
  // Roles and Permissions
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
  emailVerified: {
    type: Boolean,
    default: false
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
  },
  
  // Device Info
  deviceInfo: {
    platform: String,
    os: String,
    browser: String,
    lastIpAddress: String,
    fcmToken: String // For push notifications
  },
  
  // Statistics
  stats: {
    totalTrips: { type: Number, default: 0 },
    totalBookings: { type: Number, default: 0 },
    totalSpent: { type: Number, default: 0 },
    joinedDate: { type: Date, default: Date.now }
  },
  
  // Wallet/Balance (optional - can be separate model)
  wallet: {
    balance: { type: Number, default: 0 },
    currency: { type: String, default: 'NGN' },
    lastUpdated: { type: Date, default: Date.now }
  }
}, {
  timestamps: true,
  toJSON: { virtuals: true },
  toObject: { virtuals: true }
});

// ==============================
// MIDDLEWARE
// ==============================

// Update timestamps on save
UserSchema.pre('save', function(next) {
  this.updatedAt = Date.now();
  next();
});

// Hash password before saving


// ==============================
// VIRTUAL PROPERTIES
// ==============================

// Full name virtual
UserSchema.virtual('fullName').get(function() {
  return this.name || 'User';
});

// User type virtual
UserSchema.virtual('userType').get(function() {
  if (this.roles.isAdmin) return 'admin';
  if (this.roles.isTransportCompany) return 'transport_company';
  if (this.roles.isDriver) return 'driver';
  if (this.roles.isUser) return 'user';
  return 'unknown';
});

// Formatted phone virtual
UserSchema.virtual('formattedPhone').get(function() {
  if (!this.phone) return '';
  // Format Nigerian phone numbers
  const phone = this.phone.replace(/\D/g, '');
  if (phone.startsWith('234') && phone.length === 13) {
    return `+${phone}`;
  } else if (phone.startsWith('0') && phone.length === 11) {
    return `+234${phone.slice(1)}`;
  }
  return this.phone;
});






// Update transport company stats
UserSchema.methods.updateCompanyStats = function(bookingsCount = 0, amount = 0) {
  if (!this.roles.isTransportCompany) return false;
  
  this.transportCompanyProfile.totalBookings += bookingsCount;
  // Add other stats updates as needed
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

// Additional indexes for better query performance
UserSchema.index({ 'roles.isDriver': 1 });
UserSchema.index({ 'roles.isTransportCompany': 1 });
UserSchema.index({ 'roles.isAdmin': 1 });
UserSchema.index({ 'driverProfile.isAvailable': 1 });
UserSchema.index({ 'driverProfile.lastSeen': -1 });
UserSchema.index({ 'driverProfile.verificationState': 1 });
UserSchema.index({ 'transportCompanyProfile.verificationStatus': 1 });
UserSchema.index({ phone: 1 }, { unique: true });
UserSchema.index({ email: 1 }, { sparse: true });
UserSchema.index({ 'subscription.expiresAt': 1 });
UserSchema.index({ 'subscription.type': 1 });
UserSchema.index({ isActive: 1 });
UserSchema.index({ createdAt: -1 });

// Text search index for names and company names
UserSchema.index({
  name: 'text',
  'transportCompanyProfile.companyName': 'text',
  'driverProfile.vehicleNumber': 'text'
});

// ==============================
// TO JSON TRANSFORM
// ==============================

UserSchema.set('toJSON', {
  virtuals: true,
  transform: function (doc, ret, options) {
    // Hide sensitive fields
    delete ret.password;
    delete ret.otpCode;
    delete ret.otpExpiresAt;
    delete ret.deviceInfo;
    
    // Format dates
    if (ret.createdAt) ret.createdAt = ret.createdAt.toISOString();
    if (ret.updatedAt) ret.updatedAt = ret.updatedAt.toISOString();
    if (ret.lastLogin) ret.lastLogin = ret.lastLogin.toISOString();
    
    return ret;
  }
});

module.exports = mongoose.model('User', UserSchema);