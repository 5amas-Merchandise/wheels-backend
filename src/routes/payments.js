const express = require('express');
const router = express.Router();
const expressRaw = express.raw;
const { initializeTransaction, verifyTransaction, verifyWebhookSignature } = require('../utils/paystack');
const { requireAuth } = require('../middleware/auth');
const { paymentLimiter } = require('../middleware/rateLimiter');
const { validateAmount } = require('../middleware/validation');
const User = require('../models/user.model');
const Transaction = require('../models/transaction.model');
const Wallet = require('../models/wallet.model');
const Settings = require('../models/settings.model');
const emitter = require('../utils/eventEmitter');

// init topup: user provides amount in Naira (number), we'll convert to kobo
router.post('/wallet/topup/init', requireAuth, paymentLimiter, async (req, res, next) => {
  try {
    const userId = req.user && req.user.sub;
    if (!userId) return res.status(401).json({ error: { message: 'Unauthorized' } });
    const { amount, email } = req.body; // amount in Naira
    if (!amount || amount <= 0) return res.status(400).json({ error: { message: 'Invalid amount' } });

    const amountKobo = Math.round(amount * 100);
    const customerEmail = email || `${userId}@wheela.local`;

    // create pending transaction
    const tx = await Transaction.create({ userId, type: 'topup', amount: amountKobo, reference: null, status: 'pending' });

    const resPay = await initializeTransaction({ amountKobo, email: customerEmail, metadata: { txId: tx._id.toString() } });
    if (!resPay || !resPay.status) return res.status(500).json({ error: { message: 'Paystack initialize failed' } });

    // store reference
    tx.reference = resPay.data.reference;
    await tx.save();

    res.json({ authorization_url: resPay.data.authorization_url, reference: resPay.data.reference });
  } catch (err) {
    next(err);
  }
});

// Paystack webhook endpoint (raw body required to verify signature)
router.post('/webhook/paystack', expressRaw({ type: 'application/json' }), async (req, res, next) => {
  try {
    const sig = req.headers['x-paystack-signature'];
    const ok = verifyWebhookSignature(req.body, sig);
    if (!ok) {
      res.status(400).send('invalid signature');
      return;
    }

    const event = JSON.parse(req.body.toString());
    const eventType = event.event;

    if (eventType === 'charge.success' || eventType === 'charge.completed') {
      const ref = event.data.reference;
      const tx = await Transaction.findOne({ reference: ref, status: 'pending' });
      if (!tx) {
        res.json({ received: true });
        return;
      }

      // mark success
      tx.status = 'success';
      tx.meta = event.data;
      await tx.save();

      // Handle transaction type
      if (tx.type === 'topup') {
        // credit wallet for topup
        await Wallet.findOneAndUpdate({ owner: tx.userId }, { $inc: { balance: tx.amount } }, { upsert: true });
        console.log(`Wallet for ${tx.userId} credited by ${tx.amount}`);
        
        // emit event
        emitter.emit('notification', {
          userId: tx.userId,
          type: 'payment_received',
          title: 'Wallet credited',
          body: `₦${Math.floor(tx.amount / 100)} added to wallet`,
          data: { amount: tx.amount, reference: ref }
        });
      } else if (tx.type === 'subscription') {
        // activate subscription for driver
        const subType = tx.meta && tx.meta.subType;
        if (subType) {
          const now = new Date();
          const durationDays = { daily: 1, weekly: 7, monthly: 30 }[subType] || 30;
          const expiresAt = new Date(now.getTime() + durationDays * 24 * 60 * 60 * 1000);
          await User.findByIdAndUpdate(tx.userId, {
            $set: {
              subscription: { type: subType, startedAt: now, expiresAt },
              'roles.isDriver': true
            }
          });
          console.log(`Subscription activated for driver ${tx.userId}: ${subType}`);
          
          // emit event
          emitter.emit('notification', {
            userId: tx.userId,
            type: 'subscription_activated',
            title: 'Subscription activated',
            body: `${subType} subscription active until ${expiresAt.toLocaleDateString()}`,
            data: { subType, expiresAt }
          });
        }
      }
    }

    res.json({ received: true });
  } catch (err) {
    next(err);
  }
});

// Simple verify endpoint (manual) — verify by reference
router.get('/verify/:reference', async (req, res, next) => {
  try {
    const reference = req.params.reference;
    const result = await verifyTransaction(reference);
    res.json(result);
  } catch (err) {
    next(err);
  }
});

// Process completed trip payment: calculate commission for luxury, credit driver wallet, record ledger entries
// This is a helper endpoint to simulate trip completion payout
router.post('/trip/complete', async (req, res, next) => {
  try {
    const { tripId, passengerId, driverId, amount, serviceType } = req.body; // amount in Naira
    if (!tripId || !driverId || !amount) return res.status(400).json({ error: { message: 'tripId, driverId and amount required' } });

    const amountKobo = Math.round(amount * 100);

    // get commission percent from settings or env
    const commissionSetting = await Settings.findOne({ key: 'commission_percent' }).lean();
    const commissionPercent = commissionSetting && commissionSetting.value ? Number(commissionSetting.value) : (process.env.PLATFORM_COMMISSION_PERCENT ? Number(process.env.PLATFORM_COMMISSION_PERCENT) : 10);

    let commissionAmount = 0;
    if (serviceType === 'LUXURY_RENTAL') {
      commissionAmount = Math.round((commissionPercent / 100) * amountKobo);
    }

    const driverAmount = amountKobo - commissionAmount;

    // record transaction: passenger -> platform (trip_payment)
    await Transaction.create({ userId: passengerId, type: 'trip_payment', amount: amountKobo, reference: tripId, status: 'success', meta: { driverId, serviceType } });

    // record commission if any
    if (commissionAmount > 0) {
      await Transaction.create({ userId: null, type: 'commission', amount: commissionAmount, reference: tripId, status: 'success', meta: { driverId, serviceType } });
    }

    // credit driver wallet
    await Wallet.findOneAndUpdate({ owner: driverId }, { $inc: { balance: driverAmount } }, { upsert: true });

    res.json({ ok: true, driverCredited: driverAmount, commissionTaken: commissionAmount });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
