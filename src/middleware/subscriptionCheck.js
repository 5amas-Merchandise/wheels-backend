// middleware/subscriptionCheck.js

const User = require('../models/user.model');
const Subscription = require('../models/subscription.model');

/**
 * Middleware to check if driver has active subscription
 * This should be used on endpoints where drivers need active subscription
 * Example: Before accepting rides, going online, etc.
 */
async function requireActiveSubscription(req, res, next) {
  try {
    const driverId = req.user.sub;

    // Get driver
    const driver = await User.findById(driverId)
      .select('roles driverProfile')
      .lean();

    if (!driver) {
      return res.status(404).json({
        success: false,
        error: { 
          message: 'Driver not found',
          code: 'DRIVER_NOT_FOUND'
        }
      });
    }

    // Check if user is actually a driver
    if (!driver.roles?.isDriver) {
      return res.status(403).json({
        success: false,
        error: { 
          message: 'User is not a driver',
          code: 'NOT_A_DRIVER'
        }
      });
    }

    // Check for active subscription
    const activeSubscription = await Subscription.findOne({
      driverId,
      status: 'active',
      expiresAt: { $gt: new Date() }
    });

    if (!activeSubscription) {
      return res.status(403).json({
        success: false,
        error: { 
          message: 'No active subscription. Please subscribe to accept rides.',
          code: 'NO_ACTIVE_SUBSCRIPTION',
          action: 'SUBSCRIBE_NOW'
        }
      });
    }

    // Attach subscription info to request for use in route handlers
    req.subscription = {
      id: activeSubscription._id,
      vehicleType: activeSubscription.vehicleType,
      expiresAt: activeSubscription.expiresAt,
      plan: activeSubscription.plan
    };

    next();

  } catch (err) {
    console.error('Subscription check error:', err);
    res.status(500).json({
      success: false,
      error: { 
        message: 'Failed to verify subscription',
        code: 'SUBSCRIPTION_CHECK_FAILED'
      }
    });
  }
}

/**
 * Soft check - attaches subscription status but doesn't block request
 * Useful for informational endpoints
 */
async function checkSubscriptionStatus(req, res, next) {
  try {
    const driverId = req.user?.sub;

    if (!driverId) {
      req.subscriptionStatus = {
        hasSubscription: false,
        isActive: false
      };
      return next();
    }

    const activeSubscription = await Subscription.findOne({
      driverId,
      status: 'active',
      expiresAt: { $gt: new Date() }
    });

    if (activeSubscription) {
      req.subscriptionStatus = {
        hasSubscription: true,
        isActive: true,
        subscription: {
          id: activeSubscription._id,
          vehicleType: activeSubscription.vehicleType,
          expiresAt: activeSubscription.expiresAt,
          plan: activeSubscription.plan,
          timeRemaining: Math.max(0, activeSubscription.expiresAt - new Date())
        }
      };
    } else {
      req.subscriptionStatus = {
        hasSubscription: false,
        isActive: false
      };
    }

    next();

  } catch (err) {
    console.error('Subscription status check error:', err);
    req.subscriptionStatus = {
      hasSubscription: false,
      isActive: false,
      error: err.message
    };
    next();
  }
}

module.exports = {
  requireActiveSubscription,
  checkSubscriptionStatus
};