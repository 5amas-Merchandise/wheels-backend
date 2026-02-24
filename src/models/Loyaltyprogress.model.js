// models/loyaltyProgress.model.js
//
// ══════════════════════════════════════════════════════════════════════════════
//  THE KILOMETRE CLUB  🏆
//  "Every 5 rides, your next ride is completely FREE."
//
//  How it works:
//    1. Every time a passenger completes a paid trip, tripCount increments.
//    2. When tripCount reaches TRIPS_REQUIRED (5), freeRideAvailable flips true
//       and a freeRideExpiresAt deadline is set (e.g. 30 days to redeem).
//    3. On the next /trips/request, the backend detects freeRideAvailable=true
//       and flags the TripRequest as isFreeRide. The passenger pays nothing.
//    4. When that trip completes, the system credits the driver's wallet for
//       the full fare, tripCount resets to 0, freeRideAvailable resets to false,
//       and totalFreeRidesEarned increments.
//    5. The cycle starts again. ♻️
// ══════════════════════════════════════════════════════════════════════════════

const mongoose = require('mongoose');

// How many paid trips before a free ride is unlocked
const TRIPS_REQUIRED = 5;

// How many days the passenger has to redeem their free ride once unlocked
const FREE_RIDE_EXPIRY_DAYS = 30;

const LoyaltyProgressSchema = new mongoose.Schema({

  // ── Core identity ──────────────────────────────────────────────────────────
  passengerId: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    unique: true,   // one doc per passenger
    index: true
  },

  // ── Counter ────────────────────────────────────────────────────────────────
  // Number of PAID completed trips since the last free ride was redeemed (0–5)
  tripCount: {
    type: Number,
    default: 0,
    min: 0,
    max: TRIPS_REQUIRED
  },

  // ── Free-ride state ────────────────────────────────────────────────────────
  freeRideAvailable: {
    type: Boolean,
    default: false,
    index: true   // queried on every /trips/request
  },

  // Set when freeRideAvailable flips true; null otherwise
  freeRideUnlockedAt: {
    type: Date,
    default: null
  },

  // Passenger must redeem before this date or the free ride expires
  freeRideExpiresAt: {
    type: Date,
    default: null,
    index: true   // so a cron job can sweep expired free rides
  },

  // ── Lifetime stats ─────────────────────────────────────────────────────────
  totalFreeRidesEarned: {
    type: Number,
    default: 0
  },

  // Total value (in naira) of free rides the passenger has enjoyed
  totalFreeRideValueNaira: {
    type: Number,
    default: 0
  },

  // Last time a paid trip was counted toward the loyalty programme
  lastTripCountedAt: {
    type: Date,
    default: null
  },

  // Last time a free ride was redeemed
  lastFreeRideRedeemedAt: {
    type: Date,
    default: null
  },

  // ── Audit trail (last 20 events for debugging / support) ──────────────────
  recentEvents: {
    type: [
      {
        eventType: {
          type: String,
          enum: ['trip_counted', 'free_ride_unlocked', 'free_ride_redeemed', 'free_ride_expired', 'free_ride_granted_manually'],
        },
        tripId: { type: mongoose.Schema.Types.ObjectId, ref: 'Trip' },
        tripCountSnapshot: { type: Number },   // value of tripCount AFTER event
        fareNaira: { type: Number },
        occurredAt: { type: Date, default: Date.now },
        note: { type: String }
      }
    ],
    default: []
  }

}, {
  timestamps: true
});

// ── Constants exposed as statics ───────────────────────────────────────────
LoyaltyProgressSchema.statics.TRIPS_REQUIRED = TRIPS_REQUIRED;
LoyaltyProgressSchema.statics.FREE_RIDE_EXPIRY_DAYS = FREE_RIDE_EXPIRY_DAYS;

// ── Virtual: trips still needed until next free ride ──────────────────────
LoyaltyProgressSchema.virtual('tripsUntilFreeRide').get(function () {
  if (this.freeRideAvailable) return 0;
  return TRIPS_REQUIRED - this.tripCount;
});

// Virtual: progress percentage (0–100)
LoyaltyProgressSchema.virtual('progressPercent').get(function () {
  if (this.freeRideAvailable) return 100;
  return Math.round((this.tripCount / TRIPS_REQUIRED) * 100);
});

// Virtual: is the free ride still valid (not expired)?
LoyaltyProgressSchema.virtual('freeRideStillValid').get(function () {
  if (!this.freeRideAvailable) return false;
  if (!this.freeRideExpiresAt) return true;
  return new Date() < this.freeRideExpiresAt;
});

// ═════════════════════════════════════════════════════════════════════════════
// STATIC METHODS
// ═════════════════════════════════════════════════════════════════════════════

/**
 * findOrCreate — always returns the doc for a passenger, creating it if needed.
 * Safe to call concurrently (upsert).
 */
LoyaltyProgressSchema.statics.findOrCreate = async function (passengerId, session = null) {
  const opts = session ? { session } : {};
  const existing = await this.findOne({ passengerId }, null, opts);
  if (existing) return existing;

  const [created] = await this.create([{ passengerId }], opts);
  return created;
};

/**
 * recordCompletedTrip — call this inside the trip-complete transaction.
 *
 * - Increments tripCount for PAID trips only (not free rides).
 * - If tripCount reaches TRIPS_REQUIRED, unlocks the free ride.
 * - Appends to recentEvents (capped at 20).
 * - Returns { progress, justUnlocked } so the caller can notify the passenger.
 *
 * @param {ObjectId|string} passengerId
 * @param {ObjectId|string} tripId
 * @param {number}          fareNaira   — the fare that was paid (0 for free rides)
 * @param {boolean}         isFreeLoyaltyRide — if true, don't increment counter
 * @param {ClientSession}   session     — mongoose session (MUST be passed in)
 */
LoyaltyProgressSchema.statics.recordCompletedTrip = async function (
  passengerId,
  tripId,
  fareNaira,
  isFreeLoyaltyRide = false,
  session
) {
  const progress = await this.findOrCreate(passengerId, session);

  // ── FREE RIDE REDEEMED ────────────────────────────────────────────────────
  // Update lifetime value + audit, reset counter to 0 so the next cycle
  // requires a full 5 paid trips again before another free ride is unlocked.
  if (isFreeLoyaltyRide) {
    progress.totalFreeRidesEarned += 1;
    progress.totalFreeRideValueNaira += fareNaira || 0;
    progress.freeRideAvailable = false;
    progress.freeRideExpiresAt = null;
    progress.freeRideUnlockedAt = null;
    progress.lastFreeRideRedeemedAt = new Date();

    // ✅ FIX: Reset counter to 0 so the passenger must complete another
    // full cycle of TRIPS_REQUIRED paid trips to earn the next free ride.
    // Previously this line was missing, causing the counter to stay at 5
    // and immediately unlock a new free ride after just 1 more paid trip.
    progress.tripCount = 0;

    _appendEvent(progress, {
      eventType: 'free_ride_redeemed',
      tripId,
      tripCountSnapshot: progress.tripCount, // 0 after reset
      fareNaira,
      note: 'Free ride redeemed — counter reset to 0, new cycle begins'
    });

    await progress.save({ session });
    return { progress, justUnlocked: false, freeRideRedeemed: true };
  }

  // ── PAID TRIP — increment counter ─────────────────────────────────────────
  progress.tripCount = Math.min(progress.tripCount + 1, TRIPS_REQUIRED);
  progress.lastTripCountedAt = new Date();

  _appendEvent(progress, {
    eventType: 'trip_counted',
    tripId,
    tripCountSnapshot: progress.tripCount,
    fareNaira
  });

  let justUnlocked = false;

  // Check if threshold reached
  if (progress.tripCount >= TRIPS_REQUIRED && !progress.freeRideAvailable) {
    progress.freeRideAvailable = true;
    progress.freeRideUnlockedAt = new Date();
    progress.freeRideExpiresAt = new Date(
      Date.now() + FREE_RIDE_EXPIRY_DAYS * 24 * 60 * 60 * 1000
    );
    justUnlocked = true;

    _appendEvent(progress, {
      eventType: 'free_ride_unlocked',
      tripId,
      tripCountSnapshot: progress.tripCount,
      fareNaira: 0,
      note: `Unlocked after ${TRIPS_REQUIRED} trips. Expires ${progress.freeRideExpiresAt.toISOString()}`
    });
  }

  await progress.save({ session });
  return { progress, justUnlocked, freeRideRedeemed: false };
};

/**
 * checkEligibility — lightweight read to see if passenger can use a free ride.
 * Returns { eligible, progress }.
 */
LoyaltyProgressSchema.statics.checkEligibility = async function (passengerId) {
  const progress = await this.findOne({ passengerId });
  if (!progress) return { eligible: false, progress: null };

  const eligible =
    progress.freeRideAvailable &&
    progress.freeRideExpiresAt &&
    new Date() < progress.freeRideExpiresAt;

  return { eligible, progress };
};

/**
 * expireStaleRewards — call from a cron job to sweep free rides that expired
 * without being redeemed. Returns the number of docs updated.
 */
LoyaltyProgressSchema.statics.expireStaleRewards = async function () {
  const now = new Date();
  const stale = await this.find({
    freeRideAvailable: true,
    freeRideExpiresAt: { $lt: now }
  });

  let count = 0;
  for (const doc of stale) {
    doc.freeRideAvailable = false;
    doc.freeRideExpiresAt = null;
    doc.freeRideUnlockedAt = null;
    // Reset counter — passenger starts fresh after expiry
    doc.tripCount = 0;

    _appendEvent(doc, {
      eventType: 'free_ride_expired',
      tripCountSnapshot: 0,
      note: 'Free ride expired without redemption — counter reset'
    });

    await doc.save();
    count++;
  }

  return count;
};

// ── Private helper ─────────────────────────────────────────────────────────
function _appendEvent(doc, eventData) {
  doc.recentEvents.push({ ...eventData, occurredAt: new Date() });
  // Keep only the most recent 20 events
  if (doc.recentEvents.length > 20) {
    doc.recentEvents = doc.recentEvents.slice(-20);
  }
}

// ── Indexes ────────────────────────────────────────────────────────────────
LoyaltyProgressSchema.index({ passengerId: 1 }, { unique: true });
LoyaltyProgressSchema.index({ freeRideAvailable: 1 });
LoyaltyProgressSchema.index({ freeRideExpiresAt: 1 });

module.exports = mongoose.model('LoyaltyProgress', LoyaltyProgressSchema);
