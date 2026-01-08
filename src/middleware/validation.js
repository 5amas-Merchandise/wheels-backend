// Input validation schemas using simple check patterns
// For production, consider joi, zod, or express-validator

function validatePhone(phone) {
  return typeof phone === 'string' && /^\+?[1-9]\d{1,14}$/.test(phone.replace(/\s/g, ''));
}

function validateEmail(email) {
  return typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email);
}

function validateServiceType(serviceType) {
  const VALID = ['CITY_RIDE', 'DELIVERY_BIKE', 'TRUCK', 'INTERSTATE', 'KEKE', 'LUXURY_RENTAL'];
  return VALID.includes(serviceType);
}

function validateCoordinates(coords) {
  return Array.isArray(coords) && coords.length === 2 && typeof coords[0] === 'number' && typeof coords[1] === 'number';
}

function validateAmount(amount) {
  return typeof amount === 'number' && amount > 0;
}

function validateSubscriptionType(type) {
  return ['daily', 'weekly', 'monthly'].includes(type);
}

// Validation middleware factory
function validateRequest(schema) {
  return (req, res, next) => {
    const errors = schema(req.body, req.query, req.params);
    if (errors.length > 0) {
      return res.status(400).json({ error: { message: 'Validation failed', details: errors } });
    }
    next();
  };
}

module.exports = {
  validatePhone,
  validateEmail,
  validateServiceType,
  validateCoordinates,
  validateAmount,
  validateSubscriptionType,
  validateRequest
};
