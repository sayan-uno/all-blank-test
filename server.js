require('dotenv').config();
const dns = require('dns');
dns.setServers(['8.8.8.8', '8.8.4.4']);
const express = require('express');
const mongoose = require('mongoose');
const cookieParser = require('cookie-parser');
const path = require('path');
const http = require('http');
const { Server } = require('socket.io');
const jwt = require('jsonwebtoken');
const authRoutes = require('./routes/auth');
const linkRoutes = require('./routes/links');
const chatRoutes = require('./routes/chat');
const adminRoutes = require('./routes/admin');
const staffRoutes = require('./routes/staff');
const customerRoutes = require('./routes/customer');
const CallLink = require('./models/CallLink');
const CallHistory = require('./models/CallHistory');
const ChatMessage = require('./models/ChatMessage');
const AuthCode = require('./models/AuthCode');
const User = require('./models/User');
const StaffLink = require('./models/StaffLink');
const CustomerLink = require('./models/CustomerLink');

const app = express();
const server = http.createServer(app);
const io = new Server(server);

// Middleware
app.use(express.json());
app.use(cookieParser());

// Block direct access to admin.html
app.use((req, res, next) => {
  if (req.path === '/admin.html') return res.status(404).send('Not Found');
  next();
});

app.use(express.static(path.join(__dirname, 'public')));

// Routes
app.use('/api/auth', authRoutes);
app.use('/api/links', linkRoutes);
app.use('/api/chat', chatRoutes);
app.use('/api/admin', adminRoutes);
app.use('/api/staff', staffRoutes);
app.use('/api/customer', customerRoutes);

// Serve admin page — URL secret acts as the first gate
app.get('/admin-panel/:urlSecret', (req, res) => {
  if (!process.env.ADMIN_URL_SECRET || req.params.urlSecret !== process.env.ADMIN_URL_SECRET) {
    return res.status(404).sendFile(path.join(__dirname, 'public', 'index.html'));
  }
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

// Serve caller page for /call/:linkId
app.get('/call/:linkId', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'call.html'));
});

// Serve staff join page
app.get('/join/staff/:linkId', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'staff-join.html'));
});

// Serve customer join page
app.get('/join/customer/:linkId', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'customer-join.html'));
});

// Serve frontend (catch-all)
app.get('/{*splat}', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ===== Socket.IO Signaling =====
// Track online owners: { userId: socketId }
const onlineOwners = new Map();
// Share onlineOwners and io with admin route
app.locals.onlineOwners = onlineOwners;
app.locals.io = io;
// Track active calls: { callerSocketId: ownerSocketId } and reverse
const callPairs = new Map();
// Track ringing timeouts: { callerSocketId: timeoutId }
const ringingTimeouts = new Map();
// Track missed calls in memory: { ownerId: [{ linkName, time }] }
const missedCalls = new Map();
// Track pending/ringing calls per owner: { ownerId: [{ callerSocketId, linkId, linkName, fallbackMessage }] }
const pendingCalls = new Map();

// Parse cookie string helper
function parseCookies(cookieStr) {
  const cookies = {};
  if (!cookieStr) return cookies;
  cookieStr.split(';').forEach(c => {
    const [key, ...val] = c.trim().split('=');
    if (key) cookies[key] = val.join('=');
  });
  return cookies;
}

io.on('connection', async (socket) => {
  // Auto-authenticate from httpOnly cookie in handshake
  try {
    const cookies = parseCookies(socket.handshake.headers.cookie);
    const token = cookies.token;
    if (token) {
      const decoded = jwt.verify(token, process.env.JWT_SECRET);
      socket.userId = decoded.userId;

      // Check auth code status before allowing connection
      const user = await User.findById(decoded.userId).populate('authCode');
      if (!user || !user.authCode || user.authCode.status === 'blocked') {
        socket.emit('auth-blocked');
        socket.disconnect(true);
        return;
      }

      onlineOwners.set(decoded.userId, socket.id);
      socket.join(`owner-${decoded.userId}`);

      // Re-send any pending/ringing calls to this newly connected owner
      const pending = pendingCalls.get(decoded.userId);
      if (pending && pending.length > 0) {
        for (const call of pending) {
          // Update callPairs: point caller → new owner socket
          callPairs.set(call.callerSocketId, socket.id);
          // Emit incoming-call to the owner
          io.to(socket.id).emit('incoming-call', {
            linkId: call.linkId,
            linkName: call.linkName,
            callerSocketId: call.callerSocketId,
          });
        }
      }
    }
  } catch {
    // Not an authenticated owner — that's fine (could be a caller)
  }

  // Caller initiates a call
  socket.on('call-request', async ({ linkId }) => {
    try {
      const link = await CallLink.findOne({ linkId }).populate('owner', 'username');
      if (!link) return socket.emit('error-msg', 'Link not found');

      // Check if calling is enabled on this link
      if (link.callEnabled === false) {
        return socket.emit('error-msg', 'Calling is not enabled on this link');
      }

      const ownerId = link.owner._id.toString();
      const ownerSocketId = onlineOwners.get(ownerId);

      socket.callLinkId = linkId;
      socket.callOwnerId = ownerId;
      socket.callLinkName = link.name;
      socket.callFallbackMessage = link.fallbackMessage || '';
      socket.callStartedAt = Date.now();

      // Store the caller→owner mapping for WebRTC routing
      if (ownerSocketId) {
        callPairs.set(socket.id, ownerSocketId);
      }

      // Add to pendingCalls for this owner
      if (!pendingCalls.has(ownerId)) pendingCalls.set(ownerId, []);
      pendingCalls.get(ownerId).push({
        callerSocketId: socket.id,
        linkId,
        linkName: link.name,
        fallbackMessage: link.fallbackMessage || '',
      });

      // Send incoming call to owner (if online)
      if (ownerSocketId) {
        io.to(ownerSocketId).emit('incoming-call', {
          linkId,
          linkName: link.name,
          callerSocketId: socket.id,
        });
      }

      // Always tell caller it's ringing
      socket.emit('call-status', {
        status: 'ringing',
        ownerUsername: link.owner.username,
        linkName: link.name,
      });

      // 30-second auto-timeout
      const timeout = setTimeout(() => {
        ringingTimeouts.delete(socket.id);
        // Remove from pendingCalls
        removePendingCall(ownerId, socket.id);
        socket.emit('call-timeout', { fallbackMessage: link.fallbackMessage || '' });
        // Record missed call
        if (!missedCalls.has(ownerId)) missedCalls.set(ownerId, []);
        missedCalls.get(ownerId).push({ linkName: link.name, time: new Date() });
        // Log to call history
        CallHistory.create({
          owner: ownerId,
          linkName: link.name,
          linkId,
          type: 'missed',
          ringDuration: 30,
        }).catch(() => {});
        // Notify owner if online
        const currentOwnerSocket = onlineOwners.get(ownerId);
        if (currentOwnerSocket && io.sockets.sockets.get(currentOwnerSocket)) {
          io.to(currentOwnerSocket).emit('missed-call', { linkName: link.name, time: new Date() });
          io.to(currentOwnerSocket).emit('call-ended', { callerSocketId: socket.id });
        }
        callPairs.delete(socket.id);
      }, 30000);
      ringingTimeouts.set(socket.id, timeout);
    } catch (err) {
      console.error('call-request error:', err);
      socket.emit('error-msg', 'Server error');
    }
  });

  // Owner accepts or declines
  socket.on('call-response', ({ callerSocketId, accepted }) => {
    // Clear the 30s timeout
    const timeout = ringingTimeouts.get(callerSocketId);
    if (timeout) { clearTimeout(timeout); ringingTimeouts.delete(callerSocketId); }

    // Remove from pendingCalls
    if (socket.userId) removePendingCall(socket.userId, callerSocketId);

    if (accepted) {
      callPairs.set(socket.id, callerSocketId);
      callPairs.set(callerSocketId, socket.id);
      io.to(callerSocketId).emit('call-accepted');
      // Track call connected time on the caller socket
      const callerSocket = io.sockets.sockets.get(callerSocketId);
      if (callerSocket) {
        callerSocket.callConnectedAt = Date.now();
      }
    } else {
      // Look up the caller socket to get fallback message and ring duration
      const callerSocket = io.sockets.sockets.get(callerSocketId);
      const fallbackMessage = callerSocket && callerSocket.callFallbackMessage;
      const ringDuration = callerSocket && callerSocket.callStartedAt
        ? Math.round((Date.now() - callerSocket.callStartedAt) / 1000) : 0;
      callPairs.delete(callerSocketId);
      io.to(callerSocketId).emit('call-declined', { fallbackMessage: fallbackMessage || '' });
      // Log declined to history
      if (socket.userId && callerSocket && callerSocket.callLinkName) {
        CallHistory.create({
          owner: socket.userId,
          linkName: callerSocket.callLinkName,
          linkId: callerSocket.callLinkId,
          type: 'declined',
          ringDuration,
        }).catch(() => {});
      }
    }
  });

  // WebRTC signaling — resolve 'owner' target to actual socket ID
  socket.on('webrtc-offer', ({ targetSocketId, offer }) => {
    const resolvedTarget = targetSocketId === 'owner' ? callPairs.get(socket.id) : targetSocketId;
    if (resolvedTarget) {
      io.to(resolvedTarget).emit('webrtc-offer', { offer, callerSocketId: socket.id });
    }
  });

  socket.on('webrtc-answer', ({ targetSocketId, answer }) => {
    const resolvedTarget = targetSocketId === 'owner' ? callPairs.get(socket.id) : targetSocketId;
    if (resolvedTarget) {
      io.to(resolvedTarget).emit('webrtc-answer', { answer });
    }
  });

  socket.on('webrtc-ice-candidate', ({ targetSocketId, candidate }) => {
    const resolvedTarget = (targetSocketId === 'owner') ? callPairs.get(socket.id) : targetSocketId;
    if (resolvedTarget) {
      io.to(resolvedTarget).emit('webrtc-ice-candidate', { candidate });
    }
  });

  // End call
  socket.on('end-call', ({ targetSocketId }) => {
    const resolvedTarget = (targetSocketId === 'owner') ? callPairs.get(socket.id) : targetSocketId;

    // Clear the ringing timeout if still active
    const timeout = ringingTimeouts.get(socket.id);
    const wasRinging = !!timeout;
    if (timeout) { clearTimeout(timeout); ringingTimeouts.delete(socket.id); }

    // Remove from pendingCalls
    if (socket.callOwnerId) removePendingCall(socket.callOwnerId, socket.id);

    // If caller hung up while still ringing, record it as a missed call
    if (wasRinging && socket.callOwnerId && socket.callLinkName) {
      const ownerId = socket.callOwnerId;
      if (!missedCalls.has(ownerId)) missedCalls.set(ownerId, []);
      missedCalls.get(ownerId).push({ linkName: socket.callLinkName, time: new Date() });
      const ownerSid = onlineOwners.get(ownerId);
      if (ownerSid) {
        io.to(ownerSid).emit('missed-call', { linkName: socket.callLinkName, time: new Date() });
      }
      // Log caller-hangup to history
      const ringDuration = socket.callStartedAt ? Math.round((Date.now() - socket.callStartedAt) / 1000) : 0;
      CallHistory.create({
        owner: ownerId,
        linkName: socket.callLinkName,
        linkId: socket.callLinkId,
        type: 'caller-hangup',
        ringDuration,
      }).catch(() => {});
    }

    // If this was a connected call ending, log a completed call
    if (socket.callConnectedAt && socket.callOwnerId && socket.callLinkName) {
      const duration = Math.round((Date.now() - socket.callConnectedAt) / 1000);
      const ringDuration = socket.callStartedAt && socket.callConnectedAt
        ? Math.round((socket.callConnectedAt - socket.callStartedAt) / 1000) : 0;
      CallHistory.create({
        owner: socket.callOwnerId,
        linkName: socket.callLinkName,
        linkId: socket.callLinkId,
        type: 'completed',
        duration,
        ringDuration,
      }).catch(() => {});
    }

    // If the owner ended the call, check if the caller had an active connection
    if (!socket.callOwnerId && resolvedTarget) {
      const callerSocket = io.sockets.sockets.get(resolvedTarget);
      if (callerSocket && callerSocket.callConnectedAt && callerSocket.callOwnerId) {
        const duration = Math.round((Date.now() - callerSocket.callConnectedAt) / 1000);
        const ringDuration = callerSocket.callStartedAt && callerSocket.callConnectedAt
          ? Math.round((callerSocket.callConnectedAt - callerSocket.callStartedAt) / 1000) : 0;
        CallHistory.create({
          owner: callerSocket.callOwnerId,
          linkName: callerSocket.callLinkName,
          linkId: callerSocket.callLinkId,
          type: 'completed',
          duration,
          ringDuration,
        }).catch(() => {});
      }
    }

    // Notify the other party — include callerSocketId so owner can remove the right popup
    const ownerTarget = resolvedTarget || (socket.callOwnerId && onlineOwners.get(socket.callOwnerId));
    if (ownerTarget) {
      io.to(ownerTarget).emit('call-ended', { callerSocketId: socket.id });
    }
    callPairs.delete(socket.id);
    if (resolvedTarget) callPairs.delete(resolvedTarget);
  });

  // API: get missed calls for this owner
  socket.on('get-missed-calls', () => {
    if (socket.userId) {
      const calls = missedCalls.get(socket.userId) || [];
      socket.emit('missed-calls-list', calls);
    }
  });

  // Clear missed calls
  socket.on('clear-missed-calls', () => {
    if (socket.userId) {
      missedCalls.delete(socket.userId);
    }
  });

  // ===== Link Visited Notification =====
  socket.on('link-visited', async ({ linkId }) => {
    try {
      const link = await CallLink.findOne({ linkId });
      if (!link) return;
      const ownerId = link.owner.toString();
      const ownerSocketId = onlineOwners.get(ownerId);
      if (ownerSocketId) {
        io.to(ownerSocketId).emit('link-visited', { linkId, linkName: link.name });
      }
      CallHistory.create({
        owner: ownerId,
        linkName: link.name,
        linkId,
        type: 'link-visited',
      }).catch(() => {});
    } catch (err) {
      console.error('link-visited error:', err);
    }
  });

  // ===== Chat Events =====
  socket.on('chat-join', ({ linkId }) => {
    socket.join(`chat-${linkId}`);
    socket.chatLinkId = linkId;
  });

  socket.on('chat-message', async ({ linkId, type, content, fileName, fileSize }) => {
    const sender = socket.userId ? 'owner' : 'visitor';
    try {
      const msg = await ChatMessage.create({
        linkId,
        sender,
        type: type || 'text',
        content: content || '',
        fileName: fileName || '',
        fileSize: fileSize || 0,
      });

      // Broadcast to chat room
      io.to(`chat-${linkId}`).emit('chat-message', {
        _id: msg._id,
        linkId: msg.linkId,
        sender: msg.sender,
        type: msg.type,
        content: msg.content,
        fileName: msg.fileName,
        fileSize: msg.fileSize,
        seenAt: msg.seenAt,
        createdAt: msg.createdAt,
      });

      // Notify owner if sender is visitor
      if (sender === 'visitor') {
        const link = await CallLink.findOne({ linkId });
        if (link) {
          const ownerId = link.owner.toString();
          const ownerSocketId = onlineOwners.get(ownerId);
          if (ownerSocketId) {
            const ownerSocket = io.sockets.sockets.get(ownerSocketId);
            if (ownerSocket && !ownerSocket.rooms.has(`chat-${linkId}`)) {
              io.to(ownerSocketId).emit('chat-notification', { linkId, linkName: link.name });
            }
          }
          // Log to history (only first message per visitor session)
          if (!socket.chatNotified) {
            socket.chatNotified = true;
            CallHistory.create({
              owner: ownerId,
              linkName: link.name,
              linkId,
              type: 'new-chat',
            }).catch(() => {});
          }
        }
      }
    } catch (err) {
      console.error('chat-message error:', err);
    }
  });

  socket.on('chat-typing', ({ linkId }) => {
    const sender = socket.userId ? 'owner' : 'visitor';
    socket.to(`chat-${linkId}`).emit('chat-typing', { sender, linkId });
  });

  // Mark messages as seen
  socket.on('chat-seen', async ({ linkId }) => {
    const viewer = socket.userId ? 'owner' : 'visitor';
    // Mark all unseen messages from the OTHER party as seen
    const otherSender = viewer === 'owner' ? 'visitor' : 'owner';
    try {
      const result = await ChatMessage.updateMany(
        { linkId, sender: otherSender, seenAt: null },
        { $set: { seenAt: new Date() } }
      );
      if (result.modifiedCount > 0) {
        // Look up chatSeenEnabled for this link
        const link = await CallLink.findOne({ linkId });
        const seenEnabled = link ? !!link.chatSeenEnabled : false;
        // Broadcast seen update to the room
        io.to(`chat-${linkId}`).emit('chat-seen-update', {
          linkId,
          seenBy: viewer,
          seenAt: new Date(),
          chatSeenEnabled: seenEnabled,
        });
      }
    } catch (err) {
      console.error('chat-seen error:', err);
    }
  });

  socket.on('chat-leave', ({ linkId }) => {
    socket.leave(`chat-${linkId}`);
  });

  socket.on('disconnect', () => {
    // Clear any ringing timeout for this socket
    const timeout = ringingTimeouts.get(socket.id);
    if (timeout) { clearTimeout(timeout); ringingTimeouts.delete(socket.id); }

    // If this is a caller, remove from pendingCalls and notify owner
    if (socket.callOwnerId) {
      removePendingCall(socket.callOwnerId, socket.id);
      const ownerSocketId = onlineOwners.get(socket.callOwnerId);
      if (ownerSocketId) {
        io.to(ownerSocketId).emit('call-ended', { callerSocketId: socket.id });
      }
    }

    if (socket.userId) {
      onlineOwners.delete(socket.userId);
    }
    // Notify the other party
    const peer = callPairs.get(socket.id);
    if (peer) {
      io.to(peer).emit('call-ended', {});
      callPairs.delete(peer);
    }
    callPairs.delete(socket.id);
  });
});

// Helper: remove a specific caller from an owner's pendingCalls
function removePendingCall(ownerId, callerSocketId) {
  const pending = pendingCalls.get(ownerId);
  if (!pending) return;
  const idx = pending.findIndex(c => c.callerSocketId === callerSocketId);
  if (idx !== -1) pending.splice(idx, 1);
  if (pending.length === 0) pendingCalls.delete(ownerId);
}

// Connect to MongoDB & start server
const PORT = process.env.PORT || 3000;

mongoose
  .connect(process.env.MONGODB_URI)
  .then(() => {
    console.log('Connected to MongoDB');
    server.listen(PORT, () => console.log(`Server running on http://localhost:${PORT}`));
  })
  .catch((err) => {
    console.error('MongoDB connection error:', err.message);
    process.exit(1);
  });
