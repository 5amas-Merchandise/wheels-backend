const express = require('express');
const router = express.Router();
const { requireAuth } = require('../middleware/auth');
const Notification = require('../models/notification.model');

// Get user's notifications
router.get('/', requireAuth, async (req, res, next) => {
  try {
    const userId = req.user && req.user.sub;
    if (!userId) return res.status(401).json({ error: { message: 'Unauthorized' } });

    const { read, limit = 50, offset = 0 } = req.query;
    const filter = { userId };
    if (read !== undefined) filter.read = read === 'true';

    const notifications = await Notification.find(filter)
      .sort({ createdAt: -1 })
      .limit(parseInt(limit))
      .skip(parseInt(offset))
      .lean();

    const total = await Notification.countDocuments(filter);

    res.json({ notifications, total, limit: parseInt(limit), offset: parseInt(offset) });
  } catch (err) {
    next(err);
  }
});

// Mark notification as read
router.patch('/:id/read', requireAuth, async (req, res, next) => {
  try {
    const userId = req.user && req.user.sub;
    if (!userId) return res.status(401).json({ error: { message: 'Unauthorized' } });

    const notif = await Notification.findByIdAndUpdate(req.params.id, { $set: { read: true } }, { new: true }).lean();
    if (!notif) return res.status(404).json({ error: { message: 'Notification not found' } });
    if (notif.userId.toString() !== userId) return res.status(403).json({ error: { message: 'Forbidden' } });

    res.json({ notification: notif });
  } catch (err) {
    next(err);
  }
});

// Mark all as read
router.patch('/mark-all/read', requireAuth, async (req, res, next) => {
  try {
    const userId = req.user && req.user.sub;
    if (!userId) return res.status(401).json({ error: { message: 'Unauthorized' } });

    await Notification.updateMany({ userId, read: false }, { $set: { read: true } });
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});

module.exports = router;
