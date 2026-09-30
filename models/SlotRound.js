const mongoose = require('mongoose');

const slotRoundSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  spinId: { type: String, required: true, trim: true },
  gameId: { type: String, enum: ['penalty-pulse', 'sandstorm'], required: true },
  betAmount: { type: Number, required: true, min: 5 },
  grid: { type: [[String]], required: true }, // 5 reels × 3 rows
  lineWins: { type: [mongoose.Schema.Types.Mixed], default: [] },
  feature: { type: mongoose.Schema.Types.Mixed, default: null },
  payout: { type: Number, required: true, min: 0 },
  balanceAfter: { type: Number, required: true, min: 0 },
  createdAt: { type: Date, default: Date.now }
});

slotRoundSchema.index({ userId: 1, spinId: 1 }, { unique: true });

module.exports = mongoose.models.SlotRound || mongoose.model('SlotRound', slotRoundSchema);
