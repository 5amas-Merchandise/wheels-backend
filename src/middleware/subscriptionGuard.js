const User = require('../models/user.model');
const { isLuxury } = require('../constants/serviceTypes');

// Middleware factory that ensures driver has an active subscription for non-luxury services.
// It checks `req.body.serviceType`, `req.query.serviceType`, or an optional `serviceType` param.
function requireActiveSubscription(serviceTypeParam) {
  return async function (req, res, next) {
    try {
      const auth = req.user;
      if (!auth || !auth.sub) return res.status(401).json({ error: { message: 'Unauthorized' } });
      const user = await User.findById(auth.sub).lean();
      if (!user) return res.status(401).json({ error: { message: 'Unauthorized' } });

      // Allow admins
      if (user.roles && user.roles.isAdmin) return next();

      // Determine service type
      let serviceType = serviceTypeParam || req.body.serviceType || req.query.serviceType || (req.params && req.params.serviceType);
      if (!serviceType) return res.status(400).json({ error: { message: 'serviceType is required' } });

      // Luxury services don't require subscription
      if (isLuxury(serviceType)) return next();

      // Must be a driver
      if (!user.roles || !user.roles.isDriver) return res.status(403).json({ error: { message: 'Driver role required for this service' } });

      const sub = user.subscription;
      if (!sub || !sub.expiresAt) return res.status(402).json({ error: { message: 'Active subscription required' } });
      const now = new Date();
      if (new Date(sub.expiresAt) <= now) return res.status(402).json({ error: { message: 'Subscription expired' } });

      // allowed
      return next();
    } catch (err) {
      return next(err);
    }
  };
}

module.exports = { requireActiveSubscription };
