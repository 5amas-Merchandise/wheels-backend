// routes/auth.js
const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const mongoose = require('mongoose');

const User = require('../models/user.model');
const Wallet = require('../models/wallet.model');
const Referral = require('../models/referral.model');
const { signUser } = require('../utils/jwt');
const { authLimiter } = require('../middleware/rateLimiter');
const { validatePhone, validateEmail } = require('../middleware/validation');
const db = require('../db/mongoose');
const { sendOTP } = require('../utils/email');

function generateOtp() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

// ==========================================
// REFERRAL CODE GENERATOR
// ==========================================

const REFERRAL_CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

async function generateUniqueReferralCode(name = '') {
  // First 3 chars from name (letters only), rest random
  const prefix = (name || '')
    .toUpperCase()
    .replace(/[^A-Z]/g, '')
    .slice(0, 3)
    .padEnd(3, REFERRAL_CODE_CHARS[Math.floor(Math.random() * REFERRAL_CODE_CHARS.length)]);

  for (let attempt = 0; attempt < 10; attempt++) {
    let suffix = '';
    for (let i = 0; i < 5; i++) {
      suffix += REFERRAL_CODE_CHARS[Math.floor(Math.random() * REFERRAL_CODE_CHARS.length)];
    }
    const code = prefix + suffix;
    const exists = await User.findOne({ referralCode: code }).lean();
    if (!exists) return code;
  }

  // Pure fallback
  let fallback = '';
  for (let i = 0; i < 8; i++) {
    fallback += REFERRAL_CODE_CHARS[Math.floor(Math.random() * REFERRAL_CODE_CHARS.length)];
  }
  return fallback;
}

// ==========================================
// RECORD REFERRAL (called after user creation)
// ==========================================

async function recordReferral(newUserId, referralCode) {
  if (!referralCode) return;

  try {
    // Find the referrer by their code only — no isActive check.
    // Everyone gets their reward regardless of account status.
    const referrer = await User.findOne({
      referralCode: referralCode.toUpperCase().trim()
    }).lean();

    if (!referrer) {
      console.log(`⚠️ Referral code ${referralCode} not found`);
      return;
    }

    // Prevent self-referral
    if (referrer._id.toString() === newUserId.toString()) {
      console.log(`⚠️ Self-referral attempt blocked for user ${newUserId}`);
      return;
    }

    // Create the referral record
    await Referral.create({
      referrerId: referrer._id,
      refereeId: newUserId,
      code: referralCode.toUpperCase().trim(),
      referrerReward: 50000, // ₦500
      refereeReward: 30000   // ₦300
    });

    console.log(`🎯 Referral recorded: referrer=${referrer._id}, referee=${newUserId}`);
  } catch (err) {
    if (err.code === 11000) {
      // Unique constraint: this user was already referred — harmless
      console.log(`ℹ️ User ${newUserId} was already referred, skipping`);
    } else {
      console.error('❌ Error recording referral:', err.message);
    }
  }
}

// ==========================================
// POST /auth/request-otp
// ==========================================

router.post('/request-otp', authLimiter, async (req, res, next) => {
  try {
    await db.connect();

    const { phone, name, email } = req.body;

    if (!phone && !email) {
      return res.status(400).json({ error: { message: 'phone or email is required' } });
    }

    if (phone && !validatePhone(phone)) {
      return res.status(400).json({ error: { message: 'Invalid phone format' } });
    }

    let user = null;
    if (phone) user = await User.findOne({ phone });
    if (!user && email) user = await User.findOne({ email });

    if (user && !user.isActive) {
      return res.status(403).json({
        error: { message: 'This account has been suspended. Please contact support.' }
      });
    }

    if (!user) {
      const tempPassword = Math.random().toString(36).slice(-8);
      const passwordHash = await bcrypt.hash(tempPassword, 10);

      // Generate referral code for new user
      const referralCode = await generateUniqueReferralCode(name || '');

      user = new User({
        phone,
        name,
        email,
        passwordHash,
        referralCode
      });
    }

    const code = generateOtp();
    user.otpCode = code;
    user.otpExpiresAt = new Date(Date.now() + 10 * 60 * 1000);

    await user.save();

    try {
      await Wallet.create({ owner: user._id, balance: 0 });
    } catch (e) {
      // Ignore duplicate wallet
    }

    if (email) {
      try {
        await sendOTP(email, code);
        return res.json({ ok: true, message: 'OTP sent to email' });
      } catch (e) {
        console.error('Failed to send OTP email:', e.message);
        return res.status(500).json({ error: { message: 'Failed to send OTP email' } });
      }
    }

    console.log(`Mock OTP for ${phone}: ${code}`);
    return res.json({ ok: true, message: 'OTP generated' });
  } catch (err) {
    next(err);
  }
});

// ==========================================
// POST /auth/verify-otp
// ==========================================

router.post('/verify-otp', authLimiter, async (req, res, next) => {
  try {
    await db.connect();

    const { phone, email, code } = req.body;

    if (!code || (!phone && !email)) {
      return res.status(400).json({ error: { message: 'phone or email and code are required' } });
    }

    let user = null;
    if (phone) {
      if (!validatePhone(phone)) {
        return res.status(400).json({ error: { message: 'Invalid phone format' } });
      }
      user = await User.findOne({ phone });
    } else if (email) {
      if (!validateEmail(email)) {
        return res.status(400).json({ error: { message: 'Invalid email format' } });
      }
      user = await User.findOne({ email });
    }

    if (!user) {
      return res.status(400).json({ error: { message: 'User not found' } });
    }

    if (!user.isActive) {
      return res.status(403).json({
        error: { message: 'This account has been suspended. Please contact support.' }
      });
    }

    if (!user.otpCode || !user.otpExpiresAt) {
      return res.status(400).json({ error: { message: 'No OTP requested' } });
    }

    if (new Date() > user.otpExpiresAt) {
      return res.status(400).json({ error: { message: 'OTP expired' } });
    }

    if (user.otpCode !== code) {
      return res.status(400).json({ error: { message: 'Invalid OTP' } });
    }

    user.otpCode = undefined;
    user.otpExpiresAt = undefined;
    user.phoneVerified = true;

    await user.save();

    const token = signUser(user);
    return res.json({ token, user: user.toJSON() });
  } catch (err) {
    next(err);
  }
});

// ==========================================
// POST /auth/signup
// ==========================================

router.post('/signup', authLimiter, async (req, res, next) => {
  try {
    await db.connect();

    const { name, phone, email, password, role, driverProfile, referralCode } = req.body;

    if (!password) {
      return res.status(400).json({ error: { message: 'password is required' } });
    }

    if (!phone && !email) {
      return res.status(400).json({ error: { message: 'phone or email is required' } });
    }

    if (phone && !validatePhone(phone)) {
      return res.status(400).json({ error: { message: 'Invalid phone format' } });
    }

    // Check for duplicates
    if (phone) {
      const existing = await User.findOne({ phone });
      if (existing) {
        if (!existing.isActive) {
          return res.status(403).json({
            error: { message: 'This phone number is associated with a suspended account. Please contact support.' }
          });
        }
        return res.status(400).json({ error: { message: 'phone already in use' } });
      }
    }

    if (email) {
      const existing = await User.findOne({ email });
      if (existing) {
        if (!existing.isActive) {
          return res.status(403).json({
            error: { message: 'This email is associated with a suspended account. Please contact support.' }
          });
        }
        return res.status(400).json({ error: { message: 'email already in use' } });
      }
    }

    // Validate referral code — no isActive check.
    // Codes belonging to any user (active or suspended) are valid
    // and everyone gets their reward.
    if (referralCode) {
      const referrer = await User.findOne({
        referralCode: referralCode.toUpperCase().trim()
      }).lean();

      if (!referrer) {
        return res.status(400).json({ error: { message: 'Invalid referral code' } });
      }
    }

    const passwordHash = await bcrypt.hash(password, 10);

    // Generate this user's own referral code
    const newReferralCode = await generateUniqueReferralCode(name || '');

    const user = new User({
      name,
      phone,
      email,
      passwordHash,
      referralCode: newReferralCode,
      // Store which code they used (for audit/display)
      usedReferralCode: referralCode ? referralCode.toUpperCase().trim() : null
    });

    // Set roles
    if (role === 'driver') {
      user.roles = { isUser: false, isDriver: true, isTransportCompany: false, isAdmin: false };
      if (driverProfile && typeof driverProfile === 'object') {
        user.driverProfile = driverProfile;
      }
    } else if (role === 'transport_company') {
      user.roles = { isUser: false, isDriver: false, isTransportCompany: true, isAdmin: false };
    } else {
      user.roles = { isUser: true, isDriver: false, isTransportCompany: false, isAdmin: false };
    }

    await user.save();

    // Create wallet
    try {
      await Wallet.create({ owner: user._id, balance: 0 });
    } catch (e) {
      // Ignore duplicate wallet
    }

    // Record referral relationship (non-blocking — won't fail signup)
    if (referralCode) {
      await recordReferral(user._id, referralCode);
    }

    const token = signUser(user);
    return res.status(201).json({ token, user: user.toJSON() });
  } catch (err) {
    next(err);
  }
});

// ==========================================
// POST /auth/login
// ==========================================

router.post('/login', authLimiter, async (req, res, next) => {
  try {
    await db.connect();

    const { identifier, password } = req.body;

    if (!identifier || !password) {
      return res.status(400).json({ error: { message: 'identifier and password required' } });
    }

    const query = validatePhone(identifier)
      ? { phone: identifier }
      : { email: identifier.toLowerCase() };

    const user = await User.findOne(query).select('+passwordHash');

    if (!user || !user.passwordHash) {
      return res.status(400).json({ error: { message: 'Invalid credentials' } });
    }

    if (!user.isActive) {
      return res.status(403).json({
        error: { message: 'This account has been suspended. Please contact support.' }
      });
    }

    const isMatch = await bcrypt.compare(password, user.passwordHash);
    if (!isMatch) {
      return res.status(400).json({ error: { message: 'Invalid credentials' } });
    }

    user.lastLogin = new Date();
    await user.save();

    const token = signUser(user);
    return res.json({ token, user: user.toJSON() });
  } catch (err) {
    next(err);
  }
});

// ==========================================
// ACCOUNT MANAGEMENT ROUTES
// ==========================================

router.delete('/delete-account', authLimiter, async (req, res, next) => {
  try {
    await db.connect();

    const { userId, phone, email, reason, adminOverride } = req.body;

    if (!userId && !phone && !email) {
      return res.status(400).json({ error: { message: 'userId, phone, or email is required' } });
    }

    let user = null;
    if (userId) user = await User.findById(userId);
    else if (phone) user = await User.findOne({ phone });
    else if (email) user = await User.findOne({ email: email.toLowerCase() });

    if (!user) {
      return res.status(404).json({ error: { message: 'User not found' } });
    }

    if (!user.isActive) {
      return res.status(400).json({ error: { message: 'Account is already suspended' } });
    }

    if (user.roles?.isDriver) {
      const Ride = require('../models/ride.model');
      const activeRides = await Ride.find({
        driver: user._id,
        status: { $in: ['accepted', 'picked_up', 'ongoing'] }
      });

      if (activeRides.length > 0 && !adminOverride) {
        return res.status(400).json({
          error: { message: 'Cannot suspend account while having active rides. Please complete or cancel all rides first.' }
        });
      }

      const wallet = await Wallet.findOne({ owner: user._id });
      if (wallet && wallet.balance > 0 && !adminOverride) {
        return res.status(400).json({
          error: { message: 'Please withdraw your remaining balance before suspending your account.' }
        });
      }

      user.driverProfile.isAvailable = false;
      user.driverProfile.lastSeen = new Date();
    }

    user.isActive = false;
    user.suspendedAt = new Date();
    user.suspensionReason = reason || 'User requested account deletion';
    user.suspendedBy = 'self';
    user.otpCode = undefined;
    user.otpExpiresAt = undefined;

    const timestamp = Date.now();
    user.phone = `suspended_${timestamp}_${user.phone}`;
    if (user.email) {
      user.email = `suspended_${timestamp}_${user.email}`;
    }

    await user.save();

    return res.json({
      ok: true,
      message: 'Account has been suspended successfully',
      details: {
        userId: user._id,
        suspendedAt: user.suspendedAt,
        canReactivate: true,
        note: 'Phone and email have been marked as suspended and cannot be used for new registrations.'
      }
    });
  } catch (err) {
    console.error('Error suspending account:', err);
    next(err);
  }
});

router.post('/reactivate-account', authLimiter, async (req, res, next) => {
  try {
    await db.connect();

    const { userId, phone, email } = req.body;

    if (!userId && !phone && !email) {
      return res.status(400).json({ error: { message: 'userId, phone, or email is required' } });
    }

    let user = null;
    if (userId) user = await User.findById(userId);
    else if (phone) user = await User.findOne({ phone: new RegExp(`^suspended_.*_${phone}$`) });
    else if (email) user = await User.findOne({ email: new RegExp(`^suspended_.*_${email}$`) });

    if (!user) {
      return res.status(404).json({ error: { message: 'Suspended account not found' } });
    }

    if (user.isActive) {
      return res.status(400).json({ error: { message: 'Account is already active' } });
    }

    const phoneMatch = user.phone.match(/^suspended_\d+_(.+)$/);
    const emailMatch = user.email ? user.email.match(/^suspended_\d+_(.+)$/) : null;

    if (phoneMatch) user.phone = phoneMatch[1];
    if (emailMatch) user.email = emailMatch[1];

    user.isActive = true;
    user.suspendedAt = undefined;
    user.suspensionReason = undefined;
    user.suspendedBy = undefined;
    user.reactivatedAt = new Date();

    await user.save();

    return res.json({
      ok: true,
      message: 'Account has been reactivated successfully',
      details: {
        userId: user._id,
        reactivatedAt: user.reactivatedAt,
        phone: user.phone,
        email: user.email
      }
    });
  } catch (err) {
    console.error('Error reactivating account:', err);
    next(err);
  }
});

router.get('/account-status', authLimiter, async (req, res, next) => {
  try {
    await db.connect();

    const { userId, phone, email } = req.query;

    if (!userId && !phone && !email) {
      return res.status(400).json({ error: { message: 'userId, phone, or email is required' } });
    }

    let user = null;
    if (userId) {
      user = await User.findById(userId);
    } else if (phone) {
      user = await User.findOne({
        $or: [{ phone: phone }, { phone: new RegExp(`^suspended_.*_${phone}$`) }]
      });
    } else if (email) {
      user = await User.findOne({
        $or: [{ email: email.toLowerCase() }, { email: new RegExp(`^suspended_.*_${email.toLowerCase()}$`) }]
      });
    }

    if (!user) {
      return res.status(404).json({ error: { message: 'Account not found' } });
    }

    return res.json({
      ok: true,
      status: user.isActive ? 'active' : 'suspended',
      details: {
        userId: user._id,
        phone: user.phone.replace(/^suspended_\d+_/, ''),
        email: user.email ? user.email.replace(/^suspended_\d+_/, '') : null,
        roles: user.roles,
        isActive: user.isActive,
        suspendedAt: user.suspendedAt,
        suspensionReason: user.suspensionReason,
        createdAt: user.createdAt,
        lastLogin: user.lastLogin
      }
    });
  } catch (err) {
    console.error('Error checking account status:', err);
    next(err);
  }
});

module.exports = router;