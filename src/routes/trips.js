// routes/trips.js - COMPLETE FINAL VERSION WITH AUTO-CLEANUP
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

// ==========================================
// REJECTION TRACKING & AUTO-CLEANUP
// ==========================================

const tripRejectionCounts = new Map(); // Map<requestId, rejectionCount>

/**
 * Cleanup a trip request that couldn't find a driver
 */
async function cleanupFailedTripRequest(requestId) {
  try {
    console.log(`🧹 Cleaning up failed trip request: ${requestId}`);
    
    const tripRequest = await TripRequest.findById(requestId);
    if (!tripRequest) {
      console.log(`⚠️ Trip request ${requestId} not found for cleanup`);
      tripRejectionCounts.delete(requestId.toString());
      return;
    }

    // Mark all remaining candidates as rejected
    tripRequest.candidates.forEach(candidate => {
      if (candidate.status === 'offered' || candidate.status === 'pending') {
        candidate.status = 'rejected';
        candidate.rejectedAt = new Date();
        candidate.rejectionReason = 'max_attempts_reached';
      }
    });

    tripRequest.status = 'no_drivers';
    await tripRequest.save();

    // Notify passenger
    emitter.emit('notification', {
      userId: tripRequest.passengerId.toString(),
      type: 'no_driver_found',
      title: 'No Drivers Available',
      body: 'Unable to find a driver after multiple attempts. Please try again later.',
      data: { 
        requestId: tripRequest._id,
        reason: 'max_rejections_reached'
      }
    });

    // Remove from tracking
    tripRejectionCounts.delete(requestId.toString());

    console.log(`✅ Trip request ${requestId} marked as no_drivers and cleaned up`);

    // Delete after 5 minutes
    setTimeout(async () => {
      try {
        await TripRequest.findByIdAndDelete(requestId);
        console.log(`🗑️ Deleted failed trip request: ${requestId}`);
      } catch (delErr) {
        console.error(`❌ Error deleting trip request ${requestId}:`, delErr);
      }
    }, 5 * 60 * 1000); // 5 minutes

  } catch (err) {
    console.error(`❌ Error cleaning up trip request ${requestId}:`, err);
  }
}

/**
 * Track rejection and cleanup if threshold reached
 */
function trackRejection(requestId) {
  const id = requestId.toString();
  const currentCount = tripRejectionCounts.get(id) || 0;
  const newCount = currentCount + 1;
  
  tripRejectionCounts.set(id, newCount);
  
  console.log(`📊 Trip ${id} rejection count: ${newCount}/5`);
  
  if (newCount >= 5) {
    console.log(`🚫 Trip ${id} reached max rejections (5), initiating cleanup`);
    cleanupFailedTripRequest(requestId);
    return true; // Cleanup triggered
  }
  
  return false; // Continue to next driver
}

// ==========================================
// HELPER FUNCTIONS
// ==========================================

function calculateDistance(lat1, lon1, lat2, lon2) {
  const R = 6371000;
  const dLat = toRad(lat2 - lat1);
  const dLon = toRad(lon2 - lon1);
  const a = Math.sin(dLat/2) * Math.sin(dLat/2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
    Math.sin(dLon/2) * Math.sin(dLon/2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
  return R * c;
}

function toRad(degrees) {
  return degrees * Math.PI / 180;
}

// ==========================================
// POST /trips/request - CREATE TRIP REQUEST
// ==========================================

router.post('/request', requireAuth, async (req, res, next) => {
  try {
    const passengerId = req.user.sub;
    const { 
      pickup, 
      dropoff,
      serviceType, 
      paymentMethod = 'wallet', 
      radiusMeters = 5000, 
      limit = 10,
      estimatedFare,
      distance,
      duration,
      pickupAddress,
      dropoffAddress
    } = req.body;

    console.log('🚗 === NEW TRIP REQUEST ===');
    console.log('Passenger ID:', passengerId);
    console.log('Service Type:', serviceType);
    console.log('Estimated Fare:', estimatedFare);
    console.log('Distance:', distance, 'km');

    if (!pickup || !validateCoordinates(pickup.coordinates)) {
      return res.status(400).json({ error: { message: 'Invalid pickup coordinates' } });
    }

    if (!validateServiceType(serviceType)) {
      return res.status(400).json({ error: { message: 'Invalid serviceType' } });
    }

    const [lng, lat] = pickup.coordinates;
    const now = new Date();
    const searchRadius = radiusMeters || 5000;
    const fiveMinutesAgo = new Date(now.getTime() - 5 * 60 * 1000);

    console.log(`📍 Searching for drivers near [${lat}, ${lng}] within ${searchRadius}m`);

    // Find nearby drivers
    let nearbyDrivers;
    try {
      nearbyDrivers = await User.find({
        'roles.isDriver': true,
        'driverProfile.verified': true,
        'driverProfile.verificationState': 'approved',
        'driverProfile.isAvailable': true,
        'driverProfile.lastSeen': { $gte: fiveMinutesAgo },
        'driverProfile.location': {
          $near: {
            $geometry: { 
              type: 'Point', 
              coordinates: [lng, lat]
            },
            $maxDistance: searchRadius
          }
        }
      })
      .select('_id name driverProfile subscription')
      .limit(limit || 10)
      .lean();
    } catch (geoError) {
      console.error('❌ Geospatial query error:', geoError.message);
      
      const allAvailableDrivers = await User.find({
        'roles.isDriver': true,
        'driverProfile.verified': true,
        'driverProfile.verificationState': 'approved',
        'driverProfile.isAvailable': true,
        'driverProfile.lastSeen': { $gte: fiveMinutesAgo },
        'driverProfile.location': { $exists: true }
      })
      .select('_id name driverProfile subscription')
      .lean();

      nearbyDrivers = allAvailableDrivers
        .map(driver => {
          const driverCoords = driver.driverProfile?.location?.coordinates;
          if (!driverCoords || driverCoords.length !== 2) return null;
          
          const [driverLng, driverLat] = driverCoords;
          const dist = calculateDistance(lat, lng, driverLat, driverLng);
          
          return { ...driver, _distance: dist };
        })
        .filter(d => d && d._distance <= searchRadius)
        .sort((a, b) => a._distance - b._distance)
        .slice(0, limit || 10);
    }

    console.log(`📊 Found ${nearbyDrivers?.length || 0} nearby drivers`);

    // Filter candidates
    const candidates = [];
    for (const driver of (nearbyDrivers || [])) {
      const supportsService = driver.driverProfile?.serviceCategories?.includes(serviceType);
      
      if (!isLuxury(serviceType)) {
        const sub = driver.subscription;
        if (!sub?.expiresAt || new Date(sub.expiresAt) <= now) {
          console.log(`   ⚠️ Driver ${driver._id} subscription expired`);
          continue;
        }
      }

      candidates.push({ 
        driverId: driver._id, 
        status: 'pending',
        driverName: driver.name,
        offeredAt: null
      });
    }

    console.log(`✅ ${candidates.length} drivers qualified as candidates`);

    let tripRequest;
    if (candidates.length === 0) {
      tripRequest = await TripRequest.create({
        passengerId,
        pickup,
        dropoff,
        serviceType,
        paymentMethod,
        estimatedFare: estimatedFare || 0,
        distance: distance || 0,
        duration: duration || 0,
        pickupAddress: pickupAddress || '',
        dropoffAddress: dropoffAddress || '',
        candidates: [],
        status: 'no_drivers',
        expiresAt: new Date(now.getTime() + 60 * 1000)
      });

      emitter.emit('notification', {
        userId: passengerId,
        type: 'no_driver_found',
        title: 'No Drivers Available',
        body: `No ${serviceType} drivers are available at this time.`,
        data: { requestId: tripRequest._id }
      });

      console.log(`❌ No qualified drivers found`);
      return res.json({ 
        requestId: tripRequest._id, 
        message: 'No drivers available'
      });
    }

    // Offer to first driver immediately
    if (candidates.length > 0) {
      candidates[0].status = 'offered';
      candidates[0].offeredAt = new Date();
    }

    tripRequest = await TripRequest.create({
      passengerId,
      pickup,
      dropoff,
      serviceType,
      paymentMethod,
      estimatedFare: estimatedFare || 0,
      distance: distance || 0,
      duration: duration || 0,
      pickupAddress: pickupAddress || '',
      dropoffAddress: dropoffAddress || '',
      candidates,
      status: 'searching',
      expiresAt: new Date(now.getTime() + 5 * 60 * 1000)
    });

    console.log(`✅ Trip request ${tripRequest._id} created`);

    // Send notifications to drivers
    candidates.forEach(candidate => {
      if (candidate.status === 'offered') {
        emitter.emit('notification', {
          userId: candidate.driverId.toString(),
          type: 'trip_offered',
          title: 'New Trip Request',
          body: `New ${serviceType} ride - Accept within 20 seconds`,
          data: {
            requestId: tripRequest._id,
            serviceType: serviceType,
            fare: estimatedFare || 0,
            distance: distance || 0,
            duration: duration || 0,
            pickup: pickup,
            dropoff: dropoff,
            pickupAddress: pickupAddress || '',
            dropoffAddress: dropoffAddress || '',
            immediateOffer: true
          }
        });
      }
    });

    // Timeout for first driver
    if (candidates.length > 0 && candidates[0].status === 'offered') {
      const firstDriverId = candidates[0].driverId;
      
      setTimeout(async () => {
        try {
          const fresh = await TripRequest.findById(tripRequest._id);
          if (!fresh || fresh.status !== 'searching') return;

          const cand = fresh.candidates.find(c => c.driverId.toString() === firstDriverId.toString());
          if (cand && cand.status === 'offered') {
            cand.status = 'rejected';
            cand.rejectedAt = new Date();
            cand.rejectionReason = 'timeout';
            await fresh.save();
            
            await offerToNext(tripRequest._id);
          }
        } catch (err) {
          console.error('Timeout error:', err);
        }
      }, 20000);
    }

    res.json({ 
      requestId: tripRequest._id, 
      candidatesCount: candidates.length,
      message: `Searching ${candidates.length} drivers`,
      estimatedFare: estimatedFare || 0
    });
  } catch (err) {
    console.error('❌ Trip request error:', err);
    next(err);
  }
});

// ==========================================
// OFFER TO NEXT DRIVER
// ==========================================

async function offerToNext(requestId) {
  try {
    console.log(`🔄 offerToNext for ${requestId}`);
    
    const tripRequest = await TripRequest.findById(requestId);
    if (!tripRequest || tripRequest.status !== 'searching') {
      tripRejectionCounts.delete(requestId.toString());
      return;
    }

    // ✅ Check rejection count BEFORE offering to next
    const shouldCleanup = trackRejection(requestId);
    if (shouldCleanup) {
      return; // Cleanup already triggered, stop here
    }

    const nextCandidate = tripRequest.candidates.find(c => c.status === 'pending');
    
    if (!nextCandidate) {
      console.log(`⚠️ No more candidates for ${requestId}`);
      await cleanupFailedTripRequest(requestId);
      return;
    }

    nextCandidate.status = 'offered';
    nextCandidate.offeredAt = new Date();
    await tripRequest.save();

    const driverId = nextCandidate.driverId;
    const attemptNum = (tripRejectionCounts.get(requestId.toString()) || 0) + 1;
    console.log(`📤 Offering to driver ${driverId} (Attempt ${attemptNum}/5)`);

    emitter.emit('notification', {
      userId: driverId.toString(),
      type: 'trip_offered',
      title: 'New Trip Request',
      body: `New ${tripRequest.serviceType} ride - Accept within 20 seconds`,
      data: {
        requestId: tripRequest._id,
        serviceType: tripRequest.serviceType,
        fare: tripRequest.estimatedFare || 0,
        distance: tripRequest.distance || 0,
        duration: tripRequest.duration || 0,
        pickup: tripRequest.pickup,
        dropoff: tripRequest.dropoff,
        pickupAddress: tripRequest.pickupAddress || '',
        dropoffAddress: tripRequest.dropoffAddress || '',
        immediateOffer: true
      }
    });

    // Timeout for this driver
    setTimeout(async () => {
      try {
        const fresh = await TripRequest.findById(requestId);
        if (!fresh || fresh.status !== 'searching') {
          tripRejectionCounts.delete(requestId.toString());
          return;
        }

        const cand = fresh.candidates.find(c => c.driverId.toString() === driverId.toString());
        if (cand && cand.status === 'offered') {
          cand.status = 'rejected';
          cand.rejectedAt = new Date();
          cand.rejectionReason = 'timeout';
          await fresh.save();
          
          await offerToNext(requestId);
        }
      } catch (err) {
        console.error('Timeout error:', err);
      }
    }, 20000);
  } catch (err) {
    console.error('❌ offerToNext error:', err);
    tripRejectionCounts.delete(requestId.toString());
  }
}

// ==========================================
// GET /trips/request/:requestId - POLL STATUS
// ==========================================

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

    if (tripRequest.passengerId._id.toString() !== userId) {
      return res.status(403).json({ error: { message: 'Unauthorized' } });
    }

    let trip = null;
    if (tripRequest.status === 'assigned' && tripRequest.assignedDriverId) {
      trip = await Trip.findOne({ tripRequestId: tripRequest._id }).lean();
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

// ==========================================
// POST /trips/accept - DRIVER ACCEPTS
// ==========================================

router.post('/accept', requireAuth, async (req, res, next) => {
  try {
    const driverId = req.user.sub;
    const { requestId } = req.body;

    console.log(`🤝 Driver ${driverId} accepting ${requestId}`);

    const tripRequest = await TripRequest.findById(requestId);
    if (!tripRequest || tripRequest.status !== 'searching') {
      tripRejectionCounts.delete(requestId.toString());
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

      const tripDoc = await Trip.create([{
        passengerId: tripRequest.passengerId,
        driverId,
        tripRequestId: tripRequest._id,
        serviceType: tripRequest.serviceType,
        paymentMethod: tripRequest.paymentMethod,
        pickupLocation: tripRequest.pickup,
        dropoffLocation: tripRequest.dropoff,
        status: 'assigned',
        estimatedFare: tripRequest.estimatedFare || 0,
        distanceKm: tripRequest.distance || 0,
        durationMinutes: Math.round((tripRequest.duration || 0) / 60),
        requestedAt: new Date()
      }], { session });

      newTrip = tripDoc[0];

      await User.findByIdAndUpdate(driverId, {
        'driverProfile.isAvailable': false,
        'driverProfile.currentTripId': newTrip._id
      }, { session });
    });

    await session.endSession();

    // ✅ Clear tracking - trip accepted successfully
    tripRejectionCounts.delete(requestId.toString());

    console.log(`✅ Trip accepted, created ${newTrip._id}`);

    emitter.emit('notification', {
      userId: tripRequest.passengerId.toString(),
      type: 'trip_accepted',
      title: 'Driver Accepted!',
      body: 'Your driver is on the way',
      data: {
        requestId: tripRequest._id.toString(),
        tripId: newTrip._id.toString(),
        driverId: driverId.toString()
      }
    });

    res.json({
      success: true,
      tripId: newTrip._id,
      requestId: tripRequest._id
    });
  } catch (err) {
    console.error('❌ Accept error:', err);
    next(err);
  }
});

// ==========================================
// POST /trips/reject - DRIVER REJECTS
// ==========================================

router.post('/reject', requireAuth, async (req, res, next) => {
  try {
    const driverId = req.user.sub;
    const { requestId } = req.body;

    console.log(`🚫 Driver ${driverId} rejecting ${requestId}`);

    const tripRequest = await TripRequest.findById(requestId);
    if (!tripRequest || tripRequest.status !== 'searching') {
      tripRejectionCounts.delete(requestId.toString());
      return res.status(400).json({ error: { message: 'Trip no longer searching' } });
    }

    const candidate = tripRequest.candidates.find(
      c => c.driverId.toString() === driverId && c.status === 'offered'
    );

    if (!candidate) {
      return res.status(403).json({ error: { message: 'You were not offered this trip' } });
    }

    candidate.status = 'rejected';
    candidate.rejectedAt = new Date();
    candidate.rejectionReason = 'manual_rejection';
    await tripRequest.save();

    console.log(`❌ Driver rejected, moving to next`);
    
    // ✅ This will track rejection and potentially cleanup
    await offerToNext(requestId);

    res.json({ success: true });
  } catch (err) {
    console.error('❌ Reject error:', err);
    next(err);
  }
});

// ==========================================
// TRIP LIFECYCLE ENDPOINTS
// ==========================================

router.post('/:tripId/start', requireAuth, async (req, res, next) => {
  try {
    const driverId = req.user.sub;
    const trip = await Trip.findById(req.params.tripId);

    if (!trip) return res.status(404).json({ error: { message: 'Trip not found' } });
    if (trip.driverId.toString() !== driverId) return res.status(403).json({ error: { message: 'Unauthorized' } });

    trip.status = 'started';
    trip.startedAt = new Date();
    await trip.save();

    emitter.emit('notification', {
      userId: trip.passengerId.toString(),
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

router.post('/:tripId/complete', requireAuth, async (req, res, next) => {
  try {
    const driverId = req.user.sub;
    const trip = await Trip.findById(req.params.tripId);

    if (!trip) return res.status(404).json({ error: { message: 'Trip not found' } });
    if (trip.driverId.toString() !== driverId) return res.status(403).json({ error: { message: 'Unauthorized' } });

    const fareData = await calculateFare({
      serviceType: trip.serviceType,
      distanceKm: trip.distanceKm,
      durationMinutes: trip.durationMinutes
    });

    trip.finalFare = fareData.baseAmount;

    let commission = 0;
    if (isLuxury(trip.serviceType)) {
      const setting = await Settings.findOne({ key: 'commission_percent' }).lean();
      const percent = setting?.value ? Number(setting.value) : 10;
      commission = Math.round((percent / 100) * trip.finalFare);
    }

    trip.commission = commission;
    trip.driverEarnings = trip.finalFare - commission;

    if (trip.paymentMethod === 'wallet') {
      const passengerWallet = await Wallet.findOne({ owner: trip.passengerId }).lean();
      if (!passengerWallet || passengerWallet.balance < trip.finalFare) {
        return res.status(402).json({ error: { message: 'Insufficient balance' } });
      }

      await Wallet.findOneAndUpdate({ owner: trip.passengerId }, { $inc: { balance: -trip.finalFare } });
      await Wallet.findOneAndUpdate({ owner: driverId }, { $inc: { balance: trip.driverEarnings } }, { upsert: true });
    }

    trip.status = 'completed';
    trip.completedAt = new Date();
    await trip.save();

    await User.findByIdAndUpdate(driverId, {
      'driverProfile.isAvailable': true,
      $unset: { 'driverProfile.currentTripId': '' }
    });

    res.json({ trip });
  } catch (err) {
    next(err);
  }
});

router.post('/:tripId/cancel', requireAuth, async (req, res, next) => {
  try {
    const userId = req.user.sub;
    const { reason } = req.body;

    const trip = await Trip.findById(req.params.tripId);
    if (!trip) return res.status(404).json({ error: { message: 'Trip not found' } });

    trip.status = 'cancelled';
    trip.cancelledAt = new Date();
    trip.cancellationReason = reason || 'Cancelled';
    await trip.save();

    if (trip.driverId) {
      await User.findByIdAndUpdate(trip.driverId, {
        'driverProfile.isAvailable': true,
        $unset: { 'driverProfile.currentTripId': '' }
      });
    }

    res.json({ trip });
  } catch (err) {
    next(err);
  }
});

router.get('/:tripId', requireAuth, async (req, res, next) => {
  try {
    const trip = await Trip.findById(req.params.tripId).lean();
    if (!trip) return res.status(404).json({ error: { message: 'Trip not found' } });
    res.json({ trip });
  } catch (err) {
    next(err);
  }
});

router.get('/', requireAuth, async (req, res, next) => {
  try {
    const userId = req.user.sub;
    const { role = 'passenger', limit = 50, offset = 0 } = req.query;

    const filter = role === 'driver' ? { driverId: userId } : { passengerId: userId };
    const trips = await Trip.find(filter)
      .sort({ requestedAt: -1 })
      .limit(parseInt(limit))
      .skip(parseInt(offset))
      .lean();

    res.json({ trips, total: await Trip.countDocuments(filter) });
  } catch (err) {
    next(err);
  }
});

// ==========================================
// PERIODIC CLEANUP JOB
// ==========================================

function startPeriodicCleanup() {
  setInterval(async () => {
    try {
      const now = new Date();
      
      // Cleanup expired searching requests
      const expired = await TripRequest.find({
        status: 'searching',
        expiresAt: { $lt: now }
      }).lean();

      for (const req of expired) {
        await cleanupFailedTripRequest(req._id);
      }

      // Delete old no_drivers requests (older than 10 minutes)
      await TripRequest.deleteMany({
        status: 'no_drivers',
        createdAt: { $lt: new Date(now.getTime() - 10 * 60 * 1000) }
      });

    } catch (err) {
      console.error('Cleanup error:', err);
    }
  }, 5 * 60 * 1000); // Every 5 minutes
}

startPeriodicCleanup();

module.exports = router;