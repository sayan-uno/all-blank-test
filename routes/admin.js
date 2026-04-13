const express = require('express');
const jwt = require('jsonwebtoken');
const crypto = require('crypto');
const AuthCode = require('../models/AuthCode');
const User = require('../models/User');

const router = express.Router();

// Rate limiting for login attempts (in-memory)
const loginAttempts = new Map();
const MAX_ATTEMPTS = 5;
const LOCKOUT_MS = 15 * 60 * 1000;

function checkRateLimit(ip) {
  const entry = loginAttempts.get(ip);
  if (!entry) return true;
  if (Date.now() - entry.lastAttempt > LOCKOUT_MS) {
    loginAttempts.delete(ip);
    return true;
  }
  return entry.count < MAX_ATTEMPTS;
}

function recordAttempt(ip) {
  const entry = loginAttempts.get(ip) || { count: 0, lastAttempt: 0 };
  entry.count += 1;
  entry.lastAttempt = Date.now();
  loginAttempts.set(ip, entry);
}

function clearAttempts(ip) {
  loginAttempts.delete(ip);
}

function safeCompare(a, b) {
  if (typeof a !== 'string' || typeof b !== 'string') return false;
  const bufA = Buffer.from(a);
  const bufB = Buffer.from(b);
  if (bufA.length !== bufB.length) return false;
  return crypto.timingSafeEqual(bufA, bufB);
}

// Admin login
router.post('/login', (req, res) => {
  const ip = req.ip;
  if (!checkRateLimit(ip)) {
    return res.status(429).json({ error: 'Too many attempts. Try again in 15 minutes.' });
  }

  const { urlSecret, password } = req.body;
  if (!urlSecret || !password) {
    recordAttempt(ip);
    return res.status(401).json({ error: 'Access denied' });
  }

  const validUrl = safeCompare(urlSecret, process.env.ADMIN_URL_SECRET || '');
  const validPw = safeCompare(password, process.env.ADMIN_PASSWORD || '');

  if (!validUrl || !validPw) {
    recordAttempt(ip);
    return res.status(401).json({ error: 'Invalid credentials' });
  }

  clearAttempts(ip);
  const token = jwt.sign({ admin: true }, process.env.JWT_SECRET, { expiresIn: '2h' });
  res.json({ token });
});

// Middleware to verify admin token
function authenticateAdmin(req, res, next) {
  const auth = req.headers.authorization;
  if (!auth || !auth.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Not authenticated' });
  }
  try {
    const decoded = jwt.verify(auth.split(' ')[1], process.env.JWT_SECRET);
    if (!decoded.admin) return res.status(403).json({ error: 'Not admin' });
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

// Generate a new auth code
router.post('/generate-code', authenticateAdmin, async (req, res) => {
  try {
    const code = `AC-${crypto.randomBytes(4).toString('hex')}-${crypto.randomBytes(4).toString('hex')}-${crypto.randomBytes(4).toString('hex')}`;
    const verifiedName = req.body.verifiedName?.trim() || null;
    const allowDelete = !!req.body.allowDelete;
    const authCode = new AuthCode({ code, verifiedName, allowDelete });
    await authCode.save();
    res.json({
      _id: authCode._id,
      code: authCode.code,
      status: authCode.status,
      verifiedName: authCode.verifiedName,
      allowDelete: authCode.allowDelete,
      createdAt: authCode.createdAt,
    });
  } catch (err) {
    console.error('Generate code error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// List auth codes with pagination
router.get('/codes', authenticateAdmin, async (req, res) => {
  try {
    const skip = parseInt(req.query.skip) || 0;
    const limit = parseInt(req.query.limit) || 10;

    const [codes, total] = await Promise.all([
      AuthCode.find({})
        .sort({ createdAt: -1 })
        .skip(skip)
        .limit(limit)
        .populate('connectedUser', 'username')
        .lean(),
      AuthCode.countDocuments(),
    ]);

    res.json({
      codes: codes.map(c => ({
        _id: c._id,
        code: c.code,
        status: c.status,
        verifiedName: c.verifiedName || null,
        allowDelete: !!c.allowDelete,
        username: c.connectedUser?.username || null,
        createdAt: c.createdAt,
      })),
      total,
      hasMore: skip + limit < total,
    });
  } catch (err) {
    console.error('List codes error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Update verified name on an auth code
router.put('/codes/:codeId/name', authenticateAdmin, async (req, res) => {
  try {
    const verifiedName = req.body.verifiedName?.trim() || null;
    const codeDoc = await AuthCode.findById(req.params.codeId);
    if (!codeDoc) return res.status(404).json({ error: 'Code not found' });
    codeDoc.verifiedName = verifiedName;
    await codeDoc.save();
    res.json({ message: verifiedName ? 'Verified name set' : 'Verified name removed', verifiedName });
  } catch (err) {
    console.error('Update name error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Block / unblock an auth code
router.put('/codes/:codeId/status', authenticateAdmin, async (req, res) => {
  try {
    const { status } = req.body;
    if (!['active', 'blocked', 'ready'].includes(status)) {
      return res.status(400).json({ error: 'Invalid status' });
    }

    const codeDoc = await AuthCode.findById(req.params.codeId);
    if (!codeDoc) return res.status(404).json({ error: 'Code not found' });

    const wasBlocked = status === 'blocked' && codeDoc.status !== 'blocked';

    codeDoc.status = status;
    await codeDoc.save();

    // If we just blocked, forcefully disconnect the user's socket
    if (wasBlocked && codeDoc.connectedUser) {
      const io = req.app.locals.io;
      const onlineOwners = req.app.locals.onlineOwners;
      if (io && onlineOwners) {
        const userId = codeDoc.connectedUser.toString();
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
    }

    res.json({ message: `Code ${status}` });
  } catch (err) {
    console.error('Update code status error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Toggle delete authorization on an auth code
router.put('/codes/:codeId/delete-auth', authenticateAdmin, async (req, res) => {
  try {
    const { allowDelete } = req.body;
    const codeDoc = await AuthCode.findById(req.params.codeId);
    if (!codeDoc) return res.status(404).json({ error: 'Code not found' });
    codeDoc.allowDelete = !!allowDelete;
    await codeDoc.save();
    res.json({ message: allowDelete ? 'Delete permission enabled' : 'Delete permission disabled', allowDelete: codeDoc.allowDelete });
  } catch (err) {
    console.error('Update delete auth error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
