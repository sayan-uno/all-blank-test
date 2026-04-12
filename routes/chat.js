const express = require('express');
const multer = require('multer');
const path = require('path');
const { v4: uuidv4 } = require('uuid');
const ChatMessage = require('../models/ChatMessage');
const CallLink = require('../models/CallLink');
const { authenticateToken, requireAuthCode } = require('../middleware/auth');

const router = express.Router();

// Multer storage config
const storage = multer.diskStorage({
  destination: (_req, _file, cb) => {
    cb(null, path.join(__dirname, '..', 'public', 'uploads'));
  },
  filename: (_req, file, cb) => {
    const ext = path.extname(file.originalname);
    cb(null, `${uuidv4().slice(0, 12)}${ext}`);
  },
});

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

    const fileUrl = `/uploads/${req.file.filename}`;
    res.json({
      url: fileUrl,
      fileName: req.file.originalname,
      fileSize: req.file.size,
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

// Clear chat (owner only)
router.delete('/:linkId/clear', authenticateToken, requireAuthCode, async (req, res) => {
  try {
    const link = await CallLink.findOne({ linkId: req.params.linkId, owner: req.userId });
    if (!link) return res.status(404).json({ error: 'Link not found' });

    await ChatMessage.deleteMany({ linkId: req.params.linkId });
    res.json({ message: 'Chat cleared' });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
