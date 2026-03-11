// app.js - COMPLETE WITH ALL SUBSCRIPTION + REFERRAL + PRICING UPDATES
const express = require('express');
const cors = require('cors');
const requestLogger = require('./middleware/requestLogger');
const errorHandler = require('./middleware/errorHandler');
const { optionalAuth } = require('./middleware/auth');
const { authLimiter, paymentLimiter, defaultLimiter } = require('./middleware/rateLimiter');

const app = express();

// ==========================================
// MIDDLEWARE
// ==========================================
app.use(cors());
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));
app.use(requestLogger);
app.use(optionalAuth);
app.use(defaultLimiter);

// ==========================================
// ROUTES
// ==========================================
const authRoutes          = require('./routes/auth');
const userRoutes          = require('./routes/users');
const driverRoutes        = require('./routes/drivers');
const matchingRoutes      = require('./routes/matching');
const paymentsRoutes      = require('./routes/payments');
const walletRoutes        = require('./routes/wallet');
const subscriptionsRoutes = require('./routes/subscriptions');
const payoutsRoutes       = require('./routes/payouts');
const transactionsRoutes  = require('./routes/transactions');
const adminRoutes         = require('./routes/admin');
const notificationsRoutes = require('./routes/notifications');
const pricingRoutes       = require('./routes/pricing.routes');  // ✅ backend-controlled pricing
const tripsRoutes         = require('./routes/trips');
const intercityRoutes     = require('./routes/intercity.routes');
const referralRoutes      = require('./routes/referral');

// ==========================================
// MOUNT ROUTES
// ==========================================
app.use('/auth',          authRoutes);
app.use('/users',         userRoutes);
app.use('/drivers',       driverRoutes);
app.use('/matching',      matchingRoutes);
app.use('/payments',      paymentsRoutes);
app.use('/wallet',        walletRoutes);
app.use('/subscriptions', subscriptionsRoutes);
app.use('/payouts',       payoutsRoutes);
app.use('/transactions',  transactionsRoutes);
app.use('/admin',         adminRoutes);
app.use('/notifications', notificationsRoutes);
app.use('/pricing',       pricingRoutes);   // ✅ fare-estimate + admin config endpoints
app.use('/trips',         tripsRoutes);
app.use('/intercity',     intercityRoutes);
app.use('/referrals',     referralRoutes);

// ==========================================
// HEALTH CHECK
// ==========================================
app.get('/health', (req, res) => {
  res.json({
    status: 'healthy',
    timestamp: new Date().toISOString(),
    uptime: process.uptime(),
    environment: process.env.NODE_ENV || 'development',
    features: {
      subscriptionSystem:     true,
      paystackIntegration:    true,
      walletFunding:          true,
      referralSystem:         true,
      backendControlledPricing: true,  // ✅ fares now come from DB, not frontend
    },
  });
});

// ==========================================
// API INFO
// ==========================================
app.get('/', (req, res) => {
  res.json({
    name: 'Ride Hailing API',
    version: '2.2.0',
    status: 'running',
    features: [
      'Driver Subscriptions',
      'Wallet Management',
      'Paystack Integration',
      'Trip Management',
      'Real-time Matching',
      'Referral System',
      'Backend-Controlled Pricing',  // ✅
    ],
    endpoints: {
      auth:          '/auth',
      users:         '/users',
      drivers:       '/drivers',
      subscriptions: '/subscriptions',
      wallet:        '/wallet',
      trips:         '/trips',
      referrals:     '/referrals',
      admin:         '/admin',
      pricing: {
        fareEstimate:   'POST /pricing/fare-estimate',
        getConfig:      'GET  /pricing/config',
        updateConfig:   'PUT  /pricing/config',        // admin only
        configHistory:  'GET  /pricing/config/history', // admin only
        rollback:       'POST /pricing/config/rollback/:version', // admin only
        surge:          'PUT  /pricing/surge',          // admin only
      },
    },
  });
});

// ==========================================
// 404 HANDLER
// ==========================================
app.use((req, res, next) => {
  const err = new Error('Not Found');
  err.status = 404;
  next(err);
});

// ==========================================
// GLOBAL ERROR HANDLER
// ==========================================
app.use(errorHandler);

// ==========================================
// GRACEFUL SHUTDOWN
// ==========================================
process.on('SIGTERM', () => {
  console.log('SIGTERM signal received: closing HTTP server');
  // `server` is defined in server.js / index.js where app.listen() is called.
  // If you call app.listen() inside this file, replace `server` with that ref.
  if (typeof server !== 'undefined') {
    server.close(() => {
      console.log('HTTP server closed');
      process.exit(0);
    });
  } else {
    process.exit(0);
  }
});

module.exports = app;