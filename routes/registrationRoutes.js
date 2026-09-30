const crypto = require('crypto');
const mongoose = require('mongoose');
const bcrypt = require('bcryptjs');
const User = require('../models/User');
const PendingRegistration = require('../models/PendingRegistration');
const { sendVerificationEmail } = require('../services/sendVerificationEmail');

const ttlMs = 10 * 60 * 1000;
function hashCode(email, code) {
  return crypto.createHmac('sha256', process.env.JWT_SECRET).update(`register:${email}:${code}`).digest('hex');
}
function generateCode() { return String(crypto.randomInt(1000000)).padStart(6, '0'); }
function validEmail(value) { return value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value); }
function pendingReply() { return { success: true, requiresVerification: true, message: 'Введите код из письма в течение 10 минут.' }; }

module.exports = function registerEmailRoutes(app, authLimiter, createReferralCode) {
  app.post('/api/auth/register', authLimiter, async (req, res) => {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const password = String(req.body?.password || '');
    const username = String(req.body?.username || '').trim().slice(0, 32);
    const referralCode = String(req.body?.referralCode || '').trim().toUpperCase();
    if (!validEmail(email)) return res.status(400).json({ error: 'Введите корректный email' });
    if (password.length < 10 || password.length > 128) return res.status(400).json({ error: 'Пароль должен содержать 10–128 символов' });
    if (!process.env.JWT_SECRET || !process.env.RESEND_API_KEY || !process.env.EMAIL_FROM) {
      return res.status(503).json({ error: 'Регистрация по почте пока не настроена' });
    }
    try {
      if (await User.exists({ email })) return res.status(409).json({ error: 'Адрес уже зарегистрирован' });
      if (referralCode && !(await User.exists({ referralCode }))) return res.status(400).json({ error: 'Реферальный код не найден' });
      const previous = await PendingRegistration.findOne({ email });
      if (previous?.nextSendAt > new Date()) return res.status(429).json({ error: 'Запросить новый код можно через минуту' });
      const code = generateCode(), codeHash = hashCode(email, code), now = Date.now();
      await PendingRegistration.findOneAndUpdate({ email }, { $set: {
        username, referralCode, passwordHash: await bcrypt.hash(password, 12), codeHash,
        attempts: 0, expiresAt: new Date(now + ttlMs), nextSendAt: new Date(now + 60000)
      } }, { upsert: true });
      try { await sendVerificationEmail(email, code); }
      catch (error) {
        await PendingRegistration.deleteOne({ email, codeHash });
        console.error('Email delivery failed:', error.message);
        return res.status(503).json({ error: 'Письмо не отправлено. Повторите регистрацию позже' });
      }
      return res.status(202).json(pendingReply());
    } catch (error) {
      console.error('Pending registration failed:', error.message);
      return res.status(503).json({ error: 'Регистрация временно недоступна' });
    }
  });

  app.post('/api/auth/verify-email', authLimiter, async (req, res) => {
    const email = String(req.body?.email || '').trim().toLowerCase();
    const code = String(req.body?.code || '');
    if (!validEmail(email) || !/^\d{6}$/.test(code)) return res.status(400).json({ error: 'Неверный или истёкший код' });
    try {
      const pending = await PendingRegistration.findOne({ email }).select('+codeHash +passwordHash');
      if (!pending || pending.expiresAt <= new Date() || pending.attempts >= 5) return res.status(400).json({ error: 'Неверный или истёкший код' });
      const actual = Buffer.from(hashCode(email, code), 'hex');
      const expected = Buffer.from(pending.codeHash, 'hex');
      if (!crypto.timingSafeEqual(actual, expected)) {
        await PendingRegistration.updateOne({ _id: pending._id, attempts: { $lt: 5 } }, { $inc: { attempts: 1 } });
        return res.status(400).json({ error: 'Неверный или истёкший код' });
      }
      const session = await mongoose.startSession();
      try {
        await session.withTransaction(async () => {
          const claimed = await PendingRegistration.findOneAndDelete({ _id: pending._id,
            codeHash: pending.codeHash, attempts: { $lt: 5 }, expiresAt: { $gt: new Date() } }).session(session);
          if (!claimed) throw new Error('Code already used');
          const referrer = claimed.referralCode ? await User.findOne({ referralCode: claimed.referralCode }).session(session) : null;
          const safeName = claimed.username || email.split('@')[0].replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 20) || 'player';
          await User.create([{ email, username: `${safeName}_${crypto.randomBytes(2).toString('hex')}`,
            passwordHash: claimed.passwordHash, referralCode: createReferralCode(),
            referredBy: referrer?._id || null, emailVerifiedAt: new Date() }], { session });
          if (referrer) await User.updateOne({ _id: referrer._id }, { $inc: { referralsCount: 1 } }, { session });
        });
      } finally { await session.endSession(); }
      return res.status(201).json({ success: true, message: 'Почта подтверждена. Теперь войдите по email и паролю.' });
    } catch (error) {
      if (error.code === 11000) return res.status(409).json({ error: 'Адрес уже зарегистрирован' });
      console.error('Email verification failed:', error.message);
      return res.status(503).json({ error: 'Подтверждение временно недоступно' });
    }
  });
};
