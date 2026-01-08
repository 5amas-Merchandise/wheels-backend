const jwt = require('jsonwebtoken');
const config = require('../config');

function optionalAuth(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth) return next();
  const parts = auth.split(' ');
  if (parts.length !== 2) return next();
  const token = parts[1];
  try {
    const payload = jwt.verify(token, config.jwtSecret);
    req.user = {
      _id: payload.userId || payload.sub || payload._id,
      email: payload.email,
      phone: payload.phone,
      roles: payload.roles
    };
  } catch (e) {
    // ignore invalid token for optional auth
  }
  return next();
}

function requireAuth(req, res, next) {
  const auth = req.headers.authorization;
  
  if (!auth) {
    return res.status(401).json({ 
      success: false,
      error: { message: 'Missing authorization header' } 
    });
  }
  
  const parts = auth.split(' ');
  
  if (parts.length !== 2 || parts[0] !== 'Bearer') {
    return res.status(401).json({ 
      success: false,
      error: { message: 'Invalid authorization header format. Use: Bearer <token>' } 
    });
  }
  
  const token = parts[1];
  
  if (!token) {
    return res.status(401).json({ 
      success: false,
      error: { message: 'No token provided' } 
    });
  }
  
  try {
    const payload = jwt.verify(token, config.jwtSecret);
    
    // Standardize user object structure
    req.user = {
      _id: payload.userId || payload.sub || payload._id,
      email: payload.email,
      phone: payload.phone,
      roles: payload.roles || { isUser: true, isDriver: false, isAdmin: false },
      // Keep original payload for backward compatibility
      ...payload
    };
    
    return next();
  } catch (e) {
    console.error('JWT Verification Error:', e.message);
    
    if (e.name === 'TokenExpiredError') {
      return res.status(401).json({ 
        success: false,
        error: { message: 'Token expired. Please login again.' } 
      });
    }
    
    if (e.name === 'JsonWebTokenError') {
      return res.status(401).json({ 
        success: false,
        error: { message: 'Invalid token' } 
      });
    }
    
    return res.status(401).json({ 
      success: false,
      error: { message: 'Authentication failed' } 
    });
  }
}

module.exports = { optionalAuth, requireAuth };