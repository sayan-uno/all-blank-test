// ===== Caller Page Script =====
const precallSection = document.getElementById('precall-section');
const callerSection  = document.getElementById('caller-section');
const callerError    = document.getElementById('caller-error');
const statusText     = document.getElementById('caller-status-text');
const timerEl        = document.getElementById('caller-timer');
const countdownEl    = document.getElementById('caller-countdown');
const avatarCircle   = document.getElementById('caller-avatar-circle');
const avatarLetter   = document.getElementById('caller-avatar-letter');
const peerNameEl     = document.getElementById('caller-peer-name');
const peerSubEl      = document.getElementById('caller-peer-sub');
const muteBtn        = document.getElementById('caller-mute-btn');
const endBtn         = document.getElementById('caller-end-btn');
const remoteAudio    = document.getElementById('remote-audio');

let socket = null;
let peerConnection = null;
let localStream = null;
let callTimerInterval = null;
let callSeconds = 0;
let ringingCountdown = null;
let linkInfo = null;
let pendingCandidates = [];
let remoteDescSet = false;
let micDeniedAttempts = 0;

// Get linkId from URL: /call/:linkId
const linkId = window.location.pathname.split('/call/')[1];

async function init() {
  if (!linkId) return showError('Link Not Found', 'This call link is invalid or has been removed.');

  try {
    const res = await fetch(`/api/links/${linkId}/info`);
    if (!res.ok) return showError('Link Not Found', 'This call link is invalid or has been removed.');
    linkInfo = await res.json();

    // Check if link is expired
    if (linkInfo.expired) {
      return showError('Link Expired', 'This call link has expired and is no longer active.');
    }

    // Check if link is available (schedule)
    if (linkInfo.available === false) {
      return showError('Not Available Right Now', linkInfo.unavailableReason || 'This link is not available at this time.');
    }

    // Show pre-call screen with owner info
    document.getElementById('precall-avatar-letter').textContent = linkInfo.ownerUsername[0].toUpperCase();
    document.getElementById('precall-owner-name').textContent = linkInfo.ownerUsername;
    document.getElementById('precall-link-name').textContent = linkInfo.name;

    // Show verified name with blue tick if present
    if (linkInfo.verifiedName) {
      document.getElementById('precall-verified-name').textContent = linkInfo.verifiedName;
      document.getElementById('precall-verified-row').classList.remove('hidden');
    }

    // Show chat button if chat is enabled
    if (linkInfo.chatEnabled) {
      document.getElementById('start-chat-btn').classList.remove('hidden');
    }

    // Hide call button if calling is disabled
    if (!linkInfo.callEnabled) {
      document.getElementById('start-call-btn').classList.add('hidden');
    }

    // Notify owner that someone opened the link
    const visitSocket = io();
    visitSocket.on('connect', () => {
      visitSocket.emit('link-visited', { linkId });
      visitSocket.disconnect();
    });
  } catch {
    showError('Link Not Found', 'This call link is invalid or has been removed.');
  }
}

function showError(title, message) {
  precallSection.classList.add('hidden');
  callerSection.classList.add('hidden');
  callerError.classList.remove('hidden');
  // Update error text if elements exist
  const errTitle = callerError.querySelector('h1');
  const errMsg = callerError.querySelector('p');
  if (errTitle) errTitle.textContent = title || 'Link Not Found';
  if (errMsg) {
    errMsg.style.whiteSpace = 'pre-line';
    errMsg.textContent = message || 'This call link is invalid or has been removed.';
  }
}

// Click "Call" button
document.getElementById('start-call-btn').addEventListener('click', async () => {
  // Ask for microphone permission before starting the call
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach(t => t.stop()); // release immediately, will re-acquire during WebRTC setup
    micDeniedAttempts = 0;
  } catch (err) {
    micDeniedAttempts++;
    if (micDeniedAttempts >= 2) {
      alert('Microphone permission is blocked by your browser.\n\nPlease click the lock/site-settings icon in your address bar, set Microphone to \"Allow\", then reload this page.');
    } else {
      alert('Microphone access is required to make a call. Please allow it and try again.');
    }
    return; // Don't start the call
  }

  precallSection.classList.add('hidden');
  callerSection.classList.remove('hidden');

  // Setup calling screen
  peerNameEl.textContent = linkInfo.ownerUsername;
  peerSubEl.textContent = `Calling via "${linkInfo.name}"...`;
  avatarLetter.textContent = linkInfo.ownerUsername[0].toUpperCase();
  statusText.textContent = 'Ringing...';

  connectAndCall();
});

function connectAndCall() {
  socket = io();

  socket.on('connect', () => {
    socket.emit('call-request', { linkId });
  });

  socket.on('call-status', ({ status, ownerUsername, linkName }) => {
    if (status === 'ringing') {
      statusText.textContent = 'Ringing...';
      peerSubEl.textContent = `Calling ${ownerUsername}...`;

      // Start 30s countdown display
      let secondsLeft = 30;
      countdownEl.textContent = `Auto-cancel in ${secondsLeft}s`;
      ringingCountdown = setInterval(() => {
        secondsLeft--;
        if (secondsLeft > 0) {
          countdownEl.textContent = `Auto-cancel in ${secondsLeft}s`;
        } else {
          countdownEl.textContent = '';
          clearInterval(ringingCountdown);
          ringingCountdown = null;
        }
      }, 1000);
    }
  });

  socket.on('call-timeout', ({ fallbackMessage }) => {
    clearCountdown();
    statusText.textContent = 'No Answer';
    if (fallbackMessage) {
      peerSubEl.textContent = fallbackMessage;
    } else {
      peerSubEl.textContent = `${linkInfo.ownerUsername} didn\u2019t pick up`;
    }
    countdownEl.textContent = '';
    avatarCircle.classList.remove('ringing');
    showCallAgainBtn();
  });

  socket.on('call-accepted', async () => {
    clearCountdown();
    statusText.textContent = 'Connected';
    countdownEl.textContent = '';
    avatarCircle.classList.remove('ringing');
    muteBtn.classList.remove('hidden');
    timerEl.classList.remove('hidden');

    // Show in-call chat toggle if chat enabled
    if (linkInfo.chatEnabled) {
      document.getElementById('caller-chat-toggle-btn').classList.remove('hidden');
    }

    callSeconds = 0;
    callTimerInterval = setInterval(() => {
      callSeconds++;
      const m = String(Math.floor(callSeconds / 60)).padStart(2, '0');
      const s = String(callSeconds % 60).padStart(2, '0');
      timerEl.textContent = `${m}:${s}`;
    }, 1000);

    setTimeout(() => setupPeerConnection(true), 500);
  });

  socket.on('call-declined', (data) => {
    clearCountdown();
    statusText.textContent = 'Busy';
    if (data && data.fallbackMessage) {
      peerSubEl.textContent = data.fallbackMessage;
    } else {
      peerSubEl.textContent = `${linkInfo.ownerUsername} is busy right now`;
    }
    countdownEl.textContent = '';
    avatarCircle.classList.remove('ringing');
    showCallAgainBtn();
  });

  socket.on('webrtc-answer', async ({ answer }) => {
    if (peerConnection) {
      await peerConnection.setRemoteDescription(new RTCSessionDescription(answer));
      remoteDescSet = true;
      // Flush buffered ICE candidates
      for (const c of pendingCandidates) {
        await peerConnection.addIceCandidate(new RTCIceCandidate(c));
      }
      pendingCandidates = [];
    }
  });

  socket.on('webrtc-ice-candidate', async ({ candidate }) => {
    if (!candidate) return;
    if (peerConnection && remoteDescSet) {
      await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
    } else {
      pendingCandidates.push(candidate);
    }
  });

  socket.on('call-ended', () => {
    clearCountdown();
    endCallCleanup();
    statusText.textContent = 'Call Ended';
    peerSubEl.textContent = 'The call has been disconnected';
    countdownEl.textContent = '';
    avatarCircle.classList.remove('ringing');
    muteBtn.classList.add('hidden');
    document.getElementById('caller-chat-toggle-btn').classList.add('hidden');
    chatCallBtn.classList.remove('hidden');
    updateVoiceBtnState();
    showCallAgainBtn();
  });

  socket.on('error-msg', (msg) => {
    clearCountdown();
    statusText.textContent = 'Error';
    peerSubEl.textContent = msg;
  });

  // Chat events
  socket.on('chat-message', (msg) => {
    if (msg.linkId === linkId) {
      appendChatMessage(msg);
      if (msg.sender === 'owner' && isInChat) {
        socket.emit('chat-seen', { linkId, sender: 'visitor' });
      }
    }
  });

  socket.on('chat-typing', (data) => {
    if (data.sender !== 'visitor' && data.linkId === linkId) {
      showTypingIndicator();
    }
  });

  socket.on('chat-seen-update', (data) => {
    if (data.linkId === linkId && data.chatSeenEnabled) {
      chatMessages.querySelectorAll('.chat-msg-sent .seen-indicator').forEach(el => {
        el.textContent = '✓✓';
        el.classList.add('seen');
      });
    }
  });
}

function clearCountdown() {
  if (ringingCountdown) { clearInterval(ringingCountdown); ringingCountdown = null; }
}

// ===== WebRTC =====
async function setupPeerConnection(isCaller) {
  const config = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };
  peerConnection = new RTCPeerConnection(config);

  localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  localStream.getTracks().forEach(track => peerConnection.addTrack(track, localStream));

  peerConnection.ontrack = (event) => {
    remoteAudio.srcObject = event.streams[0];
    remoteAudio.play().catch(() => {});
  };

  peerConnection.onicecandidate = (event) => {
    if (event.candidate) {
      socket.emit('webrtc-ice-candidate', { targetSocketId: 'owner', candidate: event.candidate });
    }
  };

  if (isCaller) {
    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);
    socket.emit('webrtc-offer', { targetSocketId: 'owner', offer });
  }
}

// ===== Mute =====
muteBtn.addEventListener('click', () => {
  if (localStream) {
    const track = localStream.getAudioTracks()[0];
    if (track) {
      track.enabled = !track.enabled;
      muteBtn.classList.toggle('muted', !track.enabled);
      muteBtn.textContent = track.enabled ? '\u{1F3A4}' : '\u{1F507}';
    }
  }
});

// ===== End Call =====
endBtn.addEventListener('click', () => {
  clearCountdown();
  if (socket) {
    socket.emit('end-call', { targetSocketId: 'owner' });
  }
  endCallCleanup();
  statusText.textContent = 'Call Ended';
  peerSubEl.textContent = 'You ended the call';
  countdownEl.textContent = '';
  avatarCircle.classList.remove('ringing');
  muteBtn.classList.add('hidden');
  document.getElementById('caller-chat-toggle-btn').classList.add('hidden');
  chatCallBtn.classList.remove('hidden');
  updateVoiceBtnState();
  showCallAgainBtn();
});

function endCallCleanup() {
  if (peerConnection) { peerConnection.close(); peerConnection = null; }
  if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }
  if (callTimerInterval) { clearInterval(callTimerInterval); callTimerInterval = null; }
  pendingCandidates = [];
  remoteDescSet = false;
}

// ===== Call Again =====
function showCallAgainBtn() {
  endBtn.classList.add('hidden');
  let callAgainBtn = document.getElementById('call-again-btn');
  if (!callAgainBtn) {
    callAgainBtn = document.createElement('button');
    callAgainBtn.id = 'call-again-btn';
    callAgainBtn.className = 'call-ctrl-btn call-again-btn';
    callAgainBtn.title = 'Call Again';
    callAgainBtn.innerHTML = '&#128222; Call Again';
    callAgainBtn.addEventListener('click', () => {
      // Clean up old socket
      if (socket) { socket.disconnect(); socket = null; }
      endCallCleanup();
      chatJoined = false;
      // Reset UI
      callAgainBtn.remove();
      endBtn.classList.remove('hidden');
      statusText.textContent = 'Ringing...';
      peerSubEl.textContent = `Calling ${linkInfo.ownerUsername}...`;
      countdownEl.textContent = '';
      avatarCircle.classList.add('ringing');
      muteBtn.classList.add('hidden');
      timerEl.classList.add('hidden');
      // Reconnect and call
      connectAndCall();
    });
    endBtn.parentElement.appendChild(callAgainBtn);
  }
}

// ===== Chat System =====
const chatSection = document.getElementById('chat-section');
const chatMessages = document.getElementById('chat-messages');
const chatTextInput = document.getElementById('chat-text-input');
const chatSendBtn = document.getElementById('chat-send-btn');
const chatAttachBtn = document.getElementById('chat-attach-btn');
const chatFileInput = document.getElementById('chat-file-input');
const chatVoiceBtn = document.getElementById('chat-voice-btn');
const chatBackBtn = document.getElementById('chat-back-btn');
const chatCallBtn = document.getElementById('chat-call-btn');
const callerChatToggle = document.getElementById('caller-chat-toggle-btn');
const chatTypingEl = document.getElementById('chat-typing-indicator');

let isInChat = false;
let chatJoined = false;
let mediaRecorder = null;
let voiceChunks = [];
let isRecording = false;
let typingTimeout = null;

// Open chat from pre-call screen
document.getElementById('start-chat-btn').addEventListener('click', () => {
  precallSection.classList.add('hidden');
  chatSection.classList.remove('hidden');
  isInChat = true;
  document.getElementById('chat-header-name').textContent = `Chat with ${linkInfo.ownerUsername}`;
  // Hide the call button in chat if calling is disabled
  if (!linkInfo.callEnabled) {
    chatCallBtn.classList.add('hidden');
  }
  initChat();
});

// Back button in chat
chatBackBtn.addEventListener('click', () => {
  if (peerConnection) {
    // In a call — go back to call screen
    chatSection.classList.add('hidden');
    callerSection.classList.remove('hidden');
  } else {
    // Not in a call — go back to pre-call
    chatSection.classList.add('hidden');
    precallSection.classList.remove('hidden');
  }
  isInChat = false;
});

// Call button in chat panel
chatCallBtn.addEventListener('click', async () => {
  // Check mic permission
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach(t => t.stop());
  } catch {
    alert('Microphone access is required to make a call. Please allow it and try again.');
    return;
  }

  chatSection.classList.add('hidden');
  callerSection.classList.remove('hidden');
  isInChat = false;

  peerNameEl.textContent = linkInfo.ownerUsername;
  peerSubEl.textContent = `Calling via "${linkInfo.name}"...`;
  avatarLetter.textContent = linkInfo.ownerUsername[0].toUpperCase();
  statusText.textContent = 'Ringing...';
  avatarCircle.classList.add('ringing');
  muteBtn.classList.add('hidden');
  timerEl.classList.add('hidden');

  if (!socket) {
    connectAndCall();
  } else {
    socket.emit('call-request', { linkId });
  }
});

// In-call chat toggle
callerChatToggle.addEventListener('click', () => {
  if (isInChat) {
    chatSection.classList.add('hidden');
    callerSection.classList.remove('hidden');
    isInChat = false;
  } else {
    callerSection.classList.add('hidden');
    chatSection.classList.remove('hidden');
    isInChat = true;
    chatCallBtn.classList.add('hidden'); // hide call btn when already in call
    initChat();
  }
});

function initChat() {
  if (!socket) {
    socket = io();
    socket.on('connect', () => {
      socket.emit('chat-join', { linkId });
      chatJoined = true;
    });
    socket.on('chat-message', (msg) => {
      if (msg.linkId === linkId) {
        appendChatMessage(msg);
        // Auto-mark as seen if message is from owner and chat is visible
        if (msg.sender === 'owner' && isInChat) {
          socket.emit('chat-seen', { linkId, sender: 'visitor' });
        }
      }
    });
    socket.on('chat-typing', (data) => {
      if (data.sender !== 'visitor' && data.linkId === linkId) showTypingIndicator();
    });
    socket.on('chat-seen-update', (data) => {
      if (data.linkId === linkId && data.chatSeenEnabled) {
        chatMessages.querySelectorAll('.chat-msg-sent .seen-indicator').forEach(el => {
          el.textContent = '✓✓';
          el.classList.add('seen');
        });
      }
    });
  } else if (!chatJoined) {
    socket.emit('chat-join', { linkId });
    chatJoined = true;
  }
  loadChatMessages();
  updateVoiceBtnState();
}

async function loadChatMessages() {
  try {
    const res = await fetch(`/api/chat/${linkId}/messages`);
    if (!res.ok) return;
    const messages = await res.json();
    chatMessages.innerHTML = '';
    messages.forEach(msg => appendChatMessage(msg, false));
    scrollChatToBottom();
    // Mark owner messages as seen by visitor
    if (socket) {
      socket.emit('chat-seen', { linkId, sender: 'visitor' });
    }
  } catch {}
}

function appendChatMessage(msg, scroll = true) {
  // Avoid duplicates
  if (chatMessages.querySelector(`[data-msg-id="${msg._id}"]`)) return;

  const div = document.createElement('div');
  div.className = `chat-msg ${msg.sender === 'visitor' ? 'chat-msg-sent' : 'chat-msg-received'}`;
  div.dataset.msgId = msg._id;

  const time = new Date(msg.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const showSeen = msg.sender === 'visitor' && linkInfo && linkInfo.chatSeenEnabled;
  const seenTick = showSeen ? `<span class="seen-indicator ${msg.seenAt ? 'seen' : ''}">${msg.seenAt ? '✓✓' : '✓'}</span>` : '';

  let content = '';
  switch (msg.type) {
    case 'text':
      content = `<div class="chat-bubble"><p>${escapeHtml(msg.content)}</p><span class="chat-time">${time}${seenTick}</span></div>`;
      break;
    case 'image':
      content = `<div class="chat-bubble chat-media"><img src="${msg.content}" alt="${escapeHtml(msg.fileName)}" onclick="window.open('${msg.content}','_blank')" /><span class="chat-time">${time}${seenTick}</span></div>`;
      break;
    case 'video':
      content = `<div class="chat-bubble chat-media"><video src="${msg.content}" controls preload="metadata"></video><span class="chat-time">${time}${seenTick}</span></div>`;
      break;
    case 'voice':
      content = `<div class="chat-bubble chat-voice"><audio src="${msg.content}" controls preload="metadata"></audio><span class="chat-time">${time}${seenTick}</span></div>`;
      break;
    case 'file':
      const sizeStr = formatFileSize(msg.fileSize);
      content = `<div class="chat-bubble chat-file"><a href="${msg.content}" download="${escapeHtml(msg.fileName)}" target="_blank">&#128196; ${escapeHtml(msg.fileName)} <small>(${sizeStr})</small></a><span class="chat-time">${time}${seenTick}</span></div>`;
      break;
  }
  div.innerHTML = content;
  chatMessages.appendChild(div);
  if (scroll) scrollChatToBottom();
}

function scrollChatToBottom() {
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str || '';
  return div.innerHTML;
}

function formatFileSize(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (bytes >= 1024 && i < units.length - 1) { bytes /= 1024; i++; }
  return `${bytes.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

// Send text message
chatSendBtn.addEventListener('click', sendTextMessage);
chatTextInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); sendTextMessage(); }
});

chatTextInput.addEventListener('input', () => {
  if (socket && chatJoined) {
    socket.emit('chat-typing', { linkId });
  }
});

function sendTextMessage() {
  const text = chatTextInput.value.trim();
  if (!text || !socket) return;
  socket.emit('chat-message', { linkId, type: 'text', content: text });
  chatTextInput.value = '';
}

// File upload
chatAttachBtn.addEventListener('click', () => chatFileInput.click());
chatFileInput.addEventListener('change', async () => {
  const file = chatFileInput.files[0];
  if (!file) return;
  chatFileInput.value = '';

  // Determine type
  let msgType = 'file';
  if (file.type.startsWith('image/')) msgType = 'image';
  else if (file.type.startsWith('video/')) msgType = 'video';

  const formData = new FormData();
  formData.append('file', file);

  try {
    const res = await fetch(`/api/chat/${linkId}/upload`, { method: 'POST', body: formData });
    if (!res.ok) { alert('Upload failed'); return; }
    const data = await res.json();
    socket.emit('chat-message', {
      linkId,
      type: msgType,
      content: data.url,
      fileName: data.fileName,
      fileSize: data.fileSize,
    });
  } catch { alert('Upload failed'); }
});

// Voice message
chatVoiceBtn.addEventListener('click', toggleVoiceRecording);

function updateVoiceBtnState() {
  if (peerConnection) {
    chatVoiceBtn.classList.add('disabled');
    chatVoiceBtn.title = 'Voice messages disabled during call';
  } else {
    chatVoiceBtn.classList.remove('disabled');
    chatVoiceBtn.title = 'Voice message';
  }
}

async function toggleVoiceRecording() {
  if (peerConnection) {
    alert('Voice messages are disabled during an active call.');
    return;
  }

  if (isRecording) {
    // Stop recording
    if (mediaRecorder && mediaRecorder.state !== 'inactive') {
      mediaRecorder.stop();
    }
    return;
  }

  // Start recording
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    mediaRecorder = new MediaRecorder(stream);
    voiceChunks = [];

    mediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) voiceChunks.push(e.data);
    };

    mediaRecorder.onstop = async () => {
      stream.getTracks().forEach(t => t.stop());
      isRecording = false;
      chatVoiceBtn.classList.remove('recording');
      chatVoiceBtn.innerHTML = '&#127908;';

      const blob = new Blob(voiceChunks, { type: 'audio/webm' });
      if (blob.size < 1000) return; // too short, discard

      const formData = new FormData();
      formData.append('file', blob, `voice_${Date.now()}.webm`);

      try {
        const res = await fetch(`/api/chat/${linkId}/upload`, { method: 'POST', body: formData });
        if (!res.ok) return;
        const data = await res.json();
        socket.emit('chat-message', {
          linkId,
          type: 'voice',
          content: data.url,
          fileName: data.fileName,
          fileSize: data.fileSize,
        });
      } catch {}
    };

    mediaRecorder.start();
    isRecording = true;
    chatVoiceBtn.classList.add('recording');
    chatVoiceBtn.innerHTML = '&#9632;'; // stop icon
  } catch {
    alert('Could not access microphone for voice recording.');
  }
}

// Typing indicator
function showTypingIndicator() {
  chatTypingEl.classList.remove('hidden');
  clearTimeout(typingTimeout);
  typingTimeout = setTimeout(() => {
    chatTypingEl.classList.add('hidden');
  }, 2000);
}

init();
