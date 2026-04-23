const express = require('express');
const crypto = require('crypto');
const { v4: uuidv4 } = require('uuid');
const ApiEndpoint = require('../models/ApiEndpoint');
const CallLink = require('../models/CallLink');
const User = require('../models/User');
const AuthCode = require('../models/AuthCode');
const { authenticateToken, requireAuthCode } = require('../middleware/auth');

const router = express.Router();

// ========== AUTHENTICATED ENDPOINTS ==========

// Generate or update API endpoint configuration
router.post('/generate', authenticateToken, requireAuthCode, async (req, res) => {
  try {
    const {
      schedule,
      timezone,
      expiresAt,
      fallbackMessage,
      callEnabled,
      chatEnabled,
      chatSeenEnabled,
    } = req.body;

    // Validate schedule if provided
    if (schedule && Array.isArray(schedule) && schedule.length > 0) {
      for (const s of schedule) {
        if (s.day < 0 || s.day > 6) return res.status(400).json({ error: 'Invalid day value' });
        if (!/^\d{2}:\d{2}$/.test(s.startTime) || !/^\d{2}:\d{2}$/.test(s.endTime)) {
          return res.status(400).json({ error: 'Time must be in HH:MM format' });
        }
      }
    }

    // Validate expiry
    let parsedExpiry = null;
    if (expiresAt) {
      const d = new Date(expiresAt);
      if (isNaN(d.getTime())) return res.status(400).json({ error: 'Invalid expiry date' });
      parsedExpiry = d;
    }

    // Validate fallback message
    if (fallbackMessage && fallbackMessage.length > 200) {
      return res.status(400).json({ error: 'Fallback message must be 200 chars or less' });
    }

    // Ensure at least one is enabled
    const isCallOn = callEnabled !== undefined ? !!callEnabled : true;
    const isChatOn = !!chatEnabled;
    if (!isCallOn && !isChatOn) {
      return res.status(400).json({ error: 'Enable at least calling or chat' });
    }

    // Check if user already has an endpoint
    let endpoint = await ApiEndpoint.findOne({ owner: req.userId });

    if (endpoint) {
      // Update existing endpoint config (keep same apiKey and generatedLinks)
      endpoint.schedule = (schedule && Array.isArray(schedule)) ? schedule : [];
      endpoint.timezone = timezone === 'IST' ? 'IST' : 'UTC';
      endpoint.expiresAt = parsedExpiry;
      endpoint.fallbackMessage = (fallbackMessage || '').trim();
      endpoint.callEnabled = isCallOn;
      endpoint.chatEnabled = isChatOn;
      endpoint.chatSeenEnabled = !!chatSeenEnabled;
      await endpoint.save();
    } else {
      // Create new endpoint
      const apiKey = crypto.randomBytes(16).toString('hex'); // 32-char hex
      endpoint = new ApiEndpoint({
        owner: req.userId,
        apiKey,
        schedule: (schedule && Array.isArray(schedule)) ? schedule : [],
        timezone: timezone === 'IST' ? 'IST' : 'UTC',
        expiresAt: parsedExpiry,
        fallbackMessage: (fallbackMessage || '').trim(),
        callEnabled: isCallOn,
        chatEnabled: isChatOn,
        chatSeenEnabled: !!chatSeenEnabled,
      });
      await endpoint.save();
    }

    res.json({
      message: endpoint.isNew === false ? 'API endpoint updated' : 'API endpoint created',
      apiKey: endpoint.apiKey,
      apiUrl: `/api/webhook/${endpoint.apiKey}`,
      config: {
        schedule: endpoint.schedule,
        timezone: endpoint.timezone,
        expiresAt: endpoint.expiresAt,
        fallbackMessage: endpoint.fallbackMessage,
        callEnabled: endpoint.callEnabled,
        chatEnabled: endpoint.chatEnabled,
        chatSeenEnabled: endpoint.chatSeenEnabled,
      },
      totalLinks: endpoint.generatedLinks.length,
    });
  } catch (err) {
    console.error('API generate error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Regenerate API key (new key, keep config and links)
router.post('/regenerate-key', authenticateToken, requireAuthCode, async (req, res) => {
  try {
    const endpoint = await ApiEndpoint.findOne({ owner: req.userId });
    if (!endpoint) return res.status(404).json({ error: 'No API endpoint found. Generate one first.' });

    endpoint.apiKey = crypto.randomBytes(16).toString('hex');
    await endpoint.save();

    res.json({
      message: 'API key regenerated. Old key is now invalid.',
      apiKey: endpoint.apiKey,
      apiUrl: `/api/webhook/${endpoint.apiKey}`,
    });
  } catch (err) {
    console.error('API regenerate key error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get current API endpoint config
router.get('/config', authenticateToken, requireAuthCode, async (req, res) => {
  try {
    const endpoint = await ApiEndpoint.findOne({ owner: req.userId });
    if (!endpoint) return res.json({ exists: false });

    res.json({
      exists: true,
      apiKey: endpoint.apiKey,
      apiUrl: `/api/webhook/${endpoint.apiKey}`,
      config: {
        schedule: endpoint.schedule,
        timezone: endpoint.timezone,
        expiresAt: endpoint.expiresAt,
        fallbackMessage: endpoint.fallbackMessage,
        callEnabled: endpoint.callEnabled,
        chatEnabled: endpoint.chatEnabled,
        chatSeenEnabled: endpoint.chatSeenEnabled,
      },
      totalLinks: endpoint.generatedLinks.length,
      createdAt: endpoint.createdAt,
    });
  } catch (err) {
    console.error('API config error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// List all links generated via this API endpoint
router.get('/links', authenticateToken, requireAuthCode, async (req, res) => {
  try {
    const endpoint = await ApiEndpoint.findOne({ owner: req.userId });
    if (!endpoint) return res.json({ links: [] });

    // Return the generated links with most recent first
    const links = [...endpoint.generatedLinks]
      .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));

    res.json({ links, total: links.length });
  } catch (err) {
    console.error('API links list error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Revoke (delete) the API endpoint
router.delete('/revoke', authenticateToken, requireAuthCode, async (req, res) => {
  try {
    const endpoint = await ApiEndpoint.findOneAndDelete({ owner: req.userId });
    if (!endpoint) return res.status(404).json({ error: 'No API endpoint found' });

    // Note: generated CallLinks are NOT deleted — they continue to work independently
    res.json({ message: 'API endpoint revoked. Generated links still work but no new links can be created via the old URL.' });
  } catch (err) {
    console.error('API revoke error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// ========== PUBLIC WEBHOOK ENDPOINT ==========

// POST /api/webhook/:apiKey — receives { username } from external sites
router.post('/:apiKey', async (req, res) => {
  try {
    const { apiKey } = req.params;
    const { username } = req.body;

    // Find the API endpoint
    const endpoint = await ApiEndpoint.findOne({ apiKey });
    if (!endpoint) {
      return res.status(404).json({ success: false, error: 'Invalid API key' });
    }

    // Validate username
    if (!username || typeof username !== 'string' || !username.trim()) {
      return res.status(400).json({ success: false, error: 'Username is required in the JSON body' });
    }

    const cleanUsername = username.trim();

    // Validate username length
    if (cleanUsername.length < 1 || cleanUsername.length > 50) {
      return res.status(400).json({ success: false, error: 'Username must be between 1 and 50 characters' });
    }

    // Check for duplicate username on this endpoint
    const existing = endpoint.generatedLinks.find(
      (link) => link.externalUsername.toLowerCase() === cleanUsername.toLowerCase()
    );
    if (existing) {
      return res.status(409).json({
        success: false,
        error: `Username "${cleanUsername}" already has a link on this account`,
        existingLinkId: existing.callLinkId,
        existingCallUrl: `/call/${existing.callLinkId}`,
      });
    }

    // Check max links limit (500)
    if (endpoint.generatedLinks.length >= 500) {
      return res.status(429).json({
        success: false,
        error: 'Maximum link limit (500) reached for this API endpoint',
      });
    }

    // Verify the owner account is still active
    const owner = await User.findById(endpoint.owner).populate('authCode');
    if (!owner || !owner.authCode) {
      return res.status(403).json({ success: false, error: 'Account not available' });
    }
    const authCode = await AuthCode.findById(owner.authCode);
    if (!authCode || authCode.status === 'blocked') {
      return res.status(403).json({ success: false, error: 'Account suspended' });
    }

    // Create the CallLink with the endpoint's default config
    const linkId = uuidv4().slice(0, 8);
    const linkData = {
      linkId,
      name: cleanUsername, // Use the external username as the link name
      owner: endpoint.owner,
      timezone: endpoint.timezone,
      callEnabled: endpoint.callEnabled,
      chatEnabled: endpoint.chatEnabled,
      chatSeenEnabled: endpoint.chatSeenEnabled,
    };

    if (endpoint.schedule && endpoint.schedule.length > 0) {
      linkData.schedule = endpoint.schedule;
    }

    if (endpoint.expiresAt) {
      linkData.expiresAt = endpoint.expiresAt;
    }

    if (endpoint.fallbackMessage) {
      linkData.fallbackMessage = endpoint.fallbackMessage;
    }

    const callLink = new CallLink(linkData);
    await callLink.save();

    // Add to generated links tracking
    endpoint.generatedLinks.push({
      externalUsername: cleanUsername,
      callLinkId: linkId,
    });
    await endpoint.save();

    // Return the call URL
    res.status(201).json({
      success: true,
      username: cleanUsername,
      linkId,
      callUrl: `/call/${linkId}`,
    });
  } catch (err) {
    console.error('Webhook error:', err);
    res.status(500).json({ success: false, error: 'Server error' });
  }
});

module.exports = router;
