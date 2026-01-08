// models/user.model.js
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
profilePicUrl: { type: String }, // Cloudinary URL
carPicUrl: { type: String }, // Cloudinary URL
nin: { type: String }, // NIN number
ninImageUrl: { type: String }, // Cloudinary URL for NIN image
licenseNumber: { type: String }, // Driver's license number
licenseImageUrl: { type: String }, // Cloudinary URL for license image
vehicleRegistrationUrl: { type: String }, // Cloudinary URL for vehicle registration
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
// Profile picture at user level (for both users and drivers)
profilePicUrl: { type: String },
roles: {
isUser: { type: Boolean, default: true },
isDriver: { type: Boolean, default: false },
isAdmin: { type: Boolean, default: false }
  },
// driver-specific nested profile
driverProfile: {
type: DriverProfileSchema,
default: () => ({})
  },
// subscription for non-luxury drivers
subscription: {
type: {
type: String,
enum: SubscriptionTypes,
default: 'none'
    },
startedAt: { type: Date },
expiresAt: { type: Date }
  },
// OTP fields for phone auth
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
// 2dsphere index for driver location
UserSchema.index({ 'driverProfile.location': '2dsphere' });
module.exports = mongoose.model('User', UserSchema);