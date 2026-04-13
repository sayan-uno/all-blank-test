const mongoose = require('mongoose');

const staffLinkSchema = new mongoose.Schema({
  linkId: {
    type: String,
    required: true,
    unique: true,
  },
  username: {
    type: String,
    required: true,
    trim: true,
    minlength: 3,
    maxlength: 30,
  },
  secretCode: {
    type: String,
    required: true,
    minlength: 4,
  },
  owner: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
  },
  authCode: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'AuthCode',
    required: true,
  },
  connectedUser: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null,
  },
  showVerifiedName: {
    type: Boolean,
    default: false,
  },
  allowDelete: {
    type: Boolean,
    default: false,
  },
  status: {
    type: String,
    enum: ['active', 'paused'],
    default: 'active',
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
});

module.exports = mongoose.model('StaffLink', staffLinkSchema);
