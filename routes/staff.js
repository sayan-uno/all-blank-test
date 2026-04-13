const express = require('express');
const { v4: uuidv4 } = require('uuid');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const StaffLink = require('../models/StaffLink');
const User = require('../models/User');
const AuthCode = require('../models/AuthCode');
const CallLink = require('../models/CallLink');
const CustomerLink = require('../models/CustomerLink');
const { authenticateToken, requireAuthCode } = require('../middleware/auth');

const router = express.Router();

// Create a staff invite link (owner only)
router.post('/', authenticateToken, requireAuthCode, async (req, res) => {
  try {
    const user = await User.findById(req.userId).select('role authCode');
    if (!user || user.role !== 'owner') {
      return res.status(403).json({ error: 'Only account owners can create staff links' });
    }

    const { username, secretCode, showVerifiedName, allowDelete } = req.body;
    if (!username || !username.trim()) {
      return res.status(400).json({ error: 'Username is required' });
    }
    if (username.trim().length < 3 || username.trim().length > 30) {
      return res.status(400).json({ error: 'Username must be 3-30 characters' });
    }
    if (!secretCode || secretCode.length < 4) {
      return res.status(400).json({ error: 'Secret code must be at least 4 characters' });
    }

    // Check if username is already taken
    const existingUser = await User.findOne({ username: username.trim() });
    if (existingUser) {
      return res.status(409).json({ error: 'Username already taken' });
    }

    // Check if username is already used in another staff/customer link
    const existingStaffLink = await StaffLink.findOne({ username: username.trim() });
    if (existingStaffLink) {
      return res.status(409).json({ error: 'Username already used in another staff link' });
    }
    const existingCustomerLink = await CustomerLink.findOne({ username: username.trim() });
    if (existingCustomerLink) {
      return res.status(409).json({ error: 'Username already used in another customer link' });
    }

    const staffLink = new StaffLink({
      linkId: 's-' + uuidv4().slice(0, 8),
      username: username.trim(),
      secretCode,
      showVerifiedName: !!showVerifiedName,
      allowDelete: !!allowDelete,
      owner: req.userId,
      authCode: user.authCode,
    });
    await staffLink.save();

    res.status(201).json({
      linkId: staffLink.linkId,
      username: staffLink.username,
      secretCode: staffLink.secretCode,
      showVerifiedName: staffLink.showVerifiedName,
      allowDelete: staffLink.allowDelete,
      status: staffLink.status,
      connectedUser: null,
      createdAt: staffLink.createdAt,
    });
  } catch (err) {
    console.error('Create staff link error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// List all staff links for current owner
router.get('/', authenticateToken, requireAuthCode, async (req, res) => {
  try {
    const user = await User.findById(req.userId).select('role');
    if (!user || user.role !== 'owner') {
      return res.status(403).json({ error: 'Only account owners can view staff links' });
    }

    const links = await StaffLink.find({ owner: req.userId })
      .sort({ createdAt: -1 })
      .populate('connectedUser', 'username');

    res.json(links.map(l => ({
      linkId: l.linkId,
      username: l.username,
      secretCode: l.secretCode,
      showVerifiedName: !!l.showVerifiedName,
      allowDelete: !!l.allowDelete,
      status: l.status,
      connectedUser: l.connectedUser ? l.connectedUser.username : null,
      createdAt: l.createdAt,
    })));
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Update staff link status (pause/unpause)
router.put('/:linkId/status', authenticateToken, requireAuthCode, async (req, res) => {
  try {
    const user = await User.findById(req.userId).select('role');
    if (!user || user.role !== 'owner') {
      return res.status(403).json({ error: 'Only account owners can manage staff links' });
    }

    const { status } = req.body;
    if (!['active', 'paused'].includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }

    const link = await StaffLink.findOne({ linkId: req.params.linkId, owner: req.userId });
    if (!link) return res.status(404).json({ error: 'Staff link not found' });

    const wasPaused = status === 'paused' && link.status !== 'paused';
    link.status = status;
    await link.save();

    // If paused, disconnect the staff user's socket
    if (wasPaused && link.connectedUser) {
      const io = req.app.locals.io;
      const onlineOwners = req.app.locals.onlineOwners;
      if (io && onlineOwners) {
        const userId = link.connectedUser.toString();
        const socketId = onlineOwners.get(userId);
        if (socketId) {
          const sock = io.sockets.sockets.get(socketId);
          if (sock) {
            sock.emit('auth-blocked');
            sock.disconnect(true);
          }
          onlineOwners.delete(userId);
        }
      }

      // Also pause all customer links created by this staff
      await CustomerLink.updateMany(
        { owner: link.connectedUser },
        { $set: { status: 'paused' } }
      );

      // Disconnect all customer users under this staff
      const customerLinks = await CustomerLink.find({ owner: link.connectedUser, connectedUser: { $ne: null } });
      for (const cl of customerLinks) {
        const custUserId = cl.connectedUser.toString();
        const custSocketId = onlineOwners?.get(custUserId);
        if (custSocketId && io) {
          const sock = io.sockets.sockets.get(custSocketId);
          if (sock) {
            sock.emit('auth-blocked');
            sock.disconnect(true);
          }
          onlineOwners.delete(custUserId);
        }
      }
    }

    // If unpaused, also unpause customer links that were auto-paused
    if (status === 'active' && link.connectedUser) {
      await CustomerLink.updateMany(
        { owner: link.connectedUser },
        { $set: { status: 'active' } }
      );
    }

    res.json({ message: `Staff link ${status}` });
  } catch (err) {
    console.error('Update staff link status error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Delete a staff link
router.delete('/:linkId', authenticateToken, requireAuthCode, async (req, res) => {
  try {
    const user = await User.findById(req.userId).select('role');
    if (!user || user.role !== 'owner') {
      return res.status(403).json({ error: 'Only account owners can delete staff links' });
    }

    const link = await StaffLink.findOne({ linkId: req.params.linkId, owner: req.userId });
    if (!link) return res.status(404).json({ error: 'Staff link not found' });

    // If staff user exists, clean up their data
    if (link.connectedUser) {
      // Delete staff's call links
      await CallLink.deleteMany({ owner: link.connectedUser });

      // Delete customer links created by this staff and their users/call links
      const customerLinks = await CustomerLink.find({ owner: link.connectedUser });
      for (const cl of customerLinks) {
        if (cl.connectedUser) {
          await CallLink.deleteMany({ owner: cl.connectedUser });
          await User.findByIdAndDelete(cl.connectedUser);
        }
      }
      await CustomerLink.deleteMany({ owner: link.connectedUser });

      // Disconnect staff socket
      const io = req.app.locals.io;
      const onlineOwners = req.app.locals.onlineOwners;
      if (io && onlineOwners) {
        const userId = link.connectedUser.toString();
        const socketId = onlineOwners.get(userId);
        if (socketId) {
          const sock = io.sockets.sockets.get(socketId);
          if (sock) { sock.emit('auth-blocked'); sock.disconnect(true); }
          onlineOwners.delete(userId);
        }
      }

      // Delete staff user
      await User.findByIdAndDelete(link.connectedUser);
    }

    await StaffLink.findByIdAndDelete(link._id);
    res.json({ message: 'Staff link deleted' });
  } catch (err) {
    console.error('Delete staff link error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Public: get staff link info (for join page)
router.get('/join/:linkId', async (req, res) => {
  try {
    const link = await StaffLink.findOne({ linkId: req.params.linkId });
    if (!link) return res.status(404).json({ error: 'Staff link not found' });

    // Check auth code
    const authCode = await AuthCode.findById(link.authCode);
    if (!authCode || authCode.status === 'blocked') {
      return res.json({ suspended: true });
    }

    if (link.status === 'paused') {
      return res.json({ paused: true });
    }

    if (link.connectedUser) {
      return res.json({ alreadyJoined: true, username: link.username });
    }

    res.json({
      linkId: link.linkId,
      username: link.username,
      suspended: false,
      paused: false,
      alreadyJoined: false,
    });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Public: join as staff
router.post('/join/:linkId', async (req, res) => {
  try {
    const { secretCode } = req.body;
    if (!secretCode) {
      return res.status(400).json({ error: 'Secret code is required' });
    }

    const link = await StaffLink.findOne({ linkId: req.params.linkId });
    if (!link) return res.status(404).json({ error: 'Staff link not found' });

    // Check auth code
    const authCode = await AuthCode.findById(link.authCode);
    if (!authCode || authCode.status === 'blocked') {
      return res.status(403).json({ error: 'Service suspended' });
    }

    if (link.status === 'paused') {
      return res.status(403).json({ error: 'This staff link is paused' });
    }

    if (link.connectedUser) {
      return res.status(400).json({ error: 'This staff link is already in use' });
    }

    if (secretCode !== link.secretCode) {
      return res.status(401).json({ error: 'Invalid code' });
    }

    // Create the staff user account
    const staffUser = new User({
      username: link.username,
      password: secretCode, // code becomes password
      role: 'staff',
      parentUser: link.owner,
      authCode: link.authCode,
    });
    await staffUser.save();

    // Link the user to the staff link
    link.connectedUser = staffUser._id;
    await link.save();

    // Log them in
    const token = jwt.sign({ userId: staffUser._id }, process.env.JWT_SECRET, {
      expiresIn: '7d',
    });
    res.cookie('token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });

    res.status(201).json({ message: 'Staff account created', username: staffUser.username });
  } catch (err) {
    console.error('Staff join error:', err);
    if (err.code === 11000) {
      return res.status(409).json({ error: 'Username already taken' });
    }
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
