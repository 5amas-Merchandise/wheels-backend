// routes/drivers.routes.js - COMPLETE WITH SUBSCRIPTION INTEGRATION

const express = require("express");
const router = express.Router();
const User = require("../models/user.model");
const TripRequest = require("../models/tripRequest.model");
const Trip = require("../models/trip.model");
const { requireAuth } = require("../middleware/auth");
const { requireActiveSubscription, checkSubscriptionStatus } = require("../middleware/subscriptionCheck");

const DURATION_DAYS = {
  daily: 1,
  weekly: 7,
  monthly: 30,
};

// ==========================================
// SUBSCRIPTION-PROTECTED ENDPOINTS
// ==========================================

// ✅ UPDATE: Availability endpoint now checks subscription
router.post("/availability", requireAuth, requireActiveSubscription, async (req, res, next) => {
  try {
    const userId = req.user && req.user.sub;
    if (!userId)
      return res.status(401).json({ error: { message: "Unauthorized" } });

    const { isAvailable, location } = req.body;

    console.log('📍 Availability update for driver:', {
      userId,
      isAvailable,
      hasLocation: !!location,
      subscriptionExpiresAt: req.subscription?.expiresAt,
      timestamp: new Date().toISOString()
    });

    // ✅ ALWAYS UPDATE lastSeen - This is critical for driver visibility
    const update = { 
      "driverProfile.lastSeen": new Date(),
      "driverProfile.isAvailable": isAvailable !== undefined ? isAvailable : true
    };

    if (typeof isAvailable === "boolean") {
      update["driverProfile.isAvailable"] = isAvailable;
      console.log(`🔄 Setting driver ${userId} availability to: ${isAvailable}`);
    }

    // ✅ Handle location updates
    if (location) {
      let coords = null;
      
      if (location.type === 'Point' && Array.isArray(location.coordinates)) {
        coords = location.coordinates;
      } else if (Array.isArray(location.coordinates) && location.coordinates.length === 2) {
        coords = location.coordinates;
      } else if (Array.isArray(location) && location.length === 2) {
        coords = location;
      }

      if (coords && coords.length === 2) {
        const [lng, lat] = coords;
        
        if (lng >= -180 && lng <= 180 && lat >= -90 && lat <= 90) {
          update["driverProfile.location"] = {
            type: "Point",
            coordinates: [lng, lat],
          };
          console.log(`📍 Updated driver ${userId} location to: [${lat}, ${lng}]`);
        }
      }
    }

    const user = await User.findByIdAndUpdate(
      userId,
      { $set: update },
      { new: true }
    ).lean();

    if (!user) {
      return res.status(404).json({ error: { message: 'User not found' } });
    }

    console.log('✅ Driver availability updated:', {
      userId,
      isAvailable: user.driverProfile?.isAvailable,
      lastSeen: user.driverProfile?.lastSeen,
      hasActiveSubscription: !!req.subscription
    });

    res.json({ 
      success: true,
      driverProfile: user.driverProfile,
      subscription: {
        expiresAt: req.subscription.expiresAt,
        vehicleType: req.subscription.vehicleType,
        plan: req.subscription.plan
      }
    });
  } catch (err) {
    console.error('❌ Availability update error:', err);
    next(err);
  }
});

// ✅ Get offered request - requires active subscription
router.get("/offered-request", requireAuth, requireActiveSubscription, async (req, res, next) => {
  try {
    const driverId = req.user.sub;
    console.log(`🔍 Driver ${driverId} checking for offered requests`);
    
    const now = new Date();

    // ✅✅✅ FIXED: Use ALL REQUIRED FILTERS
    const activeRequest = await TripRequest.findOne({
      status: 'searching', // Only searching trips
      expiresAt: { $gt: now }, // Must not be expired
      candidates: {
        $elemMatch: {
          driverId: driverId,
          status: "offered",
          rejectedAt: null // Driver hasn't rejected this offer
        }
      }
    })
    .populate("passengerId", "name phone")
    .lean();

    if (!activeRequest) {
      console.log(`❌ No active offer found for driver ${driverId}`, {
        timestamp: now.toISOString(),
        reason: "No trip with status='searching', driver status='offered', and not expired"
      });
      
      return res.status(404).json({ 
        message: "No active offer",
        subscriptionStatus: {
          hasActiveSubscription: true,
          expiresAt: req.subscription.expiresAt,
          vehicleType: req.subscription.vehicleType
        },
        debug: { 
          driverId, 
          timestamp: now.toISOString(),
          filters: {
            status: 'searching',
            expiresAt: { $gt: now },
            driverId: driverId,
            candidateStatus: 'offered',
            rejectedAt: null
          }
        }
      });
    }

    const candidate = activeRequest.candidates.find(
      (c) => c.driverId.toString() === driverId && 
             c.status === "offered" && 
             !c.rejectedAt
    );

    if (!candidate) {
      console.log(`❌ Candidate mismatch for driver ${driverId}`);
      return res.status(404).json({ 
        message: "No active offer",
        debug: { 
          driverId, 
          tripStatus: activeRequest.status,
          expiresAt: activeRequest.expiresAt,
          allCandidates: activeRequest.candidates.map(c => ({
            driverId: c.driverId,
            status: c.status,
            offeredAt: c.offeredAt,
            rejectedAt: c.rejectedAt
          }))
        }
      });
    }

    console.log(`✅ Found ACTIVE offer for driver ${driverId}:`, {
      requestId: activeRequest._id,
      passenger: activeRequest.passengerId?.name,
      fare: activeRequest.estimatedFare,
      serviceType: activeRequest.serviceType,
      expiresAt: activeRequest.expiresAt,
      timeUntilExpiry: Math.max(0, activeRequest.expiresAt - now)
    });

    const response = {
      request: {
        requestId: activeRequest._id,
        passengerId: activeRequest.passengerId?._id,
        passengerName: activeRequest.passengerId?.name || "Passenger",
        passengerPhone: activeRequest.passengerId?.phone || "",
        rating: 4.8,
        
        // ✅ Location data
        pickup: activeRequest.pickup,
        dropoff: activeRequest.dropoff || null,
        pickupAddress: activeRequest.pickupAddress || "Pickup location near you",
        dropoffAddress: activeRequest.dropoffAddress || "Destination nearby",
        
        // ✅ Fare and trip details
        estimatedFare: activeRequest.estimatedFare || 0,
        fare: activeRequest.estimatedFare || 0,
        distance: activeRequest.distance || 0,
        duration: activeRequest.duration || 0,
        serviceType: activeRequest.serviceType || 'CITY_RIDE',
        
        // Offer timing
        offeredAt: candidate.offeredAt,
        expiresIn: Math.floor((activeRequest.expiresAt - now) / 1000), // Seconds remaining
        
        // Candidate info
        candidateInfo: {
          status: candidate.status,
          offeredAt: candidate.offeredAt,
          driverName: candidate.driverName
        }
      },
      subscription: {
        expiresAt: req.subscription.expiresAt,
        vehicleType: req.subscription.vehicleType,
        plan: req.subscription.plan
      }
    };
    
    res.json(response);
  } catch (err) {
    console.error('❌ Error in /offered-request:', err);
    next(err);
  }
});

// ✅ Endpoint for driver to check pending/offered trips (with subscription check)
router.get("/pending-offers", requireAuth, requireActiveSubscription, async (req, res, next) => {
  try {
    const driverId = req.user.sub;
    const now = new Date();
    
    const offeredTrips = await TripRequest.find({
      candidates: {
        $elemMatch: {
          driverId: driverId,
          status: { $in: ['offered', 'pending'] },
          rejectedAt: null
        }
      },
      status: 'searching', // ONLY searching trips!
      expiresAt: { $gt: now }, // NOT expired
      createdAt: { $gte: new Date(now.getTime() - 10 * 60 * 1000) }
    })
    .select('_id status serviceType pickup dropoff estimatedFare candidates expiresAt')
    .lean();
    
    const formatted = offeredTrips.map(trip => {
      const candidate = trip.candidates.find(c => 
        c.driverId.toString() === driverId && 
        ['offered', 'pending'].includes(c.status) &&
        !c.rejectedAt
      );
      return {
        requestId: trip._id,
        status: trip.status,
        candidateStatus: candidate?.status,
        serviceType: trip.serviceType,
        pickup: trip.pickup,
        dropoff: trip.dropoff,
        estimatedFare: trip.estimatedFare,
        offeredAt: candidate?.offeredAt,
        expiresAt: trip.expiresAt,
        timeUntilExpiry: Math.max(0, trip.expiresAt - now)
      };
    }).filter(offer => offer.candidateStatus); // Remove if no matching candidate
    
    res.json({
      count: formatted.length,
      offers: formatted,
      subscription: {
        expiresAt: req.subscription.expiresAt,
        vehicleType: req.subscription.vehicleType
      }
    });
  } catch (err) {
    console.error('Error in /pending-offers:', err);
    next(err);
  }
});

// ==========================================
// LOCATION ENDPOINTS (with subscription check)
// ==========================================

// Driver location update endpoint
router.post('/location', requireAuth, requireActiveSubscription, async (req, res, next) => {
  try {
    const driverId = req.user.sub;
    const { latitude, longitude, heading } = req.body;

    if (!latitude || !longitude) {
      return res.status(400).json({ 
        error: { message: 'Latitude and longitude are required' } 
      });
    }

    // Validate ranges
    if (latitude < -90 || latitude > 90 || longitude < -180 || longitude > 180) {
      return res.status(400).json({ 
        error: { message: 'Invalid latitude or longitude values' } 
      });
    }

    // Update driver location in database
    const updated = await User.findByIdAndUpdate(
      driverId,
      {
        $set: {
          'driverProfile.location': {
            type: 'Point',
            coordinates: [longitude, latitude]
          },
          'driverProfile.heading': heading || 0,
          'driverProfile.lastSeen': new Date()
        }
      },
      { new: true }
    ).select('driverProfile.location driverProfile.isAvailable driverProfile.lastSeen');

    if (!updated) {
      return res.status(404).json({ error: { message: 'Driver not found' } });
    }

    res.json({ 
      success: true,
      location: {
        latitude,
        longitude,
        heading: heading || 0
      },
      subscription: {
        expiresAt: req.subscription.expiresAt,
        vehicleType: req.subscription.vehicleType
      }
    });
  } catch (err) {
    console.error('❌ Location update error:', err);
    next(err);
  }
});

// Get driver location
router.get('/location', requireAuth, async (req, res, next) => {
  try {
    const driverId = req.user.sub;
    
    const driver = await User.findById(driverId)
      .select('driverProfile.location driverProfile.heading driverProfile.lastSeen driverProfile.isAvailable')
      .lean();

    if (!driver || !driver.driverProfile?.location) {
      return res.json({ location: null });
    }

    res.json({
      location: {
        latitude: driver.driverProfile.location.coordinates[1],
        longitude: driver.driverProfile.location.coordinates[0],
        heading: driver.driverProfile.heading || 0,
        lastSeen: driver.driverProfile.lastSeen,
        isAvailable: driver.driverProfile.isAvailable
      }
    });
  } catch (err) {
    next(err);
  }
});

// ==========================================
// PROFILE ENDPOINTS (with subscription status)
// ==========================================

// Get driver profile - includes subscription status
router.get("/me", requireAuth, checkSubscriptionStatus, async (req, res, next) => {
  try {
    const userId = req.user && req.user.sub;
    if (!userId)
      return res.status(401).json({ error: { message: "Unauthorized" } });
    
    const user = await User.findById(userId).lean();
    if (!user)
      return res.status(404).json({ error: { message: "User not found" } });
    
    res.json({ 
      driverProfile: user.driverProfile, 
      roles: user.roles,
      subscriptionStatus: req.subscriptionStatus || {
        hasSubscription: false,
        isActive: false
      }
    });
  } catch (err) {
    next(err);
  }
});

// Update basic driver profile
router.post("/profile", requireAuth, async (req, res, next) => {
  try {
    const userId = req.user && req.user.sub;
    if (!userId)
      return res.status(401).json({ error: { message: "Unauthorized" } });

    const {
      vehicleMake,
      vehicleModel,
      vehicleNumber,
      name,
      profilePicUrl,
      carPicUrl,
      nin,
      ninImageUrl,
      licenseNumber,
      licenseImageUrl,
    } = req.body;

    const update = {};
    if (vehicleMake !== undefined)
      update["driverProfile.vehicleMake"] = vehicleMake;
    if (vehicleModel !== undefined)
      update["driverProfile.vehicleModel"] = vehicleModel;
    if (vehicleNumber !== undefined)
      update["driverProfile.vehicleNumber"] = vehicleNumber;
    if (name !== undefined) update["name"] = name;
    if (profilePicUrl !== undefined)
      update["driverProfile.profilePicUrl"] = profilePicUrl;
    if (carPicUrl !== undefined) update["driverProfile.carPicUrl"] = carPicUrl;
    if (nin !== undefined) update["driverProfile.nin"] = nin;
    if (ninImageUrl !== undefined)
      update["driverProfile.ninImageUrl"] = ninImageUrl;
    if (licenseNumber !== undefined)
      update["driverProfile.licenseNumber"] = licenseNumber;
    if (licenseImageUrl !== undefined)
      update["driverProfile.licenseImageUrl"] = licenseImageUrl;

    const user = await User.findByIdAndUpdate(
      userId,
      { $set: update },
      { new: true }
    ).lean();
    
    res.json({ 
      success: true,
      driverProfile: user.driverProfile 
    });
  } catch (err) {
    next(err);
  }
});

// Add or remove service categories
router.post("/service-categories", requireAuth, async (req, res, next) => {
  try {
    const userId = req.user && req.user.sub;
    if (!userId)
      return res.status(401).json({ error: { message: "Unauthorized" } });
    
    const { add = [], remove = [] } = req.body;
    
    if (!Array.isArray(add) || !Array.isArray(remove))
      return res
        .status(400)
        .json({ error: { message: "add and remove must be arrays" } });
    
    const user = await User.findById(userId);
    if (!user)
      return res.status(404).json({ error: { message: "User not found" } });
    
    user.driverProfile.serviceCategories =
      user.driverProfile.serviceCategories || [];
    
    for (const s of add) {
      if (!user.driverProfile.serviceCategories.includes(s))
        user.driverProfile.serviceCategories.push(s);
    }
    
    user.driverProfile.serviceCategories =
      user.driverProfile.serviceCategories.filter((s) => !remove.includes(s));
    
    await user.save();
    
    res.json({ 
      success: true,
      serviceCategories: user.driverProfile.serviceCategories 
    });
  } catch (err) {
    next(err);
  }
});

// Driver requests verification
router.put("/request-verification", requireAuth, async (req, res, next) => {
  try {
    const userId = req.user?.sub;

    if (!userId) {
      return res.status(401).json({ error: { message: "Unauthorized" } });
    }

    const existingUser = await User.findById(userId);
    if (!existingUser) {
      return res.status(404).json({ error: { message: "User not found" } });
    }

    const {
      name,
      vehicleMake,
      vehicleModel,
      vehicleNumber,
      nin,
      licenseNumber,
      serviceCategories,
      profilePicUrl,
      carPicUrl,
      ninImageUrl,
      licenseImageUrl,
      vehicleRegistrationUrl,
    } = req.body;

    // Validate required fields
    if (
      !name ||
      !vehicleMake ||
      !vehicleModel ||
      !vehicleNumber ||
      !nin ||
      !licenseNumber
    ) {
      return res.status(400).json({
        error: { message: "Missing required fields" },
      });
    }

    if (
      !serviceCategories ||
      !Array.isArray(serviceCategories) ||
      serviceCategories.length === 0
    ) {
      return res.status(400).json({
        error: { message: "Service category is required" },
      });
    }

    if (nin.length !== 11) {
      return res.status(400).json({
        error: { message: "NIN must be exactly 11 digits" },
      });
    }

    if (
      !profilePicUrl ||
      !carPicUrl ||
      !ninImageUrl ||
      !licenseImageUrl ||
      !vehicleRegistrationUrl
    ) {
      return res.status(400).json({
        error: { message: "All document images are required" },
      });
    }

    const updateData = {
      $set: {
        name: name.trim(),
        "roles.isDriver": true,
        "roles.isUser": true,
        "driverProfile.vehicleMake": vehicleMake.trim(),
        "driverProfile.vehicleModel": vehicleModel.trim(),
        "driverProfile.vehicleNumber": vehicleNumber.trim().toUpperCase(),
        "driverProfile.nin": nin.trim(),
        "driverProfile.licenseNumber": licenseNumber.trim(),
        "driverProfile.serviceCategories": serviceCategories,
        "driverProfile.profilePicUrl": profilePicUrl,
        "driverProfile.carPicUrl": carPicUrl,
        "driverProfile.ninImageUrl": ninImageUrl,
        "driverProfile.licenseImageUrl": licenseImageUrl,
        "driverProfile.vehicleRegistrationUrl": vehicleRegistrationUrl,
        "driverProfile.verified": false,
        "driverProfile.verificationState": "pending",
        "driverProfile.submittedAt": new Date(),
      },
    };

    const updatedUser = await User.findOneAndUpdate(
      { _id: userId },
      updateData,
      { new: true }
    ).select("name phone roles driverProfile");

    if (!updatedUser) {
      return res.status(500).json({
        error: { message: "Failed to update user profile" },
      });
    }

    res.json({
      success: true,
      message: "Driver verification request submitted successfully",
      data: {
        userId: updatedUser._id,
        name: updatedUser.name,
        verificationState: updatedUser.driverProfile?.verificationState || "pending",
      }
    });
  } catch (err) {
    console.error("❌ Verification request error:", err);
    next(err);
  }
});

// ==========================================
// LEGACY SUBSCRIPTION ENDPOINTS (DEPRECATED - kept for backward compatibility)
// ==========================================

// ⚠️ DEPRECATED: Use /subscriptions/subscribe instead
router.post("/subscribe", requireAuth, async (req, res, next) => {
  try {
    const userId = req.user && req.user.sub;
    if (!userId)
      return res.status(401).json({ error: { message: "Unauthorized" } });
    
    // Redirect to new subscription system
    return res.status(410).json({ 
      error: { 
        message: "This endpoint is deprecated. Please use POST /subscriptions/subscribe",
        code: "ENDPOINT_DEPRECATED",
        newEndpoint: "/subscriptions/subscribe"
      } 
    });
  } catch (err) {
    next(err);
  }
});

// ⚠️ DEPRECATED: Use /subscriptions/current instead
router.get("/subscription", requireAuth, async (req, res, next) => {
  try {
    const userId = req.user && req.user.sub;
    if (!userId)
      return res.status(401).json({ error: { message: "Unauthorized" } });
    
    // Redirect to new subscription system
    return res.status(410).json({ 
      error: { 
        message: "This endpoint is deprecated. Please use GET /subscriptions/current",
        code: "ENDPOINT_DEPRECATED",
        newEndpoint: "/subscriptions/current"
      } 
    });
  } catch (err) {
    next(err);
  }
});

// ==========================================
// TRIP STATUS ENDPOINTS
// ==========================================

// Get driver's current trip status
router.get("/current-trip", requireAuth, async (req, res, next) => {
  try {
    const driverId = req.user.sub;
    
    const user = await User.findById(driverId)
      .select('driverProfile.currentTripId')
      .lean();
    
    if (!user || !user.driverProfile?.currentTripId) {
      return res.json({ 
        success: true,
        hasCurrentTrip: false 
      });
    }
    
    res.json({
      success: true,
      hasCurrentTrip: true,
      tripId: user.driverProfile.currentTripId
    });
  } catch (err) {
    next(err);
  }
});

// ==========================================
// STATE MANAGEMENT ENDPOINTS
// ==========================================

// Get driver state for cleanup checks
router.get('/current-state', requireAuth, checkSubscriptionStatus, async (req, res) => {
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
      success: true,
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
                    (!currentTrip || ['completed', 'cancelled'].includes(currentTrip?.status)),
      subscriptionStatus: req.subscriptionStatus
    });

  } catch (err) {
    console.error('Get state error:', err);
    res.status(500).json({ error: { message: 'Failed to get state' } });
  }
});

// Cleanup stale driver state
router.post('/cleanup-state', requireAuth, async (req, res) => {
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
// DEBUG ENDPOINTS
// ==========================================

// Debug: Get all trips where driver is a candidate
router.get("/debug/my-offers", requireAuth, async (req, res, next) => {
  try {
    const driverId = req.user.sub;
    
    const trips = await TripRequest.find({
      candidates: {
        $elemMatch: { driverId: driverId }
      },
      createdAt: { $gte: new Date(Date.now() - 30 * 60 * 1000) }
    })
    .populate("passengerId", "name phone")
    .select('_id status serviceType estimatedFare pickup dropoff candidates createdAt')
    .sort({ createdAt: -1 })
    .lean();
    
    const formatted = trips.map(trip => {
      const candidate = trip.candidates.find(c => c.driverId.toString() === driverId);
      return {
        requestId: trip._id,
        passengerName: trip.passengerId?.name,
        serviceType: trip.serviceType,
        estimatedFare: trip.estimatedFare,
        tripStatus: trip.status,
        candidateStatus: candidate?.status,
        offeredAt: candidate?.offeredAt,
        rejectedAt: candidate?.rejectedAt,
        createdAt: trip.createdAt,
        allCandidates: trip.candidates.map(c => ({
          driverId: c.driverId,
          status: c.status,
          offeredAt: c.offeredAt
        }))
      };
    });
    
    res.json({
      success: true,
      driverId,
      tripCount: formatted.length,
      trips: formatted,
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    console.error('Error in /debug/my-offers:', err);
    next(err);
  }
});

// DEBUG: Get all currently online drivers
router.get('/debug/online', async (req, res) => {
  try {
    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);

    const onlineDrivers = await User.find({
      'roles.isDriver': true,
      'driverProfile.isAvailable': true,
      'driverProfile.verified': true,
      'driverProfile.verificationState': 'approved',
      'driverProfile.lastSeen': { $gte: fiveMinutesAgo }
    })
      .select('name phone driverProfile.location driverProfile.lastSeen driverProfile.vehicleModel driverProfile.serviceCategories')
      .lean();

    const formatted = onlineDrivers.map(driver => ({
      driverId: driver._id.toString(),
      name: driver.name || 'Unknown Driver',
      phone: driver.phone || 'Not set',
      vehicle: driver.driverProfile?.vehicleModel || 'No vehicle',
      serviceCategories: driver.driverProfile?.serviceCategories || [],
      location: driver.driverProfile?.location?.coordinates
        ? {
            latitude: driver.driverProfile.location.coordinates[1],
            longitude: driver.driverProfile.location.coordinates[0]
          }
        : null,
      lastSeen: driver.driverProfile?.lastSeen?.toISOString() || null,
      isOnline: true
    }));

    res.json({
      success: true,
      count: formatted.length,
      drivers: formatted,
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    console.error('Error in /debug/online:', err);
    res.status(500).json({
      success: false,
      error: 'Failed to fetch online drivers',
      message: err.message
    });
  }
});

module.exports = router;