const mongoose = require('mongoose');

const authCodeSchema = new mongoose.Schema({
  code: {
    type: String,
    required: true,
    unique: true,
    index: true,
  },
  status: {
    type: String,
    enum: ['ready', 'active', 'blocked'],
    default: 'ready',
  },
  verifiedName: {
    type: String,
    default: null,
    trim: true,
  },
  connectedUser: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null,
  },
  allowDelete: {
    type: Boolean,
    default: false,
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
});

module.exports = mongoose.model('AuthCode', authCodeSchema);
