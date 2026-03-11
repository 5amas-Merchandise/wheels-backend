// routes/pricing.routes.js
//
// Endpoints:
//
//   POST /pricing/fare-estimate        — authenticated passenger
//     Receives pickup + dropoff coordinates, calls Google Directions server-side,
//     applies the DB pricing config, and returns authoritative fares for all
//     active service types plus the decoded route polyline.
//     The frontend displays these values and passes estimatedFare to /trips/request.
//
//   GET  /pricing/config               — authenticated (any role)
//     Returns the current pricing config for display purposes (admin dashboard,
//     driver app info screen, etc.). Does NOT include internal audit history.
//
//   PUT  /pricing/config               — admin only
//     Replaces the pricing config, bumps the version, and archives the previous
//     state in the history log. Validates every service entry before saving.
//
//   GET  /pricing/config/history       — admin only
//     Returns the last 20 config versions for audit/rollback review.
//
//   POST /pricing/config/rollback/:version — admin only
//     Rolls the config back to a specific historical version.
//
//   PUT  /pricing/surge                — admin only
//     Quick-update surge multipliers without touching the full config.
//     Useful for real-time demand management.
//
// MOUNT IN app.js / index.js:
//   const pricingRouter = require("./routes/pricing.routes");
//   app.use("/pricing", pricingRouter);
//
// ALSO: wire the fare re-verification into /trips/request
//   See the comment block at the bottom of this file for the code snippet
//   to add to your existing trips.routes.js.

const express = require("express");
const router = express.Router();
const rateLimit = require("express-rate-limit");
const { requireAuth } = require("../middleware/auth");
const PricingConfig = require("../models/Pricingconfig.model");

// ─────────────────────────────────────────────────────────────────────────────
// CONFIG
// ─────────────────────────────────────────────────────────────────────────────
const GOOGLE_API_KEY = process.env.GOOGLE_MAPS_API_KEY;

// Maximum allowed deviation between client-sent estimatedFare and the
// server-recalculated fare before the trip request is rejected.
// e.g. 0.15 = allow ±15% tolerance to account for timing differences.
const FARE_TOLERANCE_PERCENT = 0.15;

// ─────────────────────────────────────────────────────────────────────────────
// RATE LIMITING
// ─────────────────────────────────────────────────────────────────────────────
const fareEstimateLimiter = rateLimit({
  windowMs: 60 * 1000,        // 1 minute window
  max: 30,                     // max 30 fare estimates per minute per IP
  message: {
    error: { message: "Too many fare estimate requests. Please slow down." },
  },
  standardHeaders: true,
  legacyHeaders: false,
});

const adminLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  message: { error: { message: "Too many admin requests." } },
});

// ─────────────────────────────────────────────────────────────────────────────
// MIDDLEWARE
// ─────────────────────────────────────────────────────────────────────────────
const requireAdmin = (req, res, next) => {
  if (req.user?.roles?.isAdmin) return next();
  return res.status(403).json({ error: { message: "Admin access required" } });
};

// ─────────────────────────────────────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Call the Google Directions API from the server side.
 * Returns { distanceKm, durationSeconds, polyline } or throws on failure.
 *
 * @param {number} originLat
 * @param {number} originLng
 * @param {number} destLat
 * @param {number} destLng
 * @returns {Promise<{ distanceKm: number, durationSeconds: number, polyline: Array<{latitude,longitude}> }>}
 */
async function fetchGoogleDirections(originLat, originLng, destLat, destLng) {
  const url =
    `https://maps.googleapis.com/maps/api/directions/json` +
    `?origin=${originLat},${originLng}` +
    `&destination=${destLat},${destLng}` +
    `&key=${GOOGLE_API_KEY}` +
    `&mode=driving`;

  const res = await fetch(url);
  if (!res.ok) {
    throw new Error(`Google Directions HTTP error: ${res.status}`);
  }

  const data = await res.json();

  if (data.status === "ZERO_RESULTS") {
    throw new Error("No route found between the selected locations");
  }
  if (data.status !== "OK" || !data.routes?.length) {
    throw new Error(`Google Directions error: ${data.status}`);
  }

  const route = data.routes[0];
  const leg = route.legs[0];

  return {
    distanceKm: leg.distance.value / 1000,           // metres → km
    durationSeconds: leg.duration.value,              // seconds
    polyline: decodePolyline(route.overview_polyline.points),
  };
}

/**
 * Google encoded polyline decoder.
 * Returns an array of { latitude, longitude } objects.
 */
function decodePolyline(encoded) {
  const pts = [];
  let i = 0, lat = 0, lng = 0;
  while (i < encoded.length) {
    let b, s = 0, r = 0;
    do {
      b = encoded.charCodeAt(i++) - 63;
      r |= (b & 0x1f) << s;
      s += 5;
    } while (b >= 0x20);
    lat += r & 1 ? ~(r >> 1) : r >> 1;
    s = 0; r = 0;
    do {
      b = encoded.charCodeAt(i++) - 63;
      r |= (b & 0x1f) << s;
      s += 5;
    } while (b >= 0x20);
    lng += r & 1 ? ~(r >> 1) : r >> 1;
    pts.push({ latitude: lat / 1e5, longitude: lng / 1e5 });
  }
  return pts;
}

/**
 * Validate that a coordinates object is a GeoJSON-style pair:
 * { coordinates: [longitude, latitude] }
 */
function validateCoordsPayload(obj, fieldName) {
  if (!obj || !Array.isArray(obj.coordinates) || obj.coordinates.length < 2) {
    throw new Error(`${fieldName}.coordinates must be [longitude, latitude]`);
  }
  const [lng, lat] = obj.coordinates;
  if (
    typeof lat !== "number" || typeof lng !== "number" ||
    lat < -90 || lat > 90 ||
    lng < -180 || lng > 180
  ) {
    throw new Error(`${fieldName} has invalid coordinate values`);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// POST /pricing/fare-estimate
//
// Body: { pickup: { coordinates: [lng, lat] }, dropoff: { coordinates: [lng, lat] } }
//
// Response:
// {
//   fares: { CITY_RIDE: 1450, BIKE: 850, KEKE: 700, LUXURY_RENTAL: 3200 },
//   breakdowns: { CITY_RIDE: { baseFare, distanceCharge, ... }, ... },
//   route: { distanceKm, durationSeconds, durationMinutes, polyline },
//   config: { version, surgeActive: false }
// }
// ─────────────────────────────────────────────────────────────────────────────
router.post(
  "/fare-estimate",
  requireAuth,
  fareEstimateLimiter,
  async (req, res, next) => {
    try {
      const { pickup, dropoff } = req.body;

      // ── Validate inputs ────────────────────────────────────────────────────
      validateCoordsPayload(pickup, "pickup");
      validateCoordsPayload(dropoff, "dropoff");

      const [pickupLng, pickupLat] = pickup.coordinates;
      const [dropoffLng, dropoffLat] = dropoff.coordinates;

      // Sanity: pickup and dropoff must not be identical
      if (pickupLat === dropoffLat && pickupLng === dropoffLng) {
        return res.status(400).json({
          error: { message: "Pickup and dropoff cannot be the same location" },
        });
      }

      // ── Check pricing system is active ─────────────────────────────────────
      const pricingConfig = await PricingConfig.getActive();
      if (!pricingConfig.pricingActive) {
        return res.status(503).json({
          error: {
            message: "Pricing is temporarily unavailable. Please try again shortly.",
            code: "PRICING_INACTIVE",
          },
        });
      }

      // ── Call Google Directions server-side ─────────────────────────────────
      let routeData;
      try {
        routeData = await fetchGoogleDirections(
          pickupLat, pickupLng,
          dropoffLat, dropoffLng,
        );
      } catch (googleErr) {
        console.error("❌ Google Directions error:", googleErr.message);
        return res.status(502).json({
          error: {
            message: googleErr.message || "Could not calculate route. Please try again.",
            code: "ROUTE_UNAVAILABLE",
          },
        });
      }

      const { distanceKm, durationSeconds, polyline } = routeData;
      const durationMinutes = durationSeconds / 60;

      console.log(
        `📍 Fare estimate: ${distanceKm.toFixed(2)} km | ` +
        `${Math.round(durationMinutes)} min | ` +
        `passenger: ${req.user.sub}`,
      );

      // ── Calculate fares for all active service types ────────────────────────
      const { fares, breakdowns } = pricingConfig.calculateAllFares(
        distanceKm,
        durationMinutes,
      );

      if (Object.keys(fares).length === 0) {
        return res.status(503).json({
          error: {
            message: "No ride types are currently available",
            code: "NO_SERVICES_AVAILABLE",
          },
        });
      }

      // ── Check for any active surge to inform the frontend ──────────────────
      const anySurgeActive =
        pricingConfig.globalSurgeActive ||
        pricingConfig.services.some((s) => s.surgeActive && s.isActive);

      res.json({
        success: true,
        fares,          // { CITY_RIDE: 1450, BIKE: 850, ... }
        breakdowns,     // detailed per-service breakdown (useful for receipts)
        route: {
          distanceKm: parseFloat(distanceKm.toFixed(2)),
          durationSeconds,
          durationMinutes: parseFloat(durationMinutes.toFixed(1)),
          polyline,     // decoded array of { latitude, longitude } objects
        },
        config: {
          version: pricingConfig.version,
          surgeActive: anySurgeActive,
        },
      });
    } catch (err) {
      console.error("❌ Fare estimate error:", err.message);
      if (err.message.includes("invalid") || err.message.includes("cannot be")) {
        return res.status(400).json({ error: { message: err.message } });
      }
      next(err);
    }
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// GET /pricing/config
// Returns the current pricing config (sanitised — no history).
// Accessible by any authenticated user (drivers, passengers, admins).
// ─────────────────────────────────────────────────────────────────────────────
router.get("/config", requireAuth, async (req, res, next) => {
  try {
    const config = await PricingConfig.getActive();

    res.json({
      success: true,
      config: {
        version: config.version,
        updatedAt: config.updatedAt,
        updatedBy: config.updatedBy,
        changeNote: config.changeNote,
        pricingActive: config.pricingActive,
        globalSurgeActive: config.globalSurgeActive,
        services: config.services.map((s) => ({
          serviceType: s.serviceType,
          displayName: s.displayName,
          baseFare: s.baseFare,
          perKmRate: s.perKmRate,
          perMinRate: s.perMinRate,
          multiplier: s.multiplier,
          minimumFare: s.minimumFare,
          surgeMultiplier: s.surgeMultiplier,
          surgeActive: s.surgeActive,
          surgeReason: s.surgeReason,
          isActive: s.isActive,
        })),
      },
    });
  } catch (err) {
    next(err);
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// PUT /pricing/config
// Admin-only: replace the pricing config with validated new values.
//
// Body (all fields optional — only provided fields are updated):
// {
//   "services": [
//     {
//       "serviceType": "CITY_RIDE",
//       "baseFare": 600,
//       "perKmRate": 180,
//       "perMinRate": 0,
//       "multiplier": 1.6,
//       "minimumFare": 600,
//       "isActive": true
//     },
//     ...
//   ],
//   "globalSurgeActive": false,
//   "pricingActive": true,
//   "changeNote": "Increased base fare due to fuel costs"
// }
// ─────────────────────────────────────────────────────────────────────────────
router.put(
  "/config",
  requireAuth,
  requireAdmin,
  adminLimiter,
  async (req, res, next) => {
    try {
      const {
        services,
        globalSurgeActive,
        pricingActive,
        changeNote,
      } = req.body;

      const adminUserId = req.user.sub;
      const updates = {};

      // ── Validate and build services update ─────────────────────────────────
      if (services !== undefined) {
        if (!Array.isArray(services) || services.length === 0) {
          return res.status(400).json({
            error: { message: "services must be a non-empty array" },
          });
        }

        const VALID_TYPES = ["CITY_RIDE", "BIKE", "KEKE", "LUXURY_RENTAL"];
        const seenTypes = new Set();
        const validatedServices = [];

        for (const svc of services) {
          // Required fields
          if (!svc.serviceType || !VALID_TYPES.includes(svc.serviceType)) {
            return res.status(400).json({
              error: {
                message: `Invalid serviceType: "${svc.serviceType}". Must be one of: ${VALID_TYPES.join(", ")}`,
              },
            });
          }
          if (seenTypes.has(svc.serviceType)) {
            return res.status(400).json({
              error: { message: `Duplicate serviceType: "${svc.serviceType}"` },
            });
          }
          seenTypes.add(svc.serviceType);

          // Numeric validation helpers
          const requirePositiveNumber = (val, name) => {
            if (val !== undefined && (typeof val !== "number" || val < 0)) {
              throw new Error(`${name} must be a non-negative number`);
            }
          };
          const requireMinNumber = (val, name, min) => {
            if (val !== undefined && (typeof val !== "number" || val < min)) {
              throw new Error(`${name} must be >= ${min}`);
            }
          };

          try {
            requirePositiveNumber(svc.baseFare, "baseFare");
            requirePositiveNumber(svc.perKmRate, "perKmRate");
            requirePositiveNumber(svc.perMinRate, "perMinRate");
            requireMinNumber(svc.multiplier, "multiplier", 0.1);
            requirePositiveNumber(svc.minimumFare, "minimumFare");
            requireMinNumber(svc.surgeMultiplier, "surgeMultiplier", 1.0);
            if (
              svc.surgeMultiplier !== undefined &&
              svc.surgeMultiplier > 5.0
            ) {
              throw new Error("surgeMultiplier cannot exceed 5.0");
            }
          } catch (validationErr) {
            return res.status(400).json({
              error: {
                message: `Validation error for ${svc.serviceType}: ${validationErr.message}`,
              },
            });
          }

          validatedServices.push(svc);
        }

        // If a partial update was sent (not all 4 types), merge with existing
        if (validatedServices.length < 4) {
          const existing = await PricingConfig.getActive();
          const existingMap = {};
          for (const s of existing.services) {
            existingMap[s.serviceType] = s.toObject ? s.toObject() : { ...s };
          }
          for (const s of validatedServices) {
            existingMap[s.serviceType] = {
              ...existingMap[s.serviceType],
              ...s,
            };
          }
          updates.services = Object.values(existingMap);
        } else {
          updates.services = validatedServices;
        }
      }

      // ── Boolean flags ───────────────────────────────────────────────────────
      if (globalSurgeActive !== undefined) {
        if (typeof globalSurgeActive !== "boolean") {
          return res.status(400).json({
            error: { message: "globalSurgeActive must be a boolean" },
          });
        }
        updates.globalSurgeActive = globalSurgeActive;
      }

      if (pricingActive !== undefined) {
        if (typeof pricingActive !== "boolean") {
          return res.status(400).json({
            error: { message: "pricingActive must be a boolean" },
          });
        }
        updates.pricingActive = pricingActive;
      }

      if (Object.keys(updates).length === 0) {
        return res.status(400).json({
          error: { message: "No valid fields provided for update" },
        });
      }

      const updatedConfig = await PricingConfig.applyUpdate(
        updates,
        adminUserId,
        changeNote || null,
      );

      console.log(
        `⚙️  Pricing config updated by ${adminUserId} — ` +
        `version ${updatedConfig.version} | ${changeNote || "no note"}`,
      );

      res.json({
        success: true,
        message: `Pricing config updated to version ${updatedConfig.version}`,
        config: {
          version: updatedConfig.version,
          updatedAt: updatedConfig.updatedAt,
          updatedBy: updatedConfig.updatedBy,
          changeNote: updatedConfig.changeNote,
          pricingActive: updatedConfig.pricingActive,
          globalSurgeActive: updatedConfig.globalSurgeActive,
          services: updatedConfig.services.map((s) => ({
            serviceType: s.serviceType,
            displayName: s.displayName,
            baseFare: s.baseFare,
            perKmRate: s.perKmRate,
            perMinRate: s.perMinRate,
            multiplier: s.multiplier,
            minimumFare: s.minimumFare,
            surgeMultiplier: s.surgeMultiplier,
            surgeActive: s.surgeActive,
            isActive: s.isActive,
          })),
        },
      });
    } catch (err) {
      console.error("❌ Config update error:", err.message);
      if (err.name === "ValidationError") {
        return res.status(400).json({
          error: { message: err.message, code: "VALIDATION_ERROR" },
        });
      }
      next(err);
    }
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// GET /pricing/config/history
// Admin-only: returns the last 20 archived config snapshots.
// ─────────────────────────────────────────────────────────────────────────────
router.get(
  "/config/history",
  requireAuth,
  requireAdmin,
  async (req, res, next) => {
    try {
      const config = await PricingConfig.getActive();
      res.json({
        success: true,
        currentVersion: config.version,
        history: config.history.map((h) => ({
          version: h.version,
          updatedBy: h.updatedBy,
          updatedAt: h.updatedAt,
          changeNote: h.changeNote,
          // Include service summaries (not full objects) for quick review
          serviceSummary: Array.isArray(h.snapshot)
            ? h.snapshot.map((s) => ({
                serviceType: s.serviceType,
                baseFare: s.baseFare,
                perKmRate: s.perKmRate,
                multiplier: s.multiplier,
                minimumFare: s.minimumFare,
                isActive: s.isActive,
              }))
            : [],
        })),
      });
    } catch (err) {
      next(err);
    }
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// POST /pricing/config/rollback/:version
// Admin-only: rolls the live config back to a specific archived version.
// ─────────────────────────────────────────────────────────────────────────────
router.post(
  "/config/rollback/:version",
  requireAuth,
  requireAdmin,
  adminLimiter,
  async (req, res, next) => {
    try {
      const targetVersion = parseInt(req.params.version, 10);
      if (isNaN(targetVersion) || targetVersion < 1) {
        return res.status(400).json({
          error: { message: "version must be a positive integer" },
        });
      }

      const config = await PricingConfig.getActive();
      const historicalEntry = config.history.find(
        (h) => h.version === targetVersion,
      );

      if (!historicalEntry) {
        return res.status(404).json({
          error: {
            message: `Version ${targetVersion} not found in history. Only the last 20 versions are retained.`,
          },
        });
      }

      const updatedConfig = await PricingConfig.applyUpdate(
        { services: historicalEntry.snapshot },
        req.user.sub,
        `Rollback to version ${targetVersion}`,
      );

      console.log(
        `⏪ Pricing config rolled back to v${targetVersion} by ${req.user.sub} ` +
        `— now v${updatedConfig.version}`,
      );

      res.json({
        success: true,
        message: `Config rolled back to version ${targetVersion}. Current version is now ${updatedConfig.version}.`,
        config: {
          version: updatedConfig.version,
          updatedAt: updatedConfig.updatedAt,
          services: updatedConfig.services,
        },
      });
    } catch (err) {
      next(err);
    }
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// PUT /pricing/surge
// Admin-only: quick-update surge settings without touching base pricing.
// Designed for real-time demand management.
//
// Body:
// {
//   "globalSurge": true,                     — optional: master on/off switch
//   "services": [                             — optional: per-service overrides
//     {
//       "serviceType": "CITY_RIDE",
//       "surgeMultiplier": 1.5,
//       "surgeActive": true,
//       "surgeReason": "High demand in Wuse"
//     }
//   ]
// }
// ─────────────────────────────────────────────────────────────────────────────
router.put(
  "/surge",
  requireAuth,
  requireAdmin,
  adminLimiter,
  async (req, res, next) => {
    try {
      const { globalSurge, services: surgeUpdates } = req.body;
      const adminUserId = req.user.sub;

      const config = await PricingConfig.getActive();
      const updates = {};
      const changeNotes = [];

      // Global surge switch
      if (globalSurge !== undefined) {
        if (typeof globalSurge !== "boolean") {
          return res.status(400).json({
            error: { message: "globalSurge must be a boolean" },
          });
        }
        updates.globalSurgeActive = globalSurge;
        changeNotes.push(`globalSurge → ${globalSurge}`);
      }

      // Per-service surge updates
      if (surgeUpdates && Array.isArray(surgeUpdates)) {
        const updatedServices = config.services.map((svc) => {
          const svcObj = svc.toObject ? svc.toObject() : { ...svc };
          const upd = surgeUpdates.find(
            (u) => u.serviceType === svc.serviceType,
          );
          if (!upd) return svcObj;

          if (upd.surgeMultiplier !== undefined) {
            if (
              typeof upd.surgeMultiplier !== "number" ||
              upd.surgeMultiplier < 1.0 ||
              upd.surgeMultiplier > 5.0
            ) {
              throw new Error(
                `surgeMultiplier for ${svc.serviceType} must be between 1.0 and 5.0`,
              );
            }
            svcObj.surgeMultiplier = upd.surgeMultiplier;
          }
          if (upd.surgeActive !== undefined) {
            svcObj.surgeActive = Boolean(upd.surgeActive);
          }
          if (upd.surgeReason !== undefined) {
            svcObj.surgeReason = upd.surgeReason || null;
          }

          changeNotes.push(
            `${svc.serviceType}: surge=${svcObj.surgeActive} × ${svcObj.surgeMultiplier}`,
          );
          return svcObj;
        });

        updates.services = updatedServices;
      }

      if (Object.keys(updates).length === 0) {
        return res.status(400).json({
          error: { message: "Provide globalSurge and/or services to update" },
        });
      }

      const updatedConfig = await PricingConfig.applyUpdate(
        updates,
        adminUserId,
        `Surge update: ${changeNotes.join(" | ")}`,
      );

      console.log(
        `⚡ Surge updated by ${adminUserId}: ${changeNotes.join(" | ")}`,
      );

      res.json({
        success: true,
        message: "Surge settings updated",
        globalSurgeActive: updatedConfig.globalSurgeActive,
        services: updatedConfig.services.map((s) => ({
          serviceType: s.serviceType,
          surgeMultiplier: s.surgeMultiplier,
          surgeActive: s.surgeActive,
          surgeReason: s.surgeReason,
        })),
      });
    } catch (err) {
      if (err.message.includes("must be between")) {
        return res.status(400).json({ error: { message: err.message } });
      }
      next(err);
    }
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// EXPORTED UTILITY: verifyFareForTripRequest
//
// Use this inside /trips/request (POST) to re-verify the fare the passenger
// claims against the server's own calculation, rejecting tampered fares.
//
// HOW TO USE — add this to the top section of your POST /trips/request handler
// in trips.routes.js, right after the coordinate validation:
//
//   const { verifyFareForTripRequest } = require("./pricing.routes");
//
//   const fareVerification = await verifyFareForTripRequest({
//     pickupCoordinates: pickup.coordinates,   // [lng, lat]
//     dropoffCoordinates: dropoff.coordinates, // [lng, lat]
//     serviceType,
//     clientFareNaira: estimatedFare,
//   });
//
//   if (!fareVerification.ok) {
//     throw new Error(fareVerification.reason);
//   }
//
//   // Use fareVerification.serverFare as the canonical fare for the trip
//   const canonicalFare = fareVerification.serverFare;
//
// The function returns:
// {
//   ok: boolean,
//   serverFare: number,         — always present (the correct fare)
//   clientFare: number,         — what the client sent
//   deviation: number,          — absolute deviation as a fraction (e.g. 0.08 = 8%)
//   reason: string | null,      — human-readable rejection reason when ok=false
//   distanceKm: number,
//   durationSeconds: number,
// }
// ─────────────────────────────────────────────────────────────────────────────
async function verifyFareForTripRequest({
  pickupCoordinates,
  dropoffCoordinates,
  serviceType,
  clientFareNaira,
}) {
  const [pickupLng, pickupLat] = pickupCoordinates;
  const [dropoffLng, dropoffLat] = dropoffCoordinates;

  let routeData;
  try {
    routeData = await fetchGoogleDirections(
      pickupLat, pickupLng,
      dropoffLat, dropoffLng,
    );
  } catch (e) {
    // If Google Directions fails, allow the trip to proceed with the client fare
    // rather than blocking it. Log a warning for ops visibility.
    console.warn(
      `⚠️  Fare verification skipped (Google Directions failed): ${e.message}`,
    );
    return {
      ok: true,
      serverFare: clientFareNaira,
      clientFare: clientFareNaira,
      deviation: 0,
      reason: null,
      distanceKm: null,
      durationSeconds: null,
      skipped: true,
    };
  }

  const pricingConfig = await PricingConfig.getActive();
  const { fare: serverFare } = pricingConfig.calculateFare(
    serviceType,
    routeData.distanceKm,
    routeData.durationSeconds / 60,
  );

  const deviation =
    clientFareNaira > 0
      ? Math.abs(serverFare - clientFareNaira) / serverFare
      : 1;

  const ok = deviation <= FARE_TOLERANCE_PERCENT;

  return {
    ok,
    serverFare,
    clientFare: clientFareNaira,
    deviation: parseFloat(deviation.toFixed(4)),
    reason: ok
      ? null
      : `Client fare ₦${clientFareNaira} deviates ${(deviation * 100).toFixed(1)}% ` +
        `from server fare ₦${serverFare} (max ${FARE_TOLERANCE_PERCENT * 100}%)`,
    distanceKm: routeData.distanceKm,
    durationSeconds: routeData.durationSeconds,
  };
}

module.exports = router;
module.exports.verifyFareForTripRequest = verifyFareForTripRequest;
module.exports.FARE_TOLERANCE_PERCENT = FARE_TOLERANCE_PERCENT;