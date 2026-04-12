const mongoose = require('mongoose');

const chatMessageSchema = new mongoose.Schema({
  linkId: { type: String, required: true, index: true },
  sender: { type: String, enum: ['owner', 'visitor'], required: true },
  type: { type: String, enum: ['text', 'image', 'video', 'file', 'voice'], default: 'text' },
  content: { type: String, default: '' },
  fileName: { type: String, default: '' },
  fileSize: { type: Number, default: 0 },
  seenAt: { type: Date, default: null },
  createdAt: { type: Date, default: Date.now },
});

module.exports = mongoose.model('ChatMessage', chatMessageSchema);
