// ===== DOM Elements =====
const authSection   = document.getElementById('auth-section');
const dashSection   = document.getElementById('dashboard-section');
const callScreen    = document.getElementById('call-screen');
const cardTitle     = document.getElementById('card-title');
const cardSubtitle  = document.getElementById('card-subtitle');
const tabs          = document.querySelectorAll('.tab');
const loginForm     = document.getElementById('login-form');
const registerForm  = document.getElementById('register-form');
const forgotForm    = document.getElementById('forgot-form');
const emailForm     = document.getElementById('email-form');
const message       = document.getElementById('message');
const dashMessage   = document.getElementById('dash-message');

let socket = null;
let currentUser = null;
let peerConnection = null;
let localStream = null;
let callTimerInterval = null;
let callSeconds = 0;
let activeCallerSocketId = null; // the caller currently in a WebRTC call
let incomingCalls = []; // array of { callerSocketId, linkName }
let pendingCandidates = [];
let remoteDescSet = false;

// ===== Helpers =====
function showMsg(el, text, type) {
  el.textContent = text;
  el.className = `message ${type}`;
  el.classList.remove('hidden');
  setTimeout(() => el.classList.add('hidden'), 4000);
}

async function api(url, method = 'GET', body = null) {
  const opts = {
    method,
    headers: { 'Content-Type': 'application/json' },
    credentials: 'same-origin',
  };
  if (body) opts.body = JSON.stringify(body);
  const res = await fetch(url, opts);
  const data = await res.json();
  return { ok: res.ok, data };
}

// ===== Tab Switching =====
tabs.forEach(tab => {
  tab.addEventListener('click', () => {
    const target = tab.dataset.tab;
    tabs.forEach(t => t.classList.remove('active'));
    tab.classList.add('active');
    loginForm.classList.remove('active');
    registerForm.classList.remove('active');
    forgotForm.classList.remove('active');
    message.classList.add('hidden');
    if (target === 'login') {
      loginForm.classList.add('active');
      cardTitle.textContent = 'Welcome Back';
      cardSubtitle.textContent = 'Sign in to your account';
    } else {
      registerForm.classList.add('active');
      cardTitle.textContent = 'Get Started';
      cardSubtitle.textContent = 'Create a new account';
    }
  });
});

// ===== Forgot Password =====
document.getElementById('show-forgot').addEventListener('click', e => {
  e.preventDefault();
  loginForm.classList.remove('active');
  registerForm.classList.remove('active');
  forgotForm.classList.add('active');
  document.querySelector('.tabs').classList.add('hidden');
  cardTitle.textContent = 'Reset Password';
  cardSubtitle.textContent = 'Use your recovery email to reset';
  message.classList.add('hidden');
});

document.getElementById('back-to-login').addEventListener('click', e => {
  e.preventDefault();
  forgotForm.classList.remove('active');
  loginForm.classList.add('active');
  document.querySelector('.tabs').classList.remove('hidden');
  tabs[0].click();
});

// ===== Register =====
registerForm.addEventListener('submit', async e => {
  e.preventDefault();
  const username = document.getElementById('reg-username').value.trim();
  const password = document.getElementById('reg-password').value;
  const confirm  = document.getElementById('reg-confirm').value;
  const authCode = document.getElementById('reg-authcode').value.trim();
  if (password !== confirm) return showMsg(message, 'Passwords do not match', 'error');
  if (!authCode) return showMsg(message, 'Auth code is required', 'error');
  const { ok, data } = await api('/api/auth/register', 'POST', { username, password, authCode });
  if (ok) { showMsg(message, data.message, 'success'); setTimeout(loadDashboard, 800); }
  else showMsg(message, data.error, 'error');
});

// ===== Login =====
loginForm.addEventListener('submit', async e => {
  e.preventDefault();
  const username = document.getElementById('login-username').value.trim();
  const password = document.getElementById('login-password').value;
  const { ok, data } = await api('/api/auth/login', 'POST', { username, password });
  if (ok) { showMsg(message, data.message, 'success'); setTimeout(loadDashboard, 800); }
  else showMsg(message, data.error, 'error');
});

// ===== Forgot Password Submit =====
forgotForm.addEventListener('submit', async e => {
  e.preventDefault();
  const username    = document.getElementById('forgot-username').value.trim();
  const email       = document.getElementById('forgot-email').value.trim();
  const newPassword = document.getElementById('forgot-new-password').value;
  const { ok, data } = await api('/api/auth/forgot-password', 'POST', { username, email, newPassword });
  if (ok) { showMsg(message, data.message, 'success'); setTimeout(() => document.getElementById('back-to-login').click(), 1500); }
  else showMsg(message, data.error, 'error');
});

// ===== Dashboard =====
async function loadDashboard() {
  const { ok, data } = await api('/api/auth/me');
  if (!ok) return;

  currentUser = data;
  document.getElementById('dash-username').textContent = data.username;
  document.getElementById('info-username').textContent = data.username;
  document.getElementById('info-email').textContent    = data.email || 'Not set';
  document.getElementById('info-date').textContent     = new Date(data.createdAt).toLocaleDateString();

  // Show role
  const roleEl = document.getElementById('info-role');
  roleEl.textContent = data.role || 'owner';

  // Role-based UI
  const role = data.role || 'owner';

  // Hide email form for staff/customer
  if (role === 'staff' || role === 'customer') {
    document.getElementById('email-form').style.display = 'none';
    document.getElementById('email-row').style.display = 'none';
  }

  // Show staff management for owner
  if (role === 'owner') {
    document.getElementById('staff-mgmt-section').classList.remove('hidden');
    loadStaffLinks();
  }

  // Show customer management for owner and staff
  if (role === 'owner' || role === 'staff') {
    document.getElementById('customer-mgmt-section').classList.remove('hidden');
    loadCustomerLinks();
  }

  // Show verified-name toggle in staff creation form (if owner has verified name)
  if (data.hasVerifiedName && role === 'owner') {
    document.getElementById('staff-verified-toggle').classList.remove('hidden');
  }

  // Show hide-username toggle in create link form (if user has verified name)
  if (data.hasVerifiedName) {
    document.getElementById('hide-username-toggle').classList.remove('hidden');
  }

  // Show delete toggle in staff creation form (if owner has delete permission)
  if (data.canDelete && role === 'owner') {
    document.getElementById('staff-delete-toggle').classList.remove('hidden');
  }

  // Hide delete-related UI if user doesn't have delete permission
  if (!data.canDelete) {
    // Hide clear history button
    const clearHistBtn = document.getElementById('clear-history-btn');
    if (clearHistBtn) clearHistBtn.classList.add('hidden');
    // Hide clear chat button
    const chatClearBtn = document.getElementById('owner-chat-clear-btn');
    if (chatClearBtn) chatClearBtn.classList.add('hidden');
  }

  // For customer role, hide the add link button after 1 link
  if (role === 'customer') {
    // We'll check after loading links
  }

  authSection.classList.add('hidden');
  callScreen.classList.add('hidden');
  dashSection.classList.remove('hidden');

  // Check microphone permission right away
  await ensureMicPermission();

  loadLinks();
  loadHistory();
  connectSocket();
}

async function ensureMicPermission() {
  try {
    const result = await navigator.permissions.query({ name: 'microphone' });
    if (result.state === 'granted') return;
    // Not yet granted — request it now
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    stream.getTracks().forEach(t => t.stop());
    showMsg(dashMessage, 'Microphone access granted \u2714', 'success');
  } catch {
    showMsg(dashMessage, 'Microphone access is required for calls. Please allow it in your browser settings.', 'error');
  }
}

// ===== Settings Toggle =====
document.getElementById('settings-btn').addEventListener('click', () => {
  document.getElementById('settings-panel').classList.toggle('hidden');
});

// ===== Save Recovery Email =====
emailForm.addEventListener('submit', async e => {
  e.preventDefault();
  const email = document.getElementById('recovery-email').value.trim();
  const { ok, data } = await api('/api/auth/email', 'PUT', { email });
  if (ok) { showMsg(dashMessage, data.message, 'success'); document.getElementById('info-email').textContent = email; }
  else showMsg(dashMessage, data.error, 'error');
});

// ===== Logout =====
document.getElementById('logout-btn').addEventListener('click', async () => {
  await api('/api/auth/logout', 'POST');
  if (socket) { socket.disconnect(); socket = null; }
  dashSection.classList.add('hidden');
  authSection.classList.remove('hidden');
  document.querySelector('.tabs').classList.remove('hidden');
  tabs[0].click();
});

// ========== CALL LINKS ==========
const addLinkBtn      = document.getElementById('add-link-btn');
const createLinkPanel = document.getElementById('create-link-panel');
const createLinkForm  = document.getElementById('create-link-form');
const cancelLinkBtn   = document.getElementById('cancel-link-btn');
const linksList       = document.getElementById('links-list');
let editingLinkId     = null; // null = create mode, string = edit mode
let linksData         = []; // cached link data for edit lookups
let linksPerPage      = 10;
let linksShown        = 10;
let linksSortNewest   = true; // true = newest first (default), false = oldest first

addLinkBtn.addEventListener('click', () => {
  editingLinkId = null;
  createLinkForm.reset();
  document.getElementById('schedule-builder').classList.add('hidden');
  document.getElementById('expiry-builder').classList.add('hidden');
  document.getElementById('fallback-builder').classList.add('hidden');
  document.getElementById('chat-seen-toggle').classList.add('hidden');
  document.getElementById('link-form-title').textContent = 'Create Link';
  document.getElementById('link-form-submit').textContent = 'Create Link';
  createLinkPanel.classList.toggle('hidden');
  document.getElementById('link-name-input').focus();
});

cancelLinkBtn.addEventListener('click', () => {
  createLinkPanel.classList.add('hidden');
  createLinkForm.reset();
  editingLinkId = null;
  document.getElementById('schedule-builder').classList.add('hidden');
  document.getElementById('expiry-builder').classList.add('hidden');
  document.getElementById('fallback-builder').classList.add('hidden');
  document.getElementById('chat-seen-toggle').classList.add('hidden');
});

// Toggle schedule/expiry/fallback builders
document.getElementById('enable-schedule').addEventListener('change', e => {
  document.getElementById('schedule-builder').classList.toggle('hidden', !e.target.checked);
});
document.getElementById('enable-expiry').addEventListener('change', e => {
  document.getElementById('expiry-builder').classList.toggle('hidden', !e.target.checked);
});
document.getElementById('enable-fallback').addEventListener('change', e => {
  document.getElementById('fallback-builder').classList.toggle('hidden', !e.target.checked);
});
document.getElementById('enable-chat').addEventListener('change', e => {
  document.getElementById('chat-seen-toggle').classList.toggle('hidden', !e.target.checked);
  if (!e.target.checked) document.getElementById('enable-chat-seen').checked = false;
});

createLinkForm.addEventListener('submit', async e => {
  e.preventDefault();
  const name = document.getElementById('link-name-input').value.trim();
  const body = { name };
  const isEdit = !!editingLinkId;

  // Schedule
  if (document.getElementById('enable-schedule').checked) {
    const checkedDays = [...document.querySelectorAll('#schedule-days input:checked')].map(cb => Number(cb.value));
    const startTime = document.getElementById('schedule-start').value;
    const endTime = document.getElementById('schedule-end').value;
    const tz = document.querySelector('input[name="timezone"]:checked').value;
    if (checkedDays.length === 0) return showMsg(dashMessage, 'Select at least one day', 'error');
    if (!startTime || !endTime) return showMsg(dashMessage, 'Set start and end time', 'error');
    if (startTime >= endTime) return showMsg(dashMessage, 'End time must be after start time', 'error');
    body.schedule = checkedDays.map(day => ({ day, startTime, endTime }));
    body.timezone = tz;
  } else if (isEdit) {
    body.schedule = [];
  }

  // Expiry
  if (document.getElementById('enable-expiry').checked) {
    const val = document.getElementById('expiry-input').value;
    if (!val) return showMsg(dashMessage, 'Set an expiry date', 'error');
    body.expiresAt = new Date(val).toISOString();
  } else if (isEdit) {
    body.expiresAt = null;
  }

  // Fallback message
  if (document.getElementById('enable-fallback').checked) {
    const msg = document.getElementById('fallback-input').value.trim();
    if (msg) body.fallbackMessage = msg;
  } else if (isEdit) {
    body.fallbackMessage = '';
  }

  // Call & Chat enabled
  body.callEnabled = document.getElementById('enable-call').checked;
  body.chatEnabled = document.getElementById('enable-chat').checked;
  body.chatSeenEnabled = document.getElementById('enable-chat-seen').checked;

  // Hide username toggle
  const hideUsernameToggle = document.getElementById('enable-hide-username');
  if (hideUsernameToggle && !hideUsernameToggle.closest('.hidden')) {
    body.hideUsername = hideUsernameToggle.checked;
  }

  if (!body.callEnabled && !body.chatEnabled) {
    return showMsg(dashMessage, 'Enable at least calling or chat', 'error');
  }

  const { ok, data } = isEdit
    ? await api(`/api/links/${editingLinkId}`, 'PUT', body)
    : await api('/api/links', 'POST', body);
  if (ok) {
    createLinkPanel.classList.add('hidden');
    createLinkForm.reset();
    editingLinkId = null;
    document.getElementById('schedule-builder').classList.add('hidden');
    document.getElementById('expiry-builder').classList.add('hidden');
    document.getElementById('fallback-builder').classList.add('hidden');
    loadLinks();
    showMsg(dashMessage, isEdit ? 'Link updated!' : 'Link created!', 'success');
  } else {
    showMsg(dashMessage, data.error, 'error');
  }
});

async function loadLinks() {
  const { ok, data } = await api('/api/links');
  if (!ok) return;
  linksData = data;
  linksShown = linksPerPage;
  // Clear search on fresh load
  document.getElementById('link-search-input').value = '';
  document.getElementById('search-clear-btn').classList.add('hidden');

  // Hide add button for customers who already have a link
  if (currentUser && currentUser.role === 'customer' && data.length >= 1) {
    addLinkBtn.classList.add('hidden');
  } else {
    addLinkBtn.classList.remove('hidden');
  }

  applyLinksView();
}

function getSortedLinks(data) {
  const sorted = [...data];
  if (linksSortNewest) {
    sorted.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
  } else {
    sorted.sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
  }
  return sorted;
}

function applyLinksView() {
  const query = document.getElementById('link-search-input').value.trim().toLowerCase();
  let filtered = linksData;
  if (query.length > 0) {
    filtered = linksData.filter(link => link.name.toLowerCase().includes(query));
  }
  const sorted = getSortedLinks(filtered);
  const page = sorted.slice(0, linksShown);
  renderLinks(page);
  // Show/hide load more
  const loadMoreBtn = document.getElementById('load-more-links');
  if (sorted.length > linksShown) {
    loadMoreBtn.classList.remove('hidden');
    loadMoreBtn.textContent = `Load More (${sorted.length - linksShown} remaining)`;
  } else {
    loadMoreBtn.classList.add('hidden');
  }
  if (filtered.length === 0 && query.length > 0) {
    linksList.innerHTML = `<p class="empty-state">No links matching "<strong>${escapeHtml(query)}</strong>"</p>`;
    loadMoreBtn.classList.add('hidden');
  }
}

function renderLinks(data) {
  if (data.length === 0) {
    linksList.innerHTML = '<p class="empty-state">No links yet. Click <strong>+</strong> to create one.</p>';
    return;
  }

  linksList.innerHTML = data.map(link => {
    const url = `${location.origin}/call/${link.linkId}`;
    let badges = '';

    // Schedule badge
    if (link.schedule && link.schedule.length > 0) {
      const dayAbbr = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
      const days = [...new Set(link.schedule.map(s => dayAbbr[s.day]))].join(', ');
      const t1 = formatTime12(link.schedule[0].startTime);
      const t2 = formatTime12(link.schedule[0].endTime);
      const tz = link.timezone || 'UTC';
      badges += `<span class="link-badge schedule-badge" title="Available: ${days} ${t1} to ${t2} (${tz})">&#128336; ${days} ${t1} - ${t2} ${tz}</span>`;
    }

    // Expiry badge
    if (link.expiresAt) {
      const exp = new Date(link.expiresAt);
      const isExpired = exp < new Date();
      const label = isExpired ? 'Expired' : `Expires ${exp.toLocaleDateString()}`;
      badges += `<span class="link-badge ${isExpired ? 'expired-badge' : 'expiry-badge'}">&#128197; ${label}</span>`;
    }

    // Fallback badge
    if (link.fallbackMessage) {
      badges += `<span class="link-badge fallback-badge" title="${escapeHtml(link.fallbackMessage)}">&#128172; Busy msg</span>`;
    }

    // Chat badge
    if (link.chatEnabled) {
      badges += `<span class="link-badge chat-badge">&#128488; Chat</span>`;
    }

    // Call badge (show when call is disabled, since it's on by default)
    if (link.callEnabled === false) {
      badges += `<span class="link-badge expired-badge">&#128222; Call off</span>`;
    }

    const deleteBtn = currentUser && currentUser.canDelete
      ? `<button class="link-action-btn delete-btn" title="Delete" onclick="deleteLink('${link.linkId}')">&#128465;</button>`
      : '';

    return `
      <div class="link-card" data-link-id="${link.linkId}">
        <div class="link-card-info">
          <h3>${escapeHtml(link.name)}</h3>
          <div class="link-card-url">${url}</div>
          ${badges ? `<div class="link-badges">${badges}</div>` : ''}
        </div>
        <div class="link-card-actions">
          <button class="link-action-btn copy-btn" title="Copy link" onclick="copyLink('${url}')">&#128203;</button>
          <button class="link-action-btn edit-btn" title="Edit" onclick="editLink('${link.linkId}')">&#9998;</button>
          <button class="link-action-btn reset-btn" title="Reset link" onclick="resetLink('${link.linkId}')">&#8635;</button>
          ${deleteBtn}
        </div>
      </div>
    `;
  }).join('');
}

// ========== LINK SEARCH ==========
const linkSearchInput = document.getElementById('link-search-input');
const searchClearBtn = document.getElementById('search-clear-btn');

linkSearchInput.addEventListener('input', () => {
  const query = linkSearchInput.value.trim().toLowerCase();
  searchClearBtn.classList.toggle('hidden', query.length === 0);
  linksShown = linksPerPage; // reset pagination on search
  applyLinksView();
});

searchClearBtn.addEventListener('click', () => {
  linkSearchInput.value = '';
  searchClearBtn.classList.add('hidden');
  linksShown = linksPerPage;
  applyLinksView();
  linkSearchInput.focus();
});

// ========== SORT TOGGLE ==========
document.getElementById('sort-links-btn').addEventListener('click', () => {
  linksSortNewest = !linksSortNewest;
  const btn = document.getElementById('sort-links-btn');
  btn.title = linksSortNewest ? 'Sort: Newest first' : 'Sort: Oldest first';
  btn.classList.toggle('sort-asc', !linksSortNewest);
  linksShown = linksPerPage;
  applyLinksView();
});

// ========== LOAD MORE LINKS ==========
document.getElementById('load-more-links').addEventListener('click', () => {
  linksShown += linksPerPage;
  applyLinksView();
});

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function formatTime12(time24) {
  const [h, m] = time24.split(':').map(Number);
  const period = h >= 12 ? 'PM' : 'AM';
  const hour12 = h === 0 ? 12 : h > 12 ? h - 12 : h;
  return m === 0 ? `${hour12} ${period}` : `${hour12}:${String(m).padStart(2, '0')} ${period}`;
}

window.copyLink = async function(url) {
  try {
    await navigator.clipboard.writeText(url);
    showMsg(dashMessage, 'Link copied!', 'success');
  } catch {
    showMsg(dashMessage, 'Failed to copy', 'error');
  }
};

window.resetLink = async function(linkId) {
  const { ok, data } = await api(`/api/links/${linkId}/reset`, 'PUT');
  if (ok) { loadLinks(); showMsg(dashMessage, 'Link reset!', 'success'); }
  else showMsg(dashMessage, data.error, 'error');
};

window.deleteLink = async function(linkId) {
  const { ok, data } = await api(`/api/links/${linkId}`, 'DELETE');
  if (ok) { loadLinks(); showMsg(dashMessage, 'Link deleted', 'success'); }
  else showMsg(dashMessage, data.error, 'error');
};

window.editLink = function(linkId) {
  const link = linksData.find(l => l.linkId === linkId);
  if (!link) return;

  editingLinkId = linkId;

  // Set form title
  document.getElementById('link-form-title').textContent = 'Edit Link';
  document.getElementById('link-form-submit').textContent = 'Save Changes';

  // Populate name
  document.getElementById('link-name-input').value = link.name;

  // Populate schedule
  const hasSchedule = link.schedule && link.schedule.length > 0;
  document.getElementById('enable-schedule').checked = hasSchedule;
  document.getElementById('schedule-builder').classList.toggle('hidden', !hasSchedule);
  // Uncheck all days first
  document.querySelectorAll('#schedule-days input').forEach(cb => { cb.checked = false; });
  if (hasSchedule) {
    const days = new Set(link.schedule.map(s => s.day));
    document.querySelectorAll('#schedule-days input').forEach(cb => {
      cb.checked = days.has(Number(cb.value));
    });
    document.getElementById('schedule-start').value = link.schedule[0].startTime;
    document.getElementById('schedule-end').value = link.schedule[0].endTime;
    // Set timezone radio
    const tz = link.timezone || 'UTC';
    const tzRadio = document.querySelector(`input[name="timezone"][value="${tz}"]`);
    if (tzRadio) tzRadio.checked = true;
  }

  // Populate expiry
  const hasExpiry = !!link.expiresAt;
  document.getElementById('enable-expiry').checked = hasExpiry;
  document.getElementById('expiry-builder').classList.toggle('hidden', !hasExpiry);
  if (hasExpiry) {
    // Convert to datetime-local format
    const d = new Date(link.expiresAt);
    const local = new Date(d.getTime() - d.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
    document.getElementById('expiry-input').value = local;
  }

  // Populate fallback
  const hasFallback = !!link.fallbackMessage;
  document.getElementById('enable-fallback').checked = hasFallback;
  document.getElementById('fallback-builder').classList.toggle('hidden', !hasFallback);
  if (hasFallback) {
    document.getElementById('fallback-input').value = link.fallbackMessage;
  }

  // Populate call enabled
  document.getElementById('enable-call').checked = link.callEnabled !== false;

  // Populate chat enabled
  document.getElementById('enable-chat').checked = !!link.chatEnabled;
  document.getElementById('chat-seen-toggle').classList.toggle('hidden', !link.chatEnabled);
  document.getElementById('enable-chat-seen').checked = !!link.chatSeenEnabled;

  // Show panel and scroll to it
  createLinkPanel.classList.remove('hidden');
  createLinkPanel.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  document.getElementById('link-name-input').focus();
};

// ========== SOCKET.IO (Owner side) ==========
function connectSocket() {
  if (socket) return;
  socket = io(); // auto-authenticates via httpOnly cookie on server

  // Auth code blocked — immediate logout
  socket.on('auth-blocked', () => {
    document.cookie = 'token=; Max-Age=0; path=/';
    socket.disconnect();
    socket = null;
    dashboardSection.classList.add('hidden');
    authSection.classList.remove('hidden');
    showMsg(message, 'Your access has been revoked', 'error');
  });

  // Request missed calls on connect
  socket.on('connect', () => {
    socket.emit('get-missed-calls');
  });

  // Missed calls list
  socket.on('missed-calls-list', (calls) => {
    renderMissedCalls(calls);
  });

  // New missed call in real-time
  socket.on('missed-call', (call) => {
    // Remove this caller's popup if it exists
    removeIncomingCall(null); // legacy cleanup
    showMsg(dashMessage, `Missed call on "${call.linkName}"`, 'error');
    socket.emit('get-missed-calls');
    loadHistory();
  });

  // Incoming call — add to stack
  socket.on('incoming-call', ({ linkId, linkName, callerSocketId }) => {
    // Avoid duplicate popups for the same caller
    if (incomingCalls.find(c => c.callerSocketId === callerSocketId)) return;
    incomingCalls.push({ callerSocketId, linkName, linkId });
    renderIncomingCalls();
  });

  // WebRTC offer from caller
  socket.on('webrtc-offer', async ({ offer, callerSocketId }) => {
    activeCallerSocketId = callerSocketId;
    await setupPeerConnection(callerSocketId, false);
    await peerConnection.setRemoteDescription(new RTCSessionDescription(offer));
    remoteDescSet = true;
    // Flush buffered ICE candidates
    for (const c of pendingCandidates) {
      await peerConnection.addIceCandidate(new RTCIceCandidate(c));
    }
    pendingCandidates = [];
    const answer = await peerConnection.createAnswer();
    await peerConnection.setLocalDescription(answer);
    socket.emit('webrtc-answer', { targetSocketId: callerSocketId, answer });
  });

  socket.on('webrtc-ice-candidate', async ({ candidate }) => {
    if (!candidate) return;
    if (peerConnection && remoteDescSet) {
      await peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
    } else {
      pendingCandidates.push(candidate);
    }
  });

  socket.on('call-ended', (data) => {
    const callerSocketId = data && data.callerSocketId;
    if (callerSocketId) {
      // A specific caller's call ended (timeout, disconnect, etc.)
      removeIncomingCall(callerSocketId);
      // If this was the active call, clean up
      if (activeCallerSocketId === callerSocketId) {
        endCallCleanup();
        // If in chat panel during call, go back to dashboard
        if (!ownerChatPanel.classList.contains('hidden')) {
          ownerChatPanel.classList.add('hidden');
        }
        dashSection.classList.remove('hidden');
        callScreen.classList.add('hidden');
        showMsg(dashMessage, 'Call ended', 'success');
        loadHistory();
      }
    } else {
      // Generic call ended (e.g., peer hung up during active call)
      endCallCleanup();
      if (!ownerChatPanel.classList.contains('hidden')) {
        ownerChatPanel.classList.add('hidden');
      }
      dashSection.classList.remove('hidden');
      callScreen.classList.add('hidden');
      showMsg(dashMessage, 'Call ended', 'success');
      loadHistory();
    }
  });

  // Chat events
  socket.on('chat-message', (msg) => {
    if (ownerChatJoined && msg.linkId === ownerChatJoined) {
      ownerAppendChatMessage(msg);
      // Auto-mark as seen if chat panel is open and message is from visitor
      if (msg.sender === 'visitor' && !ownerChatPanel.classList.contains('hidden')) {
        socket.emit('chat-seen', { linkId: ownerChatJoined, sender: 'owner' });
      }
    }
  });

  socket.on('chat-typing', (data) => {
    if (data.sender !== 'owner' && data.linkId === ownerChatLinkId) {
      ownerShowTyping();
    }
  });

  socket.on('chat-seen-update', (data) => {
    if (data.linkId === ownerChatJoined) {
      // Update all owner-sent message ticks to seen
      ownerChatMessages.querySelectorAll('.chat-msg-sent .seen-indicator').forEach(el => {
        el.textContent = '✓✓';
        el.classList.add('seen');
      });
    }
  });

  socket.on('chat-notification', ({ linkId, linkName }) => {
    showMsg(dashMessage, `New chat message on "${linkName}"`, 'success');
    loadHistory();
  });

  socket.on('link-visited', ({ linkId, linkName }) => {
    showMsg(dashMessage, `Someone opened your link "${linkName}"`, 'success');
    loadHistory();
  });
}

// ========== Incoming Calls Stack ==========
function renderIncomingCalls() {
  const container = document.getElementById('incoming-calls-container');
  if (incomingCalls.length === 0) {
    container.innerHTML = '';
    return;
  }
  container.innerHTML = incomingCalls.map((call, idx) => `
    <div class="incoming-call-popup" data-caller="${call.callerSocketId}" style="z-index: ${20 + idx}; transform: translateY(${idx * 10}px) scale(${1 - idx * 0.03});">
      <div class="call-overlay-content">
        <div class="call-pulse"></div>
        <h2>Incoming Call</h2>
        <p>From: <span class="highlight">${escapeHtml(call.linkName)}</span></p>
        <div class="call-actions">
          <button class="call-btn accept" onclick="acceptCall('${call.callerSocketId}')">&#128222; Accept</button>
          <button class="call-btn decline" onclick="declineCall('${call.callerSocketId}')">&#10060; Decline</button>
        </div>
      </div>
    </div>
  `).join('');
}

function removeIncomingCall(callerSocketId) {
  incomingCalls = incomingCalls.filter(c => c.callerSocketId !== callerSocketId);
  renderIncomingCalls();
}

window.acceptCall = function(callerSocketId) {
  const call = incomingCalls.find(c => c.callerSocketId === callerSocketId);
  if (!call) return;
  activeCallerSocketId = callerSocketId;

  // Store linkId for in-call chat
  ownerChatLinkId = call.linkId || null;
  ownerChatLinkNameCache = call.linkName || 'Chat';

  // Decline all other incoming calls
  const others = incomingCalls.filter(c => c.callerSocketId !== callerSocketId);
  for (const other of others) {
    socket.emit('call-response', { callerSocketId: other.callerSocketId, accepted: false });
  }
  incomingCalls = [];
  renderIncomingCalls();

  socket.emit('call-response', { callerSocketId, accepted: true });

  // Check if this link has chat enabled to show in-call chat button
  const linkData = linksData.find(l => l.linkId === call.linkId);
  if (linkData && linkData.chatEnabled) {
    document.getElementById('incall-chat-btn').classList.remove('hidden');
  }

  showCallScreen(call.linkName, 'Voice Call');
};

window.declineCall = function(callerSocketId) {
  removeIncomingCall(callerSocketId);
  socket.emit('call-response', { callerSocketId, accepted: false });
  setTimeout(loadHistory, 500);
};

// ========== MISSED CALLS ==========
function renderMissedCalls(calls) {
  const container = document.getElementById('missed-calls-list');
  const section = document.getElementById('missed-calls-section');
  if (!calls || calls.length === 0) {
    section.classList.add('hidden');
    return;
  }
  section.classList.remove('hidden');
  container.innerHTML = calls.map(c => {
    const time = new Date(c.time).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    return `<div class="missed-call-item">
      <span class="missed-call-icon">&#128276;</span>
      <span class="missed-call-text">Missed call on <strong>${escapeHtml(c.linkName)}</strong></span>
      <span class="missed-call-time">${time}</span>
    </div>`;
  }).join('');
}

document.getElementById('clear-missed-btn').addEventListener('click', () => {
  if (socket) socket.emit('clear-missed-calls');
  document.getElementById('missed-calls-section').classList.add('hidden');
});

// ========== CALL HISTORY ==========
let historyData = [];
let historyShown = 10;
const historyPerPage = 10;

async function loadHistory() {
  const { ok, data } = await api('/api/links/history/list');
  if (!ok) return;
  historyData = data;
  historyShown = historyPerPage;
  applyHistoryView();
}

function applyHistoryView() {
  const page = historyData.slice(0, historyShown);
  renderHistory(page);
  const loadMoreBtn = document.getElementById('load-more-history');
  if (historyData.length > historyShown) {
    loadMoreBtn.classList.remove('hidden');
    loadMoreBtn.textContent = `Load More (${historyData.length - historyShown} remaining)`;
  } else {
    loadMoreBtn.classList.add('hidden');
  }
}

function renderHistory(entries) {
  const container = document.getElementById('history-list');
  if (!entries || entries.length === 0) {
    container.innerHTML = '<p class="empty-state">No call history yet.</p>';
    return;
  }

  container.innerHTML = entries.map(entry => {
    const time = new Date(entry.time);
    const dateStr = time.toLocaleDateString([], { month: 'short', day: 'numeric' });
    const timeStr = time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

    let icon, label, detail, typeClass;
    switch (entry.type) {
      case 'completed':
        icon = '&#9989;';
        label = 'Completed';
        typeClass = 'history-completed';
        detail = `Duration: ${formatDuration(entry.duration)}`;
        break;
      case 'missed':
        icon = '&#128276;';
        label = 'Missed';
        typeClass = 'history-missed';
        detail = `Rang for ${entry.ringDuration}s`;
        break;
      case 'declined':
        icon = '&#10060;';
        label = 'Declined';
        typeClass = 'history-declined';
        detail = `Rang for ${entry.ringDuration}s`;
        break;
      case 'caller-hangup':
        icon = '&#128260;';
        label = 'Caller hung up';
        typeClass = 'history-hangup';
        detail = `After ${entry.ringDuration}s`;
        break;
      case 'expired-attempt':
        icon = '&#9203;';
        label = 'Expired link visit';
        typeClass = 'history-expired';
        detail = 'Someone tried calling on an expired link';
        break;
      case 'outside-schedule':
        icon = '&#128337;';
        label = 'Outside schedule';
        typeClass = 'history-schedule';
        detail = 'Someone tried calling outside your set hours';
        break;
      case 'new-chat':
        icon = '&#128488;';
        label = 'New chat message';
        typeClass = 'history-chat';
        detail = `<button class="btn btn-outline btn-sm open-chat-btn" onclick="openOwnerChat('${escapeHtml(entry.linkId)}', '${escapeHtml(entry.linkName)}')">Open Chat</button>`;
        break;
      case 'link-visited':
        icon = '&#128065;';
        label = 'Link opened';
        typeClass = 'history-schedule';
        detail = 'Someone opened this link';
        break;
      default:
        icon = '&#128222;';
        label = entry.type;
        typeClass = '';
        detail = '';
    }

    return `<div class="history-item ${typeClass}">
      <span class="history-icon">${icon}</span>
      <div class="history-info">
        <span class="history-link-name">${escapeHtml(entry.linkName)}</span>
        <span class="history-label">${label}</span>
        <span class="history-detail">${detail}</span>
      </div>
      <div class="history-time">
        <span>${dateStr}</span>
        <span>${timeStr}</span>
      </div>
    </div>`;
  }).join('');
}

function formatDuration(seconds) {
  if (!seconds || seconds === 0) return '0s';
  const m = Math.floor(seconds / 60);
  const s = seconds % 60;
  if (m === 0) return `${s}s`;
  return s === 0 ? `${m}m` : `${m}m ${s}s`;
}

document.getElementById('clear-history-btn').addEventListener('click', async () => {
  const { ok } = await api('/api/links/history/clear', 'DELETE');
  if (ok) {
    historyData = [];
    document.getElementById('history-list').innerHTML = '<p class="empty-state">No call history yet.</p>';
    document.getElementById('load-more-history').classList.add('hidden');
    showMsg(dashMessage, 'History cleared', 'success');
  }
});

document.getElementById('load-more-history').addEventListener('click', () => {
  historyShown += historyPerPage;
  applyHistoryView();
});

// ========== CALL SCREEN (Owner) ==========
function showCallScreen(peerName, subtitle) {
  document.getElementById('call-peer-name').textContent = peerName;
  document.getElementById('call-peer-sub').textContent = subtitle;
  document.getElementById('call-avatar-letter').textContent = (peerName || '?')[0].toUpperCase();
  document.getElementById('call-status-text').textContent = 'Connected';
  document.getElementById('call-timer').textContent = '00:00';
  document.getElementById('call-avatar-circle').classList.remove('ringing');

  dashSection.classList.add('hidden');
  callScreen.classList.remove('hidden');

  callSeconds = 0;
  callTimerInterval = setInterval(() => {
    callSeconds++;
    const m = String(Math.floor(callSeconds / 60)).padStart(2, '0');
    const s = String(callSeconds % 60).padStart(2, '0');
    document.getElementById('call-timer').textContent = `${m}:${s}`;
  }, 1000);
}

// Mute
document.getElementById('mute-btn').addEventListener('click', () => {
  const btn = document.getElementById('mute-btn');
  if (localStream) {
    const track = localStream.getAudioTracks()[0];
    if (track) {
      track.enabled = !track.enabled;
      btn.classList.toggle('muted', !track.enabled);
      btn.textContent = track.enabled ? '\u{1F3A4}' : '\u{1F507}';
    }
  }
});

// End call
document.getElementById('end-call-btn').addEventListener('click', () => {
  if (socket && activeCallerSocketId) {
    socket.emit('end-call', { targetSocketId: activeCallerSocketId });
  }
  endCallCleanup();
  dashSection.classList.remove('hidden');
  callScreen.classList.add('hidden');
  setTimeout(loadHistory, 500);
});

// ========== WebRTC ==========
async function setupPeerConnection(targetSocketId, isCaller) {
  const config = { iceServers: [{ urls: 'stun:stun.l.google.com:19302' }] };
  peerConnection = new RTCPeerConnection(config);

  localStream = await navigator.mediaDevices.getUserMedia({ audio: true });
  localStream.getTracks().forEach(track => peerConnection.addTrack(track, localStream));

  peerConnection.ontrack = (event) => {
    const audio = document.getElementById('remote-audio');
    audio.srcObject = event.streams[0];
    audio.play().catch(() => {});
  };

  peerConnection.onicecandidate = (event) => {
    if (event.candidate) {
      socket.emit('webrtc-ice-candidate', { targetSocketId, candidate: event.candidate });
    }
  };

  if (isCaller) {
    const offer = await peerConnection.createOffer();
    await peerConnection.setLocalDescription(offer);
    socket.emit('webrtc-offer', { targetSocketId, offer });
  }
}

function endCallCleanup() {
  if (peerConnection) { peerConnection.close(); peerConnection = null; }
  if (localStream) { localStream.getTracks().forEach(t => t.stop()); localStream = null; }
  if (callTimerInterval) { clearInterval(callTimerInterval); callTimerInterval = null; }
  activeCallerSocketId = null;
  pendingCandidates = [];
  remoteDescSet = false;
  const muteBtn = document.getElementById('mute-btn');
  if (muteBtn) { muteBtn.classList.remove('muted'); muteBtn.textContent = '\u{1F3A4}'; }
  // Hide in-call chat button
  document.getElementById('incall-chat-btn').classList.add('hidden');
  ownerUpdateVoiceBtnState();
}

// ========== OWNER CHAT SYSTEM ==========
const ownerChatPanel = document.getElementById('owner-chat-panel');
const ownerChatMessages = document.getElementById('owner-chat-messages');
const ownerChatTextInput = document.getElementById('owner-chat-text-input');
const ownerChatSendBtn = document.getElementById('owner-chat-send-btn');
const ownerChatAttachBtn = document.getElementById('owner-chat-attach-btn');
const ownerChatFileInput = document.getElementById('owner-chat-file-input');
const ownerChatVoiceBtn = document.getElementById('owner-chat-voice-btn');
const ownerChatBackBtn = document.getElementById('owner-chat-back-btn');
const ownerChatClearBtn = document.getElementById('owner-chat-clear-btn');
const ownerChatTypingEl = document.getElementById('owner-chat-typing');

let ownerChatLinkId = null;
let ownerChatLinkNameCache = null;
let ownerChatJoined = false;
let ownerMediaRecorder = null;
let ownerVoiceChunks = [];
let ownerIsRecording = false;
let ownerTypingTimeout = null;
let ownerChatPrevScreen = null; // 'dashboard' or 'call'

window.openOwnerChat = function(linkId, linkName) {
  ownerChatLinkId = linkId;
  document.getElementById('owner-chat-header-name').textContent = `Chat - ${linkName}`;

  // Remember where we came from
  if (!callScreen.classList.contains('hidden')) {
    ownerChatPrevScreen = 'call';
    callScreen.classList.add('hidden');
  } else {
    ownerChatPrevScreen = 'dashboard';
    dashSection.classList.add('hidden');
  }
  ownerChatPanel.classList.remove('hidden');

  // Join chat room
  if (socket) {
    if (ownerChatJoined && ownerChatJoined !== linkId) {
      socket.emit('chat-leave', { linkId: ownerChatJoined });
    }
    socket.emit('chat-join', { linkId });
    ownerChatJoined = linkId;
  }
  ownerLoadChatMessages();
  ownerUpdateVoiceBtnState();
};

// Back button
ownerChatBackBtn.addEventListener('click', () => {
  ownerChatPanel.classList.add('hidden');
  if (ownerChatPrevScreen === 'call') {
    callScreen.classList.remove('hidden');
  } else {
    dashSection.classList.remove('hidden');
  }
  if (socket && ownerChatJoined) {
    socket.emit('chat-leave', { linkId: ownerChatJoined });
    ownerChatJoined = null;
  }
});

// Clear chat
ownerChatClearBtn.addEventListener('click', async () => {
  if (!ownerChatLinkId) return;
  const { ok } = await api(`/api/chat/${ownerChatLinkId}/clear`, 'DELETE');
  if (ok) {
    ownerChatMessages.innerHTML = '<p class="empty-state">Chat cleared</p>';
  }
});

// In-call chat button
document.getElementById('incall-chat-btn').addEventListener('click', () => {
  if (!activeCallerSocketId) return;
  const linkId = ownerChatLinkId;
  const linkName = ownerChatLinkNameCache || 'Chat';
  if (linkId) {
    openOwnerChat(linkId, linkName);
  }
});

async function ownerLoadChatMessages() {
  if (!ownerChatLinkId) return;
  try {
    const res = await fetch(`/api/chat/${ownerChatLinkId}/messages`);
    if (!res.ok) {
      ownerChatMessages.innerHTML = '<p class="empty-state">Chat not available</p>';
      return;
    }
    const messages = await res.json();
    ownerChatMessages.innerHTML = '';
    messages.forEach(msg => ownerAppendChatMessage(msg, false));
    ownerScrollChatToBottom();
    // Mark visitor messages as seen
    if (socket && ownerChatLinkId) {
      socket.emit('chat-seen', { linkId: ownerChatLinkId, sender: 'owner' });
    }
  } catch {}
}

function ownerAppendChatMessage(msg, scroll = true) {
  if (ownerChatMessages.querySelector(`[data-msg-id="${msg._id}"]`)) return;

  const div = document.createElement('div');
  div.className = `chat-msg ${msg.sender === 'owner' ? 'chat-msg-sent' : 'chat-msg-received'}`;
  div.dataset.msgId = msg._id;

  const time = new Date(msg.createdAt).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const seenTick = msg.sender === 'owner' ? `<span class="seen-indicator ${msg.seenAt ? 'seen' : ''}">${msg.seenAt ? '✓✓' : '✓'}</span>` : '';
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
      const sizeStr = ownerFormatFileSize(msg.fileSize);
      content = `<div class="chat-bubble chat-file"><a href="${msg.content}" download="${escapeHtml(msg.fileName)}" target="_blank">&#128196; ${escapeHtml(msg.fileName)} <small>(${sizeStr})</small></a><span class="chat-time">${time}${seenTick}</span></div>`;
      break;
  }
  div.innerHTML = content;
  ownerChatMessages.appendChild(div);
  if (scroll) ownerScrollChatToBottom();
}

function ownerScrollChatToBottom() {
  ownerChatMessages.scrollTop = ownerChatMessages.scrollHeight;
}

function ownerFormatFileSize(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (bytes >= 1024 && i < units.length - 1) { bytes /= 1024; i++; }
  return `${bytes.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

// Send text
ownerChatSendBtn.addEventListener('click', ownerSendText);
ownerChatTextInput.addEventListener('keydown', (e) => {
  if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); ownerSendText(); }
});
ownerChatTextInput.addEventListener('input', () => {
  if (socket && ownerChatJoined) {
    socket.emit('chat-typing', { linkId: ownerChatLinkId });
  }
});

function ownerSendText() {
  const text = ownerChatTextInput.value.trim();
  if (!text || !socket || !ownerChatLinkId) return;
  socket.emit('chat-message', { linkId: ownerChatLinkId, type: 'text', content: text });
  ownerChatTextInput.value = '';
}

// File upload
ownerChatAttachBtn.addEventListener('click', () => ownerChatFileInput.click());
ownerChatFileInput.addEventListener('change', async () => {
  const file = ownerChatFileInput.files[0];
  if (!file) return;
  ownerChatFileInput.value = '';

  let msgType = 'file';
  if (file.type.startsWith('image/')) msgType = 'image';
  else if (file.type.startsWith('video/')) msgType = 'video';

  const formData = new FormData();
  formData.append('file', file);

  try {
    const res = await fetch(`/api/chat/${ownerChatLinkId}/upload`, { method: 'POST', body: formData });
    if (!res.ok) { showMsg(dashMessage, 'Upload failed', 'error'); return; }
    const data = await res.json();
    socket.emit('chat-message', {
      linkId: ownerChatLinkId,
      type: msgType,
      content: data.url,
      fileName: data.fileName,
      fileSize: data.fileSize,
    });
  } catch { showMsg(dashMessage, 'Upload failed', 'error'); }
});

// Voice message
ownerChatVoiceBtn.addEventListener('click', ownerToggleVoice);

function ownerUpdateVoiceBtnState() {
  if (peerConnection) {
    ownerChatVoiceBtn.classList.add('disabled');
    ownerChatVoiceBtn.title = 'Voice messages disabled during call';
  } else {
    ownerChatVoiceBtn.classList.remove('disabled');
    ownerChatVoiceBtn.title = 'Voice message';
  }
}

async function ownerToggleVoice() {
  if (peerConnection) {
    showMsg(dashMessage, 'Voice messages disabled during call', 'error');
    return;
  }
  if (ownerIsRecording) {
    if (ownerMediaRecorder && ownerMediaRecorder.state !== 'inactive') {
      ownerMediaRecorder.stop();
    }
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    ownerMediaRecorder = new MediaRecorder(stream);
    ownerVoiceChunks = [];

    ownerMediaRecorder.ondataavailable = (e) => {
      if (e.data.size > 0) ownerVoiceChunks.push(e.data);
    };

    ownerMediaRecorder.onstop = async () => {
      stream.getTracks().forEach(t => t.stop());
      ownerIsRecording = false;
      ownerChatVoiceBtn.classList.remove('recording');
      ownerChatVoiceBtn.innerHTML = '&#127908;';

      const blob = new Blob(ownerVoiceChunks, { type: 'audio/webm' });
      if (blob.size < 1000) return;

      const formData = new FormData();
      formData.append('file', blob, `voice_${Date.now()}.webm`);
      try {
        const res = await fetch(`/api/chat/${ownerChatLinkId}/upload`, { method: 'POST', body: formData });
        if (!res.ok) return;
        const data = await res.json();
        socket.emit('chat-message', {
          linkId: ownerChatLinkId,
          type: 'voice',
          content: data.url,
          fileName: data.fileName,
          fileSize: data.fileSize,
        });
      } catch {}
    };

    ownerMediaRecorder.start();
    ownerIsRecording = true;
    ownerChatVoiceBtn.classList.add('recording');
    ownerChatVoiceBtn.innerHTML = '&#9632;';
  } catch {
    showMsg(dashMessage, 'Could not access microphone', 'error');
  }
}

// Typing indicator
function ownerShowTyping() {
  ownerChatTypingEl.classList.remove('hidden');
  clearTimeout(ownerTypingTimeout);
  ownerTypingTimeout = setTimeout(() => {
    ownerChatTypingEl.classList.add('hidden');
  }, 2000);
}

// ========== STAFF MANAGEMENT ==========
const createStaffBtn = document.getElementById('create-staff-btn');
const createStaffPanel = document.getElementById('create-staff-panel');
const createStaffForm = document.getElementById('create-staff-form');
const cancelStaffBtn = document.getElementById('cancel-staff-btn');
const staffLinksList = document.getElementById('staff-links-list');

if (createStaffBtn) {
  createStaffBtn.addEventListener('click', () => {
    createStaffPanel.classList.toggle('hidden');
    createStaffForm.reset();
  });
}

if (cancelStaffBtn) {
  cancelStaffBtn.addEventListener('click', () => {
    createStaffPanel.classList.add('hidden');
    createStaffForm.reset();
  });
}

if (createStaffForm) {
  createStaffForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = document.getElementById('staff-username-input').value.trim();
    const secretCode = document.getElementById('staff-code-input').value;
    const showVerifiedName = document.getElementById('staff-show-verified').checked;
    const allowDelete = document.getElementById('staff-allow-delete').checked;

    const { ok, data } = await api('/api/staff', 'POST', { username, secretCode, showVerifiedName, allowDelete });
    if (ok) {
      createStaffPanel.classList.add('hidden');
      createStaffForm.reset();
      showMsg(dashMessage, 'Staff link created!', 'success');
      loadStaffLinks();
    } else {
      showMsg(dashMessage, data.error, 'error');
    }
  });
}

async function loadStaffLinks() {
  const { ok, data } = await api('/api/staff');
  if (!ok) return;
  renderStaffLinks(data);
}

function renderStaffLinks(links) {
  if (!links || links.length === 0) {
    staffLinksList.innerHTML = '<p class="empty-state">No staff links yet.</p>';
    return;
  }

  staffLinksList.innerHTML = links.map(link => {
    const joinUrl = `${location.origin}/join/staff/${link.linkId}`;
    const statusClass = link.connectedUser ? 'joined' : link.status;
    const statusLabel = link.connectedUser ? `Joined: ${link.connectedUser}` : link.status;

    const pauseBtn = link.status === 'active'
      ? `<button class="mgmt-action-btn pause-btn" onclick="staffAction('${link.linkId}', 'pause')">⏸ Pause</button>`
      : `<button class="mgmt-action-btn resume-btn" onclick="staffAction('${link.linkId}', 'resume')">▶ Resume</button>`;

    const verifiedBadge = link.showVerifiedName
      ? '<span class="mgmt-link-status joined" style="margin-left:6px;">✅ Verified</span>'
      : '';

    const deleteBadge = link.allowDelete
      ? '<span class="mgmt-link-status joined" style="margin-left:6px;">🔐 Delete</span>'
      : '';

    const deleteBtn = currentUser && currentUser.canDelete
      ? `<button class="mgmt-action-btn delete-btn" onclick="staffAction('${link.linkId}', 'delete')">&#128465; Delete</button>`
      : '';

    return `
      <div class="mgmt-link-card">
        <div class="mgmt-link-top">
          <span class="mgmt-link-username">&#128100; ${escapeHtml(link.username)} ${verifiedBadge} ${deleteBadge}</span>
          <span class="mgmt-link-status ${statusClass}">${statusLabel}</span>
        </div>
        <div class="mgmt-link-details">
          <span class="mgmt-link-detail"><strong>Code:</strong> ${escapeHtml(link.secretCode)}</span>
          <span class="mgmt-link-url">${joinUrl}</span>
        </div>
        <div class="mgmt-link-actions">
          <button class="mgmt-action-btn copy-btn" onclick="copyStaffLink('${joinUrl}')">&#128203; Copy Link</button>
          ${pauseBtn}
          ${deleteBtn}
        </div>
      </div>
    `;
  }).join('');
}

window.copyStaffLink = async function(url) {
  try { await navigator.clipboard.writeText(url); showMsg(dashMessage, 'Staff link copied!', 'success'); }
  catch { showMsg(dashMessage, 'Failed to copy', 'error'); }
};

window.staffAction = async function(linkId, action) {
  if (action === 'pause') {
    const { ok, data } = await api(`/api/staff/${linkId}/status`, 'PUT', { status: 'paused' });
    if (ok) { showMsg(dashMessage, 'Staff paused', 'success'); loadStaffLinks(); }
    else showMsg(dashMessage, data.error, 'error');
  } else if (action === 'resume') {
    const { ok, data } = await api(`/api/staff/${linkId}/status`, 'PUT', { status: 'active' });
    if (ok) { showMsg(dashMessage, 'Staff resumed', 'success'); loadStaffLinks(); }
    else showMsg(dashMessage, data.error, 'error');
  } else if (action === 'delete') {
    const { ok, data } = await api(`/api/staff/${linkId}`, 'DELETE');
    if (ok) { showMsg(dashMessage, 'Staff deleted', 'success'); loadStaffLinks(); }
    else showMsg(dashMessage, data.error, 'error');
  }
};

// ========== CUSTOMER MANAGEMENT ==========
const createCustomerBtn = document.getElementById('create-customer-btn');
const createCustomerPanel = document.getElementById('create-customer-panel');
const createCustomerForm = document.getElementById('create-customer-form');
const cancelCustomerBtn = document.getElementById('cancel-customer-btn');
const customerLinksList = document.getElementById('customer-links-list');

if (createCustomerBtn) {
  createCustomerBtn.addEventListener('click', () => {
    createCustomerPanel.classList.toggle('hidden');
    createCustomerForm.reset();
  });
}

if (cancelCustomerBtn) {
  cancelCustomerBtn.addEventListener('click', () => {
    createCustomerPanel.classList.add('hidden');
    createCustomerForm.reset();
  });
}

if (createCustomerForm) {
  createCustomerForm.addEventListener('submit', async (e) => {
    e.preventDefault();
    const username = document.getElementById('customer-username-input').value.trim();
    const secretCode = document.getElementById('customer-code-input').value;

    const { ok, data } = await api('/api/customer', 'POST', { username, secretCode });
    if (ok) {
      createCustomerPanel.classList.add('hidden');
      createCustomerForm.reset();
      showMsg(dashMessage, 'Customer link created!', 'success');
      loadCustomerLinks();
    } else {
      showMsg(dashMessage, data.error, 'error');
    }
  });
}

async function loadCustomerLinks() {
  const { ok, data } = await api('/api/customer');
  if (!ok) return;
  renderCustomerLinks(data);
}

function renderCustomerLinks(links) {
  if (!links || links.length === 0) {
    customerLinksList.innerHTML = '<p class="empty-state">No customer links yet.</p>';
    return;
  }

  customerLinksList.innerHTML = links.map(link => {
    const joinUrl = `${location.origin}/join/customer/${link.linkId}`;
    const statusClass = link.connectedUser ? 'joined' : link.status;
    const statusLabel = link.connectedUser ? `Joined: ${link.connectedUser}` : link.status;

    const pauseBtn = link.status === 'active'
      ? `<button class="mgmt-action-btn pause-btn" onclick="customerAction('${link.linkId}', 'pause')">⏸ Pause</button>`
      : `<button class="mgmt-action-btn resume-btn" onclick="customerAction('${link.linkId}', 'resume')">▶ Resume</button>`;

    const deleteBtn = currentUser && currentUser.canDelete
      ? `<button class="mgmt-action-btn delete-btn" onclick="customerAction('${link.linkId}', 'delete')">&#128465; Delete</button>`
      : '';

    return `
      <div class="mgmt-link-card">
        <div class="mgmt-link-top">
          <span class="mgmt-link-username">&#128100; ${escapeHtml(link.username)}</span>
          <span class="mgmt-link-status ${statusClass}">${statusLabel}</span>
        </div>
        <div class="mgmt-link-details">
          <span class="mgmt-link-detail"><strong>Code:</strong> ${escapeHtml(link.secretCode)}</span>
          <span class="mgmt-link-url">${joinUrl}</span>
        </div>
        <div class="mgmt-link-actions">
          <button class="mgmt-action-btn copy-btn" onclick="copyCustomerLink('${joinUrl}')">&#128203; Copy Link</button>
          ${pauseBtn}
          ${deleteBtn}
        </div>
      </div>
    `;
  }).join('');
}

window.copyCustomerLink = async function(url) {
  try { await navigator.clipboard.writeText(url); showMsg(dashMessage, 'Customer link copied!', 'success'); }
  catch { showMsg(dashMessage, 'Failed to copy', 'error'); }
};

window.customerAction = async function(linkId, action) {
  if (action === 'pause') {
    const { ok, data } = await api(`/api/customer/${linkId}/status`, 'PUT', { status: 'paused' });
    if (ok) { showMsg(dashMessage, 'Customer paused', 'success'); loadCustomerLinks(); }
    else showMsg(dashMessage, data.error, 'error');
  } else if (action === 'resume') {
    const { ok, data } = await api(`/api/customer/${linkId}/status`, 'PUT', { status: 'active' });
    if (ok) { showMsg(dashMessage, 'Customer resumed', 'success'); loadCustomerLinks(); }
    else showMsg(dashMessage, data.error, 'error');
  } else if (action === 'delete') {
    const { ok, data } = await api(`/api/customer/${linkId}`, 'DELETE');
    if (ok) { showMsg(dashMessage, 'Customer deleted', 'success'); loadCustomerLinks(); }
    else showMsg(dashMessage, data.error, 'error');
  }
};

// ===== Check Auth on Load =====
(async () => {
  const { ok } = await api('/api/auth/me');
  if (ok) loadDashboard();
})();
