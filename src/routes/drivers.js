// routes/drivers.routes.js - COMPLETE MERGED VERSION WITH ALL FEATURES

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
// DRIVER PROFILE & VERIFICATION ENDPOINTS
// ==========================================

// GET /drivers/me - GET DRIVER PROFILE (with subscription status)
router.get("/me", requireAuth, checkSubscriptionStatus, async (req, res, next) => {
  try {
    const userId = req.user && req.user.sub;
    if (!userId)
      return res.status(401).json({ error: { message: "Unauthorized" } });

    console.log(`📊 Fetching driver profile for: ${userId}`);

    const user = await User.findById(userId)
      .select('-passwordHash -otpCode -otpExpiresAt')
      .lean();

    if (!user) {
      return res.status(404).json({
        success: false,
        error: { message: 'User not found' }
      });
    }

    // Ensure driverProfile exists
    if (!user.driverProfile) {
      user.driverProfile = {
        verified: false,
        verificationState: 'pending'
      };
    }

    res.json({ 
      success: true,
      user: user,
      subscriptionStatus: req.subscriptionStatus || {
        hasSubscription: false,
        isActive: false
      }
    });
  } catch (err) {
    console.error('Get driver profile error:', err);
    next(err);
  }
});

// ==========================================
// PUT /drivers/request-verification - SUBMIT VERIFICATION
// ==========================================

router.put('/request-verification', requireAuth, async (req, res, next) => {
  try {
    const rawUserId = req.user.sub || req.user._id || req.user.id;

    if (!rawUserId) {
      return res.status(401).json({
        success: false,
        error: { message: 'No user ID found in token. Check your auth middleware.' }
      });
    }

    // Convert to ObjectId — req.user.sub from JWT is a plain string.
    // findByIdAndUpdate handles strings fine in theory, but explicit conversion
    // eliminates any type-mismatch silently causing "no document found".
    const mongoose = require('mongoose');
    let userId;
    try {
      userId = new mongoose.Types.ObjectId(rawUserId);
    } catch (e) {
      return res.status(400).json({
        success: false,
        error: { message: `Invalid user ID format: ${rawUserId}` }
      });
    }

    const {
      name,
      vehicleMake,
      vehicleModel,
      vehicleNumber,
      vehicleYear,
      vehicleColor,
      nin,
      licenseNumber,
      driverLicenseClass,
      serviceCategories,
      profilePicUrl,
      carPicUrl,
      ninImageUrl,
      licenseImageUrl,
      vehicleRegistrationUrl,
      insuranceUrl,
      roadWorthinessUrl
    } = req.body;

    console.log(`📝 Driver verification request from: ${userId}`);
    console.log('📦 Received data:', JSON.stringify(req.body, null, 2));

    // ── Validation ──────────────────────────────────────────────────
    const requiredFields = [
      'name', 'vehicleMake', 'vehicleModel', 'vehicleNumber',
      'nin', 'licenseNumber', 'serviceCategories'
    ];
    const missingFields = requiredFields.filter(field => !req.body[field]);
    if (missingFields.length > 0) {
      return res.status(400).json({
        success: false,
        error: { message: 'Missing required fields', details: missingFields }
      });
    }

    if (!/^\d{11}$/.test(nin)) {
      return res.status(400).json({
        success: false,
        error: { message: 'NIN must be exactly 11 digits' }
      });
    }

    // ── Service categories ───────────────────────────────────────────
    let serviceCategoriesArray = Array.isArray(serviceCategories)
      ? serviceCategories
      : [serviceCategories].filter(Boolean);

    const allowedCategories = [
      'CITY_CAR', 'BIKE', 'KEKE', 'TRUCK', 'LUXURY', 'VAN',
      'INTERSTATE', 'DELIVERY', 'LOGISTICS',
      'CITY_RIDE', 'TRUCK_LOGISTICS', 'INTERSTATE_TRAVEL', 'LUXURY_RENTAL'
    ];

    const validCategories = serviceCategoriesArray
      .filter(cat => allowedCategories.includes(cat))
      .slice(0, 3);

    if (validCategories.length === 0) {
      return res.status(400).json({
        success: false,
        error: {
          message: 'No valid service categories provided',
          received: serviceCategoriesArray,
          allowedCategories
        }
      });
    }

    // ── Required documents ───────────────────────────────────────────
    const missingDocs = [];
    if (!profilePicUrl) missingDocs.push('profilePicUrl');
    if (!carPicUrl) missingDocs.push('carPicUrl');
    if (!ninImageUrl) missingDocs.push('ninImageUrl');
    if (!licenseImageUrl) missingDocs.push('licenseImageUrl');
    if (!vehicleRegistrationUrl) missingDocs.push('vehicleRegistrationUrl');

    if (missingDocs.length > 0) {
      return res.status(400).json({
        success: false,
        error: { message: 'Missing required documents', details: missingDocs }
      });
    }

    // ── Parse vehicleYear (frontend sends string from TextInput) ─────
    let parsedVehicleYear = null;
    if (vehicleYear) {
      const y = parseInt(vehicleYear, 10);
      if (!isNaN(y) && y > 1900 && y <= new Date().getFullYear() + 1) {
        parsedVehicleYear = y;
      }
    }

    // ── Confirm user exists BEFORE attempting update ─────────────────
    // This catches any ID mismatch early and gives a clear error instead
    // of a silent no-op write.
    const existingUser = await User.findById(userId).lean();
    if (!existingUser) {
      console.error(`❌ User not found for ID: ${userId} (raw token value: ${rawUserId})`);
      return res.status(404).json({
        success: false,
        error: { message: `User not found. Token sub: ${rawUserId}` }
      });
    }
    console.log(`✅ User confirmed in DB: ${existingUser.name} (${existingUser.phone})`);

    // ── Build $set payload with dot-notation ─────────────────────────
    // NEVER do: user.driverProfile = { ...user.driverProfile, ...newData }
    // Mongoose does not detect subdocument object replacement as a change,
    // so .save() silently skips writing it. Dot-notation $set bypasses
    // this entirely and writes directly at the MongoDB level.
    const setPayload = {
      name: name.trim(),
      profilePicUrl,
      'roles.isDriver': true,

      'driverProfile.vehicleMake': vehicleMake.trim(),
      'driverProfile.vehicleModel': vehicleModel.trim(),
      'driverProfile.vehicleNumber': vehicleNumber.trim().toUpperCase(),
      'driverProfile.vehicleColor': vehicleColor?.trim() || '',
      'driverProfile.serviceCategories': validCategories,
      'driverProfile.nin': nin,
      'driverProfile.licenseNumber': licenseNumber.trim(),
      'driverProfile.driverLicenseClass': driverLicenseClass?.trim() || '',
      'driverProfile.profilePicUrl': profilePicUrl,
      'driverProfile.carPicUrl': carPicUrl,
      'driverProfile.ninImageUrl': ninImageUrl,
      'driverProfile.licenseImageUrl': licenseImageUrl,
      'driverProfile.vehicleRegistrationUrl': vehicleRegistrationUrl,
      'driverProfile.verified': false,
      'driverProfile.verificationState': 'pending',
      'driverProfile.isAvailable': false,
      'driverProfile.submittedAt': new Date(),
    };

    // Only set optional fields if provided so we don't wipe existing values
    if (parsedVehicleYear !== null) setPayload['driverProfile.vehicleYear'] = parsedVehicleYear;
    if (insuranceUrl) setPayload['driverProfile.insuranceUrl'] = insuranceUrl;
    if (roadWorthinessUrl) setPayload['driverProfile.roadWorthinessUrl'] = roadWorthinessUrl;

    console.log('📝 Applying $set payload:', JSON.stringify(setPayload, null, 2));

    // ── Write to DB ──────────────────────────────────────────────────
    const result = await User.findByIdAndUpdate(
      userId,
      { $set: setPayload },
      {
        new: true,          // return the updated document
        runValidators: false // skip schema validators on partial update to avoid conflicts
      }
    ).select('-passwordHash -otpCode -otpExpiresAt').lean();

    if (!result) {
      console.error('❌ findByIdAndUpdate returned null — document not found during write');
      return res.status(404).json({
        success: false,
        error: { message: 'Write failed — user not found. Please re-login and try again.' }
      });
    }

    // ── Log what actually saved to verify ────────────────────────────
    console.log(`✅ Saved to DB for ${userId}:`, {
      name: result.name,
      vehicleMake: result.driverProfile?.vehicleMake,
      vehicleModel: result.driverProfile?.vehicleModel,
      vehicleNumber: result.driverProfile?.vehicleNumber,
      serviceCategories: result.driverProfile?.serviceCategories,
      verificationState: result.driverProfile?.verificationState,
      profilePicUrl: result.driverProfile?.profilePicUrl ? '✅ present' : '❌ missing',
      carPicUrl: result.driverProfile?.carPicUrl ? '✅ present' : '❌ missing',
    });

    res.json({
      success: true,
      message: 'Verification request submitted successfully',
      data: {
        userId: result._id,
        name: result.name,
        verificationState: result.driverProfile?.verificationState || 'pending',
        submittedAt: result.driverProfile?.submittedAt || new Date().toISOString(),
      },
      debug: {
        vehicleMake: result.driverProfile?.vehicleMake,
        serviceCategories: result.driverProfile?.serviceCategories,
        profilePicUrl: result.driverProfile?.profilePicUrl,
      }
    });

  } catch (err) {
    console.error('❌ Verification request error:', err);

    if (err.name === 'ValidationError') {
      return res.status(400).json({
        success: false,
        error: {
          message: 'Validation error',
          details: Object.values(err.errors).map(e => e.message)
        }
      });
    }

    res.status(500).json({
      success: false,
      error: {
        message: 'Failed to submit verification request',
        details: err.message
      }
    });
  }
});

// ==========================================
// GET /drivers/pending - GET PENDING VERIFICATIONS (ADMIN)
// ==========================================

router.get('/pending', requireAuth, async (req, res, next) => {
  try {
    // Check if user is admin
    const user = await User.findById(req.user.sub).select('roles');
    if (!user?.roles?.isAdmin) {
      return res.status(403).json({
        success: false,
        error: { message: 'Admin access required' }
      });
    }

    console.log('🔍 Admin fetching pending driver verifications');

    const pendingDrivers = await User.find({
      'roles.isDriver': true,
      'driverProfile.verificationState': 'pending'
    })
    .select('name phone email driverProfile createdAt')
    .sort({ createdAt: -1 })
    .lean();

    console.log(`✅ Found ${pendingDrivers.length} pending drivers`);

    const formattedDrivers = pendingDrivers.map(driver => ({
      id: driver._id,
      name: driver.name,
      phone: driver.phone,
      email: driver.email || 'No email',
      vehicleMake: driver.driverProfile?.vehicleMake || 'Not provided',
      vehicleModel: driver.driverProfile?.vehicleModel || 'Not provided',
      vehicleNumber: driver.driverProfile?.vehicleNumber || 'Not provided',
      serviceCategories: driver.driverProfile?.serviceCategories || [],
      profilePicUrl: driver.driverProfile?.profilePicUrl,
      carPicUrl: driver.driverProfile?.carPicUrl,
      ninImageUrl: driver.driverProfile?.ninImageUrl,
      licenseImageUrl: driver.driverProfile?.licenseImageUrl,
      vehicleRegistrationUrl: driver.driverProfile?.vehicleRegistrationUrl,
      submittedAt: driver.driverProfile?.updatedAt || driver.createdAt,
      verificationState: driver.driverProfile?.verificationState || 'pending'
    }));

    res.json({
      success: true,
      total: formattedDrivers.length,
      drivers: formattedDrivers
    });

  } catch (err) {
    console.error('Get pending drivers error:', err);
    next(err);
  }
});

// ==========================================
// PUT /drivers/:id/verify - APPROVE/REJECT VERIFICATION (ADMIN)
// ==========================================

router.put('/:id/verify', requireAuth, async (req, res, next) => {
  try {
    const { id } = req.params;
    const { action, reason } = req.body;

    console.log(`🔄 Admin verification action: ${action} for driver ${id}`);

    // Check if user is admin
    const adminUser = await User.findById(req.user.sub).select('roles');
    if (!adminUser?.roles?.isAdmin) {
      return res.status(403).json({
        success: false,
        error: { message: 'Admin access required' }
      });
    }

    // Validate action
    if (!['approve', 'reject'].includes(action)) {
      return res.status(400).json({
        success: false,
        error: { message: 'Action must be either "approve" or "reject"' }
      });
    }

    // Find driver
    const driver = await User.findById(id);
    if (!driver) {
      return res.status(404).json({
        success: false,
        error: { message: 'Driver not found' }
      });
    }

    if (!driver.roles?.isDriver) {
      return res.status(400).json({
        success: false,
        error: { message: 'User is not a driver' }
      });
    }

    // Update verification status
    const newState = action === 'approve' ? 'approved' : 'rejected';
    
    driver.driverProfile = {
      ...driver.driverProfile,
      verificationState: newState,
      verified: newState === 'approved',
      isAvailable: newState === 'approved' // Make available if approved
    };

    if (action === 'reject' && reason) {
      driver.driverProfile.rejectionReason = reason;
    }

    await driver.save();

    console.log(`✅ Driver ${id} verification status updated to: ${newState}`);

    res.json({
      success: true,
      message: `Driver verification ${action}d successfully`,
      data: {
        driverId: driver._id,
        name: driver.name,
        verificationState: driver.driverProfile.verificationState,
        verified: driver.driverProfile.verified,
        isAvailable: driver.driverProfile.isAvailable,
        updatedAt: driver.updatedAt
      }
    });

  } catch (err) {
    console.error('Verify driver error:', err);
    next(err);
  }
});

// ==========================================
// GET /drivers/check-user/:id - CHECK USER STATUS (DEBUG)
// ==========================================

router.get('/check-user/:id', async (req, res, next) => {
  try {
    const { id } = req.params;

    console.log(`🔍 Checking user status for: ${id}`);

    const user = await User.findById(id)
      .select('name phone email roles driverProfile createdAt')
      .lean();

    if (!user) {
      return res.status(404).json({
        success: false,
        error: { message: 'User not found' }
      });
    }

    res.json({
      success: true,
      user: {
        id: user._id,
        name: user.name,
        phone: user.phone,
        email: user.email || 'No email',
        roles: user.roles,
        hasDriverProfile: !!user.driverProfile,
        driverProfile: user.driverProfile || {},
        driverProfileKeys: user.driverProfile ? Object.keys(user.driverProfile) : [],
        createdAt: user.createdAt
      }
    });

  } catch (err) {
    console.error('Check user error:', err);
    next(err);
  }
});

// ==========================================
// GET /drivers/verified - GET VERIFIED DRIVERS
// ==========================================

router.get('/verified', async (req, res, next) => {
  try {
    const { limit = 20, offset = 0 } = req.query;

    const verifiedDrivers = await User.find({
      'roles.isDriver': true,
      'driverProfile.verificationState': 'approved',
      'driverProfile.isAvailable': true
    })
    .select('name phone driverProfile location rating totalTrips totalEarnings')
    .sort({ 'driverProfile.rating': -1, 'driverProfile.totalTrips': -1 })
    .limit(parseInt(limit))
    .skip(parseInt(offset))
    .lean();

    const formattedDrivers = verifiedDrivers.map(driver => ({
      id: driver._id,
      name: driver.name,
      phone: driver.phone,
      profilePicUrl: driver.driverProfile?.profilePicUrl,
      vehicleMake: driver.driverProfile?.vehicleMake,
      vehicleModel: driver.driverProfile?.vehicleModel,
      vehicleNumber: driver.driverProfile?.vehicleNumber,
      serviceCategories: driver.driverProfile?.serviceCategories || [],
      rating: driver.driverProfile?.rating || 0,
      totalTrips: driver.driverProfile?.totalTrips || 0,
      totalEarnings: driver.driverProfile?.totalEarnings || 0,
      location: driver.driverProfile?.location,
      isAvailable: driver.driverProfile?.isAvailable || false
    }));

    const total = await User.countDocuments({
      'roles.isDriver': true,
      'driverProfile.verificationState': 'approved',
      'driverProfile.isAvailable': true
    });

    res.json({
      success: true,
      data: {
        drivers: formattedDrivers,
        pagination: {
          total,
          limit: parseInt(limit),
          offset: parseInt(offset),
          hasMore: total > parseInt(offset) + parseInt(limit)
        }
      }
    });

  } catch (err) {
    console.error('Get verified drivers error:', err);
    next(err);
  }
});

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
// PROFILE MANAGEMENT ENDPOINTS
// ==========================================

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