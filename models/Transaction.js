const mongoose = require('mongoose');

const transactionSchema = new mongoose.Schema({
  userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User', required: true },
  amount: { type: Number, required: true, min: 0 },
  type: {
    type: String,
    enum: ['deposit', 'withdraw', 'bet', 'win', 'daily_bonus', 'promo', 'referral_bonus', 'referral_commission'],
    required: true
  },
  description: { type: String, default: '' },
  // Хэш транзакции из сети Tron (только для крипто-депозитов)
  txHash: { type: String, unique: true, sparse: true, trim: true },
  status: { type: String, enum: ['pending', 'completed', 'failed'], default: 'completed' },
  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Transaction', transactionSchema);
