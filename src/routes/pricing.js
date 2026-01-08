const express = require('express');
const router = express.Router();
const Pricing = require('../models/pricing.model');
const { calculateFare } = require('../utils/pricingCalculator');
const { validateServiceType } = require('../middleware/validation');

// Get pricing rule for a service type
router.get('/:serviceType', async (req, res, next) => {
  try {
    const { serviceType } = req.params;
    if (!validateServiceType(serviceType)) return res.status(400).json({ error: { message: 'Invalid serviceType' } });

    const pricing = await Pricing.findOne({ serviceType, active: true }).lean();
    if (!pricing) return res.status(404).json({ error: { message: 'Pricing not found for this service' } });

    res.json({ pricing });
  } catch (err) {
    next(err);
  }
});

// Get all active pricing rules
router.get('/', async (req, res, next) => {
  try {
    const pricing = await Pricing.find({ active: true }).lean();
    res.json({ pricing, total: pricing.length });
  } catch (err) {
    next(err);
  }
});

// Calculate fare for a trip
// POST with: serviceType, distanceKm (optional, for distance-based), durationMinutes (optional, for rental)
router.post('/calculate', async (req, res, next) => {
  try {
    const { serviceType, distanceKm = 0, durationMinutes = 0 } = req.body;
    if (!serviceType || !validateServiceType(serviceType)) return res.status(400).json({ error: { message: 'Invalid serviceType' } });
    
    if (typeof distanceKm !== 'number' || distanceKm < 0) return res.status(400).json({ error: { message: 'distanceKm must be >= 0' } });
    if (typeof durationMinutes !== 'number' || durationMinutes < 0) return res.status(400).json({ error: { message: 'durationMinutes must be >= 0' } });

    const fareData = await calculateFare({ serviceType, distanceKm, durationMinutes });
    res.json({ fare: fareData });
  } catch (err) {
    if (err.message.includes('No active pricing')) {
      return res.status(404).json({ error: { message: err.message } });
    }
    next(err);
  }
});

module.exports = router;
