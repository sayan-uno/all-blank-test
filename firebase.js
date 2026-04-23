const admin = require('firebase-admin');
const path = require('path');

// Initialize Firebase Admin SDK
// Production: reads from FIREBASE_SERVICE_ACCOUNT env variable (JSON string)
// Local dev: reads from firebase-service-account.json file
let serviceAccount;

if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  // Production — parse the JSON string from environment variable
  serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
} else {
  // Local development — read from file
  serviceAccount = require(path.join(__dirname, 'firebase-service-account.json'));
}

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const messaging = admin.messaging();

/**
 * Send a push notification via Firebase Cloud Messaging.
 * Automatically clears invalid tokens from the database.
 * 
 * @param {string} fcmToken - The recipient's FCM token
 * @param {string} title - Notification title
 * @param {string} body - Notification body text
 * @param {object} data - Optional data payload (all values must be strings)
 * @returns {Promise<boolean>} - true if sent successfully, false otherwise
 */
async function sendPushNotification(fcmToken, title, body, data = {}) {
  if (!fcmToken) return false;

  try {
    // Ensure all data values are strings (FCM requirement)
    const stringData = {};
    for (const [key, val] of Object.entries(data)) {
      stringData[key] = String(val);
    }

    // Send data-only message (no 'notification' field).
    // This prevents the browser from auto-displaying a notification,
    // letting our service worker handle it once via onBackgroundMessage.
    stringData.title = title;
    stringData.body = body;

    await messaging.send({
      token: fcmToken,
      data: stringData,
      webpush: {
        headers: {
          Urgency: 'high',
        },
      },
    });

    return true;
  } catch (err) {
    // If token is invalid/expired, clear it from the database
    if (
      err.code === 'messaging/invalid-registration-token' ||
      err.code === 'messaging/registration-token-not-registered'
    ) {
      const User = require('./models/User');
      await User.updateMany({ fcmToken }, { $set: { fcmToken: null } });
      console.log('Cleared invalid FCM token from database');
    } else {
      console.error('FCM send error:', err.message);
    }
    return false;
  }
}

/**
 * Send a webhook POST request to the user's trigger URL.
 * Fire-and-forget — does not block the calling code.
 * 
 * @param {string} triggerUrl - The webhook URL saved by the user
 * @param {object} payload - JSON payload to send
 * @returns {Promise<boolean>} - true if sent successfully, false otherwise
 * 
 * Payload format sent to the trigger URL:
 * {
 *   "event": "incoming-call" | "missed-call" | "call-declined" | "call-completed" |
 *            "caller-hangup" | "new-chat" | "link-visited",
 *   "linkId": "abc123",
 *   "linkName": "My Call Link",
 *   "timestamp": "2026-04-15T00:00:00.000Z",
 *   ... (extra fields depending on event type)
 * }
 */
async function sendTriggerWebhook(triggerUrl, payload) {
  if (!triggerUrl) return false;

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10000); // 10s timeout

    await fetch(triggerUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...payload,
        timestamp: new Date().toISOString(),
      }),
      signal: controller.signal,
    });

    clearTimeout(timeout);
    return true;
  } catch (err) {
    console.error('Trigger webhook error:', err.message);
    return false;
  }
}

module.exports = { sendPushNotification, sendTriggerWebhook };
