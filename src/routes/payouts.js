const express = require('express');
const router = express.Router();
const { createTransferRecipient, initiateTransfer } = require('../utils/paystack');
const { requireAuth } = require('../middleware/auth');
const User = require('../models/user.model');
const Wallet = require('../models/wallet.model');
const Transaction = require('../models/transaction.model');

// Driver requests a payout (withdrawal)
router.post('/request', requireAuth, async (req, res, next) => {
  try {
    const driverId = req.user && req.user.sub;
    if (!driverId) return res.status(401).json({ error: { message: 'Unauthorized' } });
    const { amountNaira, accountNumber, bankCode } = req.body;
    if (!amountNaira || amountNaira <= 0) return res.status(400).json({ error: { message: 'Invalid amount' } });
    if (!accountNumber || !bankCode) return res.status(400).json({ error: { message: 'accountNumber and bankCode required' } });

    // check balance
    const wallet = await Wallet.findOne({ owner: driverId }).lean();
    const balanceNaira = wallet ? Math.floor(wallet.balance / 100) : 0;
    if (balanceNaira < amountNaira) return res.status(400).json({ error: { message: 'Insufficient balance' } });

    const driver = await User.findById(driverId).lean();
    if (!driver) return res.status(404).json({ error: { message: 'Driver not found' } });

    // create transfer recipient
    const recipientRes = await createTransferRecipient({
      type: 'nuban',
      accountNumber,
      bankCode,
      name: driver.name || `Driver ${driverId}`
    });

    if (!recipientRes || !recipientRes.status) return res.status(500).json({ error: { message: 'Failed to create recipient' } });

    // create pending payout transaction
    const amountKobo = Math.round(amountNaira * 100);
    const reference = `payout_${driverId}_${Date.now()}`;
    const tx = await Transaction.create({
      userId: driverId,
      type: 'payout',
      amount: amountKobo,
      reference,
      status: 'pending',
      meta: { recipientCode: recipientRes.data.recipient_code, accountNumber, bankCode }
    });

    // initiate transfer
    const transferRes = await initiateTransfer({ amountKobo, recipientCode: recipientRes.data.recipient_code, reference });
    if (!transferRes || !transferRes.status) {
      tx.status = 'failed';
      await tx.save();
      return res.status(500).json({ error: { message: 'Transfer initiation failed' } });
    }

    // deduct from wallet immediately (assume transfer will be confirmed via webhook)
    await Wallet.findOneAndUpdate({ owner: driverId }, { $inc: { balance: -amountKobo } });

    res.json({ ok: true, reference, transferStatus: transferRes.data.status });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
