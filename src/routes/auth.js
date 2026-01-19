// routes/auth.js
const express = require('express');
const router = express.Router();
const bcrypt = require('bcryptjs');

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

    // Find existing user
    let user = null;
    if (phone) user = await User.findOne({ phone });
    if (!user && email) user = await User.findOne({ email });

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

    // Check for duplicates
    if (phone) {
      const existing = await User.findOne({ phone });
      if (existing) {
        return res.status(400).json({ error: { message: 'phone already in use' } });
      }
    }
    
    if (email) {
      const existing = await User.findOne({ email });
      if (existing) {
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

module.exports = router;