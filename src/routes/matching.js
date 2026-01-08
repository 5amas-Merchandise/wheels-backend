const express = require('express');
const router = express.Router();
const User = require('../models/user.model');
const TripRequest = require('../models/tripRequest.model');
const { requireAuth } = require('../middleware/auth');
const { SERVICE_TYPES, isLuxury } = require('../constants/serviceTypes');
const { validateServiceType, validateCoordinates } = require('../middleware/validation');
const emitter = require('../utils/eventEmitter');
const { calculateFare } = require('../utils/pricingCalculator');

// Create a trip request and find nearest eligible drivers
router.post('/request', requireAuth, async (req, res, next) => {
  try {
    const passengerId = req.user && req.user.sub;
    if (!passengerId) return res.status(401).json({ error: { message: 'Unauthorized' } });

    const { pickup, serviceType, paymentMethod = 'wallet', radiusMeters = 5000, limit = 10 } = req.body;
    if (!pickup || !validateCoordinates(pickup.coordinates)) {
      return res.status(400).json({ error: { message: 'pickup must be GeoJSON Point with valid coordinates [lng, lat]' } });
    }
    if (!serviceType || !validateServiceType(serviceType)) return res.status(400).json({ error: { message: 'Invalid serviceType' } });

    const [lng, lat] = pickup.coordinates;

    // Base query for drivers
    const now = new Date();
    const baseQuery = {
      'roles.isDriver': true,
      'driverProfile.isAvailable': true,
      'driverProfile.verified': true
    };

    // For non-luxury services require active subscription
    // We'll fetch candidates then filter by subscription/status and serviceCategories

    const nearbyDrivers = await User.find(Object.assign({}, baseQuery, {
      'driverProfile.location': {
        $near: {
          $geometry: { type: 'Point', coordinates: [lng, lat] },
          $maxDistance: radiusMeters
        }
      }
    })).limit(limit).lean();

    // filter eligibility
    const candidates = [];
    for (const d of nearbyDrivers) {
      // service category check: driver must accept this service or service is luxury
      const supports = Array.isArray(d.driverProfile && d.driverProfile.serviceCategories) && d.driverProfile.serviceCategories.includes(serviceType);
      if (!supports && !isLuxury(serviceType)) continue;

      // verification
      if (d.driverProfile && d.driverProfile.verificationState !== 'approved') continue;

      // subscription enforcement for non-luxury
      if (!isLuxury(serviceType)) {
        const sub = d.subscription;
        if (!sub || !sub.expiresAt || new Date(sub.expiresAt) <= now) continue;
      }

      // compute rough distance via Haversine? For now mongoose $near already orders by distance but we'll keep field
      candidates.push({ driverId: d._id, distanceMeters: null, status: 'pending' });
    }

    if (candidates.length === 0) {
      const tr = await TripRequest.create({ passengerId, pickup, serviceType, candidates: [], status: 'no_drivers', expiresAt: new Date(now.getTime() + 60 * 1000) });
      return res.status(200).json({ requestId: tr._id, message: 'No drivers available' });
    }

    // create trip request with candidates
    const expiresAt = new Date(now.getTime() + 5 * 60 * 1000); // 5 minutes search expiry
    const trip = await TripRequest.create({ passengerId, pickup, serviceType, paymentMethod, candidates, expiresAt });

    // Offer to first candidate immediately (system will call /offer to simulate dispatching)
    console.log(`TripRequest ${trip._id} created with ${candidates.length} candidates`);

    // emit event for matching
    emitter.emit('notification', {
      userId: passengerId,
      type: 'trip_offered',
      title: 'Drivers found',
      body: `${candidates.length} drivers available`,
      data: { tripId: trip._id }
    });

    res.json({ requestId: trip._id, candidates: trip.candidates.map(c => ({ driverId: c.driverId })) });
  } catch (err) {
    next(err);
  }
});

// System: offer to next candidate for a trip (simulate dispatch)
router.post('/offer/:requestId', async (req, res, next) => {
  try {
    const { requestId } = req.params;
    const trip = await TripRequest.findById(requestId);
    if (!trip) return res.status(404).json({ error: { message: 'TripRequest not found' } });
    if (trip.status !== 'searching') return res.status(400).json({ error: { message: 'Trip not in searching state' } });

    // find next pending candidate
    const idx = trip.candidates.findIndex(c => c.status === 'pending');
    if (idx === -1) return res.status(400).json({ error: { message: 'No pending candidates' } });

    trip.candidates[idx].status = 'offered';
    trip.candidates[idx].offeredAt = new Date();
    await trip.save();

    // mock notification
    console.log(`Offered Trip ${trip._id} to driver ${trip.candidates[idx].driverId}`);

    // emit event: driver is offered trip
    emitter.emit('notification', {
      userId: trip.candidates[idx].driverId,
      type: 'trip_offered',
      title: 'New trip available',
      body: `${trip.serviceType} ride available`,
      data: { tripId: trip._id, serviceType: trip.serviceType }
    });

    res.json({ ok: true, offeredTo: trip.candidates[idx].driverId });
  } catch (err) {
    next(err);
  }
});

// Driver accepts an offered trip
router.post('/accept', requireAuth, async (req, res, next) => {
  try {
    const driverId = req.user && req.user.sub;
    if (!driverId) return res.status(401).json({ error: { message: 'Unauthorized' } });
    const { requestId } = req.body;
    if (!requestId) return res.status(400).json({ error: { message: 'requestId is required' } });

    // atomic check: ensure trip not assigned
    const trip = await TripRequest.findById(requestId);
    if (!trip) return res.status(404).json({ error: { message: 'TripRequest not found' } });
    if (trip.status !== 'searching') return res.status(400).json({ error: { message: 'Trip not available' } });

    // find candidate entry
    const cand = trip.candidates.find(c => c.driverId.toString() === driverId.toString());
    if (!cand) return res.status(403).json({ error: { message: 'Driver not a candidate for this trip' } });
    if (cand.status !== 'offered') return res.status(400).json({ error: { message: 'Driver was not offered or already acted' } });

    // assign driver
    trip.assignedDriverId = driverId;
    trip.status = 'assigned';
    cand.status = 'accepted';
    await trip.save();

    // mark driver unavailable
    await User.findByIdAndUpdate(driverId, { 'driverProfile.isAvailable': false, 'driverProfile.currentTripId': trip._id });

    console.log(`Driver ${driverId} accepted Trip ${trip._id}`);

    // Auto-create Trip record so passenger/driver have an instantiated trip
    try {
      const fareData = await calculateFare({ serviceType: trip.serviceType, distanceKm: 0, durationMinutes: 0 });
      const Trip = require('../models/trip.model');
      const newTrip = await Trip.create({
        passengerId: trip.passengerId,
        driverId: driverId,
        tripRequestId: trip._id,
        serviceType: trip.serviceType,
        paymentMethod: trip.paymentMethod || 'wallet',
        pickupLocation: trip.pickup,
        status: 'pending',
        estimatedFare: fareData.baseAmount
      });

      // attach currentTripId to driver
      await User.findByIdAndUpdate(driverId, { 'driverProfile.currentTripId': newTrip._id, 'driverProfile.isAvailable': false });
    } catch (e) {
      console.error('Failed to auto-create Trip after accept:', e.message || e);
    }

    // emit event: passenger, driver accept
    emitter.emit('notification', {
      userId: trip.passengerId,
      type: 'trip_accepted',
      title: 'Driver accepted',
      body: 'Your driver is on the way',
      data: { tripId: trip._id, driverId }
    });

    emitter.emit('notification', {
      userId: driverId,
      type: 'trip_accepted',
      title: 'Trip accepted',
      body: 'You have accepted a trip',
      data: { tripId: trip._id }
    });

    res.json({ ok: true, assignedDriverId: driverId });
  } catch (err) {
    next(err);
  }
});

// Get trip status
router.get('/:requestId', requireAuth, async (req, res, next) => {
  try {
    const { requestId } = req.params;
    const trip = await TripRequest.findById(requestId).lean();
    if (!trip) return res.status(404).json({ error: { message: 'TripRequest not found' } });
    res.json({ trip });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
