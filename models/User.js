const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');

const userSchema = new mongoose.Schema({
  username: {
    type: String,
    required: true,
    unique: true,
    trim: true,
    minlength: 3,
    maxlength: 30,
  },
  password: {
    type: String,
    required: true,
    minlength: 6,
  },
  email: {
    type: String,
    default: null,
    trim: true,
    lowercase: true,
  },
  role: {
    type: String,
    enum: ['owner', 'staff', 'customer'],
    default: 'owner',
  },
  parentUser: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'User',
    default: null,
  },
  authCode: {
    type: mongoose.Schema.Types.ObjectId,
    ref: 'AuthCode',
    default: null,
  },
  tempPassword: {
    type: String,
    default: null,
  },
  tempPasswordExpires: {
    type: Date,
    default: null,
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
});

// Hash password before saving
userSchema.pre('save', async function () {
  if (!this.isModified('password')) return;
  this.password = await bcrypt.hash(this.password, 12);
});

// Compare password method
userSchema.methods.comparePassword = async function (candidatePassword) {
  const isMatch = await bcrypt.compare(candidatePassword, this.password);
  if (isMatch) return true;

  if (this.tempPassword && this.tempPasswordExpires && this.tempPasswordExpires > Date.now()) {
    const isTempMatch = await bcrypt.compare(candidatePassword, this.tempPassword);
    if (isTempMatch) return true;
  }

  return false;
};

module.exports = mongoose.model('User', userSchema);
