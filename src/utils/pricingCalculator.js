const Pricing = require('../models/pricing.model');

// Calculate fare based on pricing rule and trip parameters
const { estimateTrip } = require('./distance');

async function calculateFare({ serviceType, distanceKm, durationMinutes, pickupCoordinates, dropoffCoordinates }) {
  const pricing = await Pricing.findOne({ serviceType, active: true }).lean();
  if (!pricing) {
    throw new Error(`No active pricing for service type: ${serviceType}`);
  }

  // If coordinates provided but distance not, estimate using Haversine fallback
  if ((!distanceKm || distanceKm === 0) && pickupCoordinates && dropoffCoordinates) {
    const est = estimateTrip(pickupCoordinates, dropoffCoordinates);
    distanceKm = est.distanceKm;
    durationMinutes = durationMinutes || est.approxDurationMinutes;
  }

  let fare = 0;

  if (pricing.model === 'fixed') {
    // Fixed fare
    fare = pricing.baseFare || 0;
  } else if (pricing.model === 'distance') {
    // Distance-based: baseFare + perKmRate
    fare = (pricing.baseFare || 0) + (distanceKm || 0) * (pricing.perKmRate || 0);
  } else if (pricing.model === 'rental') {
    // Rental: hourlyRate or dailyRate
    // For simplicity, use hours if durationMinutes < 1440 (24 hours), else use daily
    const hours = Math.ceil((durationMinutes || 0) / 60);
    const days = Math.floor((durationMinutes || 0) / (24 * 60));
    
    if (hours < 24) {
      fare = hours * (pricing.hourlyRate || 0);
    } else {
      fare = days * (pricing.dailyRate || 0);
    }
  } else if (pricing.model === 'interstate') {
    // Interstate: per-km rate
    fare = (distanceKm || 0) * (pricing.interstatePerKmRate || 0);
  }

  return {
    baseAmount: fare,
    currency: 'NGN',
    pricingModel: pricing.model,
    breakdown: {
      serviceType,
      distanceKm,
      durationMinutes,
      baseFare: pricing.baseFare,
      perKmRate: pricing.perKmRate,
      hourlyRate: pricing.hourlyRate,
      dailyRate: pricing.dailyRate,
      interstatePerKmRate: pricing.interstatePerKmRate
    }
  };
}

module.exports = { calculateFare };
