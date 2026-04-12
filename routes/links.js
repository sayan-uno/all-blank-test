const express = require('express');
const { v4: uuidv4 } = require('uuid');
const jwt = require('jsonwebtoken');
const CallLink = require('../models/CallLink');
const CallHistory = require('../models/CallHistory');
const ChatMessage = require('../models/ChatMessage');

const router = express.Router();

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

// Convert 24h "HH:MM" to 12h "h:MM AM/PM"
function to12Hour(time24) {
  const [h, m] = time24.split(':').map(Number);
  const period = h >= 12 ? 'PM' : 'AM';
  const hour12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
  return m === 0 ? `${hour12} ${period}` : `${hour12}:${String(m).padStart(2, '0')} ${period}`;
}

// Get current time in the given timezone
function getNowInTimezone(tz) {
  const now = new Date();
  if (tz === 'IST') {
    // IST = UTC + 5:30
    const utcMs = now.getTime() + now.getTimezoneOffset() * 60000;
    return new Date(utcMs + 5.5 * 3600000);
  }
  // UTC
  const utcMs = now.getTime() + now.getTimezoneOffset() * 60000;
  return new Date(utcMs);
}

// Check if current time falls within a schedule
function isWithinSchedule(schedule, timezone) {
  if (!schedule || schedule.length === 0) return { available: true };

  const now = getNowInTimezone(timezone || 'UTC');
  const currentDay = now.getDay(); // 0=Sun .. 6=Sat
  const currentMinutes = now.getHours() * 60 + now.getMinutes();

  const todaySlots = schedule.filter(s => s.day === currentDay);
  if (todaySlots.length === 0) {
    return { available: false, reason: formatScheduleMessage(schedule, timezone) };
  }

  for (const slot of todaySlots) {
    const [sh, sm] = slot.startTime.split(':').map(Number);
    const [eh, em] = slot.endTime.split(':').map(Number);
    const start = sh * 60 + sm;
    const end = eh * 60 + em;
    if (currentMinutes >= start && currentMinutes < end) {
      return { available: true };
    }
  }

  return { available: false, reason: formatScheduleMessage(schedule, timezone) };
}

function formatScheduleMessage(schedule, timezone) {
  const dayNames = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
  const tzLabel = timezone === 'IST' ? 'IST' : 'UTC';
  const grouped = {};
  for (const s of schedule) {
    if (!grouped[s.day]) grouped[s.day] = [];
    grouped[s.day].push(`${to12Hour(s.startTime)} to ${to12Hour(s.endTime)}`);
  }
  const parts = Object.entries(grouped)
    .sort(([a], [b]) => Number(a) - Number(b))
    .map(([day, times]) => `${dayNames[Number(day)]}: ${times.join(', ')}`);
  return `Please call during available hours (${tzLabel}):\n${parts.join('\n')}`;
}

// Create a new call link
router.post('/', authenticateToken, async (req, res) => {
  try {
    const { name, schedule, expiresAt, fallbackMessage, timezone, callEnabled, chatEnabled, chatSeenEnabled } = req.body;
    if (!name || !name.trim()) {
      return res.status(400).json({ error: 'Link name is required' });
    }
    if (name.length > 50) {
      return res.status(400).json({ error: 'Name must be 50 characters or less' });
    }

    const isCallOn = callEnabled !== undefined ? !!callEnabled : true;
    const isChatOn = !!chatEnabled;
    if (!isCallOn && !isChatOn) {
      return res.status(400).json({ error: 'Enable at least calling or chat' });
    }

    const linkData = {
      linkId: uuidv4().slice(0, 8),
      name: name.trim(),
      owner: req.userId,
      timezone: timezone === 'IST' ? 'IST' : 'UTC',
      callEnabled: isCallOn,
    };

    // Validate & save schedule
    if (schedule && Array.isArray(schedule) && schedule.length > 0) {
      for (const s of schedule) {
        if (s.day < 0 || s.day > 6) return res.status(400).json({ error: 'Invalid day value' });
        if (!/^\d{2}:\d{2}$/.test(s.startTime) || !/^\d{2}:\d{2}$/.test(s.endTime)) {
          return res.status(400).json({ error: 'Time must be in HH:MM format' });
        }
      }
      linkData.schedule = schedule;
    }

    if (expiresAt) {
      const d = new Date(expiresAt);
      if (isNaN(d.getTime())) return res.status(400).json({ error: 'Invalid expiry date' });
      linkData.expiresAt = d;
    }

    if (fallbackMessage && fallbackMessage.trim()) {
      if (fallbackMessage.length > 200) return res.status(400).json({ error: 'Fallback message must be 200 chars or less' });
      linkData.fallbackMessage = fallbackMessage.trim();
    }

    if (chatEnabled !== undefined) {
      linkData.chatEnabled = !!chatEnabled;
    }

    if (chatSeenEnabled !== undefined) {
      linkData.chatSeenEnabled = !!chatSeenEnabled;
    }

    const link = new CallLink(linkData);
    await link.save();

    res.status(201).json({
      linkId: link.linkId,
      name: link.name,
      timezone: link.timezone,
      schedule: link.schedule,
      expiresAt: link.expiresAt,
      fallbackMessage: link.fallbackMessage,
      callEnabled: link.callEnabled !== false,
      chatEnabled: link.chatEnabled,
      chatSeenEnabled: link.chatSeenEnabled,
      createdAt: link.createdAt,
    });
  } catch (err) {
    console.error('Create link error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Get all links for current user
router.get('/', authenticateToken, async (req, res) => {
  try {
    const links = await CallLink.find({ owner: req.userId }).sort({ createdAt: -1 });
    res.json(links.map(l => ({
      linkId: l.linkId,
      name: l.name,
      timezone: l.timezone,
      schedule: l.schedule,
      expiresAt: l.expiresAt,
      fallbackMessage: l.fallbackMessage,
      callEnabled: l.callEnabled !== false,
      chatEnabled: l.chatEnabled,
      chatSeenEnabled: l.chatSeenEnabled,
      createdAt: l.createdAt,
    })));
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Reset (regenerate) a link
router.put('/:linkId/reset', authenticateToken, async (req, res) => {
  try {
    const link = await CallLink.findOne({ linkId: req.params.linkId, owner: req.userId });
    if (!link) return res.status(404).json({ error: 'Link not found' });

    link.linkId = uuidv4().slice(0, 8);
    await link.save();

    res.json({ linkId: link.linkId, name: link.name });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Update link configuration (keeps same linkId/URL)
router.put('/:linkId', authenticateToken, async (req, res) => {
  try {
    const link = await CallLink.findOne({ linkId: req.params.linkId, owner: req.userId });
    if (!link) return res.status(404).json({ error: 'Link not found' });

    const { name, schedule, expiresAt, fallbackMessage, timezone, callEnabled, chatEnabled, chatSeenEnabled } = req.body;

    if (name !== undefined) {
      if (!name || !name.trim()) return res.status(400).json({ error: 'Link name is required' });
      if (name.length > 50) return res.status(400).json({ error: 'Name must be 50 characters or less' });
      link.name = name.trim();
    }

    if (schedule !== undefined) {
      if (Array.isArray(schedule) && schedule.length > 0) {
        for (const s of schedule) {
          if (s.day < 0 || s.day > 6) return res.status(400).json({ error: 'Invalid day value' });
          if (!/^\d{2}:\d{2}$/.test(s.startTime) || !/^\d{2}:\d{2}$/.test(s.endTime)) {
            return res.status(400).json({ error: 'Time must be in HH:MM format' });
          }
        }
        link.schedule = schedule;
      } else {
        link.schedule = [];
      }
    }

    if (timezone !== undefined) {
      link.timezone = timezone === 'IST' ? 'IST' : 'UTC';
    }

    if (expiresAt !== undefined) {
      if (expiresAt === null || expiresAt === '') {
        link.expiresAt = null;
      } else {
        const d = new Date(expiresAt);
        if (isNaN(d.getTime())) return res.status(400).json({ error: 'Invalid expiry date' });
        link.expiresAt = d;
      }
    }

    if (fallbackMessage !== undefined) {
      if (fallbackMessage && fallbackMessage.length > 200) return res.status(400).json({ error: 'Fallback message must be 200 chars or less' });
      link.fallbackMessage = (fallbackMessage || '').trim();
    }

    if (callEnabled !== undefined) {
      link.callEnabled = !!callEnabled;
    }

    if (chatEnabled !== undefined) {
      link.chatEnabled = !!chatEnabled;
    }

    if (chatSeenEnabled !== undefined) {
      link.chatSeenEnabled = !!chatSeenEnabled;
    }

    // Ensure at least one is enabled
    if (!link.callEnabled && !link.chatEnabled) {
      return res.status(400).json({ error: 'Enable at least calling or chat' });
    }

    await link.save();

    res.json({
      linkId: link.linkId,
      name: link.name,
      timezone: link.timezone,
      schedule: link.schedule,
      expiresAt: link.expiresAt,
      fallbackMessage: link.fallbackMessage,
      callEnabled: link.callEnabled !== false,
      chatEnabled: link.chatEnabled,
      chatSeenEnabled: link.chatSeenEnabled,
      createdAt: link.createdAt,
    });
  } catch (err) {
    console.error('Update link error:', err);
    res.status(500).json({ error: 'Server error' });
  }
});

// Delete a link
router.delete('/:linkId', authenticateToken, async (req, res) => {
  try {
    const link = await CallLink.findOneAndDelete({ linkId: req.params.linkId, owner: req.userId });
    if (!link) return res.status(404).json({ error: 'Link not found' });
    // Cascade delete chat messages for this link
    await ChatMessage.deleteMany({ linkId: req.params.linkId });
    res.json({ message: 'Link deleted' });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Get call history for current user (must be before /:linkId routes)
router.get('/history/list', authenticateToken, async (req, res) => {
  try {
    const history = await CallHistory.find({ owner: req.userId })
      .sort({ time: -1 })
      .limit(100);
    res.json(history);
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Clear call history
router.delete('/history/clear', authenticateToken, async (req, res) => {
  try {
    await CallHistory.deleteMany({ owner: req.userId });
    res.json({ message: 'History cleared' });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

// Public: get link info (for caller page) — includes availability check
router.get('/:linkId/info', async (req, res) => {
  try {
    const link = await CallLink.findOne({ linkId: req.params.linkId }).populate('owner', 'username');
    if (!link) return res.status(404).json({ error: 'Link not found' });

    // Check expiry
    if (link.expiresAt && new Date() > link.expiresAt) {
      // Log expired attempt in history
      CallHistory.create({
        owner: link.owner._id,
        linkName: link.name,
        linkId: link.linkId,
        type: 'expired-attempt',
      }).catch(() => {});
      return res.json({
        linkId: link.linkId,
        name: link.name,
        ownerUsername: link.owner.username,
        expired: true,
      });
    }

    // Check schedule
    const scheduleCheck = isWithinSchedule(link.schedule, link.timezone);

    if (!scheduleCheck.available) {
      // Log outside-schedule attempt in history
      CallHistory.create({
        owner: link.owner._id,
        linkName: link.name,
        linkId: link.linkId,
        type: 'outside-schedule',
      }).catch(() => {});
    }

    res.json({
      linkId: link.linkId,
      name: link.name,
      ownerUsername: link.owner.username,
      expired: false,
      available: scheduleCheck.available,
      unavailableReason: scheduleCheck.reason || null,
      timezone: link.timezone,
      schedule: link.schedule,
      fallbackMessage: link.fallbackMessage || null,
      callEnabled: link.callEnabled !== false,
      chatEnabled: !!link.chatEnabled,
      chatSeenEnabled: !!link.chatSeenEnabled,
    });
  } catch (err) {
    res.status(500).json({ error: 'Server error' });
  }
});

module.exports = router;
