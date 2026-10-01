const mongoose = require('mongoose');

const userSchema = new mongoose.Schema({
  email: { type: String, unique: true, sparse: true, lowercase: true, trim: true },
  passwordHash: { type: String, select: false },
  emailVerifiedAt: { type: Date, default: null },
  username: { type: String, unique: true, sparse: true, trim: true },
  balance: { type: Number, default: 0, min: 0 },
  walletAddress: { type: String, trim: true, default: '' },

  // Creator-роль назначается администратором после ручной проверки заявки.
  role: { type: String, enum: ['player', 'creator'], default: 'player' },
  creatorStatus: { type: String, enum: ['none', 'pending', 'approved', 'rejected'], default: 'none' },

  // Ежедневный бонус: серия и последний использованный календарный день (Africa/Lagos).
  dailyBonusStreak: { type: Number, default: 0, min: 0, max: 7 },
  lastDailyClaim: { type: Date, default: null },
  lastDailyClaimDay: { type: String, default: null },

  // Реферальная атрибуция и начисления.
  referralCode: { type: String, unique: true, sparse: true, uppercase: true, trim: true },
  referredBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User', default: null },
  referralRewardGranted: { type: Boolean, default: false },
  referralsCount: { type: Number, default: 0, min: 0 },
  referralEarnings: { type: Number, default: 0, min: 0 },

  stats: {
    totalBets: { type: Number, default: 0 },
    totalWins: { type: Number, default: 0 },
    totalWagered: { type: Number, default: 0 },
    totalWon: { type: Number, default: 0 }
  },

  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('User', userSchema);
