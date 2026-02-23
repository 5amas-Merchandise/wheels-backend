// routes/trips.routes.js
const express = require("express");
const router = express.Router();
const mongoose = require("mongoose");
const User = require("../models/user.model");
const TripRequest = require("../models/tripRequest.model");
const Trip = require("../models/trip.model");
const Wallet = require("../models/wallet.model");
const Transaction = require("../models/transaction.model");
const Settings = require("../models/settings.model");
const { requireAuth } = require("../middleware/auth");
const {
  validateCoordinates,
  validateServiceType,
} = require("../middleware/validation");
const { isLuxury } = require("../constants/serviceTypes");
const { calculateFare } = require("../utils/pricingCalculator");
const emitter = require("../utils/eventEmitter");
const rateLimit = require("express-rate-limit");
const {
  requireActiveSubscription,
} = require("../middleware/subscriptionCheck");
const {
  processTripWalletPayment,
  recordCashTripEarning,
} = require("../utils/tripPaymentService");

// ==========================================
// RATE LIMITING
// ==========================================
const requestLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  message: { error: { message: "Too many requests, please try again later." } },
});

// ==========================================
// CONFIGURATION
// ==========================================
const CONFIG = {
  OFFER_TIMEOUT_MS: 20000,
  MAX_REJECTIONS: 5,
  SEARCH_TIMEOUT_MS: 5 * 60 * 1000,
  FAILED_TRIP_CLEANUP_MS: 5 * 60 * 1000,
  DRIVER_LAST_SEEN_THRESHOLD_MS: 5 * 60 * 1000,
  SEARCH_RADIUS_METERS: 5000,
  MAX_DRIVERS_SEARCH: 10,
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

    tripRequest.candidates.forEach((candidate) => {
      if (candidate.status === "offered" || candidate.status === "pending") {
        candidate.status = "rejected";
        candidate.rejectedAt = new Date();
        candidate.rejectionReason = "max_attempts_reached";
      }
    });

    tripRequest.status = "no_drivers";
    await tripRequest.save();

    try {
      emitter.emit("notification", {
        userId: tripRequest.passengerId.toString(),
        type: "no_driver_found",
        title: "No Drivers Available",
        body: "Unable to find a driver after multiple attempts. Please try again later.",
        data: { requestId: tripRequest._id, reason: "max_rejections_reached" },
      });
    } catch (emitErr) {
      console.error("Notification emit error during cleanup:", emitErr);
    }

    console.log(`✅ Trip request ${requestId} marked as no_drivers`);

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
      (c) =>
        c.status === "rejected" && c.rejectionReason !== "max_attempts_reached",
    ).length;

    console.log(
      `📊 Trip ${requestId} rejection count: ${rejectionCount}/${CONFIG.MAX_REJECTIONS}`,
    );

    if (rejectionCount >= CONFIG.MAX_REJECTIONS) {
      console.log(
        `🚫 Trip ${requestId} reached max rejections, initiating cleanup`,
      );
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
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) *
      Math.cos(toRad(lat2)) *
      Math.sin(dLon / 2) *
      Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}

function toRad(degrees) {
  return (degrees * Math.PI) / 180;
}

// ==========================================
// POST /trips/request
// ==========================================

router.post("/request", requireAuth, requestLimiter, async (req, res, next) => {
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
        paymentMethod = "cash",
        radiusMeters = CONFIG.SEARCH_RADIUS_METERS,
        limit = CONFIG.MAX_DRIVERS_SEARCH,
        estimatedFare,
        distance,
        duration,
        pickupAddress,
        dropoffAddress,
      } = req.body;

      console.log("🚗 === NEW TRIP REQUEST ===");
      console.log("Passenger ID:", passengerId);
      console.log("Service Type:", serviceType);
      console.log("Payment Method:", paymentMethod);
      console.log("Estimated Fare (naira):", estimatedFare);
      console.log("Distance:", distance, "km");

      if (!pickup || !validateCoordinates(pickup.coordinates)) {
        throw new Error("Invalid pickup coordinates");
      }

      if (!validateServiceType(serviceType)) {
        throw new Error("Invalid serviceType");
      }

      if (estimatedFare && (estimatedFare < 0 || estimatedFare > 1000000)) {
        throw new Error("Invalid estimated fare");
      }

      if (distance && (distance < 0 || distance > 1000)) {
        throw new Error("Invalid distance");
      }

      if (duration && (duration < 0 || duration > 24 * 60 * 60)) {
        throw new Error("Invalid duration");
      }

      const [lng, lat] = pickup.coordinates;
      const now = new Date();
      const lastSeenThreshold = new Date(
        now.getTime() - CONFIG.DRIVER_LAST_SEEN_THRESHOLD_MS,
      );

      console.log(
        `📍 Searching for drivers near [${lat}, ${lng}] within ${radiusMeters}m`,
      );

      let nearbyDrivers = [];

      try {
        nearbyDrivers = await User.find({
          "roles.isDriver": true,
          "driverProfile.verified": true,
          "driverProfile.verificationState": "approved",
          "driverProfile.isAvailable": true,
          "driverProfile.lastSeen": { $gte: lastSeenThreshold },
          "driverProfile.location": {
            $near: {
              $geometry: { type: "Point", coordinates: [lng, lat] },
              $maxDistance: radiusMeters,
            },
          },
        })
          .select("_id name driverProfile subscription")
          .limit(limit)
          .session(session)
          .lean();
      } catch (geoError) {
        console.error("❌ Geospatial query error:", geoError.message);
        throw new Error("Geospatial service temporarily unavailable");
      }

      console.log(`📊 Found ${nearbyDrivers?.length || 0} nearby drivers`);

      const candidates = [];
      for (const driver of nearbyDrivers || []) {
        const supportsService =
          driver.driverProfile?.serviceCategories?.includes(serviceType);
        if (!supportsService) {
          console.log(
            ` ⚠️ Driver ${driver._id} doesn't support ${serviceType}`,
          );
          continue;
        }
        candidates.push({
          driverId: driver._id,
          status: "pending",
          driverName: driver.name,
          offeredAt: null,
          rejectedAt: null,
          rejectionReason: null,
        });
        console.log(` ✅ Added driver ${driver._id} to candidates`);
      }

      console.log(`✅ ${candidates.length} drivers qualified`);

      let tripRequest;
      if (candidates.length === 0) {
        tripRequest = await TripRequest.create(
          [
            {
              passengerId,
              pickup,
              dropoff,
              serviceType,
              paymentMethod,
              estimatedFare: estimatedFare || 0,
              distance: distance || 0,
              duration: duration || 0,
              pickupAddress: pickupAddress || "",
              dropoffAddress: dropoffAddress || "",
              candidates: [],
              status: "no_drivers",
              expiresAt: new Date(now.getTime() + 60 * 1000),
            },
          ],
          { session },
        );

        createdRequestId = tripRequest[0]._id;
        responsePayload = {
          requestId: tripRequest[0]._id,
          message: "No drivers available",
        };
        candidateData = null;
        firstCandidate = null;
        return;
      }

      candidates[0].status = "offered";
      candidates[0].offeredAt = now;
      firstCandidate = candidates[0];
      console.log(`📤 Offering to first driver: ${candidates[0].driverId}`);

      tripRequest = await TripRequest.create(
        [
          {
            passengerId,
            pickup,
            dropoff,
            serviceType,
            paymentMethod,
            estimatedFare: estimatedFare || 0,
            distance: distance || 0,
            duration: duration || 0,
            pickupAddress: pickupAddress || "",
            dropoffAddress: dropoffAddress || "",
            candidates,
            status: "searching",
            expiresAt: new Date(now.getTime() + CONFIG.SEARCH_TIMEOUT_MS),
          },
        ],
        { session },
      );

      const createdRequest = tripRequest[0];
      createdRequestId = createdRequest._id;

      responsePayload = {
        requestId: createdRequest._id,
        candidatesCount: candidates.length,
        message: `Searching ${candidates.length} drivers`,
        estimatedFare: estimatedFare || 0,
      };

      candidateData = {
        serviceType,
        estimatedFare: estimatedFare || 0,
        distance: distance || 0,
        duration: duration || 0,
        pickup,
        dropoff,
        pickupAddress: pickupAddress || "",
        dropoffAddress: dropoffAddress || "",
        paymentMethod,
        immediateOffer: true,
      };
    });

    res.json(responsePayload);

    if (createdRequestId && firstCandidate) {
      try {
        emitter.emit("notification", {
          userId: firstCandidate.driverId.toString(),
          type: "trip_offered",
          title: "New Trip Request",
          body: `New ${candidateData.serviceType} ride - Accept within ${CONFIG.OFFER_TIMEOUT_MS / 1000} seconds`,
          data: {
            requestId: createdRequestId,
            ...candidateData,
          },
        });
        console.log(
          `📨 Notification sent to driver ${firstCandidate.driverId}`,
        );
      } catch (emitErr) {
        console.error("Notification emit error:", emitErr);
      }

      const firstDriverId = firstCandidate.driverId;
      setTimeout(async () => {
        try {
          const fresh = await TripRequest.findById(createdRequestId);
          if (!fresh || fresh.status !== "searching") return;
          const cand = fresh.candidates.find(
            (c) => c.driverId.toString() === firstDriverId.toString(),
          );
          if (cand && cand.status === "offered") {
            cand.status = "rejected";
            cand.rejectedAt = new Date();
            cand.rejectionReason = "timeout";
            await fresh.save();
            await offerToNext(createdRequestId);
          }
        } catch (err) {
          console.error("Timeout error:", err);
        }
      }, CONFIG.OFFER_TIMEOUT_MS);
    }
  } catch (err) {
    if (session.inTransaction()) await session.abortTransaction();
    console.error("❌ Trip request error:", err);
    if (
      err.message.includes("Invalid") ||
      err.message.includes("Unavailable")
    ) {
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
    if (!tripRequest || tripRequest.status !== "searching") {
      console.log(`❌ Trip ${requestId} not searching or not found`);
      return;
    }

    const shouldCleanup = await trackRejection(requestId);
    if (shouldCleanup) return;

    const nextCandidate = tripRequest.candidates.find(
      (c) => c.status === "pending" && !c.rejectedAt,
    );

    if (!nextCandidate) {
      console.log(`⚠️ No more pending candidates for ${requestId}`);
      await cleanupFailedTripRequest(requestId);
      return;
    }

    nextCandidate.status = "offered";
    nextCandidate.offeredAt = new Date();
    await tripRequest.save();

    const driverId = nextCandidate.driverId;
    const rejectionCount = tripRequest.candidates.filter(
      (c) => c.status === "rejected",
    ).length;
    console.log(
      `📤 Offering to driver ${driverId} (Attempt ${rejectionCount + 1}/${CONFIG.MAX_REJECTIONS})`,
    );

    try {
      emitter.emit("notification", {
        userId: driverId.toString(),
        type: "trip_offered",
        title: "New Trip Request",
        body: `New ${tripRequest.serviceType} ride - Accept within ${CONFIG.OFFER_TIMEOUT_MS / 1000} seconds`,
        data: {
          requestId: tripRequest._id,
          serviceType: tripRequest.serviceType,
          estimatedFare: tripRequest.estimatedFare || 0,
          distance: tripRequest.distance || 0,
          duration: tripRequest.duration || 0,
          pickup: tripRequest.pickup,
          dropoff: tripRequest.dropoff,
          pickupAddress: tripRequest.pickupAddress || "",
          dropoffAddress: tripRequest.dropoffAddress || "",
          paymentMethod: tripRequest.paymentMethod || "cash",
          immediateOffer: true,
        },
      });
    } catch (emitErr) {
      console.error("Notification emit error in offerToNext:", emitErr);
    }

    setTimeout(async () => {
      try {
        const fresh = await TripRequest.findById(requestId);
        if (!fresh || fresh.status !== "searching") return;
        const cand = fresh.candidates.find(
          (c) => c.driverId.toString() === driverId.toString(),
        );
        if (cand && cand.status === "offered") {
          cand.status = "rejected";
          cand.rejectedAt = new Date();
          cand.rejectionReason = "timeout";
          await fresh.save();
          await offerToNext(requestId);
        }
      } catch (err) {
        console.error("Timeout error:", err);
      }
    }, CONFIG.OFFER_TIMEOUT_MS);
  } catch (err) {
    console.error("❌ offerToNext error:", err);
  }
}

// ==========================================
// GET /trips/request/:requestId
// ==========================================

router.get("/request/:requestId", requireAuth, async (req, res, next) => {
  try {
    const userId = req.user.sub;
    const { requestId } = req.params;

    const tripRequest = await TripRequest.findById(requestId)
      .populate("passengerId", "name phone")
      .populate("assignedDriverId", "name phone driverProfile")
      .lean();

    if (!tripRequest) {
      return res
        .status(404)
        .json({ error: { message: "Trip request not found" } });
    }

    if (tripRequest.passengerId._id.toString() !== userId) {
      return res.status(403).json({ error: { message: "Unauthorized" } });
    }

    let trip = null;
    if (tripRequest.status === "assigned" && tripRequest.assignedDriverId) {
      trip = await Trip.findOne({ tripRequestId: tripRequest._id }).lean();
    }

    res.json({
      trip: {
        ...tripRequest,
        _id: trip?._id || tripRequest._id,
        status: trip?.status || tripRequest.status,
        assignedDriverId: tripRequest.assignedDriverId,
      },
    });
  } catch (err) {
    next(err);
  }
});

// ==========================================
// POST /trips/accept
// ==========================================

router.post(
  "/accept",
  requireAuth,
  requireActiveSubscription,
  async (req, res, next) => {
    const session = await mongoose.startSession();
    session.startTransaction();

    let tripData = null;
    let notificationData = null;
    let responseSent = false;

    try {
      const driverId = req.user.sub;
      const { requestId, idempotencyKey } = req.body;

      if (!requestId) throw new Error("Request ID is required");

      const finalIdempotencyKey =
        idempotencyKey || `accept_${requestId}_${driverId}_${Date.now()}`;

      console.log(
        `🤝 Driver ${driverId} attempting to accept request ${requestId}`,
      );

      const idempotencyCollection =
        mongoose.connection.collection("idempotency_keys");
      const existingKey = await idempotencyCollection.findOne(
        { key: finalIdempotencyKey },
        { session },
      );

      if (existingKey) {
        if (existingKey.status === "completed" && existingKey.tripId) {
          await session.abortTransaction();
          return res.json({
            success: true,
            tripId: existingKey.tripId.toString(),
            requestId: existingKey.requestId.toString(),
            driverId,
            fromCache: true,
          });
        } else if (existingKey.status === "processing") {
          throw new Error("Request is already being processed");
        } else {
          throw new Error("Previous accept attempt failed. Please try again.");
        }
      }

      await idempotencyCollection.insertOne(
        {
          key: finalIdempotencyKey,
          driverId,
          requestId,
          status: "processing",
          createdAt: new Date(),
          expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
        },
        { session },
      );

      const driver = await User.findById(driverId)
        .select("name driverProfile")
        .session(session);
      if (!driver) throw new Error("Driver not found");
      if (!driver.driverProfile?.isAvailable) {
        await idempotencyCollection.updateOne(
          { key: finalIdempotencyKey },
          { $set: { status: "failed", error: "Driver not available" } },
          { session },
        );
        throw new Error("Driver is not available");
      }

      const tripRequest = await TripRequest.findOneAndUpdate(
        {
          _id: requestId,
          status: "searching",
          assignedDriverId: null,
          candidates: { $elemMatch: { driverId, status: "offered" } },
        },
        {
          $set: {
            assignedDriverId: driverId,
            status: "assigned",
            "candidates.$[elem].status": "accepted",
            "candidates.$[elem].acceptedAt": new Date(),
          },
        },
        { arrayFilters: [{ "elem.driverId": driverId }], new: true, session },
      );

      if (!tripRequest) {
        const currentRequest =
          await TripRequest.findById(requestId).session(session);
        if (!currentRequest) {
          await idempotencyCollection.updateOne(
            { key: finalIdempotencyKey },
            { $set: { status: "failed", error: "Trip request not found" } },
            { session },
          );
          throw new Error("Trip request not found");
        }
        await idempotencyCollection.updateOne(
          { key: finalIdempotencyKey },
          { $set: { status: "failed", error: "Trip no longer available" } },
          { session },
        );
        throw new Error("Trip is no longer available");
      }

      const tripDoc = await Trip.create(
        [
          {
            passengerId: tripRequest.passengerId,
            driverId,
            tripRequestId: tripRequest._id,
            serviceType: tripRequest.serviceType,
            paymentMethod: tripRequest.paymentMethod || "cash",
            pickupLocation: tripRequest.pickup,
            dropoffLocation: tripRequest.dropoff,
            status: "assigned",
            estimatedFare: tripRequest.estimatedFare || 0,
            distanceKm: tripRequest.distance || 0,
            durationMinutes: Math.round((tripRequest.duration || 0) / 60),
            requestedAt: new Date(),
            metadata: {
              subscriptionId: req.subscription.id,
              subscriptionExpiresAt: req.subscription.expiresAt,
              vehicleType: req.subscription.vehicleType,
            },
          },
        ],
        { session },
      );

      const newTrip = tripDoc[0];

      await User.findByIdAndUpdate(
        driverId,
        {
          "driverProfile.isAvailable": false,
          "driverProfile.currentTripId": newTrip._id,
        },
        { session },
      );

      await idempotencyCollection.updateOne(
        { key: finalIdempotencyKey },
        {
          $set: {
            status: "completed",
            tripId: newTrip._id,
            requestId: tripRequest._id,
            updatedAt: new Date(),
          },
        },
        { session },
      );

      await session.commitTransaction();

      tripData = {
        success: true,
        tripId: newTrip._id.toString(),
        requestId: tripRequest._id.toString(),
        driverId,
        subscription: {
          expiresAt: req.subscription.expiresAt,
          vehicleType: req.subscription.vehicleType,
        },
      };

      notificationData = {
        passengerId: tripRequest.passengerId.toString(),
        driverId,
        tripId: newTrip._id.toString(),
        requestId: tripRequest._id.toString(),
        driverName: driver.name || "Driver",
        serviceType: tripRequest.serviceType,
        estimatedFare: tripRequest.estimatedFare || 0,
        pickup: tripRequest.pickup,
        dropoff: tripRequest.dropoff,
        pickupAddress: tripRequest.pickupAddress || "",
        dropoffAddress: tripRequest.dropoffAddress || "",
      };

      res.json(tripData);
      responseSent = true;

      setImmediate(() => {
        try {
          emitter.emit("notification", {
            userId: notificationData.passengerId,
            type: "trip_accepted",
            notificationType: "trip_accepted",
            title: "Driver Accepted!",
            body: `${notificationData.driverName} is on the way`,
            data: { ...notificationData },
          });
        } catch (emitErr) {
          console.error("❌ Notification error:", emitErr.message);
        }
      });
    } catch (error) {
      if (session.inTransaction()) await session.abortTransaction();
      console.error("❌ Accept error:", error.message);

      if (!responseSent) {
        let statusCode = 500,
          errorCode = "INTERNAL_ERROR";
        if (error.message.includes("not found")) {
          statusCode = 404;
          errorCode = "NOT_FOUND";
        } else if (
          error.message.includes("not available") ||
          error.message.includes("no longer available")
        ) {
          statusCode = 400;
          errorCode = "TRIP_UNAVAILABLE";
        }
        res
          .status(statusCode)
          .json({
            success: false,
            error: { message: error.message, code: errorCode },
          });
      }
    } finally {
      await session.endSession();
    }
  },
);

// ==========================================
// POST /trips/reject
// ==========================================

router.post("/reject", requireAuth, async (req, res, next) => {
  try {
    const driverId = req.user.sub;
    const { requestId } = req.body;

    const tripRequest = await TripRequest.findById(requestId);
    if (!tripRequest || tripRequest.status !== "searching") {
      return res
        .status(400)
        .json({ error: { message: "Trip no longer searching" } });
    }

    const candidate = tripRequest.candidates.find(
      (c) => c.driverId.toString() === driverId && c.status === "offered",
    );

    if (!candidate) {
      return res
        .status(403)
        .json({ error: { message: "You were not offered this trip" } });
    }

    candidate.status = "rejected";
    candidate.rejectedAt = new Date();
    candidate.rejectionReason = "manual_rejection";
    await tripRequest.save();

    await offerToNext(requestId);
    res.json({ success: true });
  } catch (err) {
    console.error("❌ Reject error:", err);
    next(err);
  }
});

// ==========================================
// ADMIN MIDDLEWARE
// ==========================================

const requireAdmin = (req, res, next) => {
  if (req.user?.roles?.isAdmin) next();
  else res.status(403).json({ error: { message: "Admin access required" } });
};

// ==========================================
// GET /trips/searching - ADMIN
// ==========================================

router.get("/searching", requireAuth, requireAdmin, async (req, res, next) => {
  try {
    const searchingTrips = await TripRequest.find({ status: "searching" })
      .populate("passengerId", "name phone")
      .select(
        "_id serviceType pickup dropoff estimatedFare candidates status createdAt expiresAt",
      )
      .sort({ createdAt: -1 })
      .lean();

    res.json({
      count: searchingTrips.length,
      trips: searchingTrips,
      timestamp: new Date().toISOString(),
      config: {
        OFFER_TIMEOUT_MS: CONFIG.OFFER_TIMEOUT_MS,
        MAX_REJECTIONS: CONFIG.MAX_REJECTIONS,
      },
    });
  } catch (err) {
    next(err);
  }
});

// ==========================================
// POST /trips/:tripId/start
// ==========================================

router.post("/:tripId/start", requireAuth, async (req, res, next) => {
  try {
    const driverId = req.user.sub;
    const trip = await Trip.findById(req.params.tripId);

    if (!trip)
      return res.status(404).json({ error: { message: "Trip not found" } });
    if (trip.driverId.toString() !== driverId)
      return res.status(403).json({ error: { message: "Unauthorized" } });

    trip.status = "started";
    trip.startedAt = new Date();
    await trip.save();

    try {
      emitter.emit("notification", {
        userId: trip.passengerId.toString(),
        type: "trip_started",
        title: "Trip Started",
        body: "Your driver has started the trip",
        data: { tripId: trip._id },
      });
    } catch (emitErr) {
      console.error("Notification emit error:", emitErr);
    }

    res.json({ trip });
  } catch (err) {
    next(err);
  }
});

// ==========================================
// POST /trips/:tripId/complete  ← MAIN FIX
// ==========================================
//
// UNIT CONVENTION:
//   Trip.estimatedFare  → stored in NAIRA  (frontend sends naira)
//   Wallet.balance      → stored in KOBO   (Paystack convention)
//   processTripWalletPayment receives fareNaira and converts internally
//
// ==========================================

router.post("/:tripId/complete", requireAuth, async (req, res, next) => {
  const session = await mongoose.startSession();

  try {
    await session.withTransaction(async () => {
      const driverId = req.user.sub;
      const tripId = req.params.tripId;

      console.log(`✅ Completing trip ${tripId} — driver ${driverId}`);

      // ── 1. Load trip ─────────────────────────────────────────────────────
      const existingTrip = await Trip.findById(tripId).session(session);
      if (!existingTrip) throw new Error("Trip not found");

      if (existingTrip.driverId.toString() !== driverId) {
        throw new Error("Unauthorized: You are not the driver for this trip");
      }

      if (["completed", "cancelled"].includes(existingTrip.status)) {
        throw new Error(`Trip is already ${existingTrip.status}`);
      }

      // fareNaira: the fare is stored in NAIRA in Trip.estimatedFare
      const fareNaira = existingTrip.estimatedFare || 0;
      const paymentMethod = existingTrip.paymentMethod || "cash";

      // Keep passengerId as ObjectId for referral query; use toString() for notifications
      const passengerObjectId = existingTrip.passengerId;
      const passengerIdStr = passengerObjectId.toString();

      console.log(`💰 Fare: ₦${fareNaira} (naira) | Payment: ${paymentMethod}`);

      // ── 2. Process payment ────────────────────────────────────────────────
      let paymentResult = null;
      let resolvedPaymentMethod = paymentMethod;

      if (paymentMethod === "wallet") {
        try {
          paymentResult = await processTripWalletPayment(
            {
              tripId,
              passengerId: passengerIdStr,
              driverId,
              fareNaira, // ✅ naira — service converts to kobo internally
              serviceType: existingTrip.serviceType,
            },
            session,
          );
          console.log(
            `✅ Wallet payment processed — passenger debited ₦${fareNaira}, driver credited ₦${fareNaira}`,
          );
        } catch (paymentErr) {
          console.warn(
            `⚠️ Wallet payment failed (${paymentErr.message}). Falling back to cash.`,
          );
          resolvedPaymentMethod = "cash_fallback";
          paymentResult = null;
        }
      } else {
        // Record cash earning for stats (no wallet balance change)
        try {
          paymentResult = await recordCashTripEarning(
            {
              tripId,
              driverId,
              fareNaira,
              serviceType: existingTrip.serviceType,
            },
            session,
          );
          console.log(`💵 Cash earning recorded for driver ${driverId}`);
        } catch (cashErr) {
          console.warn(
            `⚠️ Cash earning record failed (non-fatal): ${cashErr.message}`,
          );
        }
        resolvedPaymentMethod = "cash";
      }

      // ── 3. Mark trip completed ────────────────────────────────────────────
      const updatedTrip = await Trip.findByIdAndUpdate(
        tripId,
        {
          status: "completed",
          finalFare: fareNaira,
          completedAt: new Date(),
          paymentMethod: resolvedPaymentMethod,
          paymentConfirmed: true,
          ...(paymentResult?.passengerTxn && {
            "metadata.passengerTransactionId": paymentResult.passengerTxn._id,
          }),
          ...(paymentResult?.driverTxn && {
            "metadata.driverTransactionId": paymentResult.driverTxn._id,
          }),
        },
        { new: true, session },
      );

      // ── 4. Update driver availability ──────────────────────────────────
      await User.findByIdAndUpdate(
        driverId,
        {
          "driverProfile.isAvailable": true,
          $unset: { "driverProfile.currentTripId": "" },
          $inc: {
            "driverProfile.totalTrips": 1,
            "driverProfile.totalEarnings": fareNaira,
          },
        },
        { session },
      );

      console.log(`✅ Driver ${driverId} is now available`);

      // ── 5. Check for pending referral (use ObjectId!) ─────────────────
      const pendingReferral = await mongoose
        .model("Referral")
        .findOne({
          refereeId: passengerObjectId, // ✅ ObjectId — not string
          status: "pending",
        })
        .session(session);

      const shouldTriggerReferral = !!pendingReferral;
      console.log(
        `🎯 Referral check for ${passengerIdStr}:`,
        shouldTriggerReferral ? `Found (${pendingReferral._id})` : "None",
      );

      // ── 6. Build driver wallet info for response ────────────────────────
      const driverNewBalance = paymentResult?.driverWallet?.balance ?? null;

      // ── 7. Determine notification messages ─────────────────────────────
      let passengerNote, driverNote;

      if (resolvedPaymentMethod === "wallet") {
        passengerNote = `₦${fareNaira.toLocaleString()} was deducted from your wallet.`;
        driverNote = `₦${fareNaira.toLocaleString()} has been credited to your wallet. No need to collect cash from the passenger.`;
      } else if (resolvedPaymentMethod === "cash_fallback") {
        passengerNote = `Wallet payment failed — please pay the driver ₦${fareNaira.toLocaleString()} in cash.`;
        driverNote = `Wallet payment failed — please collect ₦${fareNaira.toLocaleString()} in cash from the passenger.`;
      } else {
        passengerNote = `Please pay the driver ₦${fareNaira.toLocaleString()} in cash.`;
        driverNote = `Collect ₦${fareNaira.toLocaleString()} in cash from the passenger.`;
      }

      // ── 8. Send HTTP response ────────────────────────────────────────────
      res.json({
        success: true,
        trip: {
          id: updatedTrip._id.toString(),
          status: updatedTrip.status,
          finalFare: updatedTrip.finalFare,
          completedAt: updatedTrip.completedAt,
          paymentMethod: resolvedPaymentMethod,
        },
        payment: {
          method: resolvedPaymentMethod,
          isWallet: resolvedPaymentMethod === "wallet",
          isCash: resolvedPaymentMethod === "cash",
          isFallback: resolvedPaymentMethod === "cash_fallback",
          fareNaira,
          fareFormatted: `₦${fareNaira.toLocaleString()}`,
          // Driver-facing message
          driverMessage: driverNote,
          // New driver wallet balance (only for wallet payments)
          driverWallet:
            driverNewBalance !== null
              ? {
                  balance: driverNewBalance,
                  balanceNaira: (driverNewBalance / 100).toFixed(2),
                  balanceFormatted: `₦${(driverNewBalance / 100).toLocaleString()}`,
                }
              : null,
        },
        message: "Trip completed successfully.",
      });

      // ── 9. Post-commit side effects ──────────────────────────────────────
      setImmediate(async () => {
        try {
          if (shouldTriggerReferral) {
            try {
              const referralRouter = require("./referral");
              if (typeof referralRouter.triggerReferralReward === "function") {
                await referralRouter.triggerReferralReward(
                  tripId,
                  passengerIdStr,
                );
              }
            } catch (refErr) {
              console.error(
                "Referral reward error (non-fatal):",
                refErr.message,
              );
            }
          }

          emitter.emit("notification", {
            userId: passengerIdStr,
            type: "trip_completed",
            title: "Trip Completed",
            body: `Your trip is done. Fare: ₦${fareNaira.toLocaleString()}. ${passengerNote}`,
            data: {
              tripId,
              fare: fareNaira,
              status: "completed",
              paymentMethod: resolvedPaymentMethod,
            },
          });

          emitter.emit("notification", {
            userId: driverId,
            type: "trip_completed",
            title: "Trip Completed",
            body: `You earned ₦${fareNaira.toLocaleString()}. ${driverNote}`,
            data: {
              tripId,
              earned: fareNaira,
              status: "completed",
              paymentMethod: resolvedPaymentMethod,
              driverMessage: driverNote,
              isWalletPayment: resolvedPaymentMethod === "wallet",
            },
          });

          emitter.emit("trip_completed", {
            tripId,
            driverId,
            passengerId: passengerIdStr,
            finalFare: fareNaira,
            completedAt: new Date(),
          });

          console.log(
            `📨 Post-completion notifications sent for trip ${tripId}`,
          );
        } catch (postErr) {
          console.error("Post-completion error (non-fatal):", postErr.message);
        }
      });
    }); // end withTransaction
  } catch (error) {
    console.error("❌ Complete trip error:", error.message);

    let statusCode = 500;
    let errorCode = "INTERNAL_ERROR";
    let errorMessage = error.message || "Failed to complete trip";

    if (error.message.includes("not found")) {
      statusCode = 404;
      errorCode = "TRIP_NOT_FOUND";
    } else if (error.message.includes("Unauthorized")) {
      statusCode = 403;
      errorCode = "UNAUTHORIZED";
    } else if (
      error.message.includes("already completed") ||
      error.message.includes("already cancelled")
    ) {
      statusCode = 400;
      errorCode = "TRIP_ALREADY_ENDED";
    } else if (error.message.includes("Insufficient wallet balance")) {
      statusCode = 400;
      errorCode = "INSUFFICIENT_BALANCE";
    }

    res
      .status(statusCode)
      .json({
        success: false,
        error: { message: errorMessage, code: errorCode },
      });
  } finally {
    await session.endSession();
  }
});

// ==========================================
// POST /trips/:tripId/cancel
// ==========================================

router.post("/:tripId/cancel", requireAuth, async (req, res, next) => {
  try {
    const userId = req.user.sub;
    const { reason } = req.body;

    const trip = await Trip.findById(req.params.tripId);
    if (!trip)
      return res.status(404).json({ error: { message: "Trip not found" } });

    const isPassenger = trip.passengerId.toString() === userId;
    const isDriver = trip.driverId?.toString() === userId;

    if (!isPassenger && !isDriver) {
      return res.status(403).json({ error: { message: "Unauthorized" } });
    }

    trip.status = "cancelled";
    trip.cancelledAt = new Date();
    trip.cancellationReason =
      reason || (isPassenger ? "passenger_cancelled" : "driver_cancelled");
    await trip.save();

    if (isDriver && trip.driverId) {
      await User.findByIdAndUpdate(trip.driverId, {
        "driverProfile.isAvailable": true,
        $unset: { "driverProfile.currentTripId": "" },
      });
    }

    res.json({ success: true, trip, message: "Trip cancelled successfully" });
  } catch (err) {
    console.error("Cancel error:", err);
    res
      .status(500)
      .json({ success: false, error: { message: "Failed to cancel trip" } });
  }
});

// ==========================================
// GET /trips/history
// ==========================================

router.get("/history", requireAuth, async (req, res, next) => {
  try {
    const userId = req.user.sub;
    const {
      role = "passenger",
      status = "all",
      limit = 50,
      offset = 0,
      startDate,
      endDate,
    } = req.query;

    const filter =
      role === "driver" ? { driverId: userId } : { passengerId: userId };

    if (status === "completed") filter.status = "completed";
    else if (status === "cancelled") filter.status = "cancelled";
    else filter.status = { $in: ["completed", "cancelled"] };

    if (startDate || endDate) {
      filter.completedAt = {};
      if (startDate) filter.completedAt.$gte = new Date(startDate);
      if (endDate) filter.completedAt.$lte = new Date(endDate);
    }

    const parsedLimit = Math.min(parseInt(limit) || 50, 100);
    const parsedOffset = parseInt(offset) || 0;

    const trips = await Trip.find(filter)
      .populate("passengerId", "name phone profilePicUrl")
      .populate("driverId", "name phone profilePicUrl driverProfile")
      .sort({ completedAt: -1, cancelledAt: -1, createdAt: -1 })
      .limit(parsedLimit)
      .skip(parsedOffset)
      .lean();

    const total = await Trip.countDocuments(filter);

    const formattedTrips = trips.map((trip) => {
      const isDriver = trip.driverId?._id?.toString() === userId;
      return {
        id: trip._id.toString(),
        date: trip.completedAt || trip.cancelledAt || trip.createdAt,
        status: trip.status,
        pickup: {
          address: trip.pickupLocation?.address || "Pickup Location",
          coordinates: trip.pickupLocation?.coordinates,
        },
        dropoff: {
          address: trip.dropoffLocation?.address || "Dropoff Location",
          coordinates: trip.dropoffLocation?.coordinates,
        },
        serviceType: trip.serviceType,
        paymentMethod: trip.paymentMethod,
        estimatedFare: trip.estimatedFare,
        finalFare: trip.finalFare,
        fareInNaira: trip.finalFare ? trip.finalFare.toFixed(2) : "0.00",
        distanceKm: trip.distanceKm,
        durationMinutes: trip.durationMinutes,
        requestedAt: trip.requestedAt,
        startedAt: trip.startedAt,
        completedAt: trip.completedAt,
        cancelledAt: trip.cancelledAt,
        cancellationReason: trip.cancellationReason,
        otherParty: isDriver
          ? {
              id: trip.passengerId?._id?.toString(),
              name: trip.passengerId?.name || "Passenger",
              phone: trip.passengerId?.phone,
              profilePicUrl: trip.passengerId?.profilePicUrl,
            }
          : {
              id: trip.driverId?._id?.toString(),
              name: trip.driverId?.name || "Driver",
              phone: trip.driverId?.phone,
              profilePicUrl: trip.driverId?.profilePicUrl,
              vehicleInfo: trip.driverId?.driverProfile
                ? {
                    make: trip.driverId.driverProfile.vehicleMake,
                    model: trip.driverId.driverProfile.vehicleModel,
                    number: trip.driverId.driverProfile.vehicleNumber,
                  }
                : null,
            },
      };
    });

    res.json({
      success: true,
      trips: formattedTrips,
      pagination: {
        total,
        limit: parsedLimit,
        offset: parsedOffset,
        hasMore: total > parsedOffset + parsedLimit,
      },
      stats: {
        totalTrips: total,
        completedTrips: await Trip.countDocuments({
          ...filter,
          status: "completed",
        }),
        cancelledTrips: await Trip.countDocuments({
          ...filter,
          status: "cancelled",
        }),
        totalSpent: trips
          .filter((t) => t.status === "completed")
          .reduce((s, t) => s + (t.finalFare || 0), 0),
      },
    });
  } catch (err) {
    console.error("❌ Trip history error:", err);
    next(err);
  }
});

// ==========================================
// GET /trips/history/stats
// ==========================================

router.get("/history/stats", requireAuth, async (req, res, next) => {
  try {
    const userId = req.user.sub;
    const { role = "passenger", period = "month" } = req.query;

    const now = new Date();
    let startDate;
    if (period === "week")
      startDate = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    else if (period === "month")
      startDate = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    else if (period === "year")
      startDate = new Date(now.getTime() - 365 * 24 * 60 * 60 * 1000);

    const filter =
      role === "driver" ? { driverId: userId } : { passengerId: userId };
    if (startDate) filter.completedAt = { $gte: startDate };

    const completedFilter = { ...filter, status: "completed" };

    const [
      completedTrips,
      cancelledTrips,
      totalDistRes,
      totalFareRes,
      serviceBreakdown,
    ] = await Promise.all([
      Trip.countDocuments(completedFilter),
      Trip.countDocuments({ ...filter, status: "cancelled" }),
      Trip.aggregate([
        { $match: completedFilter },
        { $group: { _id: null, total: { $sum: "$distanceKm" } } },
      ]),
      Trip.aggregate([
        { $match: completedFilter },
        { $group: { _id: null, total: { $sum: "$finalFare" } } },
      ]),
      Trip.aggregate([
        { $match: completedFilter },
        {
          $group: {
            _id: "$serviceType",
            count: { $sum: 1 },
            totalFare: { $sum: "$finalFare" },
          },
        },
      ]),
    ]);

    const totalDistance = totalDistRes[0]?.total || 0;
    const totalFare = totalFareRes[0]?.total || 0;

    res.json({
      success: true,
      period,
      stats: {
        totalTrips: completedTrips + cancelledTrips,
        completedTrips,
        cancelledTrips,
        totalDistance: parseFloat(totalDistance.toFixed(2)),
        totalFare,
        totalFareFormatted: `₦${totalFare.toLocaleString()}`,
        averageFare: completedTrips > 0 ? totalFare / completedTrips : 0,
        serviceTypeBreakdown: serviceBreakdown.map((i) => ({
          serviceType: i._id,
          count: i.count,
          totalFare: i.totalFare,
        })),
      },
    });
  } catch (err) {
    next(err);
  }
});

// ==========================================
// GET /trips/history/:tripId
// ==========================================

router.get("/history/:tripId", requireAuth, async (req, res, next) => {
  try {
    const userId = req.user.sub;
    const trip = await Trip.findById(req.params.tripId)
      .populate("passengerId", "name phone profilePicUrl")
      .populate("driverId", "name phone profilePicUrl driverProfile")
      .lean();

    if (!trip)
      return res
        .status(404)
        .json({ success: false, error: { message: "Trip not found" } });

    const isPassenger = trip.passengerId?._id?.toString() === userId;
    const isDriver = trip.driverId?._id?.toString() === userId;

    if (!isPassenger && !isDriver) {
      return res
        .status(403)
        .json({ success: false, error: { message: "Unauthorized" } });
    }

    res.json({ success: true, trip });
  } catch (err) {
    next(err);
  }
});

// ==========================================
// GET /trips/:tripId
// ==========================================

router.get("/:tripId", requireAuth, async (req, res, next) => {
  try {
    const trip = await Trip.findById(req.params.tripId).lean();
    if (!trip)
      return res.status(404).json({ error: { message: "Trip not found" } });

    const userId = req.user.sub;
    const isAuth =
      trip.passengerId.toString() === userId ||
      trip.driverId?.toString() === userId;
    if (!isAuth)
      return res.status(403).json({ error: { message: "Unauthorized" } });

    res.json({ trip });
  } catch (err) {
    next(err);
  }
});

// ==========================================
// GET /trips
// ==========================================

router.get("/", requireAuth, async (req, res, next) => {
  try {
    const userId = req.user.sub;
    const { role = "passenger", limit = 50, offset = 0 } = req.query;
    const filter =
      role === "driver" ? { driverId: userId } : { passengerId: userId };
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
// PERIODIC CLEANUP
// ==========================================

function startPeriodicCleanup() {
  setInterval(
    async () => {
      try {
        const now = new Date();
        const expired = await TripRequest.find({
          status: "searching",
          expiresAt: { $lt: now },
        }).lean();
        for (const req of expired) await cleanupFailedTripRequest(req._id);

        const deleted = await TripRequest.deleteMany({
          status: "no_drivers",
          createdAt: { $lt: new Date(now.getTime() - 10 * 60 * 1000) },
        });
        if (deleted.deletedCount > 0)
          console.log(
            `🗑️ Deleted ${deleted.deletedCount} old no_drivers requests`,
          );

        await mongoose.connection
          .collection("idempotency_keys")
          .deleteMany({ expiresAt: { $lt: now } });
      } catch (err) {
        console.error("Cleanup error:", err);
      }
    },
    5 * 60 * 1000,
  );
}

startPeriodicCleanup();

// ==========================================
// ADMIN ENDPOINTS
// ==========================================

router.post(
  "/admin/flush-trips",
  requireAuth,
  requireAdmin,
  async (req, res) => {
    try {
      const deleted = await TripRequest.deleteMany({
        expiresAt: { $lt: new Date() },
      });
      res.json({ success: true, deletedCount: deleted.deletedCount });
    } catch (err) {
      res.status(500).json({ error: { message: "Flush failed" } });
    }
  },
);

router.get("/admin/config", requireAuth, requireAdmin, async (req, res) => {
  res.json({
    config: CONFIG,
    timestamp: new Date().toISOString(),
    stats: {
      searchingTrips: await TripRequest.countDocuments({ status: "searching" }),
      activeTrips: await Trip.countDocuments({
        status: { $in: ["assigned", "started", "in_progress"] },
      }),
    },
  });
});

router.post("/drivers/cleanup-state", requireAuth, async (req, res) => {
  try {
    const driverId = req.user.sub;
    const driver = await User.findById(driverId).select("driverProfile");
    if (!driver)
      return res.status(404).json({ error: { message: "Driver not found" } });

    let cleaned = false;
    const issues = [];

    if (driver.driverProfile?.currentTripId) {
      const currentTrip = await Trip.findById(
        driver.driverProfile.currentTripId,
      ).select("status");
      if (
        !currentTrip ||
        ["completed", "cancelled"].includes(currentTrip?.status)
      ) {
        cleaned = true;
        issues.push(
          !currentTrip
            ? "Trip not found — removing stale ref"
            : `Trip ${currentTrip.status} — removing stale ref`,
        );
      } else {
        issues.push(`Trip is ${currentTrip.status} — keeping ref`);
      }
    }

    if (cleaned) {
      await User.findByIdAndUpdate(driverId, {
        "driverProfile.isAvailable": true,
        $unset: { "driverProfile.currentTripId": "" },
      });
    }

    res.json({ success: true, cleaned, issues });
  } catch (err) {
    res.status(500).json({ error: { message: "Cleanup failed" } });
  }
});

router.get("/drivers/current-state", requireAuth, async (req, res) => {
  try {
    const driverId = req.user.sub;
    const driver = await User.findById(driverId)
      .select("name driverProfile")
      .lean();
    if (!driver)
      return res.status(404).json({ error: { message: "Driver not found" } });

    let currentTrip = null;
    if (driver.driverProfile?.currentTripId) {
      currentTrip = await Trip.findById(driver.driverProfile.currentTripId)
        .select("status requestedAt startedAt completedAt cancelledAt")
        .lean();
    }

    res.json({
      driverId,
      name: driver.name,
      isAvailable: driver.driverProfile?.isAvailable,
      currentTripId: driver.driverProfile?.currentTripId?.toString() || null,
      currentTrip,
      needsCleanup:
        driver.driverProfile?.currentTripId &&
        (!currentTrip ||
          ["completed", "cancelled"].includes(currentTrip?.status)),
    });
  } catch (err) {
    res.status(500).json({ error: { message: "Failed to get state" } });
  }
});

// ==========================================
// INDEX CREATION
// ==========================================

async function createIndexes() {
  try {
    await mongoose.connection
      .collection("idempotency_keys")
      .createIndex(
        { key: 1 },
        { unique: true, expireAfterSeconds: 24 * 60 * 60 },
      );
    console.log("✅ Idempotency key index created");
  } catch (err) {
    console.log("Index creation note:", err.message);
  }
}

createIndexes();

module.exports = router;
