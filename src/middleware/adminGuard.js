const User = require('../models/user.model');

async function requireAdmin(req, res, next) {
  try {
    const auth = req.user;
    if (!auth || !auth.sub) return res.status(401).json({ error: { message: 'Unauthorized' } });
    const user = await User.findById(auth.sub).lean();
    if (!user || !user.roles || !user.roles.isAdmin) {
      return res.status(403).json({ error: { message: 'Admin access required' } });
    }
    return next();
  } catch (err) {
    return next(err);
  }
}

module.exports = { requireAdmin };
