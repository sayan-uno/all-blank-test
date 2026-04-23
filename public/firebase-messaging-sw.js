// Firebase Messaging Service Worker
// This runs in the background to receive push notifications even when the browser is closed

importScripts('https://www.gstatic.com/firebasejs/10.12.0/firebase-app-compat.js');
importScripts('https://www.gstatic.com/firebasejs/10.12.0/firebase-messaging-compat.js');

// Initialize Firebase in the service worker
firebase.initializeApp({
  apiKey: "AIzaSyD2Lz_Vf1fG9fG0idALAikOPu4dk9oPwU4",
  authDomain: "calldrop-af263.firebaseapp.com",
  projectId: "calldrop-af263",
  storageBucket: "calldrop-af263.firebasestorage.app",
  messagingSenderId: "25680263206",
  appId: "1:25680263206:web:3c7aa17e70fbcf03d28ee7",
});

const messaging = firebase.messaging();

// Handle background messages (when tab is closed or page is not focused)
messaging.onBackgroundMessage((payload) => {
  const data = payload.data || {};
  const title = data.title || 'CallDrop';
  const body = data.body || 'You have a new notification';

  let tag = 'calldrop-notification';
  let requireInteraction = false;

  switch (data.type) {
    case 'incoming-call':
      tag = 'calldrop-incoming-call';
      requireInteraction = true; // Keep notification visible until user interacts
      break;
    case 'missed-call':
      tag = 'calldrop-missed-call';
      break;
    case 'new-chat':
      tag = 'calldrop-chat-' + (data.linkId || '');
      break;
    case 'link-visited':
      tag = 'calldrop-link-visited';
      break;
  }

  return self.registration.showNotification(title, {
    body,
    icon: '/favicon.ico',
    badge: '/favicon.ico',
    tag,
    requireInteraction,
    data: data,
    vibrate: data.type === 'incoming-call' ? [200, 100, 200, 100, 200] : [200, 100, 200],
  });
});

// Handle notification click — open or focus the app
self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true }).then((windowClients) => {
      // If a window is already open, focus it
      for (const client of windowClients) {
        if (client.url.includes(self.location.origin) && 'focus' in client) {
          return client.focus();
        }
      }
      // Otherwise open a new window
      return clients.openWindow('/');
    })
  );
});
