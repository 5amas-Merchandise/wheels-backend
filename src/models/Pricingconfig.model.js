// models/pricingConfig.model.js
//
// Stores the authoritative pricing rules for every service type.
// The /pricing/fare-estimate endpoint reads from this collection to calculate
// fares. Admins update it via PUT /pricing/config.
//
// UNIT CONVENTION:
//   All monetary values stored in NAIRA (not kobo).
//   Wallet balances elsewhere in the app are kobo — this model is the exception
//   because fares are expressed in naira throughout the trip flow.
//
// FARE FORMULA (applied per service type):
//   fare = baseFare + (distanceKm * perKmRate * multiplier) + (durationMins * perMinRate)
//
//   • baseFare      — fixed flag-fall charge regardless of distance
//   • perKmRate     — naira per kilometre (before multiplier)
//   • multiplier    — service-level scalar (e.g. 2.5× for Luxury)
//   • perMinRate    — naira per minute of estimated journey time (can be 0)
//   • minimumFare   — floor; fare never goes below this value
//   • surgeMultiplier — runtime surge applied on top of everything (default 1.0)
//
// VERSIONING:
//   Each save increments `version` and records `updatedBy` + `updatedAt`.
//   A capped history array keeps the last 20 snapshots for audit purposes.

const mongoose = require("mongoose");

// ─────────────────────────────────────────────────────────────────────────────
// Sub-schema: one entry per service type
// ─────────────────────────────────────────────────────────────────────────────
const ServicePricingSchema = new mongoose.Schema(
  {
    // ── Identity ─────────────────────────────────────────────────────────────
    serviceType: {
      type: String,
      required: true,
      enum: ["CITY_RIDE", "BIKE", "KEKE", "LUXURY_RENTAL"],
      // No unique constraint here — uniqueness is enforced at the document level
      // because all service configs live inside a single PricingConfig document.
    },

    displayName: {
      type: String,
      required: true,
      trim: true,
      // e.g. "Ride", "Delivery Bike", "Keke", "Luxury"
    },

    // ── Fare components ───────────────────────────────────────────────────────
    baseFare: {
      type: Number,
      required: true,
      min: 0,
      // Flag-fall charge in naira. Applied once per trip regardless of distance.
      // Example: 300 → every trip starts at ₦300 before distance is added.
    },

    perKmRate: {
      type: Number,
      required: true,
      min: 0,
      // Naira per kilometre BEFORE the multiplier is applied.
      // Example: 120 → 10 km trip adds 120 × 10 = ₦1,200 (× multiplier).
    },

    perMinRate: {
      type: Number,
      default: 0,
      min: 0,
      // Naira per minute of estimated journey duration.
      // Set to 0 to use distance-only pricing (simpler, typical for Nigeria).
    },

    multiplier: {
      type: Number,
      required: true,
      min: 0.1,
      // Service-level scalar applied to the distance component only.
      // CITY_RIDE: 1.6 | BIKE: 1.0 | KEKE: 0.8 | LUXURY_RENTAL: 2.5
    },

    minimumFare: {
      type: Number,
      required: true,
      min: 0,
      // Hard floor in naira. Fare is never returned below this value.
      // Prevents near-zero fares on very short trips.
    },

    // ── Surge pricing ─────────────────────────────────────────────────────────
    surgeMultiplier: {
      type: Number,
      default: 1.0,
      min: 1.0,
      max: 5.0,
      // Applied on top of the normal fare formula.
      // 1.0 = no surge | 1.5 = 50% surge | 2.0 = double fare
      // Updated at runtime by surge management (not part of base config admin).
    },

    surgeActive: {
      type: Boolean,
      default: false,
    },

    surgeReason: {
      type: String,
      default: null,
      trim: true,
      // Human-readable reason shown to passengers during surge.
      // e.g. "High demand in your area"
    },

    // ── Availability ──────────────────────────────────────────────────────────
    isActive: {
      type: Boolean,
      default: true,
      // false = this service type is disabled; not shown to passengers.
    },
  },
  { _id: false }, // sub-schema, no separate _id needed
);

// ─────────────────────────────────────────────────────────────────────────────
// Sub-schema: audit history snapshot
// ─────────────────────────────────────────────────────────────────────────────
const HistoryEntrySchema = new mongoose.Schema(
  {
    version: Number,
    updatedBy: String,        // admin userId
    updatedAt: Date,
    changeNote: String,       // optional human note, e.g. "Increased LUXURY base fare"
    snapshot: mongoose.Schema.Types.Mixed, // full services array at that point
  },
  { _id: false },
);

// ─────────────────────────────────────────────────────────────────────────────
// Main schema: single-document design (singleton pattern)
// ─────────────────────────────────────────────────────────────────────────────
const PricingConfigSchema = new mongoose.Schema(
  {
    // ── Singleton guard ───────────────────────────────────────────────────────
    // Only one document should ever exist in this collection.
    // Enforced by a unique index on `singleton`.
    singleton: {
      type: String,
      default: "global",
      enum: ["global"],
      unique: true,
      // Do not expose or allow clients to set this field.
    },

    // ── Service configs ───────────────────────────────────────────────────────
    services: {
      type: [ServicePricingSchema],
      validate: {
        validator(arr) {
          // Every service type must appear exactly once
          const ids = arr.map((s) => s.serviceType);
          const uniqueIds = new Set(ids);
          return (
            uniqueIds.size === ids.length &&
            ["CITY_RIDE", "BIKE", "KEKE", "LUXURY_RENTAL"].every((t) =>
              uniqueIds.has(t),
            )
          );
        },
        message:
          "services must contain exactly one entry for each of: CITY_RIDE, BIKE, KEKE, LUXURY_RENTAL",
      },
    },

    // ── Versioning & audit ────────────────────────────────────────────────────
    version: {
      type: Number,
      default: 1,
    },

    updatedBy: {
      type: String,
      default: "system",
    },

    updatedAt: {
      type: Date,
      default: Date.now,
    },

    changeNote: {
      type: String,
      default: null,
      trim: true,
    },

    // Capped audit log — last 20 versions
    history: {
      type: [HistoryEntrySchema],
      default: [],
    },

    // ── Global pricing switches ───────────────────────────────────────────────
    globalSurgeActive: {
      type: Boolean,
      default: false,
      // Master switch: if true, surgeMultiplier on ALL services is applied
      // regardless of their individual surgeActive flag.
    },

    pricingActive: {
      type: Boolean,
      default: true,
      // Safety kill-switch. If false, fare-estimate returns an error and
      // new trip requests are blocked until re-enabled.
    },
  },
  {
    collection: "pricing_config",
    timestamps: false, // managed manually via updatedAt + version
  },
);

// ─────────────────────────────────────────────────────────────────────────────
// Indexes
// ─────────────────────────────────────────────────────────────────────────────
PricingConfigSchema.index({ singleton: 1 }, { unique: true });

// ─────────────────────────────────────────────────────────────────────────────
// Instance method: calculate fare for a given service type
//
// Usage:
//   const config = await PricingConfig.getActive();
//   const { fare, breakdown } = config.calculateFare("CITY_RIDE", 8.4, 18);
//
// Returns:
//   { fare: 1820, breakdown: { baseFare, distanceCharge, durationCharge,
//                              subtotal, surgeMultiplier, surgeActive,
//                              minimumFare, final } }
// ─────────────────────────────────────────────────────────────────────────────
PricingConfigSchema.methods.calculateFare = function (
  serviceType,
  distanceKm,
  durationMinutes = 0,
) {
  const svc = this.services.find((s) => s.serviceType === serviceType);
  if (!svc) {
    throw new Error(`Unknown serviceType: ${serviceType}`);
  }
  if (!svc.isActive) {
    throw new Error(`Service ${serviceType} is currently unavailable`);
  }

  const distanceCharge = distanceKm * svc.perKmRate * svc.multiplier;
  const durationCharge = durationMinutes * svc.perMinRate;
  const subtotal = svc.baseFare + distanceCharge + durationCharge;

  // Apply surge if this service has an active surge OR the global switch is on
  const effectiveSurge =
    svc.surgeActive || this.globalSurgeActive ? svc.surgeMultiplier : 1.0;
  const surged = subtotal * effectiveSurge;

  // Apply floor
  const final = Math.max(Math.round(surged), svc.minimumFare);

  return {
    fare: final,
    breakdown: {
      baseFare: svc.baseFare,
      distanceCharge: Math.round(distanceCharge),
      durationCharge: Math.round(durationCharge),
      subtotal: Math.round(subtotal),
      surgeMultiplier: effectiveSurge,
      surgeActive: svc.surgeActive || this.globalSurgeActive,
      surgeReason: svc.surgeReason || null,
      minimumFare: svc.minimumFare,
      final,
    },
  };
};

// ─────────────────────────────────────────────────────────────────────────────
// Instance method: calculate fares for ALL active service types at once
//
// Usage:
//   const config = await PricingConfig.getActive();
//   const allFares = config.calculateAllFares(8.4, 18);
//   // { CITY_RIDE: 1820, BIKE: 1050, KEKE: 890, LUXURY_RENTAL: 3400 }
// ─────────────────────────────────────────────────────────────────────────────
PricingConfigSchema.methods.calculateAllFares = function (
  distanceKm,
  durationMinutes = 0,
) {
  const result = {};
  const breakdowns = {};

  for (const svc of this.services) {
    if (!svc.isActive) continue;
    try {
      const { fare, breakdown } = this.calculateFare(
        svc.serviceType,
        distanceKm,
        durationMinutes,
      );
      result[svc.serviceType] = fare;
      breakdowns[svc.serviceType] = breakdown;
    } catch (e) {
      // Skip inactive or errored service types silently
    }
  }

  return { fares: result, breakdowns };
};

// ─────────────────────────────────────────────────────────────────────────────
// Static: get the active (singleton) config, creating it with defaults if
// it doesn't exist yet (safe for first-time deploys).
// ─────────────────────────────────────────────────────────────────────────────
PricingConfigSchema.statics.getActive = async function () {
  let config = await this.findOne({ singleton: "global" });
  if (!config) {
    console.log("⚙️  No pricing config found — seeding defaults…");
    config = await this.create(DEFAULT_PRICING_CONFIG);
    console.log("✅  Default pricing config seeded.");
  }
  return config;
};

// ─────────────────────────────────────────────────────────────────────────────
// Static: atomically update the config, bump version, and archive history
// ─────────────────────────────────────────────────────────────────────────────
PricingConfigSchema.statics.applyUpdate = async function (
  updates,
  adminUserId,
  changeNote,
) {
  const config = await this.getActive();

  // Archive current state before overwriting (keep last 20)
  const historyEntry = {
    version: config.version,
    updatedBy: config.updatedBy,
    updatedAt: config.updatedAt,
    changeNote: config.changeNote,
    snapshot: config.services.map((s) => s.toObject ? s.toObject() : s),
  };

  const trimmedHistory = [
    historyEntry,
    ...config.history.slice(0, 19), // keep 20 total
  ];

  // Apply allowed top-level field updates
  const ALLOWED_TOP_LEVEL = [
    "services",
    "globalSurgeActive",
    "pricingActive",
  ];

  for (const key of ALLOWED_TOP_LEVEL) {
    if (updates[key] !== undefined) {
      config[key] = updates[key];
    }
  }

  config.version += 1;
  config.updatedBy = adminUserId || "system";
  config.updatedAt = new Date();
  config.changeNote = changeNote || null;
  config.history = trimmedHistory;

  await config.save();
  return config;
};

// ─────────────────────────────────────────────────────────────────────────────
// DEFAULT SEED DATA
// Mirrors the original hardcoded frontend values exactly so existing
// behaviour is preserved on first deploy.
//
//   Old frontend formula: Math.round(500 + distanceKm * 150 * multiplier)
//   Mapped to this model:
//     baseFare   = 500  (the fixed 500)
//     perKmRate  = 150  (the 150 × multiplier)
//     perMinRate = 0    (time was not factored in)
//     multiplier = (original multiplier value)
//     minimumFare = baseFare (same as flag-fall)
// ─────────────────────────────────────────────────────────────────────────────
const DEFAULT_PRICING_CONFIG = {
  singleton: "global",
  version: 1,
  updatedBy: "system_seed",
  updatedAt: new Date(),
  changeNote: "Initial seed — mirrors original frontend hardcoded values",
  pricingActive: true,
  globalSurgeActive: false,
  services: [
    {
      serviceType: "CITY_RIDE",
      displayName: "Ride",
      baseFare: 500,
      perKmRate: 150,
      perMinRate: 0,
      multiplier: 1.6,
      minimumFare: 500,
      surgeMultiplier: 1.0,
      surgeActive: false,
      surgeReason: null,
      isActive: true,
    },
    {
      serviceType: "BIKE",
      displayName: "Delivery Bike",
      baseFare: 500,
      perKmRate: 150,
      perMinRate: 0,
      multiplier: 1.0,
      minimumFare: 300,
      surgeMultiplier: 1.0,
      surgeActive: false,
      surgeReason: null,
      isActive: true,
    },
    {
      serviceType: "KEKE",
      displayName: "Keke",
      baseFare: 500,
      perKmRate: 150,
      perMinRate: 0,
      multiplier: 0.8,
      minimumFare: 250,
      surgeMultiplier: 1.0,
      surgeActive: false,
      surgeReason: null,
      isActive: true,
    },
    {
      serviceType: "LUXURY_RENTAL",
      displayName: "Luxury",
      baseFare: 500,
      perKmRate: 150,
      perMinRate: 0,
      multiplier: 2.5,
      minimumFare: 1500,
      surgeMultiplier: 1.0,
      surgeActive: false,
      surgeReason: null,
      isActive: true,
    },
  ],
  history: [],
};

const PricingConfig = mongoose.model("PricingConfig", PricingConfigSchema);

module.exports = PricingConfig;