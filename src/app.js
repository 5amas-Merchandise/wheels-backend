const express = require('express');
const cors = require('cors'); // ← Added for CORS
const requestLogger = require('./middleware/requestLogger');
const errorHandler = require('./middleware/errorHandler');
const { optionalAuth } = require('./middleware/auth');
const { authLimiter, paymentLimiter, defaultLimiter } = require('./middleware/rateLimiter');

const app = express();

// === CORS: Allow requests from ANY origin (all URLs and networks) ===
app.use(cors()); // Default: allows all origins, all methods, all headers

// Parse JSON bodies
app.use(express.json());

// Custom middleware
app.use(requestLogger);
app.use(optionalAuth);
app.use(defaultLimiter);

// Simple healthcheck endpoint
app.get('/health', (req, res) => {
  res.json({ status: 'ok', uptime: process.uptime() });
});

// === Routes ===
const authRoutes = require('./routes/auth');
const userRoutes = require('./routes/users');
const driverRoutes = require('./routes/drivers');
const matchingRoutes = require('./routes/matching');
const paymentsRoutes = require('./routes/payments');
const walletRoutes = require('./routes/wallet');
const subscriptionsRoutes = require('./routes/subscriptions');
const payoutsRoutes = require('./routes/payouts');
const transactionsRoutes = require('./routes/transactions');
const adminRoutes = require('./routes/admin');
const notificationsRoutes = require('./routes/notifications');
const pricingRoutes = require('./routes/pricing');
const tripsRoutes = require('./routes/trips');

app.use('/auth', authRoutes);
app.use('/users', userRoutes);
app.use('/drivers', driverRoutes);
app.use('/matching', matchingRoutes);
app.use('/payments', paymentsRoutes);
app.use('/wallet', walletRoutes);
app.use('/subscriptions', subscriptionsRoutes);
app.use('/payouts', payoutsRoutes);
app.use('/transactions', transactionsRoutes);
app.use('/admin', adminRoutes);
app.use('/notifications', notificationsRoutes);
app.use('/pricing', pricingRoutes);
app.use('/trips', tripsRoutes);

// === 404 Handler ===
// Catch all unmatched routes
app.use((req, res, next) => {
  const err = new Error('Not Found');
  err.status = 404;
  next(err);
});

// === Global Error Handler ===
app.use(errorHandler);

module.exports = app;