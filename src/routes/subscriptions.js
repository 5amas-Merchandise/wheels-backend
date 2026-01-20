const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const User = require('../models/user.model');
const Subscription = require('../models/subscription.model');
const Wallet = require('../models/wallet.model');
const Transaction = require('../models/transaction.model');
const { requireAuth } = require('../middleware/auth');
const {
  VEHICLE_TYPES,
  SUBSCRIPTION_DURATIONS,
  getSubscriptionPrice,
  calculateExpiryDate,
  isSubscriptionActive,
  getAvailablePlans,
  getDurationHours
} = require('../constants/subscriptionPlans');

// ==========================================
// GET /subscriptions/plans - GET AVAILABLE PLANS
// ==========================================

/**
 * Get available subscription plans for a vehicle type
 * Query params:
 * - vehicleType: CITY_CAR | KEKE | BIKE
 */
router.get('/plans', requireAuth, async (req, res, next) => {
  try {
    const { vehicleType } = req.query;

    if (!vehicleType) {
      return res.status(400).json({
        success: false,
        error: { message: 'Vehicle type is required' }
      });
    }

    if (!Object.values(VEHICLE_TYPES).includes(vehicleType)) {
      return res.status(400).json({
        success: false,
        error: { message: 'Invalid vehicle type' }
      });
    }

    const plans = getAvailablePlans(vehicleType);

    res.json({
      success: true,
      vehicleType,
      plans: plans.map(plan => ({
        duration: plan.duration,
        price: plan.priceNaira,
        priceFormatted: `₦${plan.priceNaira.toLocaleString()}`,
        durationHours: plan.durationHours,
        durationDays: Math.floor(plan.durationHours / 24),
        savings: plan.savings,
        savingsFormatted: plan.savings > 0 ? `₦${plan.savings.toLocaleString()}` : null,
        recommended: plan.duration === SUBSCRIPTION_DURATIONS.MONTHLY
      }))
    });

  } catch (err) {
    console.error('Get plans error:', err);
    next(err);
  }
});

// ==========================================
// GET /subscriptions/current - GET CURRENT SUBSCRIPTION
// ==========================================

/**
 * Get driver's current active subscription
 */
router.get('/current', requireAuth, async (req, res, next) => {
  try {
    const driverId = req.user.sub;

    console.log(`📊 Fetching current subscription for driver ${driverId}`);

    const subscription = await Subscription.findActiveForDriver(driverId);

    if (!subscription) {
      return res.json({
        success: true,
        hasActiveSubscription: false,
        subscription: null
      });
    }

    const now = new Date();
    const timeRemaining = Math.max(0, subscription.expiresAt - now);
    const hoursRemaining = Math.floor(timeRemaining / (1000 * 60 * 60));
    const minutesRemaining = Math.floor((timeRemaining % (1000 * 60 * 60)) / (1000 * 60));

    res.json({
      success: true,
      hasActiveSubscription: true,
      subscription: {
        id: subscription._id,
        vehicleType: subscription.vehicleType,
        plan: {
          duration: subscription.plan.duration,
          price: subscription.plan.priceKobo / 100,
          priceFormatted: `₦${(subscription.plan.priceKobo / 100).toLocaleString()}`
        },
        startedAt: subscription.startedAt,
        expiresAt: subscription.expiresAt,
        status: subscription.status,
        autoRenew: subscription.autoRenew,
        timeRemaining: {
          milliseconds: timeRemaining,
          hours: hoursRemaining,
          minutes: minutesRemaining,
          formatted: `${hoursRemaining}h ${minutesRemaining}m`
        }
      }
    });

  } catch (err) {
    console.error('Get current subscription error:', err);
    next(err);
  }
});

// ==========================================
// POST /subscriptions/subscribe - PURCHASE SUBSCRIPTION
// ==========================================

/**
 * Purchase a new subscription or renew existing one
 * Body:
 * - vehicleType: CITY_CAR | KEKE | BIKE
 * - duration: daily | weekly | monthly
 * - autoRenew: boolean (optional, default false)
 */
router.post('/subscribe', requireAuth, async (req, res, next) => {
  const session = await mongoose.startSession();
  
  try {
    await session.withTransaction(async () => {
      const driverId = req.user.sub;
      const { vehicleType, duration, autoRenew = false } = req.body;

      console.log(`💳 Driver ${driverId} attempting to subscribe:`, {
        vehicleType,
        duration,
        autoRenew
      });

      // Validation
      if (!vehicleType || !duration) {
        throw new Error('Vehicle type and duration are required');
      }

      if (!Object.values(VEHICLE_TYPES).includes(vehicleType)) {
        throw new Error('Invalid vehicle type');
      }

      if (!Object.values(SUBSCRIPTION_DURATIONS).includes(duration)) {
        throw new Error('Invalid subscription duration');
      }

      // Get driver
      const driver = await User.findById(driverId)
        .select('name phone roles driverProfile')
        .session(session);

      if (!driver) {
        throw new Error('Driver not found');
      }

      if (!driver.roles?.isDriver) {
        throw new Error('User is not a driver');
      }

      if (!driver.driverProfile?.verified || driver.driverProfile?.verificationState !== 'approved') {
        throw new Error('Driver must be verified to subscribe');
      }

      // Check for existing active subscription
      const existingSubscription = await Subscription.findOne({
        driverId,
        status: 'active',
        expiresAt: { $gt: new Date() }
      }).session(session);

      if (existingSubscription) {
        throw new Error('You already have an active subscription. Please wait for it to expire or cancel it first.');
      }

      // Get price
      const priceKobo = getSubscriptionPrice(vehicleType, duration);
      const priceNaira = priceKobo / 100;

      console.log(`💰 Subscription price: ₦${priceNaira} (${priceKobo} kobo)`);

      // Get or create wallet using atomic upsert
      let wallet = await Wallet.findOneAndUpdate(
        { owner: driverId },
        { $setOnInsert: { owner: driverId, balance: 0, currency: 'NGN' } },
        { new: true, upsert: true, session }
      );

      if (wallet.balance < priceKobo) {
        throw new Error(`Insufficient wallet balance. Required: ₦${priceNaira}, Available: ₦${(wallet.balance / 100).toFixed(2)}`);
      }

      // Deduct from wallet
      wallet.balance -= priceKobo;
      await wallet.save({ session });

      console.log(`✅ Deducted ₦${priceNaira} from wallet. New balance: ₦${(wallet.balance / 100).toFixed(2)}`);

      // Calculate expiry
      const startedAt = new Date();
      const expiresAt = calculateExpiryDate(duration);
      const durationHours = getDurationHours(duration);

      console.log(`📅 Subscription period: ${startedAt} to ${expiresAt} (${durationHours} hours)`);

      // Create subscription record
      const subscription = await Subscription.create([{
        driverId,
        vehicleType,
        plan: {
          duration,
          priceKobo,
          durationHours
        },
        startedAt,
        expiresAt,
        status: 'active',
        paymentMethod: 'wallet',
        autoRenew,
        metadata: {
          ipAddress: req.ip,
          userAgent: req.get('user-agent')
        }
      }], { session });

      const newSubscription = subscription[0];

      // Create transaction record
      const transaction = await Transaction.create([{
        userId: driverId,
        type: 'debit',
        amount: priceKobo,
        description: `Subscription: ${duration} plan for ${vehicleType}`,
        category: 'subscription',
        status: 'completed',
        balanceBefore: wallet.balance + priceKobo,
        balanceAfter: wallet.balance,
        metadata: {
          subscriptionId: newSubscription._id,
          vehicleType,
          duration,
          expiresAt
        }
      }], { session });

      // Link transaction to subscription
      newSubscription.transactionId = transaction[0]._id;
      await newSubscription.save({ session });

      console.log(`✅ Subscription created successfully: ${newSubscription._id}`);

      // Update driver's subscription reference in User model
      await User.findByIdAndUpdate(
        driverId,
        {
          $set: {
            'driverProfile.currentSubscriptionId': newSubscription._id,
            'driverProfile.subscriptionExpiresAt': expiresAt,
            'driverProfile.isAvailable': true // Driver can now receive rides
          }
        },
        { session }
      );

      // Prepare response
      res.json({
        success: true,
        message: 'Subscription activated successfully',
        subscription: {
          id: newSubscription._id,
          vehicleType: newSubscription.vehicleType,
          plan: {
            duration: newSubscription.plan.duration,
            price: priceNaira,
            priceFormatted: `₦${priceNaira.toLocaleString()}`
          },
          startedAt: newSubscription.startedAt,
          expiresAt: newSubscription.expiresAt,
          status: newSubscription.status,
          autoRenew: newSubscription.autoRenew
        },
        wallet: {
          newBalance: wallet.balance,
          newBalanceFormatted: `₦${(wallet.balance / 100).toFixed(2)}`
        },
        transaction: {
          id: transaction[0]._id,
          amount: priceNaira,
          description: transaction[0].description
        }
      });
    });

  } catch (error) {
    console.error('❌ Subscription error:', error.message);

    let statusCode = 500;
    let errorCode = 'SUBSCRIPTION_FAILED';

    if (error.message.includes('required') || error.message.includes('Invalid')) {
      statusCode = 400;
      errorCode = 'INVALID_REQUEST';
    } else if (error.message.includes('not found')) {
      statusCode = 404;
      errorCode = 'NOT_FOUND';
    } else if (error.message.includes('Insufficient')) {
      statusCode = 400;
      errorCode = 'INSUFFICIENT_BALANCE';
    } else if (error.message.includes('already have')) {
      statusCode = 400;
      errorCode = 'SUBSCRIPTION_EXISTS';
    } else if (error.message.includes('verified')) {
      statusCode = 403;
      errorCode = 'NOT_VERIFIED';
    }

    res.status(statusCode).json({
      success: false,
      error: {
        message: error.message,
        code: errorCode
      }
    });

  } finally {
    await session.endSession();
  }
});

// ==========================================
// POST /subscriptions/cancel - CANCEL SUBSCRIPTION
// ==========================================

/**
 * Cancel active subscription (no refund)
 */
router.post('/cancel', requireAuth, async (req, res, next) => {
  try {
    const driverId = req.user.sub;

    console.log(`🚫 Driver ${driverId} attempting to cancel subscription`);

    const subscription = await Subscription.findOne({
      driverId,
      status: 'active',
      expiresAt: { $gt: new Date() }
    });

    if (!subscription) {
      return res.status(404).json({
        success: false,
        error: { message: 'No active subscription found' }
      });
    }

    // Cancel subscription
    await subscription.cancel();

    // Update driver profile
    await User.findByIdAndUpdate(driverId, {
      $unset: {
        'driverProfile.currentSubscriptionId': '',
        'driverProfile.subscriptionExpiresAt': ''
      }
    });

    console.log(`✅ Subscription ${subscription._id} cancelled`);

    res.json({
      success: true,
      message: 'Subscription cancelled successfully',
      subscription: {
        id: subscription._id,
        status: subscription.status,
        cancelledAt: subscription.cancelledAt
      }
    });

  } catch (err) {
    console.error('Cancel subscription error:', err);
    next(err);
  }
});

// ==========================================
// GET /subscriptions/history - GET SUBSCRIPTION HISTORY
// ==========================================

/**
 * Get driver's subscription history
 * Query params:
 * - limit: number (default 10, max 50)
 */
router.get('/history', requireAuth, async (req, res, next) => {
  try {
    const driverId = req.user.sub;
    const limit = Math.min(parseInt(req.query.limit) || 10, 50);

    console.log(`📚 Fetching subscription history for driver ${driverId}`);

    const subscriptions = await Subscription.find({ driverId })
      .sort({ createdAt: -1 })
      .limit(limit)
      .lean();

    const formattedHistory = subscriptions.map(sub => ({
      id: sub._id,
      vehicleType: sub.vehicleType,
      plan: {
        duration: sub.plan.duration,
        price: sub.plan.priceKobo / 100,
        priceFormatted: `₦${(sub.plan.priceKobo / 100).toLocaleString()}`
      },
      startedAt: sub.startedAt,
      expiresAt: sub.expiresAt,
      status: sub.status,
      autoRenew: sub.autoRenew,
      cancelledAt: sub.cancelledAt,
      createdAt: sub.createdAt
    }));

    res.json({
      success: true,
      count: formattedHistory.length,
      history: formattedHistory
    });

  } catch (err) {
    console.error('Get history error:', err);
    next(err);
  }
});

// ==========================================
// POST /subscriptions/toggle-auto-renew - TOGGLE AUTO RENEWAL
// ==========================================

/**
 * Enable/disable auto-renewal for current subscription
 * Body:
 * - autoRenew: boolean
 */
router.post('/toggle-auto-renew', requireAuth, async (req, res, next) => {
  try {
    const driverId = req.user.sub;
    const { autoRenew } = req.body;

    if (typeof autoRenew !== 'boolean') {
      return res.status(400).json({
        success: false,
        error: { message: 'autoRenew must be a boolean' }
      });
    }

    const subscription = await Subscription.findOne({
      driverId,
      status: 'active',
      expiresAt: { $gt: new Date() }
    });

    if (!subscription) {
      return res.status(404).json({
        success: false,
        error: { message: 'No active subscription found' }
      });
    }

    subscription.autoRenew = autoRenew;
    await subscription.save();

    console.log(`🔄 Auto-renew ${autoRenew ? 'enabled' : 'disabled'} for subscription ${subscription._id}`);

    res.json({
      success: true,
      message: `Auto-renewal ${autoRenew ? 'enabled' : 'disabled'}`,
      subscription: {
        id: subscription._id,
        autoRenew: subscription.autoRenew
      }
    });

  } catch (err) {
    console.error('Toggle auto-renew error:', err);
    next(err);
  }
});

// ==========================================
// BACKGROUND JOB: EXPIRE OLD SUBSCRIPTIONS
// ==========================================

/**
 * This should be run as a cron job every hour
 * Marks expired subscriptions and updates driver availability
 */
async function expireOldSubscriptions() {
  try {
    console.log('🔍 Checking for expired subscriptions...');

    const expiredSubscriptions = await Subscription.find({
      status: 'active',
      expiresAt: { $lte: new Date() }
    });

    console.log(`Found ${expiredSubscriptions.length} expired subscriptions`);

    for (const subscription of expiredSubscriptions) {
      // Mark as expired
      await subscription.expire();

      // Update driver - make unavailable
      await User.findByIdAndUpdate(subscription.driverId, {
        $set: {
          'driverProfile.isAvailable': false
        },
        $unset: {
          'driverProfile.currentSubscriptionId': '',
          'driverProfile.subscriptionExpiresAt': ''
        }
      });

      console.log(`✅ Expired subscription ${subscription._id} for driver ${subscription.driverId}`);
    }

    return expiredSubscriptions.length;
  } catch (err) {
    console.error('❌ Expire subscriptions error:', err);
    return 0;
  }
}

// Start periodic cleanup (run every hour)
function startSubscriptionCleanup() {
  const CLEANUP_INTERVAL = 60 * 60 * 1000; // 1 hour

  setInterval(async () => {
    const count = await expireOldSubscriptions();
    if (count > 0) {
      console.log(`🧹 Expired ${count} subscriptions`);
    }
  }, CLEANUP_INTERVAL);

  console.log('✅ Subscription cleanup job started (runs every hour)');
}

// Start cleanup on module load
startSubscriptionCleanup();

// Manual trigger endpoint (admin only)
router.post('/admin/expire-subscriptions', requireAuth, async (req, res) => {
  try {
    // Check if user is admin
    const user = await User.findById(req.user.sub).select('roles');
    if (!user?.roles?.isAdmin) {
      return res.status(403).json({
        success: false,
        error: { message: 'Admin access required' }
      });
    }

    const count = await expireOldSubscriptions();

    res.json({
      success: true,
      message: `Expired ${count} subscriptions`,
      count
    });
  } catch (err) {
    console.error('Manual expire error:', err);
    res.status(500).json({
      success: false,
      error: { message: 'Failed to expire subscriptions' }
    });
  }
});

module.exports = router;