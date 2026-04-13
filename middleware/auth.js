const jwt = require('jsonwebtoken');
const User = require('../models/User');
const AuthCode = require('../models/AuthCode');
const StaffLink = require('../models/StaffLink');
const CustomerLink = require('../models/CustomerLink');

// Verify JWT token and set req.userId
function authenticateToken(req, res, next) {
  const token = req.cookies.token;
  if (!token) return res.status(401).json({ error: 'Not authenticated' });
  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    req.userId = decoded.userId;
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

// Check that the user has a valid (non-blocked) auth code
// Also checks if staff/customer invite link is paused
// Must be used AFTER authenticateToken
async function requireAuthCode(req, res, next) {
  try {
    const user = await User.findById(req.userId).select('authCode role');
    if (!user || !user.authCode) {
      return res.status(403).json({ error: 'Access denied — no auth code' });
    }
    const authCode = await AuthCode.findById(user.authCode);
    if (!authCode || authCode.status === 'blocked') {
      return res.status(403).json({ error: 'Access denied — auth code blocked' });
    }

    // For staff users, check if their staff invite link is still active
    if (user.role === 'staff') {
      const staffLink = await StaffLink.findOne({ connectedUser: user._id });
      if (!staffLink || staffLink.status === 'paused') {
        return res.status(403).json({ error: 'Access denied — your staff access has been paused' });
      }
    }

    // For customer users, check if their customer invite link is still active
    if (user.role === 'customer') {
      const customerLink = await CustomerLink.findOne({ connectedUser: user._id });
      if (!customerLink || customerLink.status === 'paused') {
        return res.status(403).json({ error: 'Access denied — your customer access has been paused' });
      }
      // Also check if the parent (staff) invite link is paused
      if (user.parentUser) {
        const parentUser = await User.findById(user.parentUser).select('role');
        if (parentUser && parentUser.role === 'staff') {
          const parentStaffLink = await StaffLink.findOne({ connectedUser: parentUser._id });
          if (parentStaffLink && parentStaffLink.status === 'paused') {
            return res.status(403).json({ error: 'Access denied — service paused' });
          }
        }
      }
    }

    req.userRole = user.role;
    next();
  } catch {
    return res.status(500).json({ error: 'Server error' });
  }
}

module.exports = { authenticateToken, requireAuthCode };
