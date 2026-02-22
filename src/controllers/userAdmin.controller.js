// controllers/userAdmin.controller.js
const User = require('../models/user.model');

// Get all users (drivers and passengers)
async function getAllUsers(req, res) {
  try {
    const users = await User.find().lean();
    res.json({ success: true, users });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
}

// Get details of a particular user by ID
async function getUserById(req, res) {
  try {
    const user = await User.findById(req.params.id).lean();
    if (!user) {
      return res.status(404).json({ success: false, error: 'User not found' });
    }
    res.json({ success: true, user });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
}

module.exports = {
  getAllUsers,
  getUserById
};
