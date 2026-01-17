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
const rateLimit = require('express-rate-limit');

// ==========================================
// RATE LIMITING
// ==========================================
const requestLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 5, // limit each IP to 5 requests per windowMs
  message: { error: { message: 'Too many requests, please try again later.' } }
});

// ==========================================
// CONFIGURATION
// ==========================================
const CONFIG = {
  OFFER_TIMEOUT_MS: 20000, // 20 seconds
  MAX_REJECTIONS: 5,
  SEARCH_TIMEOUT_MS: 5 * 60 * 1000, // 5 minutes
  FAILED_TRIP_CLEANUP_MS: 5 * 60 * 1000, // 5 minutes
  DRIVER_LAST_SEEN_THRESHOLD_MS: 5 * 60 * 1000, // 5 minutes
  SEARCH_RADIUS_METERS: 5000, // 5km
  MAX_DRIVERS_SEARCH: 10
};

// ==========================================
// REJECTION TRACKING IN DATABASE
// ==========================================
// We'll store rejection counts in TripRequest document instead of in-memory Map

/**
 * Cleanup a trip request that couldn't find a driver
 */
async function cleanupFailedTripRequest(requestId) {
  try {
    console.log(`🧹 Cleaning up failed trip request: ${requestId}`);
    
    const tripRequest = await TripRequest.findById(requestId);
    if (!tripRequest) {
      console.log(`⚠️ Trip request ${requestId} not found for cleanup`);
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
    try {
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
    } catch (emitErr) {
      console.error('Notification emit error during cleanup:', emitErr);
    }

    console.log(`✅ Trip request ${requestId} marked as no_drivers and cleaned up`);

    // Delete after configured time
    setTimeout(async () => {
      try {
        await TripRequest.findByIdAndDelete(requestId);
        console.log(`🗑️ Deleted failed trip request: ${requestId}`);
      } catch (delErr) {
        console.error(`❌ Error deleting trip request ${requestId}:`, delErr);
      }
    }, CONFIG.FAILED_TRIP_CLEANUP_MS);

  } catch (err) {
    console.error(`❌ Error cleaning up trip request ${requestId}:`, err);
  }
}

/**
 * Track rejection and cleanup if threshold reached
 */
async function trackRejection(requestId) {
  try {
    const tripRequest = await TripRequest.findById(requestId);
    if (!tripRequest) return false;

    // Count active rejections (excluding timeouts that happen after cleanup)
    const rejectionCount = tripRequest.candidates.filter(
      c => c.status === 'rejected' && 
           c.rejectionReason !== 'max_attempts_reached' // Don't count auto-cleanup rejections
    ).length;

    console.log(`📊 Trip ${requestId} rejection count: ${rejectionCount}/${CONFIG.MAX_REJECTIONS}`);

    if (rejectionCount >= CONFIG.MAX_REJECTIONS) {
      console.log(`🚫 Trip ${requestId} reached max rejections (${CONFIG.MAX_REJECTIONS}), initiating cleanup`);
      await cleanupFailedTripRequest(requestId);
      return true; // Cleanup triggered
    }

    return false; // Continue to next driver
  } catch (err) {
    console.error(`❌ Error tracking rejection for ${requestId}:`, err);
    return false;
  }
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
// POST /trips/request - CREATE TRIP REQUEST (FIXED)
// ==========================================

router.post('/request', requireAuth, requestLimiter, async (req, res, next) => {
  const session = await mongoose.startSession();
  let responsePayload;
  let createdRequestId;
  let candidateData;
  let passengerId;
  let firstCandidate;
  
  try {
    await session.withTransaction(async () => {
      passengerId = req.user.sub;
      const {
        pickup,
        dropoff,
        serviceType,
        paymentMethod = 'wallet',
        radiusMeters = CONFIG.SEARCH_RADIUS_METERS,
        limit = CONFIG.MAX_DRIVERS_SEARCH,
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

      // Input validation
      if (!pickup || !validateCoordinates(pickup.coordinates)) {
        throw new Error('Invalid pickup coordinates');
      }

      if (!validateServiceType(serviceType)) {
        throw new Error('Invalid serviceType');
      }

      // Validate numeric inputs
      if (estimatedFare && (estimatedFare < 0 || estimatedFare > 1000000)) {
        throw new Error('Invalid estimated fare');
      }

      if (distance && (distance < 0 || distance > 1000)) {
        throw new Error('Invalid distance');
      }

      if (duration && (duration < 0 || duration > 24 * 60 * 60)) {
        throw new Error('Invalid duration');
      }

      const [lng, lat] = pickup.coordinates;
      const now = new Date();
      const searchRadius = radiusMeters;
      const lastSeenThreshold = new Date(now.getTime() - CONFIG.DRIVER_LAST_SEEN_THRESHOLD_MS);

      console.log(`📍 Searching for drivers near [${lat}, ${lng}] within ${searchRadius}m`);

      // Find nearby drivers
      let nearbyDrivers = [];
      
      try {
        // Primary: Use MongoDB geospatial query with 2dsphere index
        nearbyDrivers = await User.find({
          'roles.isDriver': true,
          'driverProfile.verified': true,
          'driverProfile.verificationState': 'approved',
          'driverProfile.isAvailable': true,
          'driverProfile.lastSeen': { $gte: lastSeenThreshold },
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
        .limit(limit)
        .session(session)
        .lean();

      } catch (geoError) {
        console.error('❌ Geospatial query error:', geoError.message);
        throw new Error('Geospatial service temporarily unavailable');
      }

      console.log(`📊 Found ${nearbyDrivers?.length || 0} nearby drivers`);

      // Filter drivers by service type
      const candidates = [];
      for (const driver of (nearbyDrivers || [])) {
        const supportsService = driver.driverProfile?.serviceCategories?.includes(serviceType);
        if (!supportsService) {
          console.log(` ⚠️ Driver ${driver._id} doesn't support ${serviceType}`);
          continue;
        }

        candidates.push({
          driverId: driver._id,
          status: 'pending',
          driverName: driver.name,
          offeredAt: null,
          rejectedAt: null,
          rejectionReason: null
        });

        console.log(` ✅ Added driver ${driver._id} to candidates list`);
      }

      console.log(`✅ ${candidates.length} drivers qualified as candidates`);

      let tripRequest;
      if (candidates.length === 0) {
        tripRequest = await TripRequest.create([{
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
        }], { session });

        createdRequestId = tripRequest[0]._id;
        
        // Store response data
        responsePayload = {
          requestId: tripRequest[0]._id,
          message: 'No drivers available'
        };
        
        candidateData = null;
        firstCandidate = null;
        
        return; // Transaction will commit
      }

      // Offer to first driver immediately
      if (candidates.length > 0) {
        candidates[0].status = 'offered';
        candidates[0].offeredAt = now;
        firstCandidate = candidates[0];
        console.log(`📤 Offering to first driver: ${candidates[0].driverId}`);
      }

      // Create trip request
      tripRequest = await TripRequest.create([{
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
        expiresAt: new Date(now.getTime() + CONFIG.SEARCH_TIMEOUT_MS)
      }], { session });

      const createdRequest = tripRequest[0];
      createdRequestId = createdRequest._id;

      console.log(`✅ Trip request ${createdRequest._id} created with ${candidates.length} candidates`);

      // Store response data
      responsePayload = {
        requestId: createdRequest._id,
        candidatesCount: candidates.length,
        message: `Searching ${candidates.length} drivers`,
        estimatedFare: estimatedFare || 0
      };
      
      candidateData = {
        serviceType: serviceType,
        estimatedFare: estimatedFare || 0,
        distance: distance || 0,
        duration: duration || 0,
        pickup: pickup,
        dropoff: dropoff,
        pickupAddress: pickupAddress || '',
        dropoffAddress: dropoffAddress || '',
        immediateOffer: true
      };
      
    });

    // ✅ Send response AFTER transaction
    res.json(responsePayload);

    // ✅ Now safe to emit events
    if (createdRequestId) {
      if (firstCandidate) {
        try {
          emitter.emit('notification', {
            userId: firstCandidate.driverId.toString(),
            type: 'trip_offered',
            title: 'New Trip Request',
            body: `New ${candidateData.serviceType} ride - Accept within ${CONFIG.OFFER_TIMEOUT_MS / 1000} seconds`,
            data: {
              requestId: createdRequestId,
              serviceType: candidateData.serviceType,
              estimatedFare: candidateData.estimatedFare,
              distance: candidateData.distance,
              duration: candidateData.duration,
              pickup: candidateData.pickup,
              dropoff: candidateData.dropoff,
              pickupAddress: candidateData.pickupAddress,
              dropoffAddress: candidateData.dropoffAddress,
              immediateOffer: candidateData.immediateOffer
            }
          });
          console.log(`📨 Notification sent to driver ${firstCandidate.driverId}`);
        } catch (emitErr) {
          console.error('Notification emit error:', emitErr);
        }
      }

      // Timeout for first driver (outside transaction)
      if (firstCandidate) {
        const firstDriverId = firstCandidate.driverId;
        
        setTimeout(async () => {
          try {
            const fresh = await TripRequest.findById(createdRequestId);
            if (!fresh || fresh.status !== 'searching') return;

            const cand = fresh.candidates.find(c => c.driverId.toString() === firstDriverId.toString());
            if (cand && cand.status === 'offered') {
              cand.status = 'rejected';
              cand.rejectedAt = new Date();
              cand.rejectionReason = 'timeout';
              await fresh.save();

              console.log(`⏱️ First driver ${firstDriverId} timeout, moving to next`);
              await offerToNext(createdRequestId);
            }
          } catch (err) {
            console.error('Timeout error:', err);
          }
        }, CONFIG.OFFER_TIMEOUT_MS);
      }
    } else {
      // No drivers case
      try {
        emitter.emit('notification', {
          userId: passengerId,
          type: 'no_driver_found',
          title: 'No Drivers Available',
          body: `No ${candidateData?.serviceType || 'service'} drivers are available at this time.`,
          data: { requestId: createdRequestId }
        });
      } catch (emitErr) {
        console.error('Notification emit error:', emitErr);
      }
    }

  } catch (err) {
    await session.abortTransaction();
    console.error('❌ Trip request error:', err);
    
    if (err.message.includes('Invalid') || err.message.includes('Unavailable')) {
      return res.status(400).json({ error: { message: err.message } });
    }
    
    next(err);
  } finally {
    await session.endSession();
  }
});

// ==========================================
// OFFER TO NEXT DRIVER - WITH REJECTION CHECK
// ==========================================

async function offerToNext(requestId) {
  try {
    console.log(`🔄 offerToNext for ${requestId}`);

    const tripRequest = await TripRequest.findById(requestId);
    if (!tripRequest || tripRequest.status !== 'searching') {
      console.log(`❌ Trip ${requestId} not searching or not found`);
      return;
    }

    // Check rejection count BEFORE offering to next
    const shouldCleanup = await trackRejection(requestId);
    if (shouldCleanup) {
      console.log(`🚫 Trip ${requestId} reached max rejections, cleaning up`);
      return; // Cleanup already triggered, stop here
    }

    // Find next pending candidate who hasn't been rejected
    const nextCandidate = tripRequest.candidates.find(
      c => c.status === 'pending' && !c.rejectedAt
    );

    if (!nextCandidate) {
      console.log(`⚠️ No more pending candidates for ${requestId}`);
      await cleanupFailedTripRequest(requestId);
      return;
    }

    // Double-check: never offer to previously rejected drivers (extra safety)
    const wasRejected = tripRequest.candidates.some(
      c => c.driverId.equals(nextCandidate.driverId) &&
           (c.status === 'rejected' || c.rejectedAt)
    );

    if (wasRejected) {
      console.log(`🚫 Driver ${nextCandidate.driverId} was already rejected, marking and moving to next`);
      nextCandidate.status = 'rejected';
      nextCandidate.rejectedAt = new Date();
      nextCandidate.rejectionReason = 'already_rejected';
      await tripRequest.save();
      return await offerToNext(requestId);
    }

    // OFFER TO THE NEXT DRIVER
    nextCandidate.status = 'offered';
    nextCandidate.offeredAt = new Date();
    await tripRequest.save();

    const driverId = nextCandidate.driverId;
    
    // Count current rejections for logging
    const rejectionCount = tripRequest.candidates.filter(c => c.status === 'rejected').length;
    console.log(`📤 Offering to driver ${driverId} (Attempt ${rejectionCount + 1}/${CONFIG.MAX_REJECTIONS})`);

    // SEND NOTIFICATION TO THE DRIVER
    try {
      emitter.emit('notification', {
        userId: driverId.toString(),
        type: 'trip_offered',
        title: 'New Trip Request',
        body: `New ${tripRequest.serviceType} ride - Accept within ${CONFIG.OFFER_TIMEOUT_MS / 1000} seconds`,
        data: {
          requestId: tripRequest._id,
          serviceType: tripRequest.serviceType,
          estimatedFare: tripRequest.estimatedFare || 0,
          distance: tripRequest.distance || 0,
          duration: tripRequest.duration || 0,
          pickup: tripRequest.pickup,
          dropoff: tripRequest.dropoff,
          pickupAddress: tripRequest.pickupAddress || '',
          dropoffAddress: tripRequest.dropoffAddress || '',
          immediateOffer: true
        }
      });
    } catch (emitErr) {
      console.error('Notification emit error in offerToNext:', emitErr);
    }

    // Timeout for this driver
    setTimeout(async () => {
      try {
        const fresh = await TripRequest.findById(requestId);
        if (!fresh || fresh.status !== 'searching') {
          console.log(`Trip ${requestId} no longer searching, stopping timeout`);
          return;
        }

        const cand = fresh.candidates.find(c => c.driverId.toString() === driverId.toString());
        if (cand && cand.status === 'offered') {
          console.log(`⏱️ Driver ${driverId} timeout, rejecting`);
          cand.status = 'rejected';
          cand.rejectedAt = new Date();
          cand.rejectionReason = 'timeout';
          await fresh.save();

          await offerToNext(requestId);
        }
      } catch (err) {
        console.error('Timeout error:', err);
      }
    }, CONFIG.OFFER_TIMEOUT_MS);

  } catch (err) {
    console.error('❌ offerToNext error:', err);
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
// POST /trips/accept - DRIVER ACCEPTS (COMPLETELY FIXED)
// ==========================================

// ==========================================
// POST /trips/accept - DRIVER ACCEPTS (COMPLETELY FIXED)
// ==========================================

// In /trips/accept endpoint - COMPLETELY FIXED WITH PROPER LOCKING

// ✅ COMPLETELY REWRITTEN: Accept Ride Endpoint (Backend)
// ✅ FIXED: Accept Ride with Automatic State Cleanup
router.post('/accept', requireAuth, async (req, res, next) => {
  const session = await mongoose.startSession();
  session.startTransaction();
  
  let tripData = null;
  let notificationData = null;
  let responseSent = false;

  try {
    const driverId = req.user.sub;
    const { requestId, idempotencyKey } = req.body;

    // Validation
    if (!requestId) {
      throw new Error('Request ID is required');
    }

    const finalIdempotencyKey = idempotencyKey || `accept_${requestId}_${driverId}_${Date.now()}`;

    console.log(`🤝 Driver ${driverId} attempting to accept request ${requestId}`);
    console.log('Idempotency key:', finalIdempotencyKey);

    // ============================================
    // STEP 1: Check Idempotency
    // ============================================
    const idempotencyCollection = mongoose.connection.collection('idempotency_keys');
    const existingKey = await idempotencyCollection.findOne(
      { key: finalIdempotencyKey },
      { session }
    );

    if (existingKey) {
      console.log('⚠️ Duplicate request detected');
      
      if (existingKey.status === 'completed' && existingKey.tripId) {
        console.log('✅ Returning cached trip data');
        await session.abortTransaction();
        
        return res.json({
          success: true,
          tripId: existingKey.tripId.toString(),
          requestId: existingKey.requestId.toString(),
          driverId: driverId.toString(),
          fromCache: true
        });
      } else if (existingKey.status === 'processing') {
        throw new Error('Request is already being processed');
      } else {
        throw new Error('Previous accept attempt failed. Please try again.');
      }
    }

    // ============================================
    // STEP 2: Insert Idempotency Key (Lock)
    // ============================================
    await idempotencyCollection.insertOne({
      key: finalIdempotencyKey,
      driverId: driverId,
      requestId: requestId,
      status: 'processing',
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000)
    }, { session });

    console.log('🔒 Idempotency key inserted');

    // ============================================
    // STEP 3: Verify Driver Availability + AUTO CLEANUP
    // ============================================
    const driver = await User.findById(driverId)
      .select('name driverProfile')
      .session(session);

    if (!driver) {
      throw new Error('Driver not found');
    }

    // ✅ CHECK IF CURRENT TRIP IS ACTUALLY ACTIVE
    if (driver.driverProfile?.currentTripId) {
      console.log(`⚠️ Driver has currentTripId: ${driver.driverProfile.currentTripId}`);
      
      // Check if the trip actually exists and is active
      const currentTrip = await Trip.findById(driver.driverProfile.currentTripId)
        .select('status')
        .session(session);

      if (!currentTrip || ['completed', 'cancelled'].includes(currentTrip.status)) {
        // Trip doesn't exist or is finished - CLEAN UP THE STALE STATE
        console.log(`🧹 Cleaning up stale currentTripId for driver ${driverId}`);
        
        await User.findByIdAndUpdate(
          driverId,
          {
            'driverProfile.isAvailable': true,
            $unset: { 'driverProfile.currentTripId': '' }
          },
          { session }
        );

        // Reload driver data after cleanup
        const cleanedDriver = await User.findById(driverId)
          .select('name driverProfile')
          .session(session);
        
        driver.driverProfile = cleanedDriver.driverProfile;
        console.log('✅ Driver state cleaned up and reloaded');
      } else if (['assigned', 'started', 'in_progress'].includes(currentTrip.status)) {
        // Driver is ACTUALLY on an active trip
        await idempotencyCollection.updateOne(
          { key: finalIdempotencyKey },
          { $set: { status: 'failed', error: 'Driver on active trip' } },
          { session }
        );
        throw new Error('Driver is already on an active trip');
      }
    }

    // ✅ NOW CHECK AVAILABILITY AFTER CLEANUP
    if (!driver.driverProfile?.isAvailable) {
      console.log(`⚠️ Driver isAvailable: ${driver.driverProfile?.isAvailable}`);
      
      // Auto-fix: If driver has no current trip but is marked unavailable, fix it
      if (!driver.driverProfile?.currentTripId) {
        console.log('🧹 Auto-fixing driver availability status');
        
        await User.findByIdAndUpdate(
          driverId,
          { 'driverProfile.isAvailable': true },
          { session }
        );
        
        console.log('✅ Driver availability auto-fixed');
      } else {
        await idempotencyCollection.updateOne(
          { key: finalIdempotencyKey },
          { $set: { status: 'failed', error: 'Driver not available' } },
          { session }
        );
        throw new Error('Driver is not available');
      }
    }

    console.log('✅ Driver availability verified');

    // ============================================
    // STEP 4: Atomic Trip Assignment
    // ============================================
    const tripRequest = await TripRequest.findOneAndUpdate(
      {
        _id: requestId,
        status: 'searching',
        assignedDriverId: null,
        'candidates': {
          $elemMatch: {
            driverId: driverId,
            status: 'offered'
          }
        }
      },
      {
        $set: {
          assignedDriverId: driverId,
          status: 'assigned',
          'candidates.$[elem].status': 'accepted',
          'candidates.$[elem].acceptedAt': new Date()
        }
      },
      {
        arrayFilters: [{ 'elem.driverId': driverId }],
        new: true,
        session
      }
    );

    if (!tripRequest) {
      console.log(`❌ Cannot assign trip - checking current state`);
      
      const currentRequest = await TripRequest.findById(requestId).session(session);
      
      if (!currentRequest) {
        await idempotencyCollection.updateOne(
          { key: finalIdempotencyKey },
          { $set: { status: 'failed', error: 'Trip request not found' } },
          { session }
        );
        throw new Error('Trip request not found');
      }
      
      console.log(`Current status: ${currentRequest.status}`);
      console.log(`Assigned to: ${currentRequest.assignedDriverId}`);
      
      const candidate = currentRequest.candidates.find(c => c.driverId.toString() === driverId.toString());
      console.log(`Candidate status: ${candidate?.status || 'not found'}`);
      
      await idempotencyCollection.updateOne(
        { key: finalIdempotencyKey },
        { $set: { status: 'failed', error: 'Trip no longer available' } },
        { session }
      );
      
      if (currentRequest.assignedDriverId && currentRequest.assignedDriverId.toString() !== driverId.toString()) {
        throw new Error('Trip was already assigned to another driver');
      } else if (currentRequest.status !== 'searching') {
        throw new Error('Trip is no longer available');
      } else if (!candidate || candidate.status !== 'offered') {
        throw new Error('You were not offered this trip');
      } else {
        throw new Error('Trip is no longer available');
      }
    }

    console.log(`✅ Trip ${requestId} atomically assigned to driver ${driverId}`);

    // ============================================
    // STEP 5: Create Trip Document
    // ============================================
    const tripDoc = await Trip.create([{
      passengerId: tripRequest.passengerId,
      driverId: driverId,
      tripRequestId: tripRequest._id,
      serviceType: tripRequest.serviceType,
      paymentMethod: tripRequest.paymentMethod || 'wallet',
      pickupLocation: tripRequest.pickup,
      dropoffLocation: tripRequest.dropoff,
      status: 'assigned',
      estimatedFare: tripRequest.estimatedFare || 0,
      distanceKm: tripRequest.distance || 0,
      durationMinutes: Math.round((tripRequest.duration || 0) / 60),
      requestedAt: new Date()
    }], { session });

    const newTrip = tripDoc[0];
    console.log(`✅ Trip document ${newTrip._id} created`);

    // ============================================
    // STEP 6: Update Driver Status
    // ============================================
    await User.findByIdAndUpdate(
      driverId,
      {
        'driverProfile.isAvailable': false,
        'driverProfile.currentTripId': newTrip._id
      },
      { session }
    );

    console.log('✅ Driver status updated');

    // ============================================
    // STEP 7: Update Idempotency Key (Success)
    // ============================================
    await idempotencyCollection.updateOne(
      { key: finalIdempotencyKey },
      { 
        $set: { 
          status: 'completed',
          tripId: newTrip._id,
          requestId: tripRequest._id,
          updatedAt: new Date()
        }
      },
      { session }
    );

    console.log('✅ Idempotency key updated to completed');

    // ============================================
    // STEP 8: Commit Transaction
    // ============================================
    await session.commitTransaction();
    console.log('✅ Transaction committed successfully');

    // ============================================
    // STEP 9: Prepare Response
    // ============================================
    tripData = {
      success: true,
      tripId: newTrip._id.toString(),
      requestId: tripRequest._id.toString(),
      driverId: driverId.toString()
    };

    notificationData = {
      passengerId: tripRequest.passengerId.toString(),
      driverId: driverId.toString(),
      tripId: newTrip._id.toString(),
      requestId: tripRequest._id.toString(),
      driverName: driver.name || 'Driver',
      serviceType: tripRequest.serviceType,
      estimatedFare: tripRequest.estimatedFare || 0,
      pickup: tripRequest.pickup,
      dropoff: tripRequest.dropoff,
      pickupAddress: tripRequest.pickupAddress || '',
      dropoffAddress: tripRequest.dropoffAddress || ''
    };

    // ============================================
    // STEP 10: Send Response IMMEDIATELY
    // ============================================
    res.json(tripData);
    responseSent = true;
    console.log('✅ Response sent to driver');

    // ============================================
    // STEP 11: Send Notifications (Non-blocking)
    // ============================================
    setImmediate(() => {
      try {
        emitter.emit('notification', {
          userId: notificationData.passengerId,
          type: 'trip_accepted',
          notificationType: 'trip_accepted',
          title: 'Driver Accepted!',
          body: `${notificationData.driverName} is on the way`,
          data: {
            requestId: notificationData.requestId,
            tripId: notificationData.tripId,
            driverId: notificationData.driverId,
            driverName: notificationData.driverName,
            serviceType: notificationData.serviceType,
            estimatedFare: notificationData.estimatedFare,
            pickup: notificationData.pickup,
            dropoff: notificationData.dropoff,
            pickupAddress: notificationData.pickupAddress,
            dropoffAddress: notificationData.dropoffAddress
          }
        });

        emitter.emit('trip_accepted', {
          requestId: notificationData.requestId,
          tripId: notificationData.tripId,
          driverId: notificationData.driverId,
          driverName: notificationData.driverName
        });

        console.log(`📨 Notifications sent for trip ${notificationData.tripId}`);
      } catch (emitErr) {
        console.error('❌ Notification error (non-fatal):', emitErr.message);
      }
    });

  } catch (error) {
    if (session.inTransaction()) {
      await session.abortTransaction();
      console.log('❌ Transaction aborted');
    }

    console.error('❌ Accept error:', error.message);

    if (!responseSent) {
      const errorMessage = error.message || 'Failed to accept ride';
      let statusCode = 500;
      let errorCode = 'INTERNAL_ERROR';

      if (errorMessage.includes('not found')) {
        statusCode = 404;
        errorCode = 'NOT_FOUND';
      } else if (
        errorMessage.includes('not available') ||
        errorMessage.includes('active trip') ||
        errorMessage.includes('not offered') ||
        errorMessage.includes('already assigned') ||
        errorMessage.includes('already processed')
      ) {
        statusCode = 400;
        
        if (errorMessage.includes('already processed')) {
          errorCode = 'DUPLICATE_REQUEST';
        } else if (errorMessage.includes('already assigned')) {
          errorCode = 'TRIP_ALREADY_ASSIGNED';
        } else {
          errorCode = 'TRIP_UNAVAILABLE';
        }
      } else if (errorMessage.includes('required') || errorMessage.includes('Invalid')) {
        statusCode = 400;
        errorCode = 'INVALID_REQUEST';
      }

      res.status(statusCode).json({
        success: false,
        error: {
          message: errorMessage,
          code: errorCode
        }
      });
    }
  } finally {
    await session.endSession();
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
      return res.status(400).json({ error: { message: 'Trip no longer searching' } });
    }

    const candidate = tripRequest.candidates.find(
      c => c.driverId.toString() === driverId && c.status === 'offered'
    );

    if (!candidate) {
      return res.status(403).json({ error: { message: 'You were not offered this trip' } });
    }

    // Mark as rejected with timestamp
    candidate.status = 'rejected';
    candidate.rejectedAt = new Date();
    candidate.rejectionReason = 'manual_rejection';
    await tripRequest.save();

    console.log(`❌ Driver ${driverId} rejected trip ${requestId}`);

    // Move to next driver
    await offerToNext(requestId);

    res.json({ success: true });
  } catch (err) {
    console.error('❌ Reject error:', err);
    next(err);
  }
});

// ==========================================
// GET /trips/searching - DEBUG: Get all searching trip requests (ADMIN ONLY)
// ==========================================

const requireAdmin = (req, res, next) => {
  if (req.user?.roles?.isAdmin) {
    next();
  } else {
    res.status(403).json({ error: { message: 'Admin access required' } });
  }
};

router.get('/searching', requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const searchingTrips = await TripRequest.find({
      status: 'searching'
    })
    .populate('passengerId', 'name phone')
    .select('_id serviceType pickup dropoff estimatedFare candidates status createdAt expiresAt')
    .sort({ createdAt: -1 })
    .lean();

    const formatted = searchingTrips.map(trip => ({
      requestId: trip._id,
      passengerName: trip.passengerId?.name || 'Unknown',
      serviceType: trip.serviceType,
      estimatedFare: trip.estimatedFare,
      pickup: trip.pickup,
      dropoff: trip.dropoff,
      status: trip.status,
      createdAt: trip.createdAt,
      expiresAt: trip.expiresAt,
      timeUntilExpiry: Math.max(0, trip.expiresAt - new Date()),
      candidates: trip.candidates.map(c => ({
        driverId: c.driverId,
        status: c.status,
        offeredAt: c.offeredAt,
        rejectedAt: c.rejectedAt,
        rejectionReason: c.rejectionReason
      })),
      candidateCount: trip.candidates.length,
      activeOffers: trip.candidates.filter(c => c.status === 'offered').length,
      rejectedCount: trip.candidates.filter(c => c.status === 'rejected').length
    }));

    res.json({
      count: formatted.length,
      trips: formatted,
      timestamp: new Date().toISOString(),
      config: {
        OFFER_TIMEOUT_MS: CONFIG.OFFER_TIMEOUT_MS,
        MAX_REJECTIONS: CONFIG.MAX_REJECTIONS
      }
    });
  } catch (err) {
    console.error('Error in /searching:', err);
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

    try {
      emitter.emit('notification', {
        userId: trip.passengerId.toString(),
        type: 'trip_started',
        title: 'Trip Started',
        body: 'Your driver has started the trip',
        data: { tripId: trip._id }
      });
    } catch (emitErr) {
      console.error('Notification emit error:', emitErr);
    }

    res.json({ trip });
  } catch (err) {
    next(err);
  }
});

router.post('/:tripId/complete', requireAuth, async (req, res, next) => {
  const session = await mongoose.startSession();
  let tripData;
  
  try {
    await session.withTransaction(async () => {
      const driverId = req.user.sub;
      const { actualDistanceKm, actualDurationMinutes } = req.body;

      const trip = await Trip.findById(req.params.tripId).session(session);
      if (!trip) throw new Error('Trip not found');
      if (trip.driverId.toString() !== driverId) throw new Error('Unauthorized');

      // Use actual metrics if provided, otherwise use estimated
      const finalDistance = actualDistanceKm || trip.distanceKm;
      const finalDuration = actualDurationMinutes || trip.durationMinutes;

      const fareData = await calculateFare({
        serviceType: trip.serviceType,
        distanceKm: finalDistance,
        durationMinutes: finalDuration
      });

      trip.finalFare = fareData.baseAmount;
      trip.distanceKm = finalDistance;
      trip.durationMinutes = finalDuration;

      let commission = 0;
      if (isLuxury(trip.serviceType)) {
        const setting = await Settings.findOne({ key: 'commission_percent' }).lean();
        const percent = setting?.value ? Number(setting.value) : 10;
        commission = Math.round((percent / 100) * trip.finalFare);
      }

      trip.commission = commission;
      trip.driverEarnings = trip.finalFare - commission;

      if (trip.paymentMethod === 'wallet') {
        const passengerWallet = await Wallet.findOne({ owner: trip.passengerId }).session(session);
        if (!passengerWallet || passengerWallet.balance < trip.finalFare) {
          throw new Error('Insufficient balance');
        }

        await Wallet.findOneAndUpdate(
          { owner: trip.passengerId },
          { $inc: { balance: -trip.finalFare } },
          { session }
        );

        await Wallet.findOneAndUpdate(
          { owner: driverId },
          { $inc: { balance: trip.driverEarnings } },
          { upsert: true, session }
        );

        // Record transaction
        await Transaction.create([{
          userId: trip.passengerId,
          type: 'trip_payment',
          amount: -trip.finalFare,
          description: `Trip #${trip._id.toString().slice(-6)}`,
          metadata: { tripId: trip._id }
        }, {
          userId: driverId,
          type: 'trip_earnings',
          amount: trip.driverEarnings,
          description: `Earnings from trip #${trip._id.toString().slice(-6)}`,
          metadata: { tripId: trip._id, commission: commission }
        }], { session });
      }

      trip.status = 'completed';
      trip.completedAt = new Date();
      await trip.save({ session });

      await User.findByIdAndUpdate(
        driverId,
        {
          'driverProfile.isAvailable': true,
          $unset: { 'driverProfile.currentTripId': '' }
        },
        { session }
      );

      // Store trip data for notification
      tripData = {
        tripId: trip._id.toString(),
        passengerId: trip.passengerId.toString(),
        finalFare: trip.finalFare
      };

      await session.commitTransaction();
    });

    // Send response
    res.json({ trip: tripData });

    // Emit notification AFTER response
    try {
      emitter.emit('notification', {
        userId: tripData.passengerId,
        type: 'trip_completed',
        title: 'Trip Completed',
        body: `Your trip has been completed. Amount: ₦${(tripData.finalFare / 100).toFixed(2)}`,
        data: { tripId: tripData.tripId, fare: tripData.finalFare }
      });
    } catch (emitErr) {
      console.error('Notification emit error:', emitErr);
    }

  } catch (err) {
    await session.abortTransaction();
    console.error('Complete trip error:', err);
    
    if (err.message.includes('Insufficient')) {
      return res.status(402).json({ error: { message: err.message } });
    }
    
    next(err);
  } finally {
    await session.endSession();
  }
});

router.post('/:tripId/cancel', requireAuth, async (req, res, next) => {
  try {
    const userId = req.user.sub;
    const { reason } = req.body;

    const trip = await Trip.findById(req.params.tripId);
    if (!trip) return res.status(404).json({ error: { message: 'Trip not found' } });

    const isPassenger = trip.passengerId.toString() === userId;
    const isDriver = trip.driverId?.toString() === userId;
    
    if (!isPassenger && !isDriver) {
      return res.status(403).json({ error: { message: 'Unauthorized' } });
    }

    trip.status = 'cancelled';
    trip.cancelledAt = new Date();
    trip.cancellationReason = reason || (isPassenger ? 'passenger_cancelled' : 'driver_cancelled');
    await trip.save();

    // ✅ ENSURE DRIVER STATE IS CLEANED UP
    if (trip.driverId) {
      await User.findByIdAndUpdate(trip.driverId, {
        'driverProfile.isAvailable': true,
        $unset: { 'driverProfile.currentTripId': '' }
      });
      
      console.log(`✅ Driver ${trip.driverId} state cleaned up after cancellation`);
    }

    const notifyUserId = isPassenger ? trip.driverId : trip.passengerId;
    if (notifyUserId) {
      setImmediate(() => {
        try {
          emitter.emit('notification', {
            userId: notifyUserId.toString(),
            type: 'trip_cancelled',
            title: 'Trip Cancelled',
            body: `Trip was cancelled: ${trip.cancellationReason}`,
            data: { tripId: trip._id, reason: trip.cancellationReason }
          });
        } catch (emitErr) {
          console.error('Notification error:', emitErr);
        }
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
    
    // Authorization check
    const userId = req.user.sub;
    const isPassenger = trip.passengerId.toString() === userId;
    const isDriver = trip.driverId?.toString() === userId;
    
    if (!isPassenger && !isDriver) {
      return res.status(403).json({ error: { message: 'Unauthorized' } });
    }
    
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
        console.log(`🧹 Cleaning up expired trip request: ${req._id}`);
        await cleanupFailedTripRequest(req._id);
      }

      // Delete old no_drivers requests (older than 10 minutes)
      const deleted = await TripRequest.deleteMany({
        status: 'no_drivers',
        createdAt: { $lt: new Date(now.getTime() - 10 * 60 * 1000) }
      });

      if (deleted.deletedCount > 0) {
        console.log(`🗑️ Deleted ${deleted.deletedCount} old no_drivers requests`);
      }

      // Cleanup old idempotency keys
      await mongoose.connection.collection('idempotency_keys').deleteMany({
        expiresAt: { $lt: now }
      });

    } catch (err) {
      console.error('Cleanup error:', err);
    }
  }, 5 * 60 * 1000); // Every 5 minutes
}

startPeriodicCleanup();

// ==========================================
// ADMIN ENDPOINTS
// ==========================================

router.post('/admin/flush-trips', requireAuth, requireAdmin, async (req, res) => {
  try {
    // Delete only old/expired trips, not all
    const deleted = await TripRequest.deleteMany({
      expiresAt: { $lt: new Date() }
    });
    
    res.json({ 
      success: true, 
      deletedCount: deleted.deletedCount,
      message: `Deleted ${deleted.deletedCount} expired trip requests`
    });
  } catch (err) {
    console.error('Flush error:', err);
    res.status(500).json({ error: { message: 'Flush failed' } });
  }
});

router.get('/admin/config', requireAuth, requireAdmin, async (req, res) => {
  res.json({
    config: CONFIG,
    timestamp: new Date().toISOString(),
    stats: {
      searchingTrips: await TripRequest.countDocuments({ status: 'searching' }),
      activeTrips: await Trip.countDocuments({ 
        status: { $in: ['assigned', 'started', 'in_progress'] } 
      })
    }
  });
});

// ==========================================
// Cleanup single driver state (Driver can call this)
// ==========================================
router.post('/drivers/cleanup-state', requireAuth, async (req, res) => {
  try {
    const driverId = req.user.sub;
    
    console.log(`🧹 Cleaning up state for driver ${driverId}`);
    
    const driver = await User.findById(driverId).select('driverProfile');
    
    if (!driver) {
      return res.status(404).json({ error: { message: 'Driver not found' } });
    }

    let cleaned = false;
    const issues = [];

    // Check if driver has a currentTripId
    if (driver.driverProfile?.currentTripId) {
      const currentTrip = await Trip.findById(driver.driverProfile.currentTripId)
        .select('status');

      if (!currentTrip) {
        issues.push('Trip not found - removing stale reference');
        cleaned = true;
      } else if (['completed', 'cancelled'].includes(currentTrip.status)) {
        issues.push(`Trip ${currentTrip.status} - removing stale reference`);
        cleaned = true;
      } else {
        issues.push(`Trip is ${currentTrip.status} - keeping reference`);
      }
    }

    // Perform cleanup if needed
    if (cleaned) {
      await User.findByIdAndUpdate(driverId, {
        'driverProfile.isAvailable': true,
        $unset: { 'driverProfile.currentTripId': '' }
      });

      console.log(`✅ Driver ${driverId} state cleaned up`);

      res.json({
        success: true,
        message: 'Driver state cleaned up successfully',
        issues,
        cleaned: true
      });
    } else {
      res.json({
        success: true,
        message: 'No cleanup needed',
        issues,
        cleaned: false
      });
    }

  } catch (err) {
    console.error('Cleanup error:', err);
    res.status(500).json({ error: { message: 'Cleanup failed' } });
  }
});

// ==========================================
// Cleanup all drivers (ADMIN ONLY)
// ==========================================
router.post('/admin/cleanup-all-drivers', requireAuth, requireAdmin, async (req, res) => {
  try {
    console.log('🧹 Starting cleanup of all driver states');

    // Find all drivers with currentTripId
    const driversWithTrips = await User.find({
      'driverProfile.currentTripId': { $exists: true, $ne: null }
    }).select('_id name driverProfile');

    const results = {
      total: driversWithTrips.length,
      cleaned: 0,
      active: 0,
      errors: []
    };

    for (const driver of driversWithTrips) {
      try {
        const currentTrip = await Trip.findById(driver.driverProfile.currentTripId)
          .select('status');

        if (!currentTrip || ['completed', 'cancelled'].includes(currentTrip?.status)) {
          // Clean up stale reference
          await User.findByIdAndUpdate(driver._id, {
            'driverProfile.isAvailable': true,
            $unset: { 'driverProfile.currentTripId': '' }
          });

          results.cleaned++;
          console.log(`✅ Cleaned up driver ${driver._id} (${driver.name})`);
        } else {
          results.active++;
          console.log(`⏩ Driver ${driver._id} has active trip ${currentTrip.status}`);
        }
      } catch (err) {
        results.errors.push({
          driverId: driver._id,
          error: err.message
        });
        console.error(`❌ Error cleaning driver ${driver._id}:`, err.message);
      }
    }

    console.log('✅ Cleanup complete:', results);

    res.json({
      success: true,
      message: 'Driver state cleanup complete',
      results
    });

  } catch (err) {
    console.error('Admin cleanup error:', err);
    res.status(500).json({ error: { message: 'Cleanup failed' } });
  }
});

// ==========================================
// Get driver current state (for debugging)
// ==========================================
router.get('/drivers/current-state', requireAuth, async (req, res) => {
  try {
    const driverId = req.user.sub;
    
    const driver = await User.findById(driverId)
      .select('name driverProfile')
      .lean();

    if (!driver) {
      return res.status(404).json({ error: { message: 'Driver not found' } });
    }

    let currentTrip = null;
    if (driver.driverProfile?.currentTripId) {
      currentTrip = await Trip.findById(driver.driverProfile.currentTripId)
        .select('status requestedAt startedAt completedAt cancelledAt')
        .lean();
    }

    res.json({
      driverId,
      name: driver.name,
      isAvailable: driver.driverProfile?.isAvailable,
      currentTripId: driver.driverProfile?.currentTripId?.toString() || null,
      currentTrip: currentTrip ? {
        id: currentTrip._id,
        status: currentTrip.status,
        requestedAt: currentTrip.requestedAt,
        startedAt: currentTrip.startedAt,
        completedAt: currentTrip.completedAt,
        cancelledAt: currentTrip.cancelledAt
      } : null,
      needsCleanup: driver.driverProfile?.currentTripId && 
                    (!currentTrip || ['completed', 'cancelled'].includes(currentTrip?.status))
    });

  } catch (err) {
    console.error('Get state error:', err);
    res.status(500).json({ error: { message: 'Failed to get state' } });
  }
});

// ==========================================
// POST /trips/:tripId/complete - COMPLETELY FIXED
// ==========================================

router.post('/:tripId/complete', requireAuth, async (req, res, next) => {
  const session = await mongoose.startSession();
  session.startTransaction();
  
  let tripData = null;
  let passengerId = null;
  let finalFare = 0;
  let tripId = req.params.tripId;

  try {
    const driverId = req.user.sub;
    const { actualDistanceKm, actualDurationMinutes, paymentConfirmation } = req.body;

    console.log(`✅ Driver ${driverId} completing trip ${tripId}`);
    console.log('Payment confirmation:', paymentConfirmation);

    // Check if trip exists
    const existingTrip = await Trip.findById(tripId).session(session);
    if (!existingTrip) {
      throw new Error('Trip not found');
    }

    // Authorization check
    if (existingTrip.driverId.toString() !== driverId) {
      throw new Error('Unauthorized: You are not the driver for this trip');
    }

    // Check if trip is already completed or cancelled
    if (['completed', 'cancelled'].includes(existingTrip.status)) {
      throw new Error(`Trip is already ${existingTrip.status}`);
    }

    // Use actual metrics if provided, otherwise use estimated
    const finalDistance = actualDistanceKm || existingTrip.distanceKm || 0;
    const finalDuration = actualDurationMinutes || existingTrip.durationMinutes || 0;

    // Calculate fare
    const fareData = await calculateFare({
      serviceType: existingTrip.serviceType,
      distanceKm: finalDistance,
      durationMinutes: finalDuration
    });

    finalFare = fareData.baseAmount;

    // Calculate commission for luxury rides
    let commission = 0;
    if (isLuxury(existingTrip.serviceType)) {
      const setting = await Settings.findOne({ key: 'commission_percent' }).lean();
      const percent = setting?.value ? Number(setting.value) : 10;
      commission = Math.round((percent / 100) * finalFare);
    }

    const driverEarnings = finalFare - commission;

    // Handle wallet payment
    if (existingTrip.paymentMethod === 'wallet') {
      const passengerWallet = await Wallet.findOne({ owner: existingTrip.passengerId }).session(session);
      if (!passengerWallet) {
        throw new Error('Passenger wallet not found');
      }

      if (passengerWallet.balance < finalFare) {
        throw new Error('Passenger has insufficient balance');
      }

      // Deduct from passenger wallet
      await Wallet.findOneAndUpdate(
        { owner: existingTrip.passengerId },
        { $inc: { balance: -finalFare } },
        { session }
      );

      // Add to driver wallet
      await Wallet.findOneAndUpdate(
        { owner: driverId },
        { $inc: { balance: driverEarnings } },
        { upsert: true, session }
      );

      // Record transactions
      await Transaction.create([{
        userId: existingTrip.passengerId,
        type: 'trip_payment',
        amount: -finalFare,
        description: `Trip #${tripId.slice(-6)}`,
        metadata: { tripId: existingTrip._id }
      }, {
        userId: driverId,
        type: 'trip_earnings',
        amount: driverEarnings,
        description: `Earnings from trip #${tripId.slice(-6)}`,
        metadata: { tripId: existingTrip._id, commission }
      }], { session });
    }

    // Update trip document
    const updatedTrip = await Trip.findByIdAndUpdate(
      tripId,
      {
        status: 'completed',
        finalFare,
        distanceKm: finalDistance,
        durationMinutes: finalDuration,
        commission,
        driverEarnings,
        completedAt: new Date()
      },
      { new: true, session }
    );

    // Store data for response
    tripData = updatedTrip;
    passengerId = existingTrip.passengerId.toString();

    // CRITICAL: Clean up driver state
    await User.findByIdAndUpdate(
      driverId,
      {
        'driverProfile.isAvailable': true,
        $unset: { 'driverProfile.currentTripId': '' }
      },
      { session }
    );

    console.log(`✅ Driver ${driverId} state cleaned up and marked available`);

    // Commit transaction
    await session.commitTransaction();
    console.log(`✅ Transaction committed for trip ${tripId}`);

    // Prepare success response
    const responseData = {
      success: true,
      trip: {
        id: tripData._id.toString(),
        status: tripData.status,
        finalFare: tripData.finalFare,
        completedAt: tripData.completedAt,
        driverEarnings: tripData.driverEarnings
      }
    };

    res.json(responseData);

    // Send notifications AFTER response is sent (non-blocking)
    setImmediate(async () => {
      try {
        // Notify passenger
        emitter.emit('notification', {
          userId: passengerId,
          type: 'trip_completed',
          title: 'Trip Completed',
          body: `Your trip has been completed. Amount: ₦${(finalFare / 100).toFixed(2)}`,
          data: {
            tripId: tripId,
            fare: finalFare,
            status: 'completed'
          }
        });

        // Also emit trip_completed event for real-time updates
        emitter.emit('trip_completed', {
          tripId: tripId,
          driverId: driverId,
          passengerId: passengerId,
          finalFare: finalFare,
          completedAt: new Date()
        });

        console.log(`📨 Notifications sent for completed trip ${tripId}`);
      } catch (emitErr) {
        console.error('Notification error (non-fatal):', emitErr);
      }
    });

  } catch (error) {
    // Abort transaction on error
    if (session.inTransaction()) {
      await session.abortTransaction();
      console.log('❌ Transaction aborted');
    }

    console.error('❌ Complete trip error:', error.message);

    // Determine appropriate error response
    let statusCode = 500;
    let errorCode = 'INTERNAL_ERROR';
    let errorMessage = error.message || 'Failed to complete trip';

    if (error.message.includes('not found')) {
      statusCode = 404;
      errorCode = 'TRIP_NOT_FOUND';
    } else if (error.message.includes('Unauthorized')) {
      statusCode = 403;
      errorCode = 'UNAUTHORIZED';
    } else if (error.message.includes('already completed') || error.message.includes('already cancelled')) {
      statusCode = 400;
      errorCode = 'TRIP_ALREADY_ENDED';
    } else if (error.message.includes('insufficient balance')) {
      statusCode = 402;
      errorCode = 'INSUFFICIENT_BALANCE';
    } else if (error.message.includes('required') || error.message.includes('Invalid')) {
      statusCode = 400;
      errorCode = 'INVALID_REQUEST';
    }

    res.status(statusCode).json({
      success: false,
      error: {
        message: errorMessage,
        code: errorCode
      }
    });
  } finally {
    await session.endSession();
  }
});

// ==========================================
// MONGOOSE INDEX CREATION (Run once)
// ==========================================

async function createIndexes() {
  try {
    // Create idempotency key index
    await mongoose.connection.collection('idempotency_keys').createIndex(
      { key: 1 },
      { unique: true, expireAfterSeconds: 24 * 60 * 60 } // 24 hour TTL
    );
    
    console.log('✅ Idempotency key index created');
  } catch (err) {
    console.log('Index creation error (may already exist):', err.message);
  }
}

// Call on startup
createIndexes();

module.exports = router;