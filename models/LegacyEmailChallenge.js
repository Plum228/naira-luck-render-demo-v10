const mongoose = require('mongoose');
const challengeSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, required: true, unique: true, ref: 'User' },
  challengeId: { type: String, required: true, unique: true },
  codeHash: { type: String, required: true, select: false },
  expiresAt: { type: Date, required: true },
  nextSendAt: { type: Date, required: true },
  attempts: { type: Number, default: 0 }
});
challengeSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
module.exports = mongoose.models.LegacyEmailChallenge || mongoose.model('LegacyEmailChallenge', challengeSchema);
