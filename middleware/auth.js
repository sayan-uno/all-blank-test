const jwt = require('jsonwebtoken');
const User = require('../models/User');
const AuthCode = require('../models/AuthCode');

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
// Must be used AFTER authenticateToken
async function requireAuthCode(req, res, next) {
  try {
    const user = await User.findById(req.userId).select('authCode');
    if (!user || !user.authCode) {
      return res.status(403).json({ error: 'Access denied — no auth code' });
    }
    const authCode = await AuthCode.findById(user.authCode);
    if (!authCode || authCode.status === 'blocked') {
      return res.status(403).json({ error: 'Access denied — auth code blocked' });
    }
    next();
  } catch {
    return res.status(500).json({ error: 'Server error' });
  }
}

module.exports = { authenticateToken, requireAuthCode };
