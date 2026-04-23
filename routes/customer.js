const express = require('express');
const { v4: uuidv4 } = require('uuid');
const jwt = require('jsonwebtoken');
const CustomerLink = require('../models/CustomerLink');
const StaffLink = require('../models/StaffLink');
const User = require('../models/User');
const AuthCode = require('../models/AuthCode');
const CallLink = require('../models/CallLink');
const { authenticateToken, requireAuthCode } = require('../middleware/auth');

const router = express.Router();

// Create a customer invite link (owner or staff)
router.post('/', authenticateToken, requireAuthCode, async (req, res) => {
  try {
    const user = await User.findById(req.userId).select('role authCode');
    if (!user || (user.role !== 'owner' && user.role !== 'staff')) {
      return res.status(403).json({ error: 'Only owners and staff can create customer links' });
    }

    const { username, secretCode } = req.body;
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
    const existingStaffLink = await StaffLink.findOne({ username: username.trim() });
    if (existingStaffLink) {
      return res.status(409).json({ error: 'Username already used in a staff link' });
    }
    const existingCustomerLink = await CustomerLink.findOne({ username: username.trim() });
    if (existingCustomerLink) {
      return res.status(409).json({ error: 'Username already used in another customer link' });
    }

    // Get the root auth code (for staff, it's inherited from parent)
    const authCodeId = user.authCode;

    const customerLink = new CustomerLink({
      linkId: 'c-' + uuidv4().slice(0, 8),
      username: username.trim(),
      secretCode,
      owner: req.userId,
      authCode: authCodeId,
    });
    await customerLink.save();

    res.status(201).json({
      linkId: customerLink.linkId,
      username: customerLink.username,
      secretCode: customerLink.secretCode,
      status: customerLink.status,
      connectedUser: null,
      createdAt: customerLink.createdAt,
    });
  } catch (err) {
    console.error('Create customer link error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// List customer links created by current user
router.get('/', authenticateToken, requireAuthCode, async (req, res) => {
  try {
    const user = await User.findById(req.userId).select('role');
    if (!user || (user.role !== 'owner' && user.role !== 'staff')) {
      return res.status(403).json({ error: 'Only owners and staff can view customer links' });
    }

    const { limit = 10, skip = 0, search = '' } = req.query;
    let query = { owner: req.userId };
    if (search) {
      query.username = { $regex: search, $options: 'i' };
    }

    const totalCount = await CustomerLink.countDocuments(query);
    const links = await CustomerLink.find(query)
      .sort({ createdAt: -1 })
      .skip(Number(skip))
      .limit(Number(limit))
      .populate('connectedUser', 'username');

    res.json({
      items: links.map(l => ({
        linkId: l.linkId,
        username: l.username,
        secretCode: l.secretCode,
        status: l.status,
        connectedUser: l.connectedUser ? l.connectedUser.username : null,
        createdAt: l.createdAt,
      })),
      totalCount,
      hasMore: Number(skip) + Number(limit) < totalCount
    });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Update customer link status (pause/unpause)
router.put('/:linkId/status', authenticateToken, requireAuthCode, async (req, res) => {
  try {
    const { status } = req.body;
    if (!['active', 'paused'].includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }

    const link = await CustomerLink.findOne({ linkId: req.params.linkId, owner: req.userId });
    if (!link) return res.status(404).json({ error: 'Customer link not found' });

    const wasPaused = status === 'paused' && link.status !== 'paused';
    link.status = status;
    await link.save();

    // If paused, disconnect the customer user
    if (wasPaused && link.connectedUser) {
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
    }

    res.json({ message: `Customer link ${status}` });
  } catch (err) {
    console.error('Update customer link status error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Delete a customer link
router.delete('/:linkId', authenticateToken, requireAuthCode, async (req, res) => {
  try {
    const currentUser = await User.findById(req.userId).select('role authCode');
    if (!currentUser || (currentUser.role !== 'owner' && currentUser.role !== 'staff')) {
      return res.status(403).json({ error: 'Only owners and staff can delete customer links' });
    }

    const ac = currentUser.authCode ? await AuthCode.findById(currentUser.authCode).lean() : null;
    let canDelete = false;
    if (currentUser.role === 'owner' && ac && ac.allowDelete) canDelete = true;
    if (currentUser.role === 'staff' && ac && ac.allowDelete) {
        const sl = await StaffLink.findOne({ connectedUser: req.userId });
        if (sl && sl.allowDelete) canDelete = true;
    }

    if (!canDelete) {
      return res.status(403).json({ error: 'Delete permission not granted for your account' });
    }

    const link = await CustomerLink.findOne({ linkId: req.params.linkId, owner: req.userId });
    if (!link) return res.status(404).json({ error: 'Customer link not found' });

    if (link.connectedUser) {
      // Delete customer's call links
      await CallLink.deleteMany({ owner: link.connectedUser });

      // Disconnect socket
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

      // Delete customer user
      await User.findByIdAndDelete(link.connectedUser);
    }

    await CustomerLink.findByIdAndDelete(link._id);
    res.json({ message: 'Customer link deleted' });
  } catch (err) {
    console.error('Delete customer link error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Public: get customer link info (for join page)
router.get('/join/:linkId', async (req, res) => {
  try {
    const link = await CustomerLink.findOne({ linkId: req.params.linkId });
    if (!link) return res.status(404).json({ error: 'Customer link not found' });

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

// Public: join as customer
router.post('/join/:linkId', async (req, res) => {
  try {
    const { secretCode, fcmToken } = req.body;
    if (!secretCode) {
      return res.status(400).json({ error: 'Secret code is required' });
    }

    const link = await CustomerLink.findOne({ linkId: req.params.linkId });
    if (!link) return res.status(404).json({ error: 'Customer link not found' });

    const authCode = await AuthCode.findById(link.authCode);
    if (!authCode || authCode.status === 'blocked') {
      return res.status(403).json({ error: 'Service suspended' });
    }

    if (link.status === 'paused') {
      return res.status(403).json({ error: 'This customer link is paused' });
    }

    if (link.connectedUser) {
      return res.status(400).json({ error: 'This customer link is already in use' });
    }

    if (secretCode !== link.secretCode) {
      return res.status(401).json({ error: 'Invalid code' });
    }

    const customerUser = new User({
      username: link.username,
      password: secretCode,
      role: 'customer',
      parentUser: link.owner,
      authCode: link.authCode,
    });
    await customerUser.save();

    // Handle FCM token — clear from any other user first, then assign
    if (fcmToken) {
      await User.updateMany({ fcmToken, _id: { $ne: customerUser._id } }, { $set: { fcmToken: null } });
      customerUser.fcmToken = fcmToken;
      await customerUser.save();
    }

    link.connectedUser = customerUser._id;
    await link.save();

    const token = jwt.sign({ userId: customerUser._id }, process.env.JWT_SECRET, {
      expiresIn: '7d',
    });
    res.cookie('token', token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === 'production',
      sameSite: 'lax',
      maxAge: 7 * 24 * 60 * 60 * 1000,
    });

    res.status(201).json({ message: 'Customer account created', username: customerUser.username });
  } catch (err) {
    console.error('Customer join error:', err);
    if (err.code === 11000) {
      return res.status(409).json({ error: 'Username already taken' });
    }
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
