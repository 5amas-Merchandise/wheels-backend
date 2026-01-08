const express = require('express');
const router = express.Router();
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const User = require('../models/user.model');
const Wallet = require('../models/wallet.model');
const { signUser } = require('../utils/jwt');
const { authLimiter } = require('../middleware/rateLimiter');
const { validatePhone } = require('../middleware/validation');

function generateOtp() {
  // 6-digit OTP
  return Math.floor(100000 + Math.random() * 900000).toString();
}

// Request OTP (email or SMS fallback)
const { sendOTP } = require('../utils/email');

router.post('/request-otp', authLimiter, async (req, res, next) => {
  try {
    const { phone, name, email } = req.body;
    if (!phone && !email) return res.status(400).json({ error: { message: 'phone or email is required' } });
    if (phone && !validatePhone(phone)) return res.status(400).json({ error: { message: 'Invalid phone format' } });

    // find existing user by phone or email
    let user = null;
    if (phone) user = await User.findOne({ phone });
    if (!user && email) user = await User.findOne({ email });
    if (!user) {
      user = new User({ phone, name, email });
    }

    const code = generateOtp();
    user.otpCode = code;
    user.otpExpiresAt = new Date(Date.now() + 10 * 60 * 1000); // 10 minutes
    await user.save();

    // ensure wallet exists
    try {
      await Wallet.create({ owner: user._id, balance: 0 });
    } catch (e) {
      // ignore duplicate wallet errors
    }

    // Prefer email sending if provided, otherwise fallback to console (SMS provider integration required)
    if (email) {
      try {
        await sendOTP(email, code);
        return res.json({ ok: true, message: 'OTP generated and emailed' });
      } catch (e) {
        console.error('Failed to send OTP email:', e.message || e);
        return res.status(500).json({ error: { message: 'Failed to send OTP email' } });
      }
    }

    // fallback to console for mock SMS
    console.log(`Mock OTP for ${phone}: ${code}`);
    return res.json({ ok: true, message: 'OTP generated (mock sent to console)' });
  } catch (err) {
    next(err);
  }
});

// Verify OTP and issue JWT (accepts phone+code or email+code)
router.post('/verify-otp', authLimiter, async (req, res, next) => {
  try {
    const { phone, email, code } = req.body;
    if (!code || (!phone && !email)) return res.status(400).json({ error: { message: 'phone or email and code are required' } });

    let user = null;
    if (phone) {
      if (!validatePhone(phone)) return res.status(400).json({ error: { message: 'Invalid phone format' } });
      user = await User.findOne({ phone });
    } else if (email) {
      const { validateEmail } = require('../middleware/validation');
      if (!validateEmail(email)) return res.status(400).json({ error: { message: 'Invalid email format' } });
      user = await User.findOne({ email });
    }

    if (!user) return res.status(400).json({ error: { message: 'Invalid identifier or code' } });
    if (!user.otpCode || !user.otpExpiresAt) return res.status(400).json({ error: { message: 'No OTP requested' } });
    if (new Date() > user.otpExpiresAt) return res.status(400).json({ error: { message: 'OTP expired' } });
    if (user.otpCode !== code) return res.status(400).json({ error: { message: 'Invalid OTP' } });

    // clear OTP
    user.otpCode = undefined;
    user.otpExpiresAt = undefined;
    // ensure basic role
    user.roles = user.roles || {};
    user.roles.isUser = true;
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
    const { name, phone, email, password, role, driverProfile } = req.body;
    if (!password) return res.status(400).json({ error: { message: 'password is required' } });

    if (phone && !validatePhone(phone)) return res.status(400).json({ error: { message: 'Invalid phone format' } });

    // prevent duplicate phone/email
    if (phone) {
      const existing = await User.findOne({ phone });
      if (existing) return res.status(400).json({ error: { message: 'phone already in use' } });
    }
    if (email) {
      const existing = await User.findOne({ email });
      if (existing) return res.status(400).json({ error: { message: 'email already in use' } });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const user = new User({ name, phone, email, passwordHash });

    // roles
    if (role === 'driver') {
      user.roles = { isUser: false, isDriver: true, isAdmin: false };
      if (driverProfile && typeof driverProfile === 'object') user.driverProfile = driverProfile;
    } else {
      user.roles = { isUser: true, isDriver: false, isAdmin: false };
    }

    await user.save();
    // create wallet record with zero balance
    try {
      await Wallet.create({ owner: user._id, balance: 0 });
    } catch (e) {
      // ignore duplicate wallet errors
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
    const { identifier, password } = req.body; // identifier = phone or email
    if (!identifier || !password) return res.status(400).json({ error: { message: 'identifier and password required' } });

    const query = validatePhone(identifier) ? { phone: identifier } : { email: identifier };
    const user = await User.findOne(query);
    if (!user || !user.passwordHash) return res.status(400).json({ error: { message: 'Invalid credentials' } });

    const ok = await bcrypt.compare(password, user.passwordHash);
    if (!ok) return res.status(400).json({ error: { message: 'Invalid credentials' } });

    const token = signUser(user);
    return res.json({ token, user: user.toJSON() });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
