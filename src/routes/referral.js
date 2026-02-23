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
 *
 * FIXES:
 *  - field name: `owner` → `userId`          (schema requires `userId`)
 *  - status: 'success' → 'completed'          (not in enum)
 *  - field name: `reference` → `paymentReference`
 *  - added `category: 'referral_reward'`
 *  - added `balanceBefore` capture
 *  - switched to findOne + save so balanceBefore is readable before increment
 */
async function creditWallet(userId, amount, description, session) {
  const wallet = await Wallet.findOne({ owner: userId }).session(session);

  if (!wallet) throw new Error(`Wallet not found for user ${userId}`);

  const balanceBefore = wallet.balance;
  wallet.balance += amount;
  await wallet.save({ session });

  await Transaction.create([{
    userId:           userId,
    type:             'referral_reward',
    category:         'referral_reward',
    amount,
    description,
    status:           'completed',
    balanceBefore,
    balanceAfter:     wallet.balance,
    paymentReference: `ref_reward_${userId}_${Date.now()}`
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

    if (!user.referralCode) {
      const code = await generateUniqueReferralCode(user.name || '');
      await User.findByIdAndUpdate(userId, { referralCode: code });
      user.referralCode = code;
    }

    const shareLink = `https://yourapp.com/signup?ref=${user.referralCode}`;
    const shareMessage = `Use my referral code ${user.referralCode} when you sign up on YourApp and get ₦${(REFERRAL_REWARDS.REFEREE / 100).toFixed(0)} off your first ride! ${shareLink}`;

    return res.json({
      success: true,
      referralCode: user.referralCode,
      shareLink,
      shareMessage,
      rewards: {
        youGet:         `₦${(REFERRAL_REWARDS.REFERRER / 100).toFixed(0)}`,
        friendGets:     `₦${(REFERRAL_REWARDS.REFEREE / 100).toFixed(0)}`,
        youGetKobo:     REFERRAL_REWARDS.REFERRER,
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
        totalReferrals:    total,
        rewardedReferrals: rewarded,
        pendingReferrals:  pending,
        totalEarnedKobo:   totalEarned,
        totalEarnedNaira:  (totalEarned / 100).toFixed(2)
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

    const parsedLimit  = Math.min(parseInt(limit) || 20, 100);
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
        name:     r.refereeId?.name || 'User',
        phone:    r.refereeId?.phone
          ? r.refereeId.phone.replace(/(\d{3})\d{4}(\d{4})/, '$1****$2')
          : null,
        joinedAt: r.refereeId?.createdAt
      },
      status:            r.status,
      rewardEarned:      r.status === 'rewarded' ? r.referrerReward : 0,
      rewardEarnedNaira: r.status === 'rewarded'
        ? (r.referrerReward / 100).toFixed(2)
        : '0.00',
      createdAt:  r.createdAt,
      rewardedAt: r.rewardedAt,
      expiresAt:  r.expiresAt
    }));

    return res.json({
      success: true,
      referrals: formatted,
      pagination: {
        total,
        limit:   parsedLimit,
        offset:  parsedOffset,
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
      referralCode: code.toUpperCase().trim()
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
        youGet:     `₦${(REFERRAL_REWARDS.REFEREE / 100).toFixed(0)}`,
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
//
// FIX: Always cast passengerId to ObjectId before querying.
//      String vs ObjectId mismatch was causing findOne to always
//      return null, meaning rewards were never triggered.
// ==========================================

async function triggerReferralReward(tripId, passengerId) {
  const session = await mongoose.startSession();

  try {
    // ✅ Always work with ObjectId, never raw strings
    const passengerObjectId = typeof passengerId === 'string'
      ? new mongoose.Types.ObjectId(passengerId)
      : passengerId;

    await session.withTransaction(async () => {
      const referral = await Referral.findOne({
        refereeId: passengerObjectId,
        status: 'pending'
      }).session(session);

      if (!referral) {
        console.log(`ℹ️ No pending referral for passenger ${passengerId}`);
        return;
      }

      if (referral.expiresAt < new Date()) {
        referral.status = 'expired';
        await referral.save({ session });
        console.log(`⏰ Referral ${referral._id} expired for passenger ${passengerId}`);
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
        passengerObjectId,
        referral.refereeReward,
        `Welcome bonus for using referral code ${referral.code}`,
        session
      );

      referral.status = 'rewarded';
      referral.triggerTripId = tripId ? new mongoose.Types.ObjectId(tripId) : null;
      referral.rewardedAt = new Date();
      await referral.save({ session });

      console.log(`✅ Referral rewards credited successfully for passenger ${passengerId}`);
    });
  } catch (err) {
    console.error('❌ Referral reward error:', err.message);
    // Non-fatal — don't throw, trip completion already succeeded
  } finally {
    await session.endSession();
  }
}

// ==========================================
// POST /referrals/admin/backfill-referral-rewards
// No auth — internal/admin use only
//
// FIX: Removed broken circular require().
//      triggerReferralReward is called directly since it's
//      defined in this same file.
// ==========================================

router.post('/admin/backfill-referral-rewards', async (req, res) => {
  try {
    const pendingReferrals = await Referral.find({ status: 'pending' }).lean();

    console.log(`🔄 Backfill: found ${pendingReferrals.length} pending referrals`);

    const results = [];

    for (const referral of pendingReferrals) {
      try {
        await triggerReferralReward(
          referral.triggerTripId?.toString() || null,
          referral.refereeId.toString()
        );

        const updated = await Referral.findById(referral._id).lean();
        results.push({
          referralId: referral._id,
          refereeId:  referral.refereeId,
          status:     updated?.status || 'unknown'
        });
      } catch (err) {
        results.push({
          referralId: referral._id,
          refereeId:  referral.refereeId,
          status:     'failed',
          error:      err.message
        });
      }
    }

    const rewarded     = results.filter(r => r.status === 'rewarded').length;
    const stillPending = results.filter(r => r.status === 'pending').length;
    const failed       = results.filter(r => r.status === 'failed').length;

    console.log(`✅ Backfill complete: ${rewarded} rewarded, ${stillPending} still pending (no trip yet), ${failed} failed`);

    res.json({
      processed: results.length,
      rewarded,
      stillPending,
      failed,
      results
    });
  } catch (err) {
    console.error('❌ Backfill error:', err);
    res.status(500).json({ success: false, error: { message: err.message } });
  }
});

// GET /referrals/my-bonus
// Returns the referral record where the current user is the REFEREE
// (they signed up using someone else's code)

router.get('/my-bonus', requireAuth, async (req, res, next) => {
  try {
    const userId = req.user._id;

    const referral = await Referral.findOne({
      refereeId: new mongoose.Types.ObjectId(userId)
    })
    .populate('referrerId', 'name')
    .lean();

    if (!referral) {
      return res.json({ found: false, bonus: null });
    }

    return res.json({
      found: true,
      bonus: {
        status:       referral.status,
        refereeReward: referral.refereeReward,
        code:          referral.code,
        referrerName:  referral.referrerId?.name || null,
        rewardedAt:    referral.rewardedAt || null,
        expiresAt:     referral.expiresAt || null
      }
    });
  } catch (err) {
    next(err);
  }
});

// Export the reward trigger so trips route can call it
router.triggerReferralReward = triggerReferralReward;

module.exports = router;