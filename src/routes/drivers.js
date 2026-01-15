const express = require("express");
const router = express.Router();
const User = require("../models/user.model");
const TripRequest = require("../models/tripRequest.model");
const { requireAuth } = require("../middleware/auth");

const DURATION_DAYS = {
  daily: 1,
  weekly: 7,
  monthly: 30,
};

// ✅ FIX 3: CRITICAL - Update availability and always update lastSeen
router.post("/availability", requireAuth, async (req, res, next) => {
  try {
    const userId = req.user && req.user.sub;
    if (!userId)
      return res.status(401).json({ error: { message: "Unauthorized" } });

    const { isAvailable, location } = req.body;

    console.log('📍 Availability update for driver:', {
      userId,
      isAvailable,
      hasLocation: !!location,
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
      lastSeen: user.driverProfile?.lastSeen
    });

    res.json({ 
      success: true,
      driverProfile: user.driverProfile 
    });
  } catch (err) {
    console.error('❌ Availability update error:', err);
    next(err);
  }
});

// ✅✅✅ CRITICAL FIX: Get offered request with $elemMatch - FIXED VERSION
router.get("/offered-request", requireAuth, async (req, res, next) => {
  try {
    const driverId = req.user.sub;
    console.log(`🔍 Driver ${driverId} checking for offered requests`);

    // ✅✅✅ FIXED: Use $elemMatch to find trip where driver is offered
    const activeRequest = await TripRequest.findOne({
      status: 'searching',
      candidates: {
        $elemMatch: {
          driverId: driverId,
          status: "offered"
        }
      }
    })
    .populate("passengerId", "name phone")
    .lean();

    if (!activeRequest) {
      console.log(`❌ No active offer found for driver ${driverId}`);
      
      // ✅ Debug: Check what trips this driver is actually in
      const debugTrips = await TripRequest.find({
        candidates: {
          $elemMatch: { driverId: driverId }
        },
        createdAt: { $gte: new Date(Date.now() - 30 * 60 * 1000) }
      })
      .select('_id status candidates')
      .lean();
      
      console.log(`🔍 Debug: Driver ${driverId} is in ${debugTrips.length} trips:`);
      debugTrips.forEach(trip => {
        const cand = trip.candidates.find(c => c.driverId.toString() === driverId);
        console.log(`  - Trip ${trip._id}: status=${trip.status}, candidate_status=${cand?.status}`);
      });
      
      return res.status(404).json({ 
        message: "No active offer",
        debug: { 
          driverId, 
          tripCount: debugTrips.length,
          timestamp: new Date().toISOString() 
        }
      });
    }

    const candidate = activeRequest.candidates.find(
      (c) => c.driverId.toString() === driverId && c.status === "offered"
    );

    if (!candidate) {
      console.log(`❌ Candidate mismatch for driver ${driverId}`);
      return res.status(404).json({ 
        message: "No active offer",
        debug: { 
          driverId, 
          tripStatus: activeRequest.status,
          allCandidates: activeRequest.candidates.map(c => ({
            driverId: c.driverId,
            status: c.status,
            offeredAt: c.offeredAt
          }))
        }
      });
    }

    console.log(`✅ Found active offer for driver ${driverId}:`, {
      requestId: activeRequest._id,
      passenger: activeRequest.passengerId?.name,
      fare: activeRequest.estimatedFare,
      serviceType: activeRequest.serviceType
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
        expiresIn: 20,
        
        // Candidate info
        candidateInfo: {
          status: candidate.status,
          offeredAt: candidate.offeredAt,
          driverName: candidate.driverName
        }
      },
    };
    
    res.json(response);
  } catch (err) {
    console.error('❌ Error in /offered-request:', err);
    next(err);
  }
});

// ✅ NEW: Debug endpoint to see all trips where driver is a candidate
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

// Driver location update endpoint
router.post('/location', requireAuth, async (req, res, next) => {
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

// Subscribe or renew subscription
router.post("/subscribe", requireAuth, async (req, res, next) => {
  try {
    const userId = req.user && req.user.sub;
    if (!userId)
      return res.status(401).json({ error: { message: "Unauthorized" } });
    const { type } = req.body;
    if (!type || !DURATION_DAYS[type])
      return res
        .status(400)
        .json({ error: { message: "Invalid subscription type" } });
    const user = await User.findById(userId);
    if (!user)
      return res.status(404).json({ error: { message: "User not found" } });
    const now = new Date();
    const days = DURATION_DAYS[type];
    const expiresAt = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);
    user.subscription = { type, startedAt: now, expiresAt };
    user.roles = user.roles || {};
    user.roles.isDriver = true;
    await user.save();
    res.json({ ok: true, subscription: user.subscription });
  } catch (err) {
    next(err);
  }
});

// Get subscription status
router.get("/subscription", requireAuth, async (req, res, next) => {
  try {
    const userId = req.user && req.user.sub;
    if (!userId)
      return res.status(401).json({ error: { message: "Unauthorized" } });
    const user = await User.findById(userId).lean();
    if (!user)
      return res.status(404).json({ error: { message: "User not found" } });
    res.json({ subscription: user.subscription || null });
  } catch (err) {
    next(err);
  }
});

// Get driver profile
router.get("/me", requireAuth, async (req, res, next) => {
  try {
    const userId = req.user && req.user.sub;
    if (!userId)
      return res.status(401).json({ error: { message: "Unauthorized" } });
    const user = await User.findById(userId).lean();
    if (!user)
      return res.status(404).json({ error: { message: "User not found" } });
    res.json({ driverProfile: user.driverProfile, roles: user.roles });
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
    res.json({ driverProfile: user.driverProfile });
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
    res.json({ serviceCategories: user.driverProfile.serviceCategories });
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

// Get driver's current trip status
router.get("/current-trip", requireAuth, async (req, res, next) => {
  try {
    const driverId = req.user.sub;
    
    const user = await User.findById(driverId)
      .select('driverProfile.currentTripId')
      .lean();
    
    if (!user || !user.driverProfile?.currentTripId) {
      return res.json({ hasCurrentTrip: false });
    }
    
    res.json({
      hasCurrentTrip: true,
      tripId: user.driverProfile.currentTripId
    });
  } catch (err) {
    next(err);
  }
});

// Endpoint for driver to check pending/offered trips
router.get("/pending-offers", requireAuth, async (req, res, next) => {
  try {
    const driverId = req.user.sub;
    
    const offeredTrips = await TripRequest.find({
      candidates: {
        $elemMatch: {
          driverId: driverId,
          status: { $in: ['offered', 'pending'] }
        }
      },
      status: { $in: ['searching', 'assigned'] },
      createdAt: { $gte: new Date(Date.now() - 10 * 60 * 1000) }
    })
    .select('_id status serviceType pickup candidates')
    .lean();
    
    const formatted = offeredTrips.map(trip => {
      const candidate = trip.candidates.find(c => c.driverId.toString() === driverId);
      return {
        requestId: trip._id,
        status: trip.status,
        candidateStatus: candidate?.status,
        serviceType: trip.serviceType,
        pickup: trip.pickup,
        offeredAt: candidate?.offeredAt
      };
    });
    
    res.json({
      count: formatted.length,
      offers: formatted
    });
  } catch (err) {
    console.error('Error in /pending-offers:', err);
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