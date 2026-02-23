const jwt = require('jsonwebtoken');
const config = require('../config');

function signUser(user) {
  const payload = {
    userId: user._id.toString(),   // ✅ primary field middleware reads
    sub: user._id.toString(),      // ✅ kept for backwards compat
    email: user.email || null,
    phone: user.phone || null,
    roles: user.roles || {}
  };
  return jwt.sign(payload, config.jwtSecret, { expiresIn: '30d' });
}

function verifyToken(token) {
  return jwt.verify(token, config.jwtSecret);
}

module.exports = { signUser, verifyToken };