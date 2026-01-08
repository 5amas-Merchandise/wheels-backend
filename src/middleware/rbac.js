// Enhanced RBAC middleware for fine-grained access control

async function requireRole(roles) {
  return async (req, res, next) => {
    try {
      const auth = req.user;
      if (!auth || !auth.sub) return res.status(401).json({ error: { message: 'Unauthorized' } });

      const User = require('../models/user.model');
      const user = await User.findById(auth.sub).lean();
      if (!user || !user.roles) return res.status(401).json({ error: { message: 'Unauthorized' } });

      const hasRole = Array.isArray(roles) ? roles.some(r => user.roles[r]) : user.roles[roles];
      if (!hasRole) return res.status(403).json({ error: { message: 'Insufficient permissions' } });

      return next();
    } catch (err) {
      return next(err);
    }
  };
}

// Ownership check: ensure user owns the resource (e.g., driver can only access own profile)
async function requireOwnershipOrAdmin(resourceOwnerId, userIdFromToken) {
  if (userIdFromToken.toString() === resourceOwnerId.toString()) return true;
  
  const User = require('../models/user.model');
  const user = await User.findById(userIdFromToken).lean();
  return user && user.roles && user.roles.isAdmin;
}

module.exports = { requireRole, requireOwnershipOrAdmin };
