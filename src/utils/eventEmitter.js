const EventEmitter = require('events');
const Notification = require('../models/notification.model');
const notificationService = require('./notificationService');

class NotificationEmitter extends EventEmitter {}

const emitter = new NotificationEmitter();

// Listen for all notification events
emitter.on('notification', async (event) => {
  try {
    const { userId, type, title, body, data } = event;
    if (!userId) return;

    // create notification in DB
    const notif = await Notification.create({ userId, type, title, body, data });

    // send mock push
    notificationService.sendPush({ userId, type, title, body, data });

    console.log(`Notification created for ${userId}: ${type}`);
  } catch (err) {
    console.error('Notification error:', err.message);
  }
});

module.exports = emitter;
