const express = require('express');
const jwt = require('jsonwebtoken');
const User = require('../models/User');
const AuthCode = require('../models/AuthCode');
const { authenticateToken, requireAuthCode } = require('../middleware/auth');

const router = express.Router();

// Register
router.post('/register', async (req, res) => {
  try {
    const { username, password, authCode: authCodeStr } = req.body;

    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required' });
    }
    if (!authCodeStr) {
      return res.status(400).json({ error: 'Auth code is required' });
    }
    if (username.length < 3 || username.length > 30) {
      return res.status(400).json({ error: 'Username must be 3-30 characters' });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }

    // Validate auth code
    const codeDoc = await AuthCode.findOne({ code: authCodeStr.trim() });
    if (!codeDoc) {
      return res.status(400).json({ error: 'Invalid auth code' });
    }
    if (codeDoc.status === 'blocked') {
      return res.status(400).json({ error: 'This auth code has been blocked' });
    }
    if (codeDoc.status === 'active' && codeDoc.connectedUser) {
      return res.status(400).json({ error: 'This auth code is already in use' });
    }

    const existing = await User.findOne({ username });
    if (existing) {
      return res.status(409).json({ error: 'Username already taken' });
    }

    const user = new User({ username, password, authCode: codeDoc._id });
    await user.save();

    // Mark auth code as active and connect to user
    codeDoc.status = 'active';
    codeDoc.connectedUser = user._id;
    await codeDoc.save();

    const token = jwt.sign({ userId: user._id }, process.env.JWT_SECRET, {
      expiresIn: '7d',
    });

    res.cookie('token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });

    res.status(201).json({ message: 'Account created successfully', username: user.username });
  } catch (err) {
    console.error('Register error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Login
router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;

    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required' });
    }

    const user = await User.findOne({ username });
    if (!user) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }

    const isMatch = await user.comparePassword(password);
    if (!isMatch) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }

    // Check auth code status on login
    if (user.authCode) {
      const codeDoc = await AuthCode.findById(user.authCode);
      if (!codeDoc || codeDoc.status === 'blocked') {
        return res.status(403).json({ error: 'Your access has been revoked' });
      }
    } else {
      return res.status(403).json({ error: 'No auth code linked to this account' });
    }

    const token = jwt.sign({ userId: user._id }, process.env.JWT_SECRET, {
      expiresIn: '7d',
    });

    res.cookie('token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });

    res.json({ message: 'Logged in successfully', username: user.username });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Get current user
router.get('/me', authenticateToken, requireAuthCode, async (req, res) => {
  try {
    const user = await User.findById(req.userId).select('-password');
    if (!user) return res.status(404).json({ error: 'User not found' });
    res.json({ username: user.username, email: user.email, createdAt: user.createdAt });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Add / update recovery email
router.put('/email', authenticateToken, requireAuthCode, async (req, res) => {
  try {
    const { email } = req.body;
    if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return res.status(400).json({ error: 'Valid email is required' });
    }

    await User.findByIdAndUpdate(req.userId, { email });
    res.json({ message: 'Recovery email saved' });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Forgot password — reset via username + email
router.post('/forgot-password', async (req, res) => {
  try {
    const { username, email, newPassword } = req.body;

    if (!username || !email || !newPassword) {
      return res.status(400).json({ error: 'All fields are required' });
    }
    if (newPassword.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }

    const user = await User.findOne({ username, email });
    if (!user) {
      return res.status(404).json({ error: 'No account found with that username and email' });
    }

    // Check auth code — blocked users can't reset password
    if (user.authCode) {
      const codeDoc = await AuthCode.findById(user.authCode);
      if (!codeDoc || codeDoc.status === 'blocked') {
        return res.status(403).json({ error: 'Your access has been revoked' });
      }
    } else {
      return res.status(403).json({ error: 'No auth code linked to this account' });
    }

    user.password = newPassword;
    await user.save();

    res.json({ message: 'Password reset successful. You can now login.' });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Logout
router.post('/logout', (_req, res) => {
  res.clearCookie('token');
  res.json({ message: 'Logged out' });
});

module.exports = router;
