const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const Wallet = require('../models/wallet.model');

router.get('/', requireAuth, async (req, res, next) => {
  try {
    const userId = req.user && req.user.sub;
    if (!userId) return res.status(401).json({ error: { message: 'Unauthorized' } });
    let wallet = await Wallet.findOne({ owner: userId }).lean();
    if (!wallet) {
      wallet = { owner: userId, balance: 0, currency: 'NGN' };
    }
    res.json({ wallet });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
