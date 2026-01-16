const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const { requireAdmin } = require('../middleware/adminGuard');
const User = require('../models/user.model');
const Pricing = require('../models/pricing.model');
const Settings = require('../models/settings.model');
const Transaction = require('../models/transaction.model');
const emitter = require('../utils/eventEmitter');
const { createAudit } = require('../utils/audit');
const Audit = require('../models/audit.model');

// --- Driver Approval ---

// List pending driver verifications
router.get('/pending', async (req, res, next) => {
  try {
    console.log('=== FETCHING PENDING DRIVERS ===');
    
    const query = {
      'roles.isDriver': true,
      'driverProfile.verificationState': 'pending'
    };
    
    console.log('Query:', JSON.stringify(query, null, 2));
    
    const drivers = await User.find(query)
      .select({
        name: 1,
        phone: 1,
        email: 1,
        createdAt: 1,
        updatedAt: 1,
        roles: 1,
        'driverProfile.vehicleMake': 1,
        'driverProfile.vehicleModel': 1,
        'driverProfile.vehicleNumber': 1,
        'driverProfile.nin': 1,
        'driverProfile.licenseNumber': 1,
        'driverProfile.serviceCategories': 1,
        'driverProfile.profilePicUrl': 1,
        'driverProfile.carPicUrl': 1,
        'driverProfile.ninImageUrl': 1,
        'driverProfile.licenseImageUrl': 1,
        'driverProfile.vehicleRegistrationUrl': 1,
        'driverProfile.verificationState': 1,
        'driverProfile.verified': 1,
        'driverProfile.submittedAt': 1,
      })
      .lean();

    console.log(`Found ${drivers.length} pending drivers`);
    
    // Log each driver for debugging
    drivers.forEach((driver, index) => {
      console.log(`\n--- Driver ${index + 1} ---`);
      console.log('ID:', driver._id);
      console.log('Name:', driver.name);
      console.log('Phone:', driver.phone);
      console.log('Has driverProfile?:', !!driver.driverProfile);
      console.log('Verification State:', driver.driverProfile?.verificationState);
      console.log('Vehicle Make:', driver.driverProfile?.vehicleMake);
      console.log('Service Categories:', driver.driverProfile?.serviceCategories);
    });

    // Transform the data
    const formattedDrivers = drivers.map(driver => ({
      _id: driver._id,
      name: driver.name || 'Not provided',
      phone: driver.phone || 'Not provided',
      submittedAt: driver.driverProfile?.submittedAt || driver.createdAt || 'Unknown',

      // Driver profile details
      vehicleMake: driver.driverProfile?.vehicleMake || 'Not provided',
      vehicleModel: driver.driverProfile?.vehicleModel || 'Not provided',
      vehicleNumber: driver.driverProfile?.vehicleNumber || 'Not provided',
      nin: driver.driverProfile?.nin || 'Not provided',
      licenseNumber: driver.driverProfile?.licenseNumber || 'Not provided',
      serviceCategories: driver.driverProfile?.serviceCategories || [],

      // Document URLs
      profilePicUrl: driver.driverProfile?.profilePicUrl || null,
      carPicUrl: driver.driverProfile?.carPicUrl || null,
      ninImageUrl: driver.driverProfile?.ninImageUrl || null,
      licenseImageUrl: driver.driverProfile?.licenseImageUrl || null,
      vehicleRegistrationUrl: driver.driverProfile?.vehicleRegistrationUrl || null,

      verificationState: driver.driverProfile?.verificationState || 'pending',
      verified: driver.driverProfile?.verified || false,
    }));

    console.log('\n=== FORMATTED PENDING DRIVERS ===');
    console.log(JSON.stringify(formattedDrivers, null, 2));

    res.json({
      success: true,
      drivers: formattedDrivers,
      total: formattedDrivers.length,
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    console.error('Error fetching pending drivers:', err);
    console.error('Error stack:', err.stack);
    res.status(500).json({
      error: {
        message: 'Failed to fetch pending drivers',
        details: err.message
      }
    });
  }
});

// Approve a driver
router.post('/drivers/:driverId/approve', async (req, res, next) => {
  try {
    const { driverId } = req.params;
    const driver = await User.findByIdAndUpdate(
      driverId,
      { $set: { 'driverProfile.verificationState': 'approved', 'driverProfile.verified': true } },
      { new: true }
    ).select('name driverProfile roles');
    if (!driver) return res.status(404).json({ error: { message: 'Driver not found' } });
    
    // emit event
    emitter.emit('notification', {
      userId: driverId,
      type: 'driver_verified',
      title: 'Profile verified',
      body: 'Your driver profile has been approved',
      data: { status: 'approved' }
    });
    // audit
    try {
      await createAudit({ adminId: req.user.sub, action: 'approve_driver', targetType: 'User', targetId: driverId, meta: { note: req.body.note || null }, ip: req.ip });
    } catch (e) {
      console.error('audit error', e.message || e);
    }

    res.json({ ok: true, driver });
  } catch (err) {
    next(err);
  }
});

// Reject a driver
router.post('/drivers/:driverId/reject', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const { driverId } = req.params;
    const { reason } = req.body;
    const driver = await User.findByIdAndUpdate(
      driverId,
      { $set: { 'driverProfile.verificationState': 'rejected', 'driverProfile.verified': false } },
      { new: true }
    ).select('name driverProfile roles');
    if (!driver) return res.status(404).json({ error: { message: 'Driver not found' } });
    
    // emit event
    emitter.emit('notification', {
      userId: driverId,
      type: 'driver_rejected',
      title: 'Profile rejected',
      body: `Your driver profile was not approved. Reason: ${reason || 'Not specified'}`,
      data: { status: 'rejected', reason }
    });
    // audit
    try {
      await createAudit({ adminId: req.user.sub, action: 'reject_driver', targetType: 'User', targetId: driverId, meta: { reason }, ip: req.ip });
    } catch (e) { console.error('audit error', e.message || e); }

    res.json({ ok: true, driver, reason });
  } catch (err) {
    next(err);
  }
});

// --- Pricing Management ---

// Create or update pricing rule for a service type
router.put('/pricing', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const { serviceType, model, baseFare, perKmRate, hourlyRate, dailyRate, interstatePerKmRate, active } = req.body;
    if (!serviceType || !model) return res.status(400).json({ error: { message: 'serviceType and model required' } });

    const pricing = await Pricing.findOneAndUpdate(
      { serviceType },
      { $set: { serviceType, model, baseFare, perKmRate, hourlyRate, dailyRate, interstatePerKmRate, active: active !== false } },
      { upsert: true, new: true }
    );
    // audit pricing change
    try { await createAudit({ adminId: req.user.sub, action: 'upsert_pricing', targetType: 'Pricing', targetId: pricing._id, meta: { serviceType, model }, ip: req.ip }); } catch (e) { console.error('audit error', e.message || e); }
    res.json({ pricing });
  } catch (err) {
    next(err);
  }
});

// Get pricing for a service type
router.get('/pricing/:serviceType', async (req, res, next) => {
  try {
    const { serviceType } = req.params;
    const pricing = await Pricing.findOne({ serviceType, active: true }).lean();
    if (!pricing) return res.status(404).json({ error: { message: 'Pricing not found' } });
    res.json({ pricing });
  } catch (err) {
    next(err);
  }
});

// List all active pricing
router.get('/pricing', async (req, res, next) => {
  try {
    const pricing = await Pricing.find({ active: true }).lean();
    res.json({ pricing });
  } catch (err) {
    next(err);
  }
});

// --- Commission Management ---

// Get or set platform commission
router.get('/commission', async (req, res, next) => {
  try {
    const setting = await Settings.findOne({ key: 'commission_percent' }).lean();
    const percent = setting && setting.value ? Number(setting.value) : (process.env.PLATFORM_COMMISSION_PERCENT || 10);
    res.json({ commissionPercent: percent });
  } catch (err) {
    next(err);
  }
});

router.post('/commission', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const { percent } = req.body;
    if (typeof percent !== 'number' || percent < 0 || percent > 100) {
      return res.status(400).json({ error: { message: 'Invalid commission percent (0-100)' } });
    }
    const setting = await Settings.findOneAndUpdate(
      { key: 'commission_percent' },
      { $set: { value: percent } },
      { upsert: true, new: true }
    );
    try { await createAudit({ adminId: req.user.sub, action: 'set_commission', targetType: 'Settings', targetId: setting._id, meta: { percent }, ip: req.ip }); } catch (e) { console.error('audit error', e.message || e); }
    res.json({ ok: true, commissionPercent: setting.value });
  } catch (err) {
    next(err);
  }
});

// --- Metrics ---

// Driver metrics
router.get('/metrics/drivers', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const totalDrivers = await User.countDocuments({ 'roles.isDriver': true });
    const verifiedDrivers = await User.countDocuments({ 'roles.isDriver': true, 'driverProfile.verified': true });
    const pendingVerification = await User.countDocuments({ 'driverProfile.verificationState': 'pending' });
    const availableDrivers = await User.countDocuments({ 'roles.isDriver': true, 'driverProfile.isAvailable': true });

    res.json({ totalDrivers, verifiedDrivers, pendingVerification, availableDrivers });
  } catch (err) {
    next(err);
  }
});

// Revenue metrics
router.get('/metrics/revenue', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const { startDate, endDate } = req.query;
    const filter = {};
    if (startDate) filter.createdAt = { $gte: new Date(startDate) };
    if (endDate) filter.createdAt = { ...filter.createdAt, $lte: new Date(endDate) };

    // total trip payments
    const tripPayments = await Transaction.aggregate([
      { $match: { ...filter, type: 'trip_payment', status: 'success' } },
      { $group: { _id: null, total: { $sum: '$amount' } } }
    ]);

    // total commissions
    const commissions = await Transaction.aggregate([
      { $match: { ...filter, type: 'commission', status: 'success' } },
      { $group: { _id: null, total: { $sum: '$amount' } } }
    ]);

    // total wallet topups
    const topups = await Transaction.aggregate([
      { $match: { ...filter, type: 'topup', status: 'success' } },
      { $group: { _id: null, total: { $sum: '$amount' } } }
    ]);

    res.json({
      tripPaymentsKobo: tripPayments[0]?.total || 0,
      commissionsKobo: commissions[0]?.total || 0,
      topupsKobo: topups[0]?.total || 0
    });
  } catch (err) {
    next(err);
  }
});

// Subscription metrics
router.get('/metrics/subscriptions', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const activeSubscriptions = await User.aggregate([
      {
        $match: {
          'roles.isDriver': true,
          'subscription.expiresAt': { $gt: new Date() }
        }
      },
      {
        $group: {
          _id: '$subscription.type',
          count: { $sum: 1 }
        }
      }
    ]);

    const totalByType = {};
    const daily = await User.countDocuments({ 'subscription.type': 'daily', 'subscription.expiresAt': { $gt: new Date() } });
    const weekly = await User.countDocuments({ 'subscription.type': 'weekly', 'subscription.expiresAt': { $gt: new Date() } });
    const monthly = await User.countDocuments({ 'subscription.type': 'monthly', 'subscription.expiresAt': { $gt: new Date() } });

    res.json({ daily, weekly, monthly, total: daily + weekly + monthly });
  } catch (err) {
    next(err);
  }
});

// --- Audit logs ---
// List audit entries (admin only)
router.get('/audit', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const { page = 1, limit = 50 } = req.query;
    const p = Math.max(1, Number(page));
    const l = Math.min(200, Number(limit) || 50);
    const docs = await Audit.find({}).sort({ createdAt: -1 }).skip((p - 1) * l).limit(l).lean();
    const total = await Audit.countDocuments();
    res.json({ total, page: p, limit: l, data: docs });
  } catch (err) {
    next(err);
  }
});

router.post('/force-cleanup-driver/:driverId',   async (req, res) => {
  try {
    await User.findByIdAndUpdate(req.params.driverId, {
      'driverProfile.isAvailable': true,
      $unset: { 'driverProfile.currentTripId': '' }
    });
    
    res.json({ success: true, message: 'Driver cleaned up' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});



module.exports = router;
