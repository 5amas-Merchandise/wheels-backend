const rateLimit = require('express-rate-limit');

// Generic rate limiter (10 requests per 15 min per IP)
const defaultLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 10,
  message: 'Too many requests, please try again later',
  standardHeaders: true,
  legacyHeaders: false
});

// Stricter limiter for auth endpoints (3 attempts per 15 min)
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 3,
  skipSuccessfulRequests: true,
  message: 'Too many auth attempts, please try again later'
});

// Payment limiter (5 per hour)
const paymentLimiter = rateLimit({
  windowMs: 60 * 60 * 1000,
  max: 5,
  message: 'Too many payment requests, please try again later'
});

module.exports = { defaultLimiter, authLimiter, paymentLimiter };
