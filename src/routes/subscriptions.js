const express = require('express');
const router = express.Router();
const { initializeTransaction } = require('../utils/paystack');
const { requireAuth } = require('../middleware/auth');
const { paymentLimiter } = require('../middleware/rateLimiter');
const { validateSubscriptionType, validateEmail } = require('../middleware/validation');
const User = require('../models/user.model');
const Transaction = require('../models/transaction.model');

// Plan prices (in Naira)
const SUBSCRIPTION_PRICES = {
  daily: 100,
  weekly: 500,
  monthly: 1500
};

// Initialize subscription payment via Paystack
router.post('/init', requireAuth, paymentLimiter, async (req, res, next) => {
  try {
    const userId = req.user && req.user.sub;
    if (!userId) return res.status(401).json({ error: { message: 'Unauthorized' } });
    const { type, email } = req.body;
    if (!type || !validateSubscriptionType(type)) return res.status(400).json({ error: { message: 'Invalid subscription type' } });
    if (email && !validateEmail(email)) return res.status(400).json({ error: { message: 'Invalid email format' } });

    const priceNaira = SUBSCRIPTION_PRICES[type];
    const amountKobo = Math.round(priceNaira * 100);
    const customerEmail = email || `${userId}@wheela.local`;

    // create pending transaction
    const tx = await Transaction.create({ userId, type: 'subscription', amount: amountKobo, reference: null, status: 'pending', meta: { subType: type } });

    const resPay = await initializeTransaction({ amountKobo, email: customerEmail, metadata: { txId: tx._id.toString(), subType: type } });
    if (!resPay || !resPay.status) return res.status(500).json({ error: { message: 'Paystack initialize failed' } });

    // store reference
    tx.reference = resPay.data.reference;
    await tx.save();

    res.json({ authorization_url: resPay.data.authorization_url, reference: resPay.data.reference });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
