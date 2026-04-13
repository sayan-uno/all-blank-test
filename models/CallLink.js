const mongoose = require('mongoose');

const callLinkSchema = new mongoose.Schema({
  linkId: {
    type: String,
    required: true,
    unique: true,
  },
  name: {
    type: String,
    required: true,
    trim: true,
    maxlength: 50,
  },
  owner: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  // Timezone region: 'IST' (Indian Standard Time, UTC+5:30) or 'UTC'
  timezone: {
    type: String,
    enum: ['IST', 'UTC'],
    default: 'UTC',
  },
  // Schedule: array of { day: 0-6 (Sun-Sat), startTime: "HH:MM", endTime: "HH:MM" }
  schedule: {
    type: [
      {
        day: { type: Number, min: 0, max: 6 },
        startTime: { type: String },
        endTime: { type: String },
      },
    ],
    default: [],
  },
  // Optional expiry date — link won't work after this
  expiresAt: {
    type: Date,
    default: null,
  },
  // Fallback message shown when 30s timeout happens
  fallbackMessage: {
    type: String,
    trim: true,
    maxlength: 200,
    default: '',
  },
  // Enable calling on this link
  callEnabled: {
    type: Boolean,
    default: true,
  },
  // Enable chat on this link
  chatEnabled: {
    type: Boolean,
    default: false,
  },
  // If true, both parties see read receipts. If false, only owner sees them.
  chatSeenEnabled: {
    type: Boolean,
    default: false,
  },
  // If true, the owner's username is hidden from visitors (only verified name shown)
  hideUsername: {
    type: Boolean,
    default: false,
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
});

module.exports = mongoose.model('CallLink', callLinkSchema);
