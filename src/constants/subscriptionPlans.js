// constants/subscriptionPlans.js

/**
 * Subscription Plans for Different Vehicle Types
 * All prices are in Naira (stored as kobo in DB: price * 100)
 */

const VEHICLE_TYPES = {
  CITY_CAR: 'CITY_CAR',
  KEKE: 'KEKE',
  BIKE: 'BIKE'
};

const SUBSCRIPTION_DURATIONS = {
  DAILY: 'daily',
  WEEKLY: 'weekly',
  MONTHLY: 'monthly'
};

// Duration in hours for each plan
const DURATION_HOURS = {
  [SUBSCRIPTION_DURATIONS.DAILY]: 24,
  [SUBSCRIPTION_DURATIONS.WEEKLY]: 24 * 7, // 168 hours
  [SUBSCRIPTION_DURATIONS.MONTHLY]: 24 * 30 // 720 hours
};

// Pricing structure in Naira (will be converted to kobo)
const SUBSCRIPTION_PRICING = {
  [VEHICLE_TYPES.CITY_CAR]: {
    [SUBSCRIPTION_DURATIONS.DAILY]: 2000,
    [SUBSCRIPTION_DURATIONS.WEEKLY]: 10000,
    [SUBSCRIPTION_DURATIONS.MONTHLY]: 30000
  },
  [VEHICLE_TYPES.KEKE]: {
    [SUBSCRIPTION_DURATIONS.DAILY]: 500,
    [SUBSCRIPTION_DURATIONS.WEEKLY]: 2000,
    [SUBSCRIPTION_DURATIONS.MONTHLY]: 6000
  },
  [VEHICLE_TYPES.BIKE]: {
    [SUBSCRIPTION_DURATIONS.DAILY]: 500,
    [SUBSCRIPTION_DURATIONS.WEEKLY]: 2000,
    [SUBSCRIPTION_DURATIONS.MONTHLY]: 6000
  }
};

// Convert to kobo for database storage
const SUBSCRIPTION_PRICING_KOBO = {};
Object.keys(SUBSCRIPTION_PRICING).forEach(vehicleType => {
  SUBSCRIPTION_PRICING_KOBO[vehicleType] = {};
  Object.keys(SUBSCRIPTION_PRICING[vehicleType]).forEach(duration => {
    SUBSCRIPTION_PRICING_KOBO[vehicleType][duration] = 
      SUBSCRIPTION_PRICING[vehicleType][duration] * 100;
  });
});

/**
 * Get price for a specific vehicle type and duration
 * @param {string} vehicleType - CITY_CAR, KEKE, or BIKE
 * @param {string} duration - daily, weekly, or monthly
 * @returns {number} Price in kobo
 */
function getSubscriptionPrice(vehicleType, duration) {
  if (!SUBSCRIPTION_PRICING_KOBO[vehicleType]) {
    throw new Error(`Invalid vehicle type: ${vehicleType}`);
  }
  if (!SUBSCRIPTION_PRICING_KOBO[vehicleType][duration]) {
    throw new Error(`Invalid duration: ${duration}`);
  }
  return SUBSCRIPTION_PRICING_KOBO[vehicleType][duration];
}

/**
 * Get duration in hours for a subscription period
 * @param {string} duration - daily, weekly, or monthly
 * @returns {number} Duration in hours
 */
function getDurationHours(duration) {
  if (!DURATION_HOURS[duration]) {
    throw new Error(`Invalid duration: ${duration}`);
  }
  return DURATION_HOURS[duration];
}

/**
 * Calculate expiry date from now
 * @param {string} duration - daily, weekly, or monthly
 * @returns {Date} Expiry date
 */
function calculateExpiryDate(duration) {
  const hours = getDurationHours(duration);
  return new Date(Date.now() + hours * 60 * 60 * 1000);
}

/**
 * Check if subscription is active
 * @param {Object} subscription - Subscription object with expiresAt
 * @returns {boolean} True if active
 */
function isSubscriptionActive(subscription) {
  if (!subscription || !subscription.expiresAt) {
    return false;
  }
  return new Date(subscription.expiresAt) > new Date();
}

/**
 * Get all available plans for a vehicle type
 * @param {string} vehicleType - CITY_CAR, KEKE, or BIKE
 * @returns {Array} Array of plan objects
 */
function getAvailablePlans(vehicleType) {
  if (!SUBSCRIPTION_PRICING[vehicleType]) {
    throw new Error(`Invalid vehicle type: ${vehicleType}`);
  }

  return Object.keys(SUBSCRIPTION_PRICING[vehicleType]).map(duration => ({
    duration,
    priceNaira: SUBSCRIPTION_PRICING[vehicleType][duration],
    priceKobo: SUBSCRIPTION_PRICING_KOBO[vehicleType][duration],
    durationHours: DURATION_HOURS[duration],
    savings: calculateSavings(vehicleType, duration)
  }));
}

/**
 * Calculate savings compared to daily rate
 * @param {string} vehicleType 
 * @param {string} duration 
 * @returns {number} Savings in Naira
 */
function calculateSavings(vehicleType, duration) {
  const dailyRate = SUBSCRIPTION_PRICING[vehicleType][SUBSCRIPTION_DURATIONS.DAILY];
  const planPrice = SUBSCRIPTION_PRICING[vehicleType][duration];
  
  let days;
  switch(duration) {
    case SUBSCRIPTION_DURATIONS.DAILY:
      return 0;
    case SUBSCRIPTION_DURATIONS.WEEKLY:
      days = 7;
      break;
    case SUBSCRIPTION_DURATIONS.MONTHLY:
      days = 30;
      break;
    default:
      return 0;
  }
  
  const dailyEquivalent = dailyRate * days;
  return Math.max(0, dailyEquivalent - planPrice);
}

module.exports = {
  VEHICLE_TYPES,
  SUBSCRIPTION_DURATIONS,
  DURATION_HOURS,
  SUBSCRIPTION_PRICING,
  SUBSCRIPTION_PRICING_KOBO,
  getSubscriptionPrice,
  getDurationHours,
  calculateExpiryDate,
  isSubscriptionActive,
  getAvailablePlans,
  calculateSavings
};