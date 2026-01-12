// routes/trips.routes.js
// Unified router: trip requests, driver matching, acceptance, and full trip lifecycle
const express = require('express');
const router = express.Router();
const mongoose = require('mongoose');
const User = require('../models/user.model');
const TripRequest = require('../models/tripRequest.model');
const Trip = require('../models/trip.model');
const Wallet = require('../models/wallet.model');
const Transaction = require('../models/transaction.model');
const Settings = require('../models/settings.model');
const { requireAuth } = require('../middleware/auth');
const { validateCoordinates, validateServiceType } = require('../middleware/validation');
const { isLuxury } = require('../constants/serviceTypes');
const { calculateFare } = require('../utils/pricingCalculator');
const emitter = require('../utils/eventEmitter');

// ========================
// 1. PASSENGER: CREATE TRIP REQUEST & FIND DRIVERS
// ========================
router.post('/request', requireAuth, async (req, res, next) => {
  try {
    const passengerId = req.user.sub;
    const { pickup, serviceType, paymentMethod = 'wallet', radiusMeters = 5000, limit = 10 } = req.body;
    
    if (!pickup || !validateCoordinates(pickup.coordinates)) {
      return res.status(400).json({ error: { message: 'Invalid pickup coordinates' } });
    }
    if (!validateServiceType(serviceType)) {
      return res.status(400).json({ error: { message: 'Invalid serviceType' } });
    }

    const [lng, lat] = pickup.coordinates;
    const now = new Date();

    const nearbyDrivers = await User.find({
      'roles.isDriver': true,
      'driverProfile.isAvailable': true,
      'driverProfile.verified': true,
      'driverProfile.verificationState': 'approved',
      'driverProfile.location': {
        $near: {
          $geometry: { type: 'Point', coordinates: [lng, lat] },
          $maxDistance: radiusMeters
        }
      }
    }).limit(limit).lean();

    const candidates = [];
    for (const driver of nearbyDrivers) {
      const supportsService = driver.driverProfile.serviceCategories?.includes(serviceType);
      if (!supportsService && !isLuxury(serviceType)) continue;

      if (!isLuxury(serviceType)) {
        const sub = driver.subscription;
        if (!sub?.expiresAt || new Date(sub.expiresAt) <= now) continue;
      }

      candidates.push({ driverId: driver._id, status: 'pending' });
    }

    let tripRequest;
    if (candidates.length === 0) {
      tripRequest = await TripRequest.create({
        passengerId,
        pickup,
        serviceType,
        paymentMethod,
        candidates: [],
        status: 'no_drivers',
        expiresAt: new Date(now.getTime() + 60 * 1000)
      });

      // Emit no drivers found notification
      emitter.emit('notification', {
        userId: passengerId,
        type: 'no_driver_found',
        title: 'No Drivers Available',
        body: 'No drivers are available at this time. Please try again later.',
        data: { requestId: tripRequest._id }
      });

      return res.json({ requestId: tripRequest._id, message: 'No drivers available' });
    }

    tripRequest = await TripRequest.create({
      passengerId,
      pickup,
      serviceType,
      paymentMethod,
      candidates,
      status: 'searching',
      expiresAt: new Date(now.getTime() + 5 * 60 * 1000) // 5 minutes
    });

    console.log(`✅ Trip request created: ${tripRequest._id} with ${candidates.length} candidates`);

    // Start sequential offering
    if (candidates.length > 0) {
      await offerToNext(tripRequest._id);
    }

    res.json({ requestId: tripRequest._id, candidatesCount: candidates.length });
  } catch (err) {
    next(err);
  }
});

// ========================
// NEW: GET TRIP REQUEST STATUS (for polling)
// ========================
router.get('/request/:requestId', requireAuth, async (req, res, next) => {
  try {
    const userId = req.user.sub;
    const { requestId } = req.params;
    
    const tripRequest = await TripRequest.findById(requestId)
      .populate('passengerId', 'name phone')
      .populate('assignedDriverId', 'name phone driverProfile')
      .lean();
    
    if (!tripRequest) {
      return res.status(404).json({ error: { message: 'Trip request not found' } });
    }

    // Check authorization
    if (tripRequest.passengerId._id.toString() !== userId) {
      return res.status(403).json({ error: { message: 'Unauthorized' } });
    }

    // If assigned, also fetch the actual Trip record
    let trip = null;
    if (tripRequest.status === 'assigned' && tripRequest.assignedDriverId) {
      trip = await Trip.findOne({ 
        tripRequestId: tripRequest._id 
      }).lean();
    }

    res.json({ 
      trip: {
        ...tripRequest,
        _id: trip?._id || tripRequest._id,
        status: trip?.status || tripRequest.status,
        assignedDriverId: tripRequest.assignedDriverId
      }
    });
  } catch (err) {
    next(err);
  }
});

// ========================
// INTERNAL: Offer to next pending driver + 20s timeout
// ========================
async function offerToNext(requestId) {
  const tripRequest = await TripRequest.findById(requestId);
  if (!tripRequest || tripRequest.status !== 'searching') return;

  const nextIdx = tripRequest.candidates.findIndex(c => c.status === 'pending');
  if (nextIdx === -1) {
    tripRequest.status = 'no_drivers';
    await tripRequest.save();
    
    emitter.emit('notification', {
      userId: tripRequest.passengerId,
      type: 'no_driver_found',
      title: 'No drivers available',
      body: 'Please try again later',
      data: { requestId: tripRequest._id }
    });
    return;
  }

  tripRequest.candidates[nextIdx].status = 'offered';
  tripRequest.candidates[nextIdx].offeredAt = new Date();
  await tripRequest.save();

  const driverId = tripRequest.candidates[nextIdx].driverId;
  
  console.log(`📤 Offering trip ${requestId} to driver ${driverId}`);
  
  emitter.emit('notification', {
    userId: driverId,
    type: 'trip_offered',
    title: 'New Trip Request',
    body: `New ${tripRequest.serviceType} ride nearby`,
    data: { 
      requestId: tripRequest._id,
      serviceType: tripRequest.serviceType 
    }
  });

  // Timeout: 20 seconds → auto-reject and try next
  setTimeout(async () => {
    const fresh = await TripRequest.findById(requestId);
    if (!fresh || fresh.status !== 'searching') return;
    
    const cand = fresh.candidates.find(c => c.driverId.toString() === driverId.toString());
    if (cand && cand.status === 'offered') {
      cand.status = 'rejected';
      await fresh.save();
      console.log(`⏱️ Driver ${driverId} timeout, moving to next candidate`);
      await offerToNext(requestId); // recursive next
    }
  }, 20000);
}

// ========================
// 2. DRIVER: ACCEPT TRIP
// ========================
router.post('/accept', requireAuth, async (req, res, next) => {
  try {
    const driverId = req.user.sub;
    const { requestId } = req.body;

    const tripRequest = await TripRequest.findById(requestId);
    if (!tripRequest || tripRequest.status !== 'searching') {
      return res.status(400).json({ error: { message: 'Trip no longer available' } });
    }

    const candidate = tripRequest.candidates.find(
      c => c.driverId.toString() === driverId && c.status === 'offered'
    );
    if (!candidate) {
      return res.status(403).json({ error: { message: 'You were not offered this trip' } });
    }

    const session = await mongoose.startSession();
    let newTrip;
    
    await session.withTransaction(async () => {
      tripRequest.assignedDriverId = driverId;
      tripRequest.status = 'assigned';
      candidate.status = 'accepted';
      await tripRequest.save({ session });

      const fareData = await calculateFare({ 
        serviceType: tripRequest.serviceType, 
        distanceKm: 0, 
        durationMinutes: 0 
      });

      const tripDoc = await Trip.create([{
        passengerId: tripRequest.passengerId,
        driverId,
        tripRequestId: tripRequest._id,
        serviceType: tripRequest.serviceType,
        paymentMethod: tripRequest.paymentMethod,
        pickupLocation: tripRequest.pickup,
        status: 'assigned', // Changed from 'pending' to 'assigned'
        estimatedFare: fareData.baseAmount,
        requestedAt: new Date()
      }], { session });

      newTrip = tripDoc[0];

      await User.findByIdAndUpdate(driverId, {
        'driverProfile.isAvailable': false,
        'driverProfile.currentTripId': newTrip._id
      }, { session });
    });

    await session.endSession();

    console.log(`✅ Driver ${driverId} accepted trip ${tripRequest._id}, created Trip ${newTrip._id}`);

    // Emit trip_accepted event to PASSENGER with correct data structure
    emitter.emit('notification', {
      userId: tripRequest.passengerId,
      type: 'trip_accepted',
      title: 'Driver Accepted!',
      body: 'Your driver is on the way',
      data: { 
        requestId: tripRequest._id.toString(),
        tripId: newTrip._id.toString(),
        driverId: driverId.toString()
      }
    });

    // Emit to driver
    emitter.emit('notification', {
      userId: driverId,
      type: 'trip_accepted',
      title: 'Trip Accepted',
      body: 'Go to pickup location',
      data: { 
        requestId: tripRequest._id.toString(),
        tripId: newTrip._id.toString()
      }
    });

    res.json({ 
      success: true, 
      message: 'Trip accepted and created',
      tripId: newTrip._id,
      requestId: tripRequest._id
    });
  } catch (err) {
    next(err);
  }
});

// ========================
// 3. DRIVER: REJECT TRIP
// ========================
router.post('/reject', requireAuth, async (req, res, next) => {
  try {
    const driverId = req.user.sub;
    const { requestId } = req.body;

    const tripRequest = await TripRequest.findById(requestId);
    if (!tripRequest || tripRequest.status !== 'searching') {
      return res.status(400).json({ error: { message: 'Trip no longer searching' } });
    }

    const candidate = tripRequest.candidates.find(
      c => c.driverId.toString() === driverId && c.status === 'offered'
    );
    if (!candidate) {
      return res.status(403).json({ error: { message: 'You were not offered this trip' } });
    }

    candidate.status = 'rejected';
    await tripRequest.save();

    console.log(`❌ Driver ${driverId} rejected trip ${requestId}`);

    await offerToNext(requestId); // Try next driver

    res.json({ success: true });
  } catch (err) {
    next(err);
  }
});

// ========================
// 4. TRIP LIFECYCLE ENDPOINTS
// ========================

// Start trip (driver)
router.post('/:tripId/start', requireAuth, async (req, res, next) => {
  try {
    const driverId = req.user.sub;
    const trip = await Trip.findById(req.params.tripId);
    
    if (!trip) return res.status(404).json({ error: { message: 'Trip not found' } });
    if (trip.driverId.toString() !== driverId) return res.status(403).json({ error: { message: 'Unauthorized' } });
    if (!['assigned', 'pending'].includes(trip.status)) {
      return res.status(400).json({ error: { message: 'Trip cannot be started from current state' } });
    }

    trip.status = 'started';
    trip.startedAt = new Date();
    await trip.save();

    console.log(`🚗 Trip ${trip._id} started by driver ${driverId}`);

    emitter.emit('notification', {
      userId: trip.passengerId,
      type: 'trip_started',
      title: 'Trip Started',
      body: 'Your driver has started the trip',
      data: { tripId: trip._id }
    });

    res.json({ trip });
  } catch (err) {
    next(err);
  }
});

// Update trip progress (driver only)
router.patch('/:tripId/progress', requireAuth, async (req, res, next) => {
  try {
    const driverId = req.user.sub;
    const { status, distanceKm, durationMinutes, dropoffLocation } = req.body;
    
    const trip = await Trip.findById(req.params.tripId);
    if (!trip) return res.status(404).json({ error: { message: 'Trip not found' } });
    if (trip.driverId.toString() !== driverId) return res.status(403).json({ error: { message: 'Only driver can update' } });
    if (['completed', 'cancelled'].includes(trip.status)) {
      return res.status(400).json({ error: { message: 'Trip already finished' } });
    }

    if (status && ['started', 'in_progress'].includes(status)) trip.status = status;
    if (typeof distanceKm === 'number' && distanceKm >= 0) trip.distanceKm = distanceKm;
    if (typeof durationMinutes === 'number' && durationMinutes >= 0) trip.durationMinutes = durationMinutes;
    if (dropoffLocation && validateCoordinates(dropoffLocation.coordinates)) {
      trip.dropoffLocation = { type: 'Point', coordinates: dropoffLocation.coordinates };
    }

    await trip.save();

    res.json({ trip });
  } catch (err) {
    next(err);
  }
});

// Complete trip (driver) — full payment processing
router.post('/:tripId/complete', requireAuth, async (req, res, next) => {
  try {
    const driverId = req.user.sub;
    const trip = await Trip.findById(req.params.tripId);
    
    if (!trip) return res.status(404).json({ error: { message: 'Trip not found' } });
    if (trip.driverId.toString() !== driverId) return res.status(403).json({ error: { message: 'Only driver can complete' } });
    if (['completed', 'cancelled'].includes(trip.status)) {
      return res.status(400).json({ error: { message: 'Trip already finished' } });
    }

    // Calculate final fare
    const pickupCoords = trip.pickupLocation?.coordinates || null;
    const dropoffCoords = trip.dropoffLocation?.coordinates || null;
    
    const fareData = await calculateFare({
      serviceType: trip.serviceType,
      distanceKm: trip.distanceKm,
      durationMinutes: trip.durationMinutes,
      pickupCoordinates: pickupCoords,
      dropoffCoordinates: dropoffCoords
    });

    trip.finalFare = fareData.baseAmount;

    // Commission for luxury only
    let commission = 0;
    if (isLuxury(trip.serviceType)) {
      const setting = await Settings.findOne({ key: 'commission_percent' }).lean();
      const percent = setting?.value ? Number(setting.value) : 10;
      commission = Math.round((percent / 100) * trip.finalFare);
    }

    trip.commission = commission;
    trip.driverEarnings = trip.finalFare - commission;

    // Payment handling
    if (trip.paymentMethod === 'cash') {
      await Transaction.create({
        userId: trip.passengerId,
        type: 'trip_payment',
        amount: trip.finalFare,
        reference: trip._id,
        status: 'pending',
        meta: { driverId, serviceType: trip.serviceType, collectionMethod: 'cash' }
      });

      trip.status = 'completed';
      trip.completedAt = new Date();
      await trip.save();

      await User.findByIdAndUpdate(driverId, {
        'driverProfile.isAvailable': true,
        $unset: { 'driverProfile.currentTripId': '' }
      });

      emitter.emit('notification', { 
        userId: trip.passengerId, 
        type: 'trip_completed', 
        title: 'Trip completed (cash)', 
        body: `Pay driver ₦${Math.floor(trip.finalFare / 100)}`,
        data: { tripId: trip._id }
      });
      
      emitter.emit('notification', { 
        userId: driverId, 
        type: 'trip_completed', 
        title: 'Confirm cash', 
        body: 'Confirm collection via /confirm-cash',
        data: { tripId: trip._id }
      });

      return res.json({ trip, fareDetail: { finalFare: trip.finalFare, commission, driverEarnings: trip.driverEarnings } });
    }

    // Wallet payment
    const passengerWallet = await Wallet.findOne({ owner: trip.passengerId }).lean();
    if (!passengerWallet || passengerWallet.balance < trip.finalFare) {
      return res.status(402).json({ error: { message: 'Insufficient wallet balance' } });
    }

    await Wallet.findOneAndUpdate({ owner: trip.passengerId }, { $inc: { balance: -trip.finalFare } });
    await Wallet.findOneAndUpdate({ owner: driverId }, { $inc: { balance: trip.driverEarnings } }, { upsert: true });

    await Transaction.create({
      userId: trip.passengerId,
      type: 'trip_payment',
      amount: trip.finalFare,
      reference: trip._id,
      status: 'success',
      meta: { driverId, serviceType: trip.serviceType }
    });

    if (commission > 0) {
      await Transaction.create({ 
        userId: null, 
        type: 'commission', 
        amount: commission, 
        reference: trip._id, 
        status: 'success' 
      });
    }

    trip.status = 'completed';
    trip.completedAt = new Date();
    await trip.save();

    await User.findByIdAndUpdate(driverId, {
      'driverProfile.isAvailable': true,
      $unset: { 'driverProfile.currentTripId': '' }
    });

    console.log(`✅ Trip ${trip._id} completed`);

    emitter.emit('notification', { 
      userId: trip.passengerId, 
      type: 'trip_completed', 
      title: 'Trip completed', 
      body: `Charged ₦${Math.floor(trip.finalFare / 100)}`,
      data: { tripId: trip._id }
    });
    
    emitter.emit('notification', { 
      userId: driverId, 
      type: 'trip_completed', 
      title: 'Earnings', 
      body: `You earned ₦${Math.floor(trip.driverEarnings / 100)}`,
      data: { tripId: trip._id }
    });

    res.json({ trip, fareDetail: { finalFare: trip.finalFare, commission, driverEarnings: trip.driverEarnings } });
  } catch (err) {
    next(err);
  }
});

// Cancel trip (passenger or driver)
router.post('/:tripId/cancel', requireAuth, async (req, res, next) => {
  try {
    const userId = req.user.sub;
    const { reason } = req.body;
    
    const trip = await Trip.findById(req.params.tripId);
    if (!trip) return res.status(404).json({ error: { message: 'Trip not found' } });
    
    if (![trip.passengerId.toString(), trip.driverId?.toString()].includes(userId)) {
      return res.status(403).json({ error: { message: 'Unauthorized' } });
    }

    if (['completed', 'cancelled'].includes(trip.status)) {
      return res.status(400).json({ error: { message: 'Trip already finished' } });
    }

    trip.status = 'cancelled';
    trip.cancelledAt = new Date();
    trip.cancellationReason = reason || 'Cancelled by user';
    await trip.save();

    if (trip.driverId) {
      await User.findByIdAndUpdate(trip.driverId, {
        'driverProfile.isAvailable': true,
        $unset: { 'driverProfile.currentTripId': '' }
      });
    }

    const otherId = trip.passengerId.toString() === userId ? trip.driverId : trip.passengerId;
    const role = trip.passengerId.toString() === userId ? 'passenger' : 'driver';

    console.log(`❌ Trip ${trip._id} cancelled by ${role}`);

    emitter.emit('notification', {
      userId: otherId,
      type: 'trip_cancelled',
      title: 'Trip Cancelled',
      body: `Cancelled by ${role}. Reason: ${trip.cancellationReason}`,
      data: { tripId: trip._id }
    });

    res.json({ trip });
  } catch (err) {
    next(err);
  }
});

// Get single trip
router.get('/:tripId', requireAuth, async (req, res, next) => {
  try {
    const userId = req.user.sub;
    const trip = await Trip.findById(req.params.tripId).lean();
    
    if (!trip) return res.status(404).json({ error: { message: 'Trip not found' } });
    
    const isParticipant = [trip.passengerId.toString(), trip.driverId?.toString()].includes(userId);
    const isAdmin = (await User.findById(userId).lean())?.roles?.isAdmin;
    
    if (!isParticipant && !isAdmin) {
      return res.status(403).json({ error: { message: 'Unauthorized' } });
    }

    res.json({ trip });
  } catch (err) {
    next(err);
  }
});

// List user's trips
router.get('/', requireAuth, async (req, res, next) => {
  try {
    const userId = req.user.sub;
    const { role = 'passenger', status, limit = 50, offset = 0 } = req.query;
    
    const filter = role === 'driver' ? { driverId: userId } : { passengerId: userId };
    if (status) filter.status = status;

    const trips = await Trip.find(filter)
      .sort({ requestedAt: -1 })
      .limit(parseInt(limit))
      .skip(parseInt(offset))
      .lean();

    const total = await Trip.countDocuments(filter);

    res.json({ trips, total, limit: parseInt(limit), offset: parseInt(offset) });
  } catch (err) {
    next(err);
  }
});

// Driver confirms cash collection
router.post('/:tripId/confirm-cash', requireAuth, async (req, res, next) => {
  try {
    const driverId = req.user.sub;
    const trip = await Trip.findById(req.params.tripId);
    
    if (!trip || trip.driverId.toString() !== driverId) {
      return res.status(403).json({ error: { message: 'Unauthorized' } });
    }
    if (trip.paymentMethod !== 'cash') {
      return res.status(400).json({ error: { message: 'Not a cash trip' } });
    }

    const pendingTx = await Transaction.findOne({ 
      reference: trip._id, 
      type: 'trip_payment', 
      status: 'pending' 
    });
    
    if (!pendingTx) {
      return res.status(404).json({ error: { message: 'No pending cash transaction' } });
    }

    pendingTx.status = 'success';
    pendingTx.meta.collectedByDriver = true;
    pendingTx.meta.collectedAt = new Date();
    await pendingTx.save();

    await Wallet.findOneAndUpdate(
      { owner: driverId }, 
      { $inc: { balance: trip.driverEarnings } }, 
      { upsert: true }
    );

    if (trip.commission > 0) {
      await Transaction.create({ 
        userId: null, 
        type: 'commission', 
        amount: trip.commission, 
        reference: trip._id, 
        status: 'success' 
      });
    }

    res.json({ success: true, message: 'Cash confirmed and earnings credited' });
  } catch (err) {
    next(err);
  }
});

module.exports = router;