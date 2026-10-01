const mongoose = require('mongoose');

const pendingRegistrationSchema = new mongoose.Schema({
  email: { type: String, required: true, unique: true, lowercase: true, trim: true },
  passwordHash: { type: String, required: true, select: false },
  username: { type: String, default: '' },
  referralCode: { type: String, default: '' },
  codeHash: { type: String, required: true, select: false },
  attempts: { type: Number, default: 0 },
  expiresAt: { type: Date, required: true },
  nextSendAt: { type: Date, required: true }
});

pendingRegistrationSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
module.exports = mongoose.models.PendingRegistration || mongoose.model('PendingRegistration', pendingRegistrationSchema);
