// routes/referral.js
const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const User = require('../models/user.model');
const Referral = require('../models/referral.model');
const Wallet = require('../models/wallet.model');
const Transaction = require('../models/transaction.model');
const { requireAuth } = require('../middleware/auth');

// ==========================================
// CONSTANTS
// ==========================================

const REFERRAL_REWARDS = {
  REFERRER: 50000, // ₦500 in kobo
  REFEREE: 30000   // ₦300 in kobo
};

// ==========================================
// HELPERS
// ==========================================

/**
 * Generate a unique 8-character alphanumeric referral code
 */
async function generateUniqueReferralCode(name = '') {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // Exclude confusing chars (0, O, 1, I)
  const attempts = 10;

  // Try to make it meaningful: first 3 chars from name, rest random
  const prefix = name
    .toUpperCase()
    .replace(/[^A-Z]/g, '')
    .slice(0, 3)
    .padEnd(3, chars[Math.floor(Math.random() * chars.length)]);

  for (let i = 0; i < attempts; i++) {
    let suffix = '';
    for (let j = 0; j < 5; j++) {
      suffix += chars[Math.floor(Math.random() * chars.length)];
    }
    const code = prefix + suffix;

    const existing = await User.findOne({ referralCode: code }).lean();
    if (!existing) return code;
  }

  // Fallback: full random
  let code = '';
  for (let i = 0; i < 8; i++) {
    code += chars[Math.floor(Math.random() * chars.length)];
  }
  return code;
}

/**
 * Credit wallet and record transaction — used for referral rewards
 */
async function creditWallet(userId, amount, description, session) {
  const wallet = await Wallet.findOneAndUpdate(
    { owner: userId },
    { $inc: { balance: amount } },
    { new: true, session }
  );

  if (!wallet) throw new Error(`Wallet not found for user ${userId}`);

  await Transaction.create([{
    owner: userId,
    type: 'referral_reward',
    amount,
    description,
    status: 'success',
    balanceAfter: wallet.balance,
    reference: `ref_reward_${userId}_${Date.now()}`
  }], { session });

  return wallet;
}

// ==========================================
// GET /referrals/my-code
// Returns the authenticated user's referral code
// Creates one if it doesn't exist yet
// ==========================================

router.get('/my-code', requireAuth, async (req, res, next) => {
  try {
    const userId = req.user._id;

    const user = await User.findById(userId)
      .select('name referralCode')
      .lean();

    if (!user) {
      return res.status(404).json({ success: false, error: { message: 'User not found' } });
    }

    // If user somehow doesn't have a code yet, generate one now
    if (!user.referralCode) {
      const code = await generateUniqueReferralCode(user.name || '');
      await User.findByIdAndUpdate(userId, { referralCode: code });
      user.referralCode = code;
    }

    // Build share link (update domain as needed)
    const shareLink = `https://yourapp.com/signup?ref=${user.referralCode}`;
    const shareMessage = `Use my referral code ${user.referralCode} when you sign up on YourApp and get ₦${(REFERRAL_REWARDS.REFEREE / 100).toFixed(0)} off your first ride! ${shareLink}`;

    return res.json({
      success: true,
      referralCode: user.referralCode,
      shareLink,
      shareMessage,
      rewards: {
        youGet: `₦${(REFERRAL_REWARDS.REFERRER / 100).toFixed(0)}`,
        friendGets: `₦${(REFERRAL_REWARDS.REFEREE / 100).toFixed(0)}`,
        youGetKobo: REFERRAL_REWARDS.REFERRER,
        friendGetsKobo: REFERRAL_REWARDS.REFEREE
      }
    });
  } catch (err) {
    next(err);
  }
});

// ==========================================
// GET /referrals/stats
// Summary of referrals made by the authenticated user
// ==========================================

router.get('/stats', requireAuth, async (req, res, next) => {
  try {
    const userId = req.user._id;

    const [total, rewarded, pending] = await Promise.all([
      Referral.countDocuments({ referrerId: userId }),
      Referral.countDocuments({ referrerId: userId, status: 'rewarded' }),
      Referral.countDocuments({ referrerId: userId, status: 'pending' })
    ]);

    const earningsResult = await Referral.aggregate([
      { $match: { referrerId: new mongoose.Types.ObjectId(userId), status: 'rewarded' } },
      { $group: { _id: null, total: { $sum: '$referrerReward' } } }
    ]);

    const totalEarned = earningsResult[0]?.total || 0;

    return res.json({
      success: true,
      stats: {
        totalReferrals: total,
        rewardedReferrals: rewarded,
        pendingReferrals: pending,
        totalEarnedKobo: totalEarned,
        totalEarnedNaira: (totalEarned / 100).toFixed(2)
      }
    });
  } catch (err) {
    next(err);
  }
});

// ==========================================
// GET /referrals/history
// Paginated list of people this user referred
// ==========================================

router.get('/history', requireAuth, async (req, res, next) => {
  try {
    const userId = req.user._id;
    const { limit = 20, offset = 0 } = req.query;

    const parsedLimit = Math.min(parseInt(limit) || 20, 100);
    const parsedOffset = parseInt(offset) || 0;

    const [referrals, total] = await Promise.all([
      Referral.find({ referrerId: userId })
        .populate('refereeId', 'name phone createdAt')
        .sort({ createdAt: -1 })
        .limit(parsedLimit)
        .skip(parsedOffset)
        .lean(),
      Referral.countDocuments({ referrerId: userId })
    ]);

    const formatted = referrals.map(r => ({
      id: r._id,
      referee: {
        name: r.refereeId?.name || 'User',
        phone: r.refereeId?.phone
          ? r.refereeId.phone.replace(/(\d{3})\d{4}(\d{4})/, '$1****$2') // Mask middle digits
          : null,
        joinedAt: r.refereeId?.createdAt
      },
      status: r.status,
      rewardEarned: r.status === 'rewarded' ? r.referrerReward : 0,
      rewardEarnedNaira: r.status === 'rewarded'
        ? (r.referrerReward / 100).toFixed(2)
        : '0.00',
      createdAt: r.createdAt,
      rewardedAt: r.rewardedAt,
      expiresAt: r.expiresAt
    }));

    return res.json({
      success: true,
      referrals: formatted,
      pagination: {
        total,
        limit: parsedLimit,
        offset: parsedOffset,
        hasMore: total > parsedOffset + parsedLimit
      }
    });
  } catch (err) {
    next(err);
  }
});

// ==========================================
// POST /referrals/validate
// Check if a referral code is valid before signup
// (Public — no auth required)
// ==========================================

router.post('/validate', async (req, res, next) => {
  try {
    const { code } = req.body;

    if (!code || typeof code !== 'string') {
      return res.status(400).json({ success: false, error: { message: 'code is required' } });
    }

    const referrer = await User.findOne({
      referralCode: code.toUpperCase().trim(),
      isActive: true
    }).select('name referralCode').lean();

    if (!referrer) {
      return res.status(404).json({
        success: false,
        valid: false,
        error: { message: 'Invalid or expired referral code' }
      });
    }

    return res.json({
      success: true,
      valid: true,
      referrerName: referrer.name || 'A friend',
      rewards: {
        youGet: `₦${(REFERRAL_REWARDS.REFEREE / 100).toFixed(0)}`,
        youGetKobo: REFERRAL_REWARDS.REFEREE
      }
    });
  } catch (err) {
    next(err);
  }
});

// ==========================================
// INTERNAL: triggerReferralReward(tripId, passengerId)
// Called from the trips route after first completed trip
// ==========================================

async function triggerReferralReward(tripId, passengerId) {
  const session = await mongoose.startSession();

  try {
    await session.withTransaction(async () => {
      // Find a pending referral for this passenger (they are the referee)
      const referral = await Referral.findOne({
        refereeId: passengerId,
        status: 'pending'
      }).session(session);

      if (!referral) {
        console.log(`ℹ️ No pending referral for passenger ${passengerId}`);
        return;
      }

      // Check it hasn't expired
      if (referral.expiresAt < new Date()) {
        referral.status = 'expired';
        await referral.save({ session });
        console.log(`⏰ Referral ${referral._id} expired`);
        return;
      }

      console.log(`🎁 Rewarding referral ${referral._id}: referrer=${referral.referrerId}, referee=${passengerId}`);

      // Credit referrer
      await creditWallet(
        referral.referrerId,
        referral.referrerReward,
        `Referral reward: your friend completed their first ride`,
        session
      );

      // Credit referee
      await creditWallet(
        passengerId,
        referral.refereeReward,
        `Welcome bonus for using referral code ${referral.code}`,
        session
      );

      // Mark referral as rewarded
      referral.status = 'rewarded';
      referral.triggerTripId = tripId;
      referral.rewardedAt = new Date();
      await referral.save({ session });

      console.log(`✅ Referral rewards credited successfully`);
    });
  } catch (err) {
    console.error('❌ Referral reward error:', err.message);
    // Non-fatal — don't throw, trip completion already succeeded
  } finally {
    await session.endSession();
  }
}

// Export the reward trigger so trips route can call it
router.triggerReferralReward = triggerReferralReward;

module.exports = router;