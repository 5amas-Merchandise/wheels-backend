// routes/users.js
const express = require('express');
const router = express.Router();
const User = require('../models/user.model');
const Referral = require('../models/referral.model');
const { requireAuth } = require('../middleware/auth');

// ==========================================
// GET /users/me
// ==========================================

router.get('/me', requireAuth, async (req, res, next) => {
  try {
    console.log('User from token:', req.user);

    const userId = req.user._id;

    if (!userId) {
      console.error('No user ID found in token');
      return res.status(401).json({
        success: false,
        error: { message: 'Invalid token payload: No user ID' }
      });
    }

    const user = await User.findById(userId)
      .select('-passwordHash -otpCode -otpExpiresAt')
      .lean();

    if (!user) {
      return res.status(404).json({
        success: false,
        error: { message: 'User not found' }
      });
    }

    // Ensure referral code exists (backfill for old accounts)
    if (!user.referralCode) {
      const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
      let code = '';
      for (let i = 0; i < 8; i++) {
        code += chars[Math.floor(Math.random() * chars.length)];
      }
      await User.findByIdAndUpdate(userId, { referralCode: code });
      user.referralCode = code;
    }

    // Fetch a quick referral summary to include in the profile response
    const referralStats = await Referral.aggregate([
      { $match: { referrerId: user._id } },
      {
        $group: {
          _id: null,
          total: { $sum: 1 },
          rewarded: {
            $sum: { $cond: [{ $eq: ['$status', 'rewarded'] }, 1, 0] }
          },
          totalEarned: {
            $sum: { $cond: [{ $eq: ['$status', 'rewarded'] }, '$referrerReward', 0] }
          }
        }
      }
    ]);

    const stats = referralStats[0] || { total: 0, rewarded: 0, totalEarned: 0 };

    const responseUser = {
      ...user,
      driverProfile: user.driverProfile || {
        verified: false,
        verificationState: 'pending'
      },
      referral: {
        code: user.referralCode,
        shareLink: `https://yourapp.com/signup?ref=${user.referralCode}`,
        totalReferrals: stats.total,
        rewardedReferrals: stats.rewarded,
        totalEarnedNaira: (stats.totalEarned / 100).toFixed(2)
      }
    };

    res.json({
      success: true,
      user: responseUser
    });
  } catch (err) {
    console.error('Get profile error:', err);
    next(err);
  }
});

// ==========================================
// PUT /users/me
// ==========================================

router.put('/me', requireAuth, async (req, res, next) => {
  try {
    const userId = req.user._id;
    const { name, email } = req.body;

    const updateData = {};
    if (name !== undefined) updateData.name = name;
    if (email !== undefined) updateData.email = email;

    const updatedUser = await User.findByIdAndUpdate(
      userId,
      { $set: updateData },
      {
        new: true,
        runValidators: true,
        select: '-passwordHash -otpCode -otpExpiresAt'
      }
    ).lean();

    if (!updatedUser) {
      return res.status(404).json({
        success: false,
        error: { message: 'User not found' }
      });
    }

    res.json({
      success: true,
      message: 'Profile updated successfully',
      user: updatedUser
    });
  } catch (err) {
    console.error('Update profile error:', err);
    if (err.name === 'ValidationError') {
      return res.status(400).json({
        success: false,
        error: { message: err.message }
      });
    }
    next(err);
  }
});

module.exports = router;