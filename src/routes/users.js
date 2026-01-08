const express = require('express');
const router = express.Router();
const User = require('../models/user.model');
const { requireAuth } = require('../middleware/auth');

// Get current user profile - FIXED VERSION
router.get('/me', requireAuth, async (req, res, next) => {
  try {
    console.log('User from token:', req.user); // Debug log
    
    // Use the standardized _id from middleware
    const userId = req.user._id;
    
    if (!userId) {
      console.error('No user ID found in token');
      return res.status(401).json({ 
        success: false,
        error: { message: 'Invalid token payload: No user ID' } 
      });
    }

    const user = await User.findById(userId)
      .select('-passwordHash -otpCode -otpExpiresAt')
      .lean();

    if (!user) {
      return res.status(404).json({ 
        success: false,
        error: { message: 'User not found' } 
      });
    }

    // Ensure consistent response structure
    const responseUser = {
      ...user,
      // Make sure driverProfile exists
      driverProfile: user.driverProfile || {
        verified: false,
        verificationState: 'pending'
      }
    };

    res.json({ 
      success: true,
      user: responseUser
    });
  } catch (err) {
    console.error('Get profile error:', err);
    next(err);
  }
});

// Update user profile
router.put('/me', requireAuth, async (req, res, next) => {
  try {
    const userId = req.user._id;
    const { name, email } = req.body;

    const updateData = {};
    if (name !== undefined) updateData.name = name;
    if (email !== undefined) updateData.email = email;

    const updatedUser = await User.findByIdAndUpdate(
      userId,
      { $set: updateData },
      { 
        new: true, 
        runValidators: true,
        select: '-passwordHash -otpCode -otpExpiresAt' 
      }
    ).lean();

    if (!updatedUser) {
      return res.status(404).json({
        success: false,
        error: { message: 'User not found' }
      });
    }

    res.json({
      success: true,
      message: 'Profile updated successfully',
      user: updatedUser
    });
  } catch (err) {
    console.error('Update profile error:', err);
    
    if (err.name === 'ValidationError') {
      return res.status(400).json({
        success: false,
        error: { message: err.message }
      });
    }
    
    next(err);
  }
});

module.exports = router;