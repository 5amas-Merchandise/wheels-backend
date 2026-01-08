const Audit = require('../models/audit.model');

async function createAudit({ adminId, action, targetType, targetId, meta, ip }) {
  try {
    const a = new Audit({ adminId, action, targetType, targetId, meta, ip });
    await a.save();
    return a;
  } catch (err) {
    console.error('Failed to write audit log', err.message || err);
  }
}

module.exports = { createAudit };
