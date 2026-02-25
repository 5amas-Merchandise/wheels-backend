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
const LoyaltyProgress = require("../models/Loyaltyprogress.model");
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
  processFreeRideLoyaltyPayment,
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
// REJECTION TRACKING
// ==========================================
async function cleanupFailedTripRequest(requestId) {
  try {
    console.log(`🧹 Cleaning up failed trip request: ${requestId}`);
    const tripRequest = await TripRequest.findById(requestId);
    if (!tripRequest) return;

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

    if (rejectionCount >= CONFIG.MAX_REJECTIONS) {
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

      // ── Validate payment method ──────────────────────────────────────────
      const VALID_PAYMENT_METHODS = ["cash", "wallet"];
      const resolvedPaymentMethod = VALID_PAYMENT_METHODS.includes(
        paymentMethod,
      )
        ? paymentMethod
        : "cash";

      console.log("🚗 === NEW TRIP REQUEST ===");
      console.log("Passenger ID:", passengerId);
      console.log("Service Type:", serviceType);
      console.log("Payment Method (resolved):", resolvedPaymentMethod);
      console.log("Estimated Fare (naira):", estimatedFare);

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

      // ── LOYALTY ELIGIBILITY CHECK ────────────────────────────────────────
      // Check BEFORE searching for drivers so we can set isFreeRide + lock in
      // the driver payout amount at the moment of request.
      let isFreeRide = false;
      let loyaltyProgressId = null;
      let freeRideDriverPayoutNaira = 0;
      let finalPaymentMethod = resolvedPaymentMethod;

      try {
        const { eligible, progress } =
          await LoyaltyProgress.checkEligibility(passengerId);

        if (eligible) {
          isFreeRide = true;
          loyaltyProgressId = progress._id;

          // ✅ BUG 3 FIX: cap the driver payout at FREE_RIDE_MAX_PAYOUT_NAIRA (₦5,000).
          // Before this fix, freeRideDriverPayoutNaira was set directly to
          // estimatedFare with no ceiling, meaning a ₦20,000 luxury ride would
          // cost the platform ₦20,000 per free ride redemption.
          // Now the platform never pays more than ₦5,000 regardless of trip fare.
          const rawFare = estimatedFare || 0;
          freeRideDriverPayoutNaira = Math.min(
            rawFare,
            LoyaltyProgress.FREE_RIDE_MAX_PAYOUT_NAIRA, // 5000
          );

          finalPaymentMethod = "free_ride";

          console.log(`🎁 Passenger ${passengerId} has a FREE RIDE available!`);
          console.log(
            `   Raw fare: ₦${rawFare} | Capped payout: ₦${freeRideDriverPayoutNaira} | ` +
              `Cap limit: ₦${LoyaltyProgress.FREE_RIDE_MAX_PAYOUT_NAIRA}`,
          );

          // Warn in logs if the fare was capped so ops team can see it
          if (rawFare > LoyaltyProgress.FREE_RIDE_MAX_PAYOUT_NAIRA) {
            console.warn(
              `⚠️  Free ride fare ₦${rawFare} exceeds cap. ` +
                `Driver will receive ₦${freeRideDriverPayoutNaira} (not ₦${rawFare}).`,
            );
          }
        }
      } catch (loyaltyErr) {
        // Non-fatal — if loyalty check fails, proceed as normal paid trip
        console.warn(
          `⚠️ Loyalty check failed (non-fatal): ${loyaltyErr.message}`,
        );
      }
      // ────────────────────────────────────────────────────────────────────

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
        if (!supportsService) continue;
        candidates.push({
          driverId: driver._id,
          status: "pending",
          driverName: driver.name,
          offeredAt: null,
          rejectedAt: null,
          rejectionReason: null,
        });
      }

      console.log(`✅ ${candidates.length} drivers qualified`);

      // ── Build shared trip request fields ──────────────────────────────────
      const tripRequestBase = {
        passengerId,
        pickup,
        dropoff,
        serviceType,
        paymentMethod: finalPaymentMethod,
        estimatedFare: estimatedFare || 0,
        distance: distance || 0,
        duration: duration || 0,
        pickupAddress: pickupAddress || "",
        dropoffAddress: dropoffAddress || "",
        // Loyalty fields
        isFreeRide,
        loyaltyProgressId,
        freeRideDriverPayoutNaira, // ✅ now capped at ₦5,000
      };

      let tripRequest;

      if (candidates.length === 0) {
        tripRequest = await TripRequest.create(
          [
            {
              ...tripRequestBase,
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

      tripRequest = await TripRequest.create(
        [
          {
            ...tripRequestBase,
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
        message: isFreeRide
          ? `🎁 Free ride! Searching ${candidates.length} drivers`
          : `Searching ${candidates.length} drivers`,
        estimatedFare: estimatedFare || 0,
        // Tell the frontend it's a free ride so it can show the banner
        isFreeRide,
        loyalty: isFreeRide
          ? {
              isFreeRide: true,
              passengerPays: 0,
              driverEarns: freeRideDriverPayoutNaira,
              // ✅ also tell the frontend if the fare was capped
              fareCapped:
                (estimatedFare || 0) >
                LoyaltyProgress.FREE_RIDE_MAX_PAYOUT_NAIRA,
              capLimit: LoyaltyProgress.FREE_RIDE_MAX_PAYOUT_NAIRA,
            }
          : null,
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
        paymentMethod: finalPaymentMethod,
        isFreeRide,
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
          data: { requestId: createdRequestId, ...candidateData },
        });
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
    const tripRequest = await TripRequest.findById(requestId);
    if (!tripRequest || tripRequest.status !== "searching") return;

    const shouldCleanup = await trackRejection(requestId);
    if (shouldCleanup) return;

    const nextCandidate = tripRequest.candidates.find(
      (c) => c.status === "pending" && !c.rejectedAt,
    );

    if (!nextCandidate) {
      await cleanupFailedTripRequest(requestId);
      return;
    }

    nextCandidate.status = "offered";
    nextCandidate.offeredAt = new Date();
    await tripRequest.save();

    const driverId = nextCandidate.driverId;

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
          isFreeRide: tripRequest.isFreeRide || false,
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

      // ── Create Trip — carry loyalty fields from TripRequest ───────────────
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
            // ✅ Loyalty fields — copied from TripRequest
            isFreeLoyaltyRide: tripRequest.isFreeRide || false,
            loyaltyTripNumberAtBooking: null, // filled on complete
            metadata: {
              subscriptionId: req.subscription.id,
              subscriptionExpiresAt: req.subscription.expiresAt,
              vehicleType: req.subscription.vehicleType,
              // Store loyalty payout amount (already capped at ₦5,000 from request)
              // so the complete handler uses the locked-in value
              freeRideDriverPayoutNaira:
                tripRequest.freeRideDriverPayoutNaira || 0,
              loyaltyProgressId: tripRequest.loyaltyProgressId || null,
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
        isFreeRide: tripRequest.isFreeRide || false,
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
        isFreeRide: tripRequest.isFreeRide || false,
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
        res.status(statusCode).json({
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
        "_id serviceType pickup dropoff estimatedFare candidates status createdAt expiresAt isFreeRide",
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
// POST /trips/:tripId/complete
// ==========================================
//
// UNIT CONVENTION:
//   Trip.estimatedFare  → stored in NAIRA  (frontend sends naira)
//   Wallet.balance      → stored in KOBO   (Paystack convention)
//   All payment service functions receive fareNaira and convert internally
//
// LOYALTY FLOW:
//   free_ride  → processFreeRideLoyaltyPayment (system pays driver, capped at ₦5,000)
//              → LoyaltyProgress.recordCompletedTrip (isFreeLoyaltyRide=true)
//              → trip counter resets to 0, lifetime stats updated
//   paid trip  → normal wallet/cash flow
//              → LoyaltyProgress.recordCompletedTrip (isFreeLoyaltyRide=false)
//              → tripCount++, possibly unlocks next free ride
// ==========================================
router.post("/:tripId/complete", requireAuth, async (req, res, next) => {
  const session = await mongoose.startSession();

  try {
    await session.withTransaction(async () => {
      const driverId = req.user.sub;
      const tripId = req.params.tripId;

      console.log(`✅ Completing trip ${tripId} — driver ${driverId}`);

      // ── 1. Load trip ──────────────────────────────────────────────────────
      const existingTrip = await Trip.findById(tripId).session(session);
      if (!existingTrip) throw new Error("Trip not found");

      if (existingTrip.driverId.toString() !== driverId) {
        throw new Error("Unauthorized: You are not the driver for this trip");
      }
      if (["completed", "cancelled"].includes(existingTrip.status)) {
        throw new Error(`Trip is already ${existingTrip.status}`);
      }

      const fareNaira = existingTrip.estimatedFare || 0;
      const paymentMethod = existingTrip.paymentMethod || "cash";
      const isFreeLoyaltyRide = existingTrip.isFreeLoyaltyRide || false;

      const passengerObjectId = existingTrip.passengerId;
      const passengerIdStr = passengerObjectId.toString();

      console.log(
        `💰 Fare: ₦${fareNaira} | Payment: ${paymentMethod} | FreeLoyaltyRide: ${isFreeLoyaltyRide}`,
      );

      // ── 2. Process payment ────────────────────────────────────────────────
      let paymentResult = null;
      let resolvedPaymentMethod = paymentMethod;

      if (isFreeLoyaltyRide || paymentMethod === "free_ride") {
        // ── FREE RIDE: driver credited directly by platform ─────────────────
        // Use the payout locked in at request time (already capped at ₦5,000)
        const driverPayoutNaira =
          existingTrip.metadata?.freeRideDriverPayoutNaira || fareNaira;

        console.log(`🎁 Free ride — locked payout: ₦${driverPayoutNaira}`);

        try {
          paymentResult = await processFreeRideLoyaltyPayment(
            {
              tripId,
              passengerId: passengerIdStr,
              driverId,
              fareNaira: driverPayoutNaira,
              serviceType: existingTrip.serviceType,
            },
            session,
          );
          resolvedPaymentMethod = "free_ride";
          console.log(
            `🎁 Free ride payout complete: ₦${driverPayoutNaira} credited to driver`,
          );
        } catch (freeRideErr) {
          // Unexpected error — flag for manual review
          console.error(
            `🚨 Free ride driver payout FAILED: ${freeRideErr.message}`,
          );
          resolvedPaymentMethod = "free_ride_pending";
          paymentResult = null;
          existingTrip.completionNotes =
            `FREE RIDE DRIVER PAYOUT FAILED: ${freeRideErr.message}. ` +
            `Manual credit of ₦${driverPayoutNaira} required for driver ${driverId}.`;
        }
      } else if (paymentMethod === "wallet") {
        // ── WALLET PAYMENT ────────────────────────────────────────────────
        try {
          paymentResult = await processTripWalletPayment(
            {
              tripId,
              passengerId: passengerIdStr,
              driverId,
              fareNaira,
              serviceType: existingTrip.serviceType,
            },
            session,
          );
          console.log(`✅ Wallet payment processed — ₦${fareNaira}`);
        } catch (paymentErr) {
          console.warn(
            `⚠️ Wallet payment failed (${paymentErr.message}). Falling back to cash.`,
          );
          resolvedPaymentMethod = "cash_fallback";
          paymentResult = null;
        }
      } else {
        // ── CASH PAYMENT ──────────────────────────────────────────────────
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
          console.log(
            `💵 Cash earning recorded (stats only) for driver ${driverId}`,
          );
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
          loyaltyDriverCreditProcessed:
            isFreeLoyaltyRide && resolvedPaymentMethod === "free_ride",
          loyaltyDriverCreditTxnId: paymentResult?.driverTxn?._id || null,
          ...(existingTrip.completionNotes && {
            completionNotes: existingTrip.completionNotes,
          }),
          ...(paymentResult?.passengerTxn && {
            "metadata.passengerTransactionId": paymentResult.passengerTxn._id,
          }),
          ...(paymentResult?.driverTxn && {
            "metadata.driverTransactionId": paymentResult.driverTxn._id,
          }),
        },
        { new: true, session },
      );

      // ── 4. Update driver availability ─────────────────────────────────────
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

      // ── 5. LOYALTY PROGRESS UPDATE ────────────────────────────────────────
      let loyaltyResult = null;
      try {
        loyaltyResult = await LoyaltyProgress.recordCompletedTrip(
          passengerObjectId,
          tripId,
          fareNaira,
          isFreeLoyaltyRide,
          session,
        );

        console.log(
          `🏆 Loyalty updated for ${passengerIdStr}: ` +
            `tripCount=${loyaltyResult.progress.tripCount} | ` +
            `justUnlocked=${loyaltyResult.justUnlocked} | ` +
            `freeRideRedeemed=${loyaltyResult.freeRideRedeemed}`,
        );

        await Trip.findByIdAndUpdate(
          tripId,
          { loyaltyTripNumberAtBooking: loyaltyResult.progress.tripCount },
          { session },
        );
      } catch (loyaltyErr) {
        console.error(
          `⚠️ Loyalty update failed (non-fatal): ${loyaltyErr.message}`,
        );
      }

      // ── 6. Check for pending referral ─────────────────────────────────────
      const pendingReferral = await mongoose
        .model("Referral")
        .findOne({ refereeId: passengerObjectId, status: "pending" })
        .session(session);

      const shouldTriggerReferral = !!pendingReferral;

      // ── 7. Build driver wallet info ───────────────────────────────────────
      const driverNewBalance = paymentResult?.driverWallet?.balance ?? null;

      // ── 8. Determine notification messages ───────────────────────────────
      let passengerNote, driverNote;

      if (resolvedPaymentMethod === "free_ride") {
        passengerNote = `🎁 This was your Kilometre Club free ride! No charge.`;
        driverNote = `🎁 Kilometre Club ride! ₦${(existingTrip.metadata?.freeRideDriverPayoutNaira || fareNaira).toLocaleString()} has been credited to your wallet by the platform.`;
      } else if (resolvedPaymentMethod === "free_ride_pending") {
        passengerNote = `🎁 This was your free ride! No charge.`;
        driverNote = `🎁 Free ride completed. Your payout is pending — our team will credit you shortly.`;
      } else if (resolvedPaymentMethod === "wallet") {
        passengerNote = `₦${fareNaira.toLocaleString()} was deducted from your wallet.`;
        driverNote = `₦${fareNaira.toLocaleString()} has been credited to your wallet.`;
      } else if (resolvedPaymentMethod === "cash_fallback") {
        passengerNote = `Wallet payment failed — please pay the driver ₦${fareNaira.toLocaleString()} in cash.`;
        driverNote = `Wallet payment failed — please collect ₦${fareNaira.toLocaleString()} in cash from the passenger.`;
      } else {
        passengerNote = `Please pay the driver ₦${fareNaira.toLocaleString()} in cash.`;
        driverNote = `Collect ₦${fareNaira.toLocaleString()} in cash from the passenger.`;
      }

      // ── 9. HTTP response ──────────────────────────────────────────────────
      res.json({
        success: true,
        trip: {
          id: updatedTrip._id.toString(),
          status: updatedTrip.status,
          finalFare: updatedTrip.finalFare,
          completedAt: updatedTrip.completedAt,
          paymentMethod: resolvedPaymentMethod,
          isFreeLoyaltyRide,
        },
        payment: {
          method: resolvedPaymentMethod,
          isWallet: resolvedPaymentMethod === "wallet",
          isCash: resolvedPaymentMethod === "cash",
          isFallback: resolvedPaymentMethod === "cash_fallback",
          isFreeRide:
            resolvedPaymentMethod === "free_ride" ||
            resolvedPaymentMethod === "free_ride_pending",
          fareNaira,
          fareFormatted: `₦${fareNaira.toLocaleString()}`,
          driverMessage: driverNote,
          driverWallet:
            driverNewBalance !== null
              ? {
                  balance: driverNewBalance,
                  balanceNaira: (driverNewBalance / 100).toFixed(2),
                  balanceFormatted: `₦${(driverNewBalance / 100).toLocaleString()}`,
                }
              : null,
        },
        loyalty: loyaltyResult
          ? {
              tripCount: loyaltyResult.progress.tripCount,
              tripsRequired: LoyaltyProgress.TRIPS_REQUIRED,
              freeRideAvailable: loyaltyResult.progress.freeRideAvailable,
              justUnlocked: loyaltyResult.justUnlocked,
              freeRideRedeemed: loyaltyResult.freeRideRedeemed,
              freeRideExpiresAt: loyaltyResult.progress.freeRideExpiresAt,
              totalFreeRidesEarned: loyaltyResult.progress.totalFreeRidesEarned,
            }
          : null,
        message: "Trip completed successfully.",
      });

      // ── 10. Post-commit side effects ──────────────────────────────────────
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
            title: isFreeLoyaltyRide
              ? "🎁 Free Ride Complete!"
              : "Trip Completed",
            body: `Your trip is done. Fare: ₦${fareNaira.toLocaleString()}. ${passengerNote}`,
            data: {
              tripId,
              fare: fareNaira,
              status: "completed",
              paymentMethod: resolvedPaymentMethod,
              isFreeLoyaltyRide,
            },
          });

          if (loyaltyResult?.justUnlocked) {
            emitter.emit("notification", {
              userId: passengerIdStr,
              type: "loyalty_free_ride_unlocked",
              title: "🏆 Free Ride Unlocked!",
              body: `You've completed ${LoyaltyProgress.TRIPS_REQUIRED} rides with The Kilometre Club. Your next ride is FREE! Expires in ${LoyaltyProgress.FREE_RIDE_EXPIRY_DAYS} days.`,
              data: {
                type: "loyalty_free_ride_unlocked",
                tripCount: loyaltyResult.progress.tripCount,
                freeRideExpiresAt: loyaltyResult.progress.freeRideExpiresAt,
                programme: "kilometre_club",
              },
            });
            console.log(
              `🏆 Free ride unlock notification sent to ${passengerIdStr}`,
            );
          }

          emitter.emit("notification", {
            userId: driverId,
            type: "trip_completed",
            title: isFreeLoyaltyRide
              ? "🎁 Kilometre Club Ride Earned!"
              : "Trip Completed",
            body: `You earned ₦${fareNaira.toLocaleString()}. ${driverNote}`,
            data: {
              tripId,
              earned: fareNaira,
              status: "completed",
              paymentMethod: resolvedPaymentMethod,
              driverMessage: driverNote,
              isWalletPayment: resolvedPaymentMethod === "wallet",
              isLoyaltyRide: isFreeLoyaltyRide,
            },
          });

          emitter.emit("trip_completed", {
            tripId,
            driverId,
            passengerId: passengerIdStr,
            finalFare: fareNaira,
            completedAt: new Date(),
            isFreeLoyaltyRide,
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

    res.status(statusCode).json({
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

    // If a free ride is cancelled, we do NOT count it against the loyalty
    // counter and we do NOT consume the free ride entitlement — it stays available.
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
// GET /trips/loyalty — passenger's loyalty status
// ==========================================
router.get("/loyalty", requireAuth, async (req, res, next) => {
  try {
    const passengerId = req.user.sub;
    const { eligible, progress } =
      await LoyaltyProgress.checkEligibility(passengerId);

    if (!progress) {
      return res.json({
        success: true,
        loyalty: {
          tripCount: 0,
          tripsRequired: LoyaltyProgress.TRIPS_REQUIRED,
          tripsUntilFreeRide: LoyaltyProgress.TRIPS_REQUIRED,
          progressPercent: 0,
          freeRideAvailable: false,
          freeRideStillValid: false,
          freeRideExpiresAt: null,
          totalFreeRidesEarned: 0,
          totalFreeRideValueNaira: 0,
          programme: {
            name: "The Kilometre Club",
            tagline: "Ride 5, Get 1 Free — Every Time.",
            colour: "#7C3AED",
            expiryDays: LoyaltyProgress.FREE_RIDE_EXPIRY_DAYS,
            maxPayoutNaira: LoyaltyProgress.FREE_RIDE_MAX_PAYOUT_NAIRA,
          },
        },
      });
    }

    res.json({
      success: true,
      loyalty: {
        tripCount: progress.tripCount,
        tripsRequired: LoyaltyProgress.TRIPS_REQUIRED,
        tripsUntilFreeRide: progress.tripsUntilFreeRide,
        progressPercent: progress.progressPercent,
        freeRideAvailable: progress.freeRideAvailable,
        freeRideStillValid: progress.freeRideStillValid,
        freeRideUnlockedAt: progress.freeRideUnlockedAt,
        freeRideExpiresAt: progress.freeRideExpiresAt,
        lastTripCountedAt: progress.lastTripCountedAt,
        lastFreeRideRedeemedAt: progress.lastFreeRideRedeemedAt,
        totalFreeRidesEarned: progress.totalFreeRidesEarned,
        totalFreeRideValueNaira: progress.totalFreeRideValueNaira,
        programme: {
          name: "The Kilometre Club",
          tagline: "Ride 5, Get 1 Free — Every Time.",
          colour: "#7C3AED",
          expiryDays: LoyaltyProgress.FREE_RIDE_EXPIRY_DAYS,
          maxPayoutNaira: LoyaltyProgress.FREE_RIDE_MAX_PAYOUT_NAIRA,
        },
      },
    });
  } catch (err) {
    next(err);
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
        isFreeLoyaltyRide: trip.isFreeLoyaltyRide || false,
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
        freeRidesUsed: await Trip.countDocuments({
          ...filter,
          isFreeLoyaltyRide: true,
        }),
        totalSpent: trips
          .filter((t) => t.status === "completed" && !t.isFreeLoyaltyRide)
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

        // Sweep expired free ride entitlements
        try {
          const expiredCount = await LoyaltyProgress.expireStaleRewards();
          if (expiredCount > 0)
            console.log(`⏰ Expired ${expiredCount} stale loyalty free rides`);
        } catch (loyaltyCleanupErr) {
          console.error(
            "Loyalty cleanup error (non-fatal):",
            loyaltyCleanupErr.message,
          );
        }
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
