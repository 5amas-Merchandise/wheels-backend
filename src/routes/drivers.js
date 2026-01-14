// routes/drivers.js - COMPLETE INTEGRATED VERSION (FIXED)
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

// ⚠️ CRITICAL FIX: Update availability and location
router.post("/availability", requireAuth, async (req, res, next) => {
  try {
    const userId = req.user && req.user.sub;
    if (!userId)
      return res.status(401).json({ error: { message: "Unauthorized" } });

    const { isAvailable, location } = req.body;

    console.log('📍 Availability update received:', {
      userId,
      isAvailable,
      location,
      timestamp: new Date().toISOString()
    });

    const update = { "driverProfile.lastSeen": new Date() };

    if (typeof isAvailable === "boolean") {
      update["driverProfile.isAvailable"] = isAvailable;
      console.log(`🔄 Setting driver ${userId} availability to: ${isAvailable}`);
    }

    // ⚠️ FIX: Accept BOTH formats (coordinates array OR location object)
    if (location) {
      let coords = null;
      
      // Format 1: { type: 'Point', coordinates: [lng, lat] }
      if (location.type === 'Point' && Array.isArray(location.coordinates)) {
        coords = location.coordinates;
      }
      // Format 2: Direct coordinates array [lng, lat]
      else if (Array.isArray(location.coordinates) && location.coordinates.length === 2) {
        coords = location.coordinates;
      }
      // Format 3: Just coordinates array [lng, lat]
      else if (Array.isArray(location) && location.length === 2) {
        coords = location;
      }

      if (coords && coords.length === 2) {
        const [lng, lat] = coords;
        
        // Validate coordinate ranges
        if (lng >= -180 && lng <= 180 && lat >= -90 && lat <= 90) {
          update["driverProfile.location"] = {
            type: "Point",
            coordinates: [lng, lat],
          };
          console.log(`📍 Updated driver ${userId} location to: [${lat}, ${lng}]`);
        } else {
          console.error(`❌ Invalid coordinates: [${lat}, ${lng}]`);
          return res.status(400).json({
            error: { message: 'Invalid coordinate values' }
          });
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

    console.log('✅ Driver availability updated successfully:', {
      userId,
      isAvailable: user.driverProfile?.isAvailable,
      hasLocation: !!user.driverProfile?.location,
      coordinates: user.driverProfile?.location?.coordinates
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

// ⚠️ CRITICAL FIX: Driver location update endpoint (for REST fallback)
router.post('/location', requireAuth, async (req, res, next) => {
  try {
    const driverId = req.user.sub;
    const { latitude, longitude, heading } = req.body;

    console.log('📍 Location update received:', {
      driverId,
      latitude,
      longitude,
      heading,
      timestamp: new Date().toISOString()
    });

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
            coordinates: [longitude, latitude] // GeoJSON: [lng, lat]
          },
          'driverProfile.heading': heading || 0,
          'driverProfile.lastSeen': new Date()
        }
      },
      { new: true }
    ).select('driverProfile.location driverProfile.isAvailable');

    if (!updated) {
      return res.status(404).json({ error: { message: 'Driver not found' } });
    }

    console.log(`✅ Driver ${driverId} location updated via REST:`, {
      coordinates: [latitude, longitude],
      isAvailable: updated.driverProfile?.isAvailable
    });

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

// Subscribe or renew subscription (driver action)
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
    console.log("🚀 === VERIFICATION REQUEST START ===");
    console.log("User ID:", userId);

    if (!userId) {
      console.log("❌ No user ID found in token");
      return res.status(401).json({ error: { message: "Unauthorized" } });
    }

    const existingUser = await User.findById(userId);
    if (!existingUser) {
      console.log("❌ User not found");
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
        "roles.isAdmin": existingUser.roles?.isAdmin || false,
        "driverProfile.vehicleMake": vehicleMake.trim(),
        "driverProfile.vehicleModel": vehicleModel.trim(),
        "driverProfile.vehicleNumber": vehicleNumber.trim().toUpperCase(),
        "driverProfile.nin": nin.trim(),
        "driverProfile.licenseNumber": licenseNumber.trim(),
        "driverProfile.serviceCategories": Array.isArray(serviceCategories)
          ? serviceCategories
          : [serviceCategories],
        "driverProfile.profilePicUrl": profilePicUrl,
        "driverProfile.carPicUrl": carPicUrl,
        "driverProfile.ninImageUrl": ninImageUrl,
        "driverProfile.licenseImageUrl": licenseImageUrl,
        "driverProfile.vehicleRegistrationUrl": vehicleRegistrationUrl,
        "driverProfile.verified": false,
        "driverProfile.verificationState": "pending",
        "driverProfile.submittedAt": new Date(),
        "driverProfile.isAvailable":
          existingUser.driverProfile?.isAvailable !== undefined
            ? existingUser.driverProfile.isAvailable
            : true,
        "driverProfile.location": existingUser.driverProfile?.location
          ? existingUser.driverProfile.location
          : { type: "Point", coordinates: [0, 0] },
        "driverProfile.lastSeen": existingUser.driverProfile?.lastSeen
          ? existingUser.driverProfile.lastSeen
          : new Date(),
      },
    };

    const updatedUser = await User.findOneAndUpdate(
      { _id: userId },
      updateData,
      {
        new: true,
        runValidators: true,
        upsert: false,
        setDefaultsOnInsert: true,
      }
    ).select("name phone roles driverProfile");

    if (!updatedUser) {
      console.log("❌ Failed to update user");
      return res.status(500).json({
        error: { message: "Failed to update user profile" },
      });
    }

    console.log("✅ Driver verification request submitted successfully");

    res.json({
      success: true,
      message: "Driver verification request submitted successfully",
      data: {
        userId: updatedUser._id,
        name: updatedUser.name,
        verificationState:
          updatedUser.driverProfile?.verificationState || "pending",
        submittedAt: updatedUser.driverProfile?.submittedAt || new Date(),
      }
    });
  } catch (err) {
    console.error("❌ Verification request error:", err);
    next(err);
  }
});

// ✅ FIXED: GET currently offered trip request for the driver (for polling)
router.get("/offered-request", requireAuth, async (req, res, next) => {
  try {
    const driverId = req.user.sub;
    console.log(`🔍 Driver ${driverId} checking for offered requests at ${new Date().toISOString()}`);
    
    // ✅ CRITICAL FIX: Check both 'searching' and 'assigned' statuses
    // A trip might be assigned but driver hasn't accepted yet in Trip collection
    const activeRequest = await TripRequest.findOne({
      candidates: {
        $elemMatch: {
          driverId: driverId,
          status: "offered",
        },
      },
      // ✅ FIX: Check for 'searching' OR recent 'assigned' trips
      $or: [
        { status: "searching" },
        { 
          status: "assigned",
          assignedDriverId: driverId, // Make sure it's assigned to THIS driver
          createdAt: { $gte: new Date(Date.now() - 5 * 60 * 1000) } // Within last 5 minutes
        }
      ]
    })
      .populate("passengerId", "name phone")
      .lean();

    if (!activeRequest) {
      console.log(`❌ No active offer found for driver ${driverId}`);
      return res.status(404).json({ 
        message: "No active offer",
        debug: { driverId, timestamp: new Date().toISOString() }
      });
    }

    const candidate = activeRequest.candidates.find(
      (c) => c.driverId.toString() === driverId && c.status === "offered"
    );

    if (!candidate) {
      console.log(`❌ Driver ${driverId} not offered this trip`);
      return res.status(404).json({ 
        message: "No active offer",
        debug: { 
          driverId, 
          availableStatuses: activeRequest.candidates.map(c => ({
            driverId: c.driverId,
            status: c.status
          })),
          tripStatus: activeRequest.status
        }
      });
    }

    console.log(`✅ Found active offer for driver ${driverId}:`, {
      requestId: activeRequest._id,
      status: activeRequest.status,
      offeredAt: candidate.offeredAt,
      passengerName: activeRequest.passengerId?.name
    });

    const response = {
      request: {
        requestId: activeRequest._id,
        passengerName: activeRequest.passengerId?.name || "Passenger",
        passengerPhone: activeRequest.passengerId?.phone || "",
        rating: 4.8,
        pickup: activeRequest.pickup,
        pickupAddress: "Pickup location near you",
        fare: 2500, // This should be calculated
        serviceType: activeRequest.serviceType,
        offeredAt: candidate.offeredAt,
        expiresIn: 20, // 20 seconds timeout
        // ✅ ADDED: Candidate info for debugging
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

// ✅ NEW: Get driver's current trip status (if any)
router.get("/current-trip", requireAuth, async (req, res, next) => {
  try {
    const driverId = req.user.sub;
    
    const user = await User.findById(driverId)
      .select('driverProfile.currentTripId')
      .lean();
    
    if (!user || !user.driverProfile?.currentTripId) {
      return res.json({ hasCurrentTrip: false });
    }
    
    // You might want to populate trip details here
    res.json({
      hasCurrentTrip: true,
      tripId: user.driverProfile.currentTripId
    });
  } catch (err) {
    next(err);
  }
});

// ✅ NEW: Endpoint for driver to check if they have any pending/offered trips
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
      createdAt: { $gte: new Date(Date.now() - 10 * 60 * 1000) } // Last 10 minutes
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

// DEBUG: Get all currently online drivers (NO AUTH)
router.get('/debug/online', async (req, res) => {
  try {
    console.log('📡 [DEBUG] Requested online drivers list');

    const fiveMinutesAgo = new Date(Date.now() - 5 * 60 * 1000);

    const onlineDrivers = await User.find({
      'roles.isDriver': true,
      'driverProfile.isAvailable': true,
      'driverProfile.verified': true,
      'driverProfile.verificationState': 'approved',
      'driverProfile.lastSeen': { $gte: fiveMinutesAgo }
    })
      .select(
        'name phone driverProfile.location driverProfile.heading driverProfile.lastSeen driverProfile.vehicleModel driverProfile.vehicleNumber driverProfile.serviceCategories'
      )
      .lean();

    if (!onlineDrivers?.length) {
      return res.json({
        success: true,
        message: 'No drivers are currently online',
        count: 0,
        drivers: [],
        timestamp: new Date().toISOString()
      });
    }

    const formatted = onlineDrivers.map(driver => ({
      driverId: driver._id.toString(),
      name: driver.name || 'Unknown Driver',
      phone: driver.phone || 'Not set',
      vehicle: driver.driverProfile?.vehicleModel
        ? `${driver.driverProfile.vehicleModel} (${driver.driverProfile.vehicleNumber || 'N/A'})`
        : 'No vehicle info',
      serviceCategories: driver.driverProfile?.serviceCategories || [],
      location: driver.driverProfile?.location?.coordinates
        ? {
            latitude: driver.driverProfile.location.coordinates[1],
            longitude: driver.driverProfile.location.coordinates[0]
          }
        : null,
      heading: driver.driverProfile?.heading || 0,
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

// ✅ NEW DEBUG: Check what trips a specific driver can see
router.get('/debug/driver-offers/:driverId', async (req, res) => {
  try {
    const { driverId } = req.params;
    
    console.log(`🔍 [DEBUG] Checking offers for driver: ${driverId}`);
    
    const driver = await User.findById(driverId)
      .select('name driverProfile.isAvailable driverProfile.lastSeen')
      .lean();
    
    if (!driver) {
      return res.status(404).json({ error: 'Driver not found' });
    }
    
    // Check trip requests where driver is a candidate
    const tripRequests = await TripRequest.find({
      candidates: {
        $elemMatch: { driverId: driverId }
      },
      createdAt: { $gte: new Date(Date.now() - 30 * 60 * 1000) } // Last 30 minutes
    })
    .select('_id status serviceType candidates pickup createdAt')
    .sort({ createdAt: -1 })
    .lean();
    
    const driverCandidates = tripRequests.map(trip => {
      const candidate = trip.candidates.find(c => c.driverId.toString() === driverId);
      return {
        requestId: trip._id,
        tripStatus: trip.status,
        candidateStatus: candidate?.status,
        serviceType: trip.serviceType,
        offeredAt: candidate?.offeredAt,
        createdAt: trip.createdAt,
        pickup: trip.pickup,
        allCandidates: trip.candidates.map(c => ({
          driverId: c.driverId,
          status: c.status,
          offeredAt: c.offeredAt
        }))
      };
    });
    
    res.json({
      driver: {
        id: driverId,
        name: driver.name,
        isAvailable: driver.driverProfile?.isAvailable,
        lastSeen: driver.driverProfile?.lastSeen
      },
      tripCount: driverCandidates.length,
      trips: driverCandidates,
      timestamp: new Date().toISOString()
    });
  } catch (err) {
    console.error('Error in /debug/driver-offers:', err);
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;