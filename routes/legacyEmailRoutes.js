const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const mongoose = require('mongoose');
const User = require('../models/User');
const Challenge = require('../models/LegacyEmailChallenge');
const { sendVerificationEmail } = require('../services/sendVerificationEmail');

const publicReply = () => ({ message: 'Если данные верны, письмо отправлено.', challengeId: crypto.randomBytes(20).toString('hex') });
const digest = (id, email, code) => crypto.createHmac('sha256', process.env.JWT_SECRET).update(`legacy:${id}:${email}:${code}`).digest('hex');

module.exports = function legacyEmailRoutes(app, limiter) {
  app.post('/api/auth/legacy-email/start', limiter, async (req, res) => {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = String(req.body?.password || '');
    if (email.length > 254 || password.length > 128) return res.json(publicReply());
    if (!process.env.JWT_SECRET || !process.env.RESEND_API_KEY || !process.env.EMAIL_FROM) return res.status(503).json({ error: 'Почта не настроена' });
    try {
      const user = await User.findOne({ email }).select('+passwordHash');
      if (!user?.passwordHash || user.emailVerifiedAt || !(await bcrypt.compare(password, user.passwordHash))) return res.json(publicReply());
      const previous = await Challenge.findOne({ userId: user._id });
      if (previous?.nextSendAt > new Date()) return res.json(publicReply());
      const id = crypto.randomBytes(20).toString('hex');
      const code = String(crypto.randomInt(1000000)).padStart(6, '0');
      const now = Date.now();
      await Challenge.findOneAndUpdate({ userId: user._id }, { $set: { challengeId: id, codeHash: digest(id, email, code), attempts: 0, expiresAt: new Date(now + 600000), nextSendAt: new Date(now + 60000) } }, { upsert: true });
      try { await sendVerificationEmail(email, code); } catch (error) {
        await Challenge.deleteOne({ userId: user._id, challengeId: id });
        console.error('Legacy email delivery failed:', error.message);
        return res.status(503).json({ error: 'Письмо не отправлено' });
      }
      return res.json({ message: 'Если данные верны, письмо отправлено.', challengeId: id });
    } catch (error) { console.error('Legacy email start failed:', error.message); return res.status(503).json({ error: 'Повторите позже' }); }
  });
  app.post('/api/auth/legacy-email/confirm', limiter, async (req, res) => {
    const id = String(req.body?.challengeId || '');
    const code = String(req.body?.code || '');
    if (!/^[a-f0-9]{40}$/.test(id) || !/^\d{6}$/.test(code)) return res.status(400).json({ error: 'Код недействителен' });
    try {
      const challenge = await Challenge.findOne({ challengeId: id }).select('+codeHash');
      if (!challenge || challenge.expiresAt <= new Date() || challenge.attempts >= 5) return res.status(400).json({ error: 'Код недействителен' });
      const user = await User.findById(challenge.userId).select('email emailVerifiedAt');
      if (!user || user.emailVerifiedAt) return res.status(400).json({ error: 'Код недействителен' });
      if (!crypto.timingSafeEqual(Buffer.from(challenge.codeHash, 'hex'), Buffer.from(digest(id, user.email, code), 'hex'))) {
        await Challenge.updateOne({ _id: challenge._id, attempts: { $lt: 5 } }, { $inc: { attempts: 1 } });
        return res.status(400).json({ error: 'Код недействителен' });
      }
      const session = await mongoose.startSession();
      try { await session.withTransaction(async () => {
        const claimed = await Challenge.findOneAndDelete({ _id: challenge._id, challengeId: id, attempts: { $lt: 5 }, expiresAt: { $gt: new Date() } }).session(session);
        if (!claimed) throw new Error('Код уже использован');
        const updated = await User.updateOne({ _id: user._id, email: user.email, emailVerifiedAt: null }, { $set: { emailVerifiedAt: new Date() } }, { session });
        if (updated.modifiedCount !== 1) throw new Error('Аккаунт изменился');
      }); } finally { await session.endSession(); }
      return res.json({ success: true, message: 'Почта подтверждена. Войдите по email и паролю.' });
    } catch (error) { console.error('Legacy email confirmation failed:', error.message); return res.status(503).json({ error: 'Подтверждение временно недоступно' }); }
  });
};
