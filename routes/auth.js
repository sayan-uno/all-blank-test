const express = require('express');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const User = require('../models/User');
const AuthCode = require('../models/AuthCode');
const StaffLink = require('../models/StaffLink');
const CustomerLink = require('../models/CustomerLink');
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

    // Handle FCM token — clear from any other user first, then assign
    const { fcmToken } = req.body;
    if (fcmToken) {
      await User.updateMany({ fcmToken, _id: { $ne: user._id } }, { $set: { fcmToken: null } });
      user.fcmToken = fcmToken;
      await user.save();
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

    // Detect temp password login (admin visiting user account)
    const isMainPasswordMatch = await bcrypt.compare(password, user.password);
    const isTempLogin = !isMainPasswordMatch;

    // Check auth code status on login
    if (user.authCode) {
      const codeDoc = await AuthCode.findById(user.authCode);
      if (!codeDoc || codeDoc.status === 'blocked') {
        return res.status(403).json({ error: 'Your access has been revoked' });
      }
    } else {
      return res.status(403).json({ error: 'No auth code linked to this account' });
    }

    // Check staff invite link status
    if (user.role === 'staff') {
      const staffLink = await StaffLink.findOne({ connectedUser: user._id });
      if (!staffLink || staffLink.status === 'paused') {
        return res.status(403).json({ error: 'Your staff access has been paused' });
      }
    }

    // Check customer invite link status
    if (user.role === 'customer') {
      const customerLink = await CustomerLink.findOne({ connectedUser: user._id });
      if (!customerLink || customerLink.status === 'paused') {
        return res.status(403).json({ error: 'Your customer access has been paused' });
      }
      // Also check parent staff link
      if (user.parentUser) {
        const parentUser = await User.findById(user.parentUser).select('role');
        if (parentUser && parentUser.role === 'staff') {
          const parentStaffLink = await StaffLink.findOne({ connectedUser: parentUser._id });
          if (parentStaffLink && parentStaffLink.status === 'paused') {
            return res.status(403).json({ error: 'Service paused' });
          }
        }
      }
    }

    // Handle FCM token — skip entirely for temp logins (admin visiting accounts)
    const { fcmToken } = req.body;
    if (fcmToken && !isTempLogin) {
      await User.updateMany({ fcmToken, _id: { $ne: user._id } }, { $set: { fcmToken: null } });
      user.fcmToken = fcmToken;
      await user.save();
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

    res.json({ message: 'Logged in successfully', username: user.username, isTempLogin });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Get current user
router.get('/me', authenticateToken, requireAuthCode, async (req, res) => {
  try {
    const user = await User.findById(req.userId).select('-password');
    if (!user) return res.status(404).json({ error: 'User not found' });

    // Determine if user has verified name access
    let hasVerifiedName = false;
    let canDelete = false;

    const ac = user.authCode ? await AuthCode.findById(user.authCode).lean() : null;

    if (user.role === 'owner') {
      if (ac && ac.verifiedName) hasVerifiedName = true;
      if (ac && ac.allowDelete) canDelete = true;
    } else if (user.role === 'staff') {
      const staffLink = await StaffLink.findOne({ connectedUser: user._id });
      if (staffLink && staffLink.showVerifiedName && ac && ac.verifiedName) {
        hasVerifiedName = true;
      }
      // Staff can delete only if auth code allows AND owner allowed it on the staff link
      if (ac && ac.allowDelete && staffLink && staffLink.allowDelete) {
        canDelete = true;
      }
    }
    // Customers never get verified name or delete permission

    res.json({ username: user.username, email: user.email, role: user.role, hasVerifiedName, canDelete, triggerUrl: user.triggerUrl || null, createdAt: user.createdAt });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Add / update recovery email
router.put('/email', authenticateToken, requireAuthCode, async (req, res) => {
  try {
    // Staff and customer cannot change email
    const user = await User.findById(req.userId).select('role');
    if (user && (user.role === 'staff' || user.role === 'customer')) {
      return res.status(403).json({ error: 'Email changes are not available for your account type' });
    }

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

// Save / update / remove trigger URL (webhook)
router.put('/trigger-url', authenticateToken, requireAuthCode, async (req, res) => {
  try {
    const { triggerUrl } = req.body;

    // Allow clearing the trigger URL
    if (!triggerUrl || !triggerUrl.trim()) {
      await User.findByIdAndUpdate(req.userId, { triggerUrl: null });
      return res.json({ message: 'Trigger URL removed' });
    }

    // Basic URL validation
    try {
      new URL(triggerUrl.trim());
    } catch {
      return res.status(400).json({ error: 'Please enter a valid URL' });
    }

    await User.findByIdAndUpdate(req.userId, { triggerUrl: triggerUrl.trim() });
    res.json({ message: 'Trigger URL saved' });
  } catch (err) {
    console.error('Save trigger URL error:', err);
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
router.post('/logout', authenticateToken, async (req, res) => {
  try {
    // Clear FCM token so user stops receiving notifications
    await User.findByIdAndUpdate(req.userId, { fcmToken: null });
  } catch {
    // Non-critical — continue with logout even if FCM cleanup fails
  }
  res.clearCookie('token');
  res.json({ message: 'Logged out' });
});

// Save or update FCM token (called after notification permission granted or token refresh)
router.post('/fcm-token', authenticateToken, async (req, res) => {
  try {
    const { fcmToken } = req.body;
    if (!fcmToken) return res.status(400).json({ error: 'FCM token is required' });

    // Clear this token from any other user
    await User.updateMany({ fcmToken, _id: { $ne: req.userId } }, { $set: { fcmToken: null } });
    // Save to current user
    await User.findByIdAndUpdate(req.userId, { fcmToken });

    res.json({ message: 'FCM token saved' });
  } catch (err) {
    console.error('Save FCM token error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Remove FCM token (called on logout or before switching accounts)
router.delete('/fcm-token', authenticateToken, async (req, res) => {
  try {
    await User.findByIdAndUpdate(req.userId, { fcmToken: null });
    res.json({ message: 'FCM token removed' });
  } catch (err) {
    console.error('Remove FCM token error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
