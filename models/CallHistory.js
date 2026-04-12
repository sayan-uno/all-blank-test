const mongoose = require('mongoose');

const callHistorySchema = new mongoose.Schema({
  owner: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    required: true,
    index: true,
  },
  linkName: { type: String, required: true },
  linkId: { type: String },
  // 'completed' | 'missed' | 'declined' | 'caller-hangup' | 'expired-attempt' | 'outside-schedule' | 'new-chat' | 'link-visited'
  type: {
    type: String,
    enum: ['completed', 'missed', 'declined', 'caller-hangup', 'expired-attempt', 'outside-schedule', 'new-chat', 'link-visited'],
    required: true,
  },
  time: { type: Date, default: Date.now },
  // Duration in seconds (only for completed calls)
  duration: { type: Number, default: 0 },
  // Ring time in seconds (how long it rang before outcome)
  ringDuration: { type: Number, default: 0 },
});

module.exports = mongoose.model('CallHistory', callHistorySchema);
