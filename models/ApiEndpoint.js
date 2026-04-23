const mongoose = require('mongoose');

const apiEndpointSchema = new mongoose.Schema({
  owner: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    unique: true, // one API endpoint per user
  },
  apiKey: {
    type: String,
    required: true,
    unique: true,
  },
  // Default configuration applied to all generated links
  timezone: {
    type: String,
    enum: ['IST', 'UTC'],
    default: 'UTC',
  },
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
  expiresAt: {
    type: Date,
    default: null,
  },
  fallbackMessage: {
    type: String,
    trim: true,
    maxlength: 200,
    default: '',
  },
  callEnabled: {
    type: Boolean,
    default: true,
  },
  chatEnabled: {
    type: Boolean,
    default: false,
  },
  chatSeenEnabled: {
    type: Boolean,
    default: false,
  },
  // Track all links generated via this endpoint
  generatedLinks: [
    {
      externalUsername: {
        type: String,
        required: true,
        trim: true,
      },
      callLinkId: {
        type: String,
        required: true,
      },
      createdAt: {
        type: Date,
        default: Date.now,
      },
    },
  ],
  createdAt: {
    type: Date,
    default: Date.now,
  },
});

// Compound index so we can quickly check duplicate usernames per endpoint
apiEndpointSchema.index({ 'generatedLinks.externalUsername': 1, owner: 1 });

module.exports = mongoose.model('ApiEndpoint', apiEndpointSchema);
