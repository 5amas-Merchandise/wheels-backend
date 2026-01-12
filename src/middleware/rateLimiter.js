// src/middleware/rateLimiter.js - Fixed for Vercel
const rateLimit = require('express-rate-limit');

// Increase limits significantly to avoid blocking legitimate users
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // Increased from default
  message: 'Too many authentication attempts, please try again later',
  standardHeaders: true,
  legacyHeaders: false,
  // Skip successful requests from counting
  skipSuccessfulRequests: true,
  // Use a custom key generator that works with Vercel
  keyGenerator: (req) => {
    // Trust proxy is set, so we can use req.ip
    return req.ip || req.headers['x-forwarded-for'] || req.connection.remoteAddress;
  },
});

const paymentLimiter = rateLimit({
  windowMs: 60 * 60 * 1000, // 1 hour
  max: 50, // Increased
  message: 'Too many payment requests, please try again later',
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: true,
  keyGenerator: (req) => {
    return req.ip || req.headers['x-forwarded-for'] || req.connection.remoteAddress;
  },
});

const defaultLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 200, // Very high limit - increased from 60
  message: 'Too many requests, please try again later',
  standardHeaders: true,
  legacyHeaders: false,
  skipSuccessfulRequests: false,
  keyGenerator: (req) => {
    return req.ip || req.headers['x-forwarded-for'] || req.connection.remoteAddress;
  },
});

module.exports = {
  authLimiter,
  paymentLimiter,
  defaultLimiter,
};