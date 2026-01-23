// routes/auth.js
const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');
const mongoose = require('mongoose');

const User = require('../models/user.model');
const Wallet = require('../models/wallet.model');
const { signUser } = require('../utils/jwt');
const { authLimiter } = require('../middleware/rateLimiter');
const { validatePhone, validateEmail } = require('../middleware/validation');
const db = require('../db/mongoose');
const { sendOTP } = require('../utils/email');

function generateOtp() {
  return Math.floor(100000 + Math.random() * 900000).toString();
}

// Request OTP
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

    // Find existing user (including suspended accounts)
    let user = null;
    if (phone) user = await User.findOne({ phone });
    if (!user && email) user = await User.findOne({ email });

    // Check if account is suspended
    if (user && !user.isActive) {
      return res.status(403).json({ 
        error: { 
          message: 'This account has been suspended. Please contact support.' 
        } 
      });
    }

    // Create new user if not found
    if (!user) {
      const tempPassword = Math.random().toString(36).slice(-8);
      const passwordHash = await bcrypt.hash(tempPassword, 10);
      user = new User({ 
        phone, 
        name, 
        email,
        passwordHash
      });
    }

    const code = generateOtp();
    user.otpCode = code;
    user.otpExpiresAt = new Date(Date.now() + 10 * 60 * 1000);

    await user.save();

    // Ensure wallet exists
    try {
      await Wallet.create({ owner: user._id, balance: 0 });
    } catch (e) {
      // Ignore duplicate wallet
    }

    // Send OTP via email if provided
    if (email) {
      try {
        await sendOTP(email, code);
        return res.json({ ok: true, message: 'OTP sent to email' });
      } catch (e) {
        console.error('Failed to send OTP email:', e.message);
        return res.status(500).json({ error: { message: 'Failed to send OTP email' } });
      }
    }

    // Fallback: log OTP
    console.log(`Mock OTP for ${phone}: ${code}`);
    return res.json({ ok: true, message: 'OTP generated' });
  } catch (err) {
    next(err);
  }
});

// Verify OTP
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
    
    // Check if account is suspended
    if (!user.isActive) {
      return res.status(403).json({ 
        error: { 
          message: 'This account has been suspended. Please contact support.' 
        } 
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

    // Clear OTP
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

// Signup with email/password or phone/password
router.post('/signup', authLimiter, async (req, res, next) => {
  try {
    await db.connect();

    const { name, phone, email, password, role, driverProfile } = req.body;

    if (!password) {
      return res.status(400).json({ error: { message: 'password is required' } });
    }

    if (!phone && !email) {
      return res.status(400).json({ error: { message: 'phone or email is required' } });
    }

    if (phone && !validatePhone(phone)) {
      return res.status(400).json({ error: { message: 'Invalid phone format' } });
    }

    // Check for duplicates (including suspended accounts)
    if (phone) {
      const existing = await User.findOne({ phone });
      if (existing) {
        // Check if the account is suspended
        if (!existing.isActive) {
          return res.status(403).json({ 
            error: { 
              message: 'This phone number is associated with a suspended account. Please contact support.' 
            } 
          });
        }
        return res.status(400).json({ error: { message: 'phone already in use' } });
      }
    }
    
    if (email) {
      const existing = await User.findOne({ email });
      if (existing) {
        // Check if the account is suspended
        if (!existing.isActive) {
          return res.status(403).json({ 
            error: { 
              message: 'This email is associated with a suspended account. Please contact support.' 
            } 
          });
        }
        return res.status(400).json({ error: { message: 'email already in use' } });
      }
    }

    // Hash password
    const passwordHash = await bcrypt.hash(password, 10);
    
    // Create user
    const user = new User({ 
      name, 
      phone, 
      email, 
      passwordHash
    });

    // Set roles based on role parameter
    if (role === 'driver') {
      user.roles = { 
        isUser: false, 
        isDriver: true, 
        isTransportCompany: false,
        isAdmin: false
      };
      if (driverProfile && typeof driverProfile === 'object') {
        user.driverProfile = driverProfile;
      }
    } else if (role === 'transport_company') {
      user.roles = { 
        isUser: false, 
        isDriver: false, 
        isTransportCompany: true,
        isAdmin: false
      };
    } else {
      // Default to regular user
      user.roles = { 
        isUser: true, 
        isDriver: false, 
        isTransportCompany: false,
        isAdmin: false
      };
    }

    await user.save();

    // Create wallet
    try {
      await Wallet.create({ owner: user._id, balance: 0 });
    } catch (e) {
      // Ignore duplicate wallet
    }

    const token = signUser(user);
    return res.status(201).json({ token, user: user.toJSON() });
  } catch (err) {
    next(err);
  }
});

// Login with phone or email + password
router.post('/login', authLimiter, async (req, res, next) => {
  try {
    await db.connect();

    const { identifier, password } = req.body;

    if (!identifier || !password) {
      return res.status(400).json({ error: { message: 'identifier and password required' } });
    }

    // Determine if identifier is phone or email
    const query = validatePhone(identifier) 
      ? { phone: identifier } 
      : { email: identifier.toLowerCase() };
    
    // IMPORTANT: Must select passwordHash explicitly since it has select: false
    const user = await User.findOne(query).select('+passwordHash');

    if (!user || !user.passwordHash) {
      return res.status(400).json({ error: { message: 'Invalid credentials' } });
    }

    // Check if account is suspended
    if (!user.isActive) {
      return res.status(403).json({ 
        error: { 
          message: 'This account has been suspended. Please contact support.' 
        } 
      });
    }

    // Compare password
    const isMatch = await bcrypt.compare(password, user.passwordHash);
    
    if (!isMatch) {
      return res.status(400).json({ error: { message: 'Invalid credentials' } });
    }

    // Update last login
    user.lastLogin = new Date();
    await user.save();

    const token = signUser(user);
    
    // Return user without password
    return res.json({ token, user: user.toJSON() });
  } catch (err) {
    next(err);
  }
});

// ==============================
// ACCOUNT MANAGEMENT ROUTES
// ==============================

// Delete/Suspend Account
router.delete('/delete-account', authLimiter, async (req, res, next) => {
  try {
    await db.connect();

    const { userId, phone, email, reason, adminOverride } = req.body;
    
    // Check for required parameters
    if (!userId && !phone && !email) {
      return res.status(400).json({ 
        error: { message: 'userId, phone, or email is required' } 
      });
    }

    // Find the user
    let user = null;
    if (userId) {
      user = await User.findById(userId);
    } else if (phone) {
      user = await User.findOne({ phone });
    } else if (email) {
      user = await User.findOne({ email: email.toLowerCase() });
    }

    if (!user) {
      return res.status(404).json({ error: { message: 'User not found' } });
    }

    // Check if user is already suspended
    if (!user.isActive) {
      return res.status(400).json({ 
        error: { message: 'Account is already suspended' } 
      });
    }

    // Additional checks for drivers (optional)
    if (user.roles?.isDriver) {
      // Check for active rides
      const Ride = require('../models/ride.model');
      const activeRides = await Ride.find({
        driver: user._id,
        status: { $in: ['accepted', 'picked_up', 'ongoing'] }
      });

      if (activeRides.length > 0 && !adminOverride) {
        return res.status(400).json({ 
          error: { 
            message: 'Cannot suspend account while having active rides. Please complete or cancel all rides first.' 
          } 
        });
      }

      // Check for pending earnings (optional)
      const wallet = await Wallet.findOne({ owner: user._id });
      if (wallet && wallet.balance > 0 && !adminOverride) {
        return res.status(400).json({ 
          error: { 
            message: 'Please withdraw your remaining balance before suspending your account.' 
          } 
        });
      }

      // If driver, set them as unavailable
      user.driverProfile.isAvailable = false;
      user.driverProfile.lastSeen = new Date();
    }

    // Suspend the account
    user.isActive = false;
    
    // Add suspension metadata
    user.suspendedAt = new Date();
    user.suspensionReason = reason || 'User requested account deletion';
    user.suspendedBy = 'self'; // or 'admin' if admin is doing it
    
    // Clear sensitive data (optional)
    user.otpCode = undefined;
    user.otpExpiresAt = undefined;
    
    // Set phone and email as unusable for new registrations
    // We'll mark them with a suffix to prevent reuse
    const timestamp = Date.now();
    user.phone = `suspended_${timestamp}_${user.phone}`;
    if (user.email) {
      user.email = `suspended_${timestamp}_${user.email}`;
    }

    await user.save();

    // Log the suspension
    console.log(`Account suspended: User ${user._id} (${user.roles.isDriver ? 'Driver' : 'User'}) at ${new Date().toISOString()}`);
    
    return res.json({ 
      ok: true, 
      message: 'Account has been suspended successfully',
      details: {
        userId: user._id,
        suspendedAt: user.suspendedAt,
        canReactivate: true, // Indicate that account can be reactivated
        note: 'Phone and email have been marked as suspended and cannot be used for new registrations.'
      }
    });
  } catch (err) {
    console.error('Error suspending account:', err);
    next(err);
  }
});

// Reactivate Account (Optional - for admin use)
router.post('/reactivate-account', authLimiter, async (req, res, next) => {
  try {
    await db.connect();

    const { userId, phone, email } = req.body;
    
    if (!userId && !phone && !email) {
      return res.status(400).json({ 
        error: { message: 'userId, phone, or email is required' } 
      });
    }

    let user = null;
    if (userId) {
      user = await User.findById(userId);
    } else if (phone) {
      user = await User.findOne({ phone: new RegExp(`^suspended_.*_${phone}$`) });
    } else if (email) {
      user = await User.findOne({ email: new RegExp(`^suspended_.*_${email}$`) });
    }

    if (!user) {
      return res.status(404).json({ error: { message: 'Suspended account not found' } });
    }

    // Check if account is already active
    if (user.isActive) {
      return res.status(400).json({ 
        error: { message: 'Account is already active' } 
      });
    }

    // Restore original phone and email
    const phoneMatch = user.phone.match(/^suspended_\d+_(.+)$/);
    const emailMatch = user.email ? user.email.match(/^suspended_\d+_(.+)$/) : null;
    
    if (phoneMatch) {
      user.phone = phoneMatch[1];
    }
    
    if (emailMatch) {
      user.email = emailMatch[1];
    }

    // Reactivate account
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

// Check Account Status
router.get('/account-status', authLimiter, async (req, res, next) => {
  try {
    await db.connect();

    const { userId, phone, email } = req.query;
    
    if (!userId && !phone && !email) {
      return res.status(400).json({ 
        error: { message: 'userId, phone, or email is required' } 
      });
    }

    let user = null;
    if (userId) {
      user = await User.findById(userId);
    } else if (phone) {
      // Try to find by original phone or suspended phone
      user = await User.findOne({ 
        $or: [
          { phone: phone },
          { phone: new RegExp(`^suspended_.*_${phone}$`) }
        ]
      });
    } else if (email) {
      user = await User.findOne({ 
        $or: [
          { email: email.toLowerCase() },
          { email: new RegExp(`^suspended_.*_${email.toLowerCase()}$`) }
        ]
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