// routes/trips.routes.js (FIXED VERSION)
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
const { requireActiveSubscription } = require('../middleware/subscriptionCheck');
const { processTripWalletPayment, recordCashTripEarning } = require('../utils/tripPaymentService');

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
async function cleanupFailedTripRequest(requestId) {
  try {
    console.log(`🧹 Cleaning up failed trip request: ${requestId}`);
    
    const tripRequest = await TripRequest.findById(requestId);
    if (!tripRequest) {
      console.log(`⚠️ Trip request ${requestId} not found for cleanup`);
      return;
    }

    tripRequest.candidates.forEach(candidate => {
      if (candidate.status === 'offered' || candidate.status === 'pending') {
        candidate.status = 'rejected';
        candidate.rejectedAt = new Date();
        candidate.rejectionReason = 'max_attempts_reached';
      }
    });

    tripRequest.status = 'no_drivers';
    await tripRequest.save();

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

async function trackRejection(requestId) {
  try {
    const tripRequest = await TripRequest.findById(requestId);
    if (!tripRequest) return false;

    const rejectionCount = tripRequest.candidates.filter(
      c => c.status === 'rejected' && 
           c.rejectionReason !== 'max_attempts_reached'
    ).length;

    console.log(`📊 Trip ${requestId} rejection count: ${rejectionCount}/${CONFIG.MAX_REJECTIONS}`);

    if (rejectionCount >= CONFIG.MAX_REJECTIONS) {
      console.log(`🚫 Trip ${requestId} reached max rejections (${CONFIG.MAX_REJECTIONS}), initiating cleanup`);
      await cleanupFailedTripRequest(requestId);
      return true;
    }

    return false;
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
// POST /trips/request - CREATE TRIP REQUEST
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

      if (!pickup || !validateCoordinates(pickup.coordinates)) {
        throw new Error('Invalid pickup coordinates');
      }

      if (!validateServiceType(serviceType)) {
        throw new Error('Invalid serviceType');
      }

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

      let nearbyDrivers = [];
      
      try {
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
        
        responsePayload = {
          requestId: tripRequest[0]._id,
          message: 'No drivers available'
        };
        
        candidateData = null;
        firstCandidate = null;
        
        return;
      }

      if (candidates.length > 0) {
        candidates[0].status = 'offered';
        candidates[0].offeredAt = now;
        firstCandidate = candidates[0];
        console.log(`📤 Offering to first driver: ${candidates[0].driverId}`);
      }

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

    res.json(responsePayload);

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
// OFFER TO NEXT DRIVER
// ==========================================

async function offerToNext(requestId) {
  try {
    console.log(`🔄 offerToNext for ${requestId}`);

    const tripRequest = await TripRequest.findById(requestId);
    if (!tripRequest || tripRequest.status !== 'searching') {
      console.log(`❌ Trip ${requestId} not searching or not found`);
      return;
    }

    const shouldCleanup = await trackRejection(requestId);
    if (shouldCleanup) {
      console.log(`🚫 Trip ${requestId} reached max rejections, cleaning up`);
      return;
    }

    const nextCandidate = tripRequest.candidates.find(
      c => c.status === 'pending' && !c.rejectedAt
    );

    if (!nextCandidate) {
      console.log(`⚠️ No more pending candidates for ${requestId}`);
      await cleanupFailedTripRequest(requestId);
      return;
    }

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

    nextCandidate.status = 'offered';
    nextCandidate.offeredAt = new Date();
    await tripRequest.save();

    const driverId = nextCandidate.driverId;
    
    const rejectionCount = tripRequest.candidates.filter(c => c.status === 'rejected').length;
    console.log(`📤 Offering to driver ${driverId} (Attempt ${rejectionCount + 1}/${CONFIG.MAX_REJECTIONS})`);

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
// POST /trips/accept - DRIVER ACCEPTS (FIXED - NO AUTO CLEANUP)
// ==========================================

router.post('/accept', requireAuth, requireActiveSubscription, async (req, res, next) => {
  const session = await mongoose.startSession();
  session.startTransaction();
  
  let tripData = null;
  let notificationData = null;
  let responseSent = false;

  try {
    const driverId = req.user.sub;
    const { requestId, idempotencyKey } = req.body;

    if (!requestId) {
      throw new Error('Request ID is required');
    }

    const finalIdempotencyKey = idempotencyKey || `accept_${requestId}_${driverId}_${Date.now()}`;

    console.log(`🤝 Driver ${driverId} attempting to accept request ${requestId}`);
    console.log('✅ Subscription verified:', {
      expiresAt: req.subscription.expiresAt,
      vehicleType: req.subscription.vehicleType
    });

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

    await idempotencyCollection.insertOne({
      key: finalIdempotencyKey,
      driverId: driverId,
      requestId: requestId,
      status: 'processing',
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000)
    }, { session });

    console.log('🔒 Idempotency key inserted');

    const driver = await User.findById(driverId)
      .select('name driverProfile')
      .session(session);

    if (!driver) {
      throw new Error('Driver not found');
    }

    if (!driver.driverProfile?.isAvailable) {
      console.log(`⚠️ Driver isAvailable: ${driver.driverProfile?.isAvailable}`);
      await idempotencyCollection.updateOne(
        { key: finalIdempotencyKey },
        { $set: { status: 'failed', error: 'Driver not available' } },
        { session }
      );
      throw new Error('Driver is not available');
    }

    console.log('✅ Driver availability verified');

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
      
      await idempotencyCollection.updateOne(
        { key: finalIdempotencyKey },
        { $set: { status: 'failed', error: 'Trip no longer available' } },
        { session }
      );
      
      if (currentRequest.assignedDriverId && currentRequest.assignedDriverId.toString() !== driverId.toString()) {
        throw new Error('Trip was already assigned to another driver');
      } else {
        throw new Error('Trip is no longer available');
      }
    }

    console.log(`✅ Trip ${requestId} atomically assigned to driver ${driverId}`);

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
      requestedAt: new Date(),
      metadata: {
        subscriptionId: req.subscription.id,
        subscriptionExpiresAt: req.subscription.expiresAt,
        vehicleType: req.subscription.vehicleType
      }
    }], { session });

    const newTrip = tripDoc[0];
    console.log(`✅ Trip document ${newTrip._id} created`);

    await User.findByIdAndUpdate(
      driverId,
      {
        'driverProfile.isAvailable': false,
        'driverProfile.currentTripId': newTrip._id
      },
      { session }
    );

    console.log('✅ Driver status updated');

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

    await session.commitTransaction();
    console.log('✅ Transaction committed successfully');

    tripData = {
      success: true,
      tripId: newTrip._id.toString(),
      requestId: tripRequest._id.toString(),
      driverId: driverId.toString(),
      subscription: {
        expiresAt: req.subscription.expiresAt,
        vehicleType: req.subscription.vehicleType
      }
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

    res.json(tripData);
    responseSent = true;
    console.log('✅ Response sent to driver');

    // Send notifications (non-blocking)
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

    candidate.status = 'rejected';
    candidate.rejectedAt = new Date();
    candidate.rejectionReason = 'manual_rejection';
    await tripRequest.save();

    console.log(`❌ Driver ${driverId} rejected trip ${requestId}`);

    await offerToNext(requestId);

    res.json({ success: true });
  } catch (err) {
    console.error('❌ Reject error:', err);
    next(err);
  }
});

// ==========================================
// ADMIN ENDPOINTS
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

// 🚨 FIX #1: DELETE DUPLICATE COMPLETE ENDPOINT
// 🚨 FIX #2: CORRECT TRANSACTION USAGE - REMOVE manual start/commit, use withTransaction
// ONLY KEEP THIS ONE /complete ENDPOINT

// ============================================================
// PATCH FOR routes/trips.routes.js
//
// ADD these two imports near the top of trips.routes.js:
//
//   const { processTripWalletPayment, recordCashTripEarning } = require('../utils/tripPaymentService');
//   const referralRouter = require('./referral');
//
// Then REPLACE the existing /:tripId/complete route entirely
// with the one below.
// ============================================================

router.post('/:tripId/complete', requireAuth, async (req, res, next) => {
  const session = await mongoose.startSession();

  try {
    await session.withTransaction(async () => {
      const driverId = req.user.sub;
      const { cashReceived } = req.body;
      const tripId = req.params.tripId;

      console.log(`✅ Completing trip ${tripId} — driver ${driverId}`);

      // ── 1. Load trip ────────────────────────────────────────────────────

      const existingTrip = await Trip.findById(tripId).session(session);
      if (!existingTrip) throw new Error('Trip not found');

      if (existingTrip.driverId.toString() !== driverId) {
        throw new Error('Unauthorized: You are not the driver for this trip');
      }

      if (['completed', 'cancelled'].includes(existingTrip.status)) {
        throw new Error(`Trip is already ${existingTrip.status}`);
      }

      const finalFare = existingTrip.estimatedFare || 0;
      const paymentMethod = existingTrip.paymentMethod || 'cash';
      const passengerId = existingTrip.passengerId.toString();

      console.log(`💰 Fare: ₦${(finalFare / 100).toFixed(2)} | Payment: ${paymentMethod}`);

      // ── 2. Process payment ──────────────────────────────────────────────
      //
      // Wallet trips:  debit passenger wallet, credit driver wallet (full fare)
      // Cash trips:    credit driver wallet with earned amount (cash already received)
      //
      // In BOTH cases the driver receives the full fare in their wallet.
      // If the passenger used a referral bonus to fund their wallet, that
      // is transparent to the driver — they still get the full amount.

      let paymentResult = null;
      let resolvedPaymentMethod = paymentMethod;

      if (paymentMethod === 'wallet') {
        try {
          paymentResult = await processTripWalletPayment(
            {
              tripId,
              passengerId,
              driverId,
              fareKobo: finalFare,
              serviceType: existingTrip.serviceType
            },
            session
          );
          console.log(`✅ Wallet payment processed — driver credited ₦${(finalFare / 100).toFixed(2)}`);
        } catch (paymentErr) {
          // Insufficient wallet balance — fall back to cash so the trip
          // can still complete (driver physically collects the amount).
          console.warn(
            `⚠️ Wallet payment failed (${paymentErr.message}). ` +
            `Falling back to cash payment.`
          );
          resolvedPaymentMethod = 'cash_fallback';

          // Still record driver earning for cash fallback
          paymentResult = await recordCashTripEarning(
            {
              tripId,
              passengerId,
              driverId,
              fareKobo: finalFare,
              serviceType: existingTrip.serviceType
            },
            session
          );
        }
      } else {
        // cash / any other method
        paymentResult = await recordCashTripEarning(
          {
            tripId,
            passengerId,
            driverId,
            fareKobo: finalFare,
            serviceType: existingTrip.serviceType
          },
          session
        );
        console.log(`✅ Cash earning recorded for driver — ₦${(finalFare / 100).toFixed(2)}`);
      }

      // ── 3. Mark trip completed ─────────────────────────────────────────

      const updatedTrip = await Trip.findByIdAndUpdate(
        tripId,
        {
          status: 'completed',
          finalFare,
          completedAt: new Date(),
          paymentMethod: resolvedPaymentMethod,
          paymentConfirmed: true,
          // Store transaction IDs for auditing
          ...(paymentResult?.passengerTxn && {
            'metadata.passengerTransactionId': paymentResult.passengerTxn._id
          }),
          ...(paymentResult?.driverTxn && {
            'metadata.driverTransactionId': paymentResult.driverTxn._id
          })
        },
        { new: true, session }
      );

      // ── 4. Update driver availability ──────────────────────────────────

      await User.findByIdAndUpdate(
        driverId,
        {
          'driverProfile.isAvailable': true,
          $unset: { 'driverProfile.currentTripId': '' },
          $inc: { 'driverProfile.totalTrips': 1, 'driverProfile.totalEarnings': finalFare }
        },
        { session }
      );

      console.log(`✅ Driver ${driverId} is now available`);

      // ── 5. First-trip referral reward gate ─────────────────────────────
      //
      // Atomically flip hasCompletedFirstTrip — only matches once per passenger,
      // so the referral reward fires exactly once no matter what.

      const passengerUpdate = await User.findOneAndUpdate(
        { _id: passengerId, hasCompletedFirstTrip: { $ne: true } },
        { $set: { hasCompletedFirstTrip: true } },
        { session, new: false }
      );
      const isFirstTrip = passengerUpdate !== null;

      // ── 6. Send response immediately ───────────────────────────────────

      const driverNewBalance = paymentResult?.driverWallet?.balance ?? null;

      res.json({
        success: true,
        trip: {
          id: updatedTrip._id.toString(),
          status: updatedTrip.status,
          finalFare: updatedTrip.finalFare,
          finalFareNaira: (updatedTrip.finalFare / 100).toFixed(2),
          completedAt: updatedTrip.completedAt,
          paymentMethod: resolvedPaymentMethod
        },
        // Include driver's updated balance so the app can refresh the UI
        driverWallet: driverNewBalance !== null
          ? {
              balance: driverNewBalance,
              balanceNaira: (driverNewBalance / 100).toFixed(2),
              balanceFormatted: `₦${(driverNewBalance / 100).toLocaleString()}`
            }
          : null,
        message: 'Trip completed successfully. Driver is now available for new trips.'
      });

      // ── 7. Post-commit side effects (non-blocking) ─────────────────────

      setImmediate(async () => {
        try {
          // Referral reward — fires only once per passenger lifetime
          if (isFirstTrip) {
            console.log(`🎁 First trip for passenger ${passengerId}, checking referral...`);
            const referralRouter = require('./referral');
            await referralRouter.triggerReferralReward(tripId, passengerId);
          }

          // Notify passenger
          const paymentNote = resolvedPaymentMethod === 'wallet'
            ? 'Paid from your wallet.'
            : resolvedPaymentMethod === 'cash_fallback'
              ? 'Insufficient wallet balance — please pay driver ₦' + (finalFare / 100).toFixed(2) + ' in cash.'
              : 'Cash payment.';

          emitter.emit('notification', {
            userId: passengerId,
            type: 'trip_completed',
            title: 'Trip Completed',
            body: `Your trip is done. Fare: ₦${(finalFare / 100).toFixed(2)}. ${paymentNote}`,
            data: {
              tripId,
              fare: finalFare,
              status: 'completed',
              paymentMethod: resolvedPaymentMethod
            }
          });

          // Notify driver of their earned amount
          emitter.emit('notification', {
            userId: driverId,
            type: 'trip_completed',
            title: 'Trip Completed — Payment Received',
            body: `You earned ₦${(finalFare / 100).toFixed(2)} for this trip.`,
            data: {
              tripId,
              earned: finalFare,
              status: 'completed'
            }
          });

          emitter.emit('trip_completed', {
            tripId,
            driverId,
            passengerId,
            finalFare,
            completedAt: new Date()
          });

          console.log(`📨 Post-completion events done for trip ${tripId}`);
        } catch (postErr) {
          console.error('Post-completion error (non-fatal):', postErr.message);
        }
      });
    }); // end withTransaction

  } catch (error) {
    console.error('❌ Complete trip error:', error.message);

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
      errorMessage = 'This trip has already been ended.';
    } else if (error.message.includes('Insufficient wallet balance')) {
      // This should not surface since we fall back to cash, but just in case
      statusCode = 400;
      errorCode = 'INSUFFICIENT_BALANCE';
    }

    res.status(statusCode).json({
      success: false,
      error: { message: errorMessage, code: errorCode }
    });
  } finally {
    await session.endSession();
  }
});

// ==========================================
// POST /trips/:tripId/cancel
// ==========================================

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

    // SIMPLIFIED: Just mark as cancelled
    trip.status = 'cancelled';
    trip.cancelledAt = new Date();
    trip.cancellationReason = reason || (isPassenger ? 'passenger_cancelled' : 'driver_cancelled');
    await trip.save();

    // ✅ Clean up driver state if driver cancelled
    if (isDriver && trip.driverId) {
      await User.findByIdAndUpdate(trip.driverId, {
        'driverProfile.isAvailable': true,
        $unset: { 'driverProfile.currentTripId': '' }
      });
    }

    res.json({ 
      success: true,
      trip,
      message: 'Trip cancelled successfully'
    });

  } catch (err) {
    console.error('Cancel error:', err);
    res.status(500).json({ 
      success: false,
      error: { message: 'Failed to cancel trip' } 
    });
  }
});

// ==========================================
// GET /trips/:tripId
// ==========================================

router.get('/:tripId', requireAuth, async (req, res, next) => {
  try {
    const trip = await Trip.findById(req.params.tripId).lean();
    if (!trip) return res.status(404).json({ error: { message: 'Trip not found' } });
    
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

// ==========================================
// GET /trips
// ==========================================

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

      const expired = await TripRequest.find({
        status: 'searching',
        expiresAt: { $lt: now }
      }).lean();

      for (const req of expired) {
        console.log(`🧹 Cleaning up expired trip request: ${req._id}`);
        await cleanupFailedTripRequest(req._id);
      }

      const deleted = await TripRequest.deleteMany({
        status: 'no_drivers',
        createdAt: { $lt: new Date(now.getTime() - 10 * 60 * 1000) }
      });

      if (deleted.deletedCount > 0) {
        console.log(`🗑️ Deleted ${deleted.deletedCount} old no_drivers requests`);
      }

      await mongoose.connection.collection('idempotency_keys').deleteMany({
        expiresAt: { $lt: now }
      });

    } catch (err) {
      console.error('Cleanup error:', err);
    }
  }, 5 * 60 * 1000);
}

startPeriodicCleanup();

// ==========================================
// ADMIN ENDPOINTS
// ==========================================

router.post('/admin/flush-trips', requireAuth, requireAdmin, async (req, res) => {
  try {
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
// Cleanup single driver state
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
// Get driver current state
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
// CREATE INDEXES
// ==========================================

async function createIndexes() {
  try {
    await mongoose.connection.collection('idempotency_keys').createIndex(
      { key: 1 },
      { unique: true, expireAfterSeconds: 24 * 60 * 60 }
    );
    
    console.log('✅ Idempotency key index created');
  } catch (err) {
    console.log('Index creation error (may already exist):', err.message);
  }
}

// ==========================================
// GET /trips/history - GET USER TRIP HISTORY
// ==========================================

/**
 * Get trip history for the authenticated user
 * Query params:
 * - role: 'passenger' | 'driver' (default: 'passenger')
 * - status: 'completed' | 'cancelled' | 'all' (default: 'all')
 * - limit: number (default: 50, max: 100)
 * - offset: number (default: 0)
 * - startDate: ISO date string (optional)
 * - endDate: ISO date string (optional)
 */
router.get('/history', requireAuth, async (req, res, next) => {
  try {
    const userId = req.user.sub;
    const { 
      role = 'passenger', 
      status = 'all',
      limit = 50, 
      offset = 0,
      startDate,
      endDate
    } = req.query;

    console.log(`📊 Fetching trip history for user ${userId} (role: ${role})`);

    // Build filter
    const filter = {};
    
    // Filter by role
    if (role === 'driver') {
      filter.driverId = userId;
    } else {
      filter.passengerId = userId;
    }

    // Filter by status
    if (status === 'completed') {
      filter.status = 'completed';
    } else if (status === 'cancelled') {
      filter.status = 'cancelled';
    } else {
      // 'all' - get completed and cancelled trips
      filter.status = { $in: ['completed', 'cancelled'] };
    }

    // Date range filter
    if (startDate || endDate) {
      filter.completedAt = {};
      if (startDate) {
        filter.completedAt.$gte = new Date(startDate);
      }
      if (endDate) {
        filter.completedAt.$lte = new Date(endDate);
      }
    }

    const parsedLimit = Math.min(parseInt(limit) || 50, 100);
    const parsedOffset = parseInt(offset) || 0;

    // Fetch trips with populated data
    const trips = await Trip.find(filter)
      .populate('passengerId', 'name phone profilePicUrl')
      .populate('driverId', 'name phone profilePicUrl driverProfile')
      .sort({ completedAt: -1, cancelledAt: -1, createdAt: -1 })
      .limit(parsedLimit)
      .skip(parsedOffset)
      .lean();

    const total = await Trip.countDocuments(filter);

    // Format trips for frontend
    const formattedTrips = trips.map(trip => {
      const isDriver = trip.driverId?._id?.toString() === userId;
      
      return {
        id: trip._id.toString(),
        date: trip.completedAt || trip.cancelledAt || trip.createdAt,
        status: trip.status,
        
        // Route information
        pickup: {
          address: trip.pickupLocation?.address || 'Pickup Location',
          coordinates: trip.pickupLocation?.coordinates
        },
        dropoff: {
          address: trip.dropoffLocation?.address || 'Dropoff Location',
          coordinates: trip.dropoffLocation?.coordinates
        },
        
        // Service details
        serviceType: trip.serviceType,
        paymentMethod: trip.paymentMethod,
        
        // Pricing
        estimatedFare: trip.estimatedFare,
        finalFare: trip.finalFare,
        fareInNaira: trip.finalFare ? (trip.finalFare / 100).toFixed(2) : '0.00',
        
        // Trip metrics
        distanceKm: trip.distanceKm,
        durationMinutes: trip.durationMinutes,
        
        // Timestamps
        requestedAt: trip.requestedAt,
        startedAt: trip.startedAt,
        completedAt: trip.completedAt,
        cancelledAt: trip.cancelledAt,
        cancellationReason: trip.cancellationReason,
        
        // Other party info (driver for passenger, passenger for driver)
        otherParty: isDriver ? {
          id: trip.passengerId?._id?.toString(),
          name: trip.passengerId?.name || 'Passenger',
          phone: trip.passengerId?.phone,
          profilePicUrl: trip.passengerId?.profilePicUrl
        } : {
          id: trip.driverId?._id?.toString(),
          name: trip.driverId?.name || 'Driver',
          phone: trip.driverId?.phone,
          profilePicUrl: trip.driverId?.profilePicUrl,
          vehicleInfo: trip.driverId?.driverProfile ? {
            make: trip.driverId.driverProfile.vehicleMake,
            model: trip.driverId.driverProfile.vehicleModel,
            number: trip.driverId.driverProfile.vehicleNumber
          } : null
        }
      };
    });

    // Calculate summary stats
    const stats = {
      totalTrips: total,
      completedTrips: await Trip.countDocuments({ 
        ...filter, 
        status: 'completed' 
      }),
      cancelledTrips: await Trip.countDocuments({ 
        ...filter, 
        status: 'cancelled' 
      }),
      totalSpent: trips
        .filter(t => t.status === 'completed')
        .reduce((sum, t) => sum + (t.finalFare || 0), 0)
    };

    console.log(`✅ Found ${formattedTrips.length} trips (${total} total)`);

    res.json({
      success: true,
      trips: formattedTrips,
      pagination: {
        total,
        limit: parsedLimit,
        offset: parsedOffset,
        hasMore: total > parsedOffset + parsedLimit
      },
      stats: {
        ...stats,
        totalSpentInNaira: (stats.totalSpent / 100).toFixed(2)
      }
    });

  } catch (err) {
    console.error('❌ Trip history error:', err);
    next(err);
  }
});

// ==========================================
// GET /trips/history/stats - GET TRIP STATISTICS
// ==========================================

/**
 * Get detailed statistics about trip history
 * Query params:
 * - role: 'passenger' | 'driver' (default: 'passenger')
 * - period: 'week' | 'month' | 'year' | 'all' (default: 'month')
 */
router.get('/history/stats', requireAuth, async (req, res, next) => {
  try {
    const userId = req.user.sub;
    const { role = 'passenger', period = 'month' } = req.query;

    console.log(`📊 Fetching trip stats for user ${userId} (period: ${period})`);

    // Calculate date range
    const now = new Date();
    let startDate;
    
    switch (period) {
      case 'week':
        startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
        break;
      case 'month':
        startDate = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
        break;
      case 'year':
        startDate = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000);
        break;
      default:
        startDate = null;
    }

    const filter = role === 'driver' 
      ? { driverId: userId }
      : { passengerId: userId };
    
    if (startDate) {
      filter.completedAt = { $gte: startDate };
    }

    // Aggregate statistics
    const completedFilter = { ...filter, status: 'completed' };
    
    const [
      completedTrips,
      cancelledTrips,
      totalDistanceResult,
      totalFareResult,
      serviceTypeBreakdown
    ] = await Promise.all([
      Trip.countDocuments(completedFilter),
      Trip.countDocuments({ ...filter, status: 'cancelled' }),
      Trip.aggregate([
        { $match: completedFilter },
        { $group: { _id: null, total: { $sum: '$distanceKm' } } }
      ]),
      Trip.aggregate([
        { $match: completedFilter },
        { $group: { _id: null, total: { $sum: '$finalFare' } } }
      ]),
      Trip.aggregate([
        { $match: completedFilter },
        { 
          $group: { 
            _id: '$serviceType', 
            count: { $sum: 1 },
            totalFare: { $sum: '$finalFare' }
          } 
        }
      ])
    ]);

    const totalDistance = totalDistanceResult[0]?.total || 0;
    const totalFare = totalFareResult[0]?.total || 0;

    res.json({
      success: true,
      period,
      stats: {
        totalTrips: completedTrips + cancelledTrips,
        completedTrips,
        cancelledTrips,
        totalDistance: parseFloat(totalDistance.toFixed(2)),
        totalFare,
        totalFareInNaira: (totalFare / 100).toFixed(2),
        averageFare: completedTrips > 0 ? totalFare / completedTrips : 0,
        averageFareInNaira: completedTrips > 0 
          ? ((totalFare / completedTrips) / 100).toFixed(2) 
          : '0.00',
        serviceTypeBreakdown: serviceTypeBreakdown.map(item => ({
          serviceType: item._id,
          count: item.count,
          totalFare: item.totalFare,
          totalFareInNaira: (item.totalFare / 100).toFixed(2)
        }))
      }
    });

  } catch (err) {
    console.error('❌ Trip stats error:', err);
    next(err);
  }
});

// ==========================================
// GET /trips/history/:tripId - GET SINGLE TRIP DETAILS
// ==========================================

/**
 * Get detailed information about a specific trip from history
 */
router.get('/history/:tripId', requireAuth, async (req, res, next) => {
  try {
    const userId = req.user.sub;
    const { tripId } = req.params;

    console.log(`📄 Fetching trip details: ${tripId}`);

    const trip = await Trip.findById(tripId)
      .populate('passengerId', 'name phone profilePicUrl')
      .populate('driverId', 'name phone profilePicUrl driverProfile')
      .lean();

    if (!trip) {
      return res.status(404).json({
        success: false,
        error: { message: 'Trip not found' }
      });
    }

    // Authorization check
    const isPassenger = trip.passengerId?._id?.toString() === userId;
    const isDriver = trip.driverId?._id?.toString() === userId;
    
    if (!isPassenger && !isDriver) {
      return res.status(403).json({
        success: false,
        error: { message: 'Unauthorized access to this trip' }
      });
    }

    // Format detailed trip data
    const detailedTrip = {
      id: trip._id.toString(),
      status: trip.status,
      
      // Passenger info
      passenger: {
        id: trip.passengerId?._id?.toString(),
        name: trip.passengerId?.name || 'Passenger',
        phone: trip.passengerId?.phone,
        profilePicUrl: trip.passengerId?.profilePicUrl
      },
      
      // Driver info
      driver: {
        id: trip.driverId?._id?.toString(),
        name: trip.driverId?.name || 'Driver',
        phone: trip.driverId?.phone,
        profilePicUrl: trip.driverId?.profilePicUrl,
        vehicle: trip.driverId?.driverProfile ? {
          make: trip.driverId.driverProfile.vehicleMake,
          model: trip.driverId.driverProfile.vehicleModel,
          number: trip.driverId.driverProfile.vehicleNumber
        } : null
      },
      
      // Route
      pickup: {
        address: trip.pickupLocation?.address || 'Pickup Location',
        coordinates: trip.pickupLocation?.coordinates
      },
      dropoff: {
        address: trip.dropoffLocation?.address || 'Dropoff Location',
        coordinates: trip.dropoffLocation?.coordinates
      },
      
      // Service & Payment
      serviceType: trip.serviceType,
      paymentMethod: trip.paymentMethod,
      paymentConfirmed: trip.paymentConfirmed,
      
      // Pricing
      estimatedFare: trip.estimatedFare,
      finalFare: trip.finalFare,
      commission: trip.commission,
      driverEarnings: trip.driverEarnings,
      fareBreakdown: {
        estimated: (trip.estimatedFare / 100).toFixed(2),
        final: trip.finalFare ? (trip.finalFare / 100).toFixed(2) : '0.00',
        commission: trip.commission ? (trip.commission / 100).toFixed(2) : '0.00',
        driverEarnings: trip.driverEarnings ? (trip.driverEarnings / 100).toFixed(2) : '0.00'
      },
      
      // Trip metrics
      distanceKm: trip.distanceKm,
      durationMinutes: trip.durationMinutes,
      
      // Timestamps
      requestedAt: trip.requestedAt,
      startedAt: trip.startedAt,
      completedAt: trip.completedAt,
      cancelledAt: trip.cancelledAt,
      cancellationReason: trip.cancellationReason,
      completionNotes: trip.completionNotes,
      
      // Trip request reference
      tripRequestId: trip.tripRequestId?.toString()
    };

    res.json({
      success: true,
      trip: detailedTrip
    });

  } catch (err) {
    console.error('❌ Trip detail error:', err);
    next(err);
  }
});


createIndexes();

module.exports = router;