const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const Transaction = require('../models/transaction.model');

// Get user's transaction history
router.get('/', requireAuth, async (req, res, next) => {
  try {
    const userId = req.user && req.user.sub;
    if (!userId) return res.status(401).json({ error: { message: 'Unauthorized' } });
    const { type, status, limit = 50, offset = 0 } = req.query;

    const filter = { userId };
    if (type) filter.type = type;
    if (status) filter.status = status;

    const transactions = await Transaction.find(filter)
      .sort({ createdAt: -1 })
      .limit(parseInt(limit))
      .skip(parseInt(offset))
      .lean();

    const total = await Transaction.countDocuments(filter);

    res.json({ transactions, total, limit: parseInt(limit), offset: parseInt(offset) });
  } catch (err) {
    next(err);
  }
});

// Get single transaction
router.get('/:id', requireAuth, async (req, res, next) => {
  try {
    const tx = await Transaction.findById(req.params.id).lean();
    if (!tx) return res.status(404).json({ error: { message: 'Transaction not found' } });
    const userId = req.user && req.user.sub;
    // only owner or admin can view (simplified)
    if (tx.userId && tx.userId.toString() !== userId) return res.status(403).json({ error: { message: 'Forbidden' } });
    res.json({ transaction: tx });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
