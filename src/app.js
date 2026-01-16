const express = require('express');
const cors = require('cors');
const requestLogger = require('./middleware/requestLogger');
const errorHandler = require('./middleware/errorHandler');
const { optionalAuth } = require('./middleware/auth');
const { authLimiter, paymentLimiter, defaultLimiter } = require('./middleware/rateLimiter');

const app = express();

// === CORS ===
app.use(cors());

// Parse JSON bodies
app.use(express.json());

// Custom middleware
app.use(requestLogger);
app.use(optionalAuth);
app.use(defaultLimiter);

// === Routes ===
const authRoutes = require('./routes/auth');
const userRoutes = require('./routes/users');
const driverRoutes = require('./routes/drivers'); // ✅ Fixed path
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
app.use((req, res, next) => {
  const err = new Error('Not Found');
  err.status = 404;
  next(err);
});

// === Global Error Handler ===
app.use(errorHandler);

module.exports = app;