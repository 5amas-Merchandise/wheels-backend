const jwt = require('jsonwebtoken');
const config = require('../config');

function signUser(user) {
  const payload = {
    sub: user._id.toString(),
    roles: user.roles || {}
  };
  return jwt.sign(payload, config.jwtSecret, { expiresIn: '30d' });
}

function verifyToken(token) {
  return jwt.verify(token, config.jwtSecret);
}

module.exports = { signUser, verifyToken };
