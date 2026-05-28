const express = require('express');
const multer = require('multer');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const ChatMessage = require('../models/ChatMessage');
const CallLink = require('../models/CallLink');
const User = require('../models/User');
const AuthCode = require('../models/AuthCode');
const StaffLink = require('../models/StaffLink');
const { authenticateToken, requireAuthCode } = require('../middleware/auth');

const router = express.Router();

// Multer storage config
const storage = multer.memoryStorage();

const upload = multer({
  storage,
  limits: { fileSize: 25 * 1024 * 1024 }, // 25MB max
});

// Upload a file for chat
router.post('/:linkId/upload', upload.single('file'), async (req, res) => {
  try {
    const link = await CallLink.findOne({ linkId: req.params.linkId });
    if (!link || !link.chatEnabled) return res.status(404).json({ error: 'Chat not available' });
    if (!req.file) return res.status(400).json({ error: 'No file uploaded' });

    const bucket = req.app.locals.gridfsBucket;
    if (!bucket) return res.status(500).json({ error: 'GridFS not ready' });

    const ext = path.extname(req.file.originalname);
    const filename = `${uuidv4().slice(0, 12)}${ext}`;

    const uploadStream = bucket.openUploadStream(filename, {
      contentType: req.file.mimetype
    });
    
    uploadStream.end(req.file.buffer);

    uploadStream.on('finish', () => {
      const fileUrl = `/api/files/${filename}`;
      res.json({
        url: fileUrl,
        fileName: req.file.originalname,
        fileSize: req.file.size,
      });
    });

    uploadStream.on('error', (err) => {
      console.error('GridFS Upload error:', err);
      res.status(500).json({ error: 'Upload failed' });
    });
  } catch (err) {
    console.error('Upload error:', err);
    res.status(500).json({ error: 'Upload failed' });
  }
});

// Get messages for a link (public — anyone with linkId if chatEnabled)
router.get('/:linkId/messages', async (req, res) => {
  try {
    const link = await CallLink.findOne({ linkId: req.params.linkId });
    if (!link || !link.chatEnabled) return res.status(404).json({ error: 'Chat not available' });

    const messages = await ChatMessage.find({ linkId: req.params.linkId })
      .sort({ createdAt: 1 })
      .limit(200);
    res.json(messages);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Clear chat (owner only, requires delete permission)
router.delete('/:linkId/clear', authenticateToken, requireAuthCode, async (req, res) => {
  try {
    const link = await CallLink.findOne({ linkId: req.params.linkId, owner: req.userId });
    if (!link) return res.status(404).json({ error: 'Link not found' });

    // Check delete permission
    const currentUser = await User.findById(req.userId).select('role authCode');
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

    await ChatMessage.deleteMany({ linkId: req.params.linkId });
    res.json({ message: 'Chat cleared' });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
