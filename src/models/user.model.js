const mongoose = require('mongoose');

const SubscriptionTypes = ['daily', 'weekly', 'monthly', 'none'];

const DriverProfileSchema = new mongoose.Schema({
  vehicleMake: { type: String },
  vehicleModel: { type: String },
  vehicleNumber: { type: String },
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
  currentTripId: { type: mongoose.Schema.Types.ObjectId, ref: 'Trip' }
}, { _id: false });

const UserSchema = new mongoose.Schema({
  name: {
    type: String,
    required: false
  },
  email: {
    type: String,
    sparse: true,
    unique: false
  },
  phone: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  passwordHash: {
    type: String,
    required: true
  },
  profilePicUrl: { type: String },
  roles: {
    isUser: { type: Boolean, default: true },
    isDriver: { type: Boolean, default: false },
    isAdmin: { type: Boolean, default: false }
  },
  driverProfile: {
    type: DriverProfileSchema,
    default: () => ({})
  },
  subscription: {
    type: {
      type: String,
      enum: SubscriptionTypes,
      default: 'none'
    },
    startedAt: { type: Date },
    expiresAt: { type: Date }
  },
  otpCode: { type: String },
  otpExpiresAt: { type: Date },
  createdAt: {
    type: Date,
    default: Date.now
  },
  updatedAt: {
    type: Date,
    default: Date.now
  }
});

// Update timestamps on save
UserSchema.pre('save', function(next) {
  this.updatedAt = Date.now();
  next();
});

// Hide sensitive fields
UserSchema.set('toJSON', {
  transform: function (doc, ret, options) {
    delete ret.passwordHash;
    delete ret.otpCode;
    delete ret.otpExpiresAt;
    return ret;
  }
});

// ✅ FIX 4: 2dsphere index for driver location
UserSchema.index({ 'driverProfile.location': '2dsphere' });

// ✅ Additional indexes for better query performance
UserSchema.index({ 'roles.isDriver': 1 });
UserSchema.index({ 'driverProfile.isAvailable': 1 });
UserSchema.index({ 'driverProfile.lastSeen': -1 });
UserSchema.index({ 'driverProfile.verificationState': 1 });

module.exports = mongoose.model('User', UserSchema);