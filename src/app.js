// app.js - COMPLETE WITH ALL SUBSCRIPTION UPDATES

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

// CORS
app.use(cors());

// Parse JSON bodies (increase limit for file uploads if needed)
app.use(express.json({ limit: '10mb' }));
app.use(express.urlencoded({ extended: true, limit: '10mb' }));

// Custom middleware
app.use(requestLogger);
app.use(optionalAuth);
app.use(defaultLimiter);

// ==========================================
// ROUTES
// ==========================================

const authRoutes = require('./routes/auth');
const userRoutes = require('./routes/users');
const driverRoutes = require('./routes/drivers');
const matchingRoutes = require('./routes/matching');
const paymentsRoutes = require('./routes/payments');
const walletRoutes = require('./routes/wallet');
const subscriptionsRoutes = require('./routes/subscriptions'); // ✅ NEW SUBSCRIPTION SYSTEM
const payoutsRoutes = require('./routes/payouts');
const transactionsRoutes = require('./routes/transactions');
const adminRoutes = require('./routes/admin');
const notificationsRoutes = require('./routes/notifications');
const pricingRoutes = require('./routes/pricing');
const tripsRoutes = require('./routes/trips');
const intercityRoutes = require('./routes/intercity.routes');

// Mount routes
app.use('/auth', authRoutes);
app.use('/users', userRoutes);
app.use('/drivers', driverRoutes); // ✅ UPDATED with subscription checks
app.use('/matching', matchingRoutes);
app.use('/payments', paymentsRoutes);
app.use('/wallet', walletRoutes); // ✅ UPDATED with Paystack integration
app.use('/subscriptions', subscriptionsRoutes); // ✅ NEW - Driver subscription management
app.use('/payouts', payoutsRoutes);
app.use('/transactions', transactionsRoutes);
app.use('/admin', adminRoutes);
app.use('/notifications', notificationsRoutes);
app.use('/pricing', pricingRoutes);
app.use('/trips', tripsRoutes); // ✅ UPDATED with subscription checks
app.use('/intercity', intercityRoutes);

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
      subscriptionSystem: true,
      paystackIntegration: true,
      walletFunding: true
    }
  });
});

// ==========================================
// API INFO
// ==========================================

app.get('/', (req, res) => {
  res.json({
    name: 'Ride Hailing API',
    version: '2.0.0',
    status: 'running',
    features: [
      'Driver Subscriptions',
      'Wallet Management',
      'Paystack Integration',
      'Trip Management',
      'Real-time Matching'
    ],
    endpoints: {
      auth: '/auth',
      users: '/users',
      drivers: '/drivers',
      subscriptions: '/subscriptions',
      wallet: '/wallet',
      trips: '/trips',
      admin: '/admin'
    },
    documentation: '/api/docs' // If you have API docs
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
  server.close(() => {
    console.log('HTTP server closed');
    // Close database connections here if needed
    process.exit(0);
  });
});

module.exports = app;