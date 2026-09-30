require('dotenv').config();
const path = require('path');
const fs = require('fs');
const express = require('express');
const mongoose = require('mongoose');
const http = require('http');
const crypto = require('crypto');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const { Server} = require('socket.io');

const User = require(fs.existsSync(path.join(__dirname, 'models/User.js')) ? './models/User' : './User');
const Transaction = require(fs.existsSync(path.join(__dirname, 'models/Transaction.js')) ? './models/Transaction' : './Transaction');
const SlotRound = require(fs.existsSync(path.join(__dirname, 'models/SlotRound.js')) ? './models/SlotRound' : './SlotRound');
const { verifyDeposit } = require(fs.existsSync(path.join(__dirname, 'services/walletService.js')) ? './services/walletService' : './walletService');

// Создаем Express-приложение и HTTP-сервер для совместной работы сокетов
const app = express();
const server = http.createServer(app);
const io = new Server(server);

// CSP отключён, потому что MVP содержит встроенные CSS/JS; при публичном релизе вынести их в файлы и включить CSP.
const allowIframe = process.env.NODE_ENV !== 'production' || process.env.ALLOW_EMBEDDED_PREVIEW === 'true';
app.use(helmet({ contentSecurityPolicy: false, crossOriginEmbedderPolicy: false, frameguard: allowIframe ? false : { action: 'deny' } }));
app.disable('x-powered-by');
const proxyHops = Number(process.env.TRUST_PROXY_HOPS || (process.env.NODE_ENV === 'production' ? 1 : 0));
if (proxyHops > 0) app.set('trust proxy', proxyHops);
app.use(express.json({ limit: '32kb' }));
const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 10, standardHeaders: 'draft-7', legacyHeaders: false, message: { error: 'Слишком много попыток. Попробуйте позже.' } });

// Avoid stale HTML/inline JS in the embedded preview after deployment updates.
app.use((req, res, next) => {
  if (req.path === '/' || req.path.endsWith('.html')) res.setHeader('Cache-Control', 'no-store, max-age=0');
  next();
});

app.get('/healthz', (req, res) => {
  const databaseConnected = mongoose.connection.readyState === 1;
  return res.status(databaseConnected ? 200 : 503).json({ status: databaseConnected ? 'ok' : 'database_unavailable' });
});

const publicDir = path.join(__dirname, 'public');
const APP_BUILD = 'nature-safari-20260929-v10';
if (fs.existsSync(publicDir)) {
  // A versioned URL defeats preview-proxy caches that served an old inline client bundle.
  app.get('/', (req, res) => {
    const params = new URLSearchParams({ build: APP_BUILD });
    if (typeof req.query.ref === 'string') params.set('ref', req.query.ref);
    res.redirect(302, `/auth-fix-v9.html?${params.toString()}`);
  });
  app.use(express.static(publicDir, {
    index: false,
    setHeaders(res, filePath) {
      if (filePath.endsWith('.html')) res.setHeader('Cache-Control', 'no-store, max-age=0');
      else if (/-v\d+\.webp$/i.test(filePath)) res.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      else res.setHeader('Cache-Control', 'public, max-age=86400');
    }
  }));
} else {
  app.get('/', (req, res) => res.sendFile(path.join(__dirname, 'index.html')));
}

// Схема Промокодов прямо в server.js для удобства MVP (в легальном казино выносится в /models)
const promoCodeSchema = new mongoose.Schema({
  code: { type: String, unique: true, required: true, uppercase: true, trim: true },
  reward: { type: Number, required: true }, // Сколько монет дает (например, 500)
  usedBy: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }] // Кто уже активировал
});
const Promo = mongoose.models.Promo || mongoose.model('Promo', promoCodeSchema);

const DEMO_USER_ID = '651f1f1f1f1f1f1f1f1f1f1f';
const MONGODB_URI = process.env.MONGODB_URI || 'mongodb://127.0.0.1:27017/nigeria_casino';
// Для production задайте постоянный случайный JWT_SECRET в окружении.
const JWT_SECRET = process.env.JWT_SECRET || crypto.randomBytes(32).toString('hex');
if (!process.env.JWT_SECRET) console.warn('JWT_SECRET is not set; sessions will be lost after restart.');
const TOKEN_TTL_SECONDS = 12 * 60 * 60;
const DAILY_BONUS_AMOUNTS = (process.env.DAILY_BONUS_AMOUNTS || '50,75,100,150,200,300,500')
  .split(',').map(Number).filter(n => Number.isFinite(n) && n > 0);
const REFERRAL_INVITER_BONUS = Number(process.env.REFERRAL_INVITER_BONUS || 100);
const REFERRAL_NEW_USER_BONUS = Number(process.env.REFERRAL_NEW_USER_BONUS || 50);
const AUTH_DEBUG_FILE = path.join(__dirname, '.auth-debug.log');
function authDebug(message) {
  if (process.env.AUTH_DEBUG !== 'true') return;
  const line = `[${new Date().toISOString()}] ${message}`;
  console.log(line);
  try { fs.appendFileSync(AUTH_DEBUG_FILE, `${line}\n`, { mode: 0o600 }); } catch (_) {}
}

function createReferralCode() {
  return crypto.randomBytes(5).toString('hex').toUpperCase();
}
function getCookie(req, name) {
  const entry = (req.headers.cookie || '').split(';').map(v => v.trim()).find(v => v.startsWith(`${name}=`));
  return entry ? decodeURIComponent(entry.slice(name.length + 1)) : null;
}
function setAuthCookie(req, res, userId) {
  const token = jwt.sign({ sub: String(userId) }, JWT_SECRET, { expiresIn: TOKEN_TTL_SECONDS });
  const secure = req.secure || process.env.NODE_ENV === 'production';
  if (secure) {
    // Partitioned cookies (CHIPS) can survive third-party-cookie blocking in the embedded preview.
    const expires = new Date(Date.now() + TOKEN_TTL_SECONDS * 1000).toUTCString();
    res.append('Set-Cookie', `session=${token}; Max-Age=${TOKEN_TTL_SECONDS}; Expires=${expires}; Path=/; HttpOnly; Secure; SameSite=None; Partitioned`);
  } else {
    res.cookie('session', token, { httpOnly: true, sameSite: 'lax', secure: false, maxAge: TOKEN_TTL_SECONDS * 1000, path: '/' });
  }
  return token;
}
function requireAuth(req, res, next) {
  const authHeader = req.headers.authorization || '';
  const bearer = authHeader.match(/^Bearer\s+(.+)$/i)?.[1];
  const customToken = req.get('x-session-token');
  const cookieToken = getCookie(req, 'session');
  const token = bearer || customToken || cookieToken;
  const via = bearer ? 'authorization' : customToken ? 'x-session-token' : cookieToken ? 'cookie' : 'none';
  if (!token) {
    authDebug(`[auth] missing token: ${req.method} ${req.originalUrl}; via=${via}; build=${req.get('x-client-build') || 'unknown'}`);
    return res.status(401).json({ error: 'Требуется вход в аккаунт' });
  }
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.userId = payload.sub;
    authDebug(`[auth] accepted: ${req.method} ${req.originalUrl}; via=${via}; build=${req.get('x-client-build') || 'unknown'}`);
    return next();
  } catch (err) {
    authDebug(`[auth] rejected token: ${req.method} ${req.originalUrl}; via=${via}; reason=${err.name}; build=${req.get('x-client-build') || 'unknown'}`);
    return res.status(401).json({ error: 'Сессия истекла. Войдите снова.' });
  }
}

function lagosDay(date = new Date()) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Africa/Lagos', year: 'numeric', month: '2-digit', day: '2-digit'
  }).formatToParts(date);
  const part = Object.fromEntries(parts.map(p => [p.type, p.value]));
  return `${part.year}-${part.month}-${part.day}`;
}
function previousCalendarDay(day) {
  const date = new Date(`${day}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() - 1);
  return date.toISOString().slice(0, 10);
}

mongoose.connect(MONGODB_URI, { dbName: process.env.MONGODB_DB || 'nigeria_casino', serverSelectionTimeoutMS: 10000 })
  .then(async () => {
    console.log('Connected to MongoDB');
    await User.updateOne(
      { _id: DEMO_USER_ID },
      { $setOnInsert: { username: 'demo_investor', balance: 1000, referralCode: createReferralCode() } },
      { upsert: true }
    );
    // Генерируем тестовый промокод при старте, если его нет
    await Promo.updateOne(
      { code: 'NAIRA500' },
      { $setOnInsert: { reward: 500, usedBy: [] } },
      { upsert: true }
    );
    await User.updateOne({ _id: DEMO_USER_ID, $or: [{ referralCode: { $exists: false } }, { referralCode: null }] }, { $set: { referralCode: createReferralCode() } });
    if (process.env.DEMO_EMAIL && process.env.DEMO_PASSWORD) {
      const demoEmail = process.env.DEMO_EMAIL.trim().toLowerCase();
      const emailOwner = await User.findOne({ email: demoEmail, _id: { $ne: DEMO_USER_ID } }).select('_id');
      if (!emailOwner && process.env.DEMO_PASSWORD.length >= 10) {
        await User.updateOne({ _id: DEMO_USER_ID }, { $set: { email: demoEmail, passwordHash: await bcrypt.hash(process.env.DEMO_PASSWORD, 12) } });
      } else {
        console.warn('Demo credentials were not seeded: email is already used or password is shorter than 10 characters.');
      }
    }
    console.log('Promo code NAIRA500 ready for test!');

    // Запускаем игровой движок Crash сразу после подключения к БД
    startCrashEngine();
  })
  .catch(err => console.error('DB connection error:', err.message));

// ==========================================
// ИГРОВОЙ ДВИЖОК CRASH НА WEBSOCKETS (СЕРВЕРНАЯ ЛОГИКА)
// ==========================================
let gameState = 'waiting'; // waiting, IN_GAME, crashed
let currentMultiplier = 1.00;
let crashPoint = 1.00;
let activeBets = new Map(); // Хранилище активных ставок в раунде: userId -> { betAmount }

function generateCrashPoint() {
  const randomFloat = Math.random();
  const houseEdge = 0.03; // 3% преимущество казино
  if (randomFloat < houseEdge) return 1.00;
  return Math.floor((100 * (1 - houseEdge)) / (1 - randomFloat)) / 100;
}

function startCrashEngine() {
  // 1. Фаза ожидания ставок (10 секунд перед стартом)
  gameState = 'waiting';
  currentMultiplier = 1.00;
  crashPoint = generateCrashPoint();
  activeBets.clear();

  io.emit('crash_waiting', { timeToStart: 10 });

  setTimeout(() => {
    // 2. Фаза полета графика
    gameState = 'IN_GAME';
    io.emit('crash_start');

    const gameInterval = setInterval(() => {
      // Экспоненциальный рост графика (чем выше икс, тем быстрее он растет)
      const increment = 0.005 * currentMultiplier;
      currentMultiplier += increment;

      if (currentMultiplier >= crashPoint) {
        // ИГРА ВЗОРВАЛАСЬ
        clearInterval(gameInterval);
        gameState = 'crashed';
        io.emit('crash_crashed', { crashPoint });

        // Все, кто не успел нажать кнопку "Забрать", проигрывают. Деньги уже списаны.
        // Перезапуск цикла через 4 секунды паузы
        setTimeout(startCrashEngine, 4000);
      } else {
        // Транслируем текущий икс всем вкладкам в реальном времени
        io.emit('crash_tick', { multiplier: currentMultiplier.toFixed(2) });
      }
    }, 50); // Частота обновления 20 раз в секунду

  }, 10000);
}

// WebSocket использует ту же HttpOnly-сессию; identity нельзя подменить в payload.
io.use((socket, next) => {
  const cookie = socket.handshake.headers.cookie || '';
  const raw = cookie.split(';').map(v => v.trim()).find(v => v.startsWith('session='));
  const token = socket.handshake.auth?.token || (raw ? decodeURIComponent(raw.slice('session='.length)) : null);
  if (!token) {
    authDebug(`[socket-auth] missing token; authField=${Boolean(socket.handshake.auth?.token)} cookie=${Boolean(raw)}`);
    return next(new Error('Требуется вход в аккаунт'));
  }
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    socket.userId = payload.sub;
    authDebug(`[socket-auth] accepted; authField=${Boolean(socket.handshake.auth?.token)} cookie=${Boolean(raw)}`);
    return next();
  } catch (err) {
    authDebug(`[socket-auth] rejected token; reason=${err.name}`);
    return next(new Error('Сессия истекла'));
  }
});

// Обработка WebSocket подключений от браузеров
io.on('connection', (socket) => {
  // При подключении отправляем клиенту текущий статус игры
  socket.emit('game_status', { gameState, currentMultiplier: currentMultiplier.toFixed(2) });

  // Игрок делает ставку через сокеты
  socket.on('place_bet', async (data) => {
    const { betAmount } = data || {};
    const userId = socket.userId;
    const numericBet = Number(betAmount);

    if (gameState !== 'waiting') {
      return socket.emit('game_error', { message: 'Идет раунд, дождитесь фазы ставок!' });
    }
    if (!userId || !mongoose.Types.ObjectId.isValid(userId)) {
      return socket.emit('game_error', { message: 'Некорректный ID пользователя' });
    }
    if (!Number.isFinite(numericBet) || numericBet <= 0) {
      return socket.emit('game_error', { message: 'Неверная сумма ставки' });
    }
    // Защита от двойной ставки в одном раунде (чтобы вторая не перезаписала первую в Map)
    if (activeBets.has(String(userId))) {
      return socket.emit('game_error', { message: 'Вы уже сделали ставку в этом раунде!' });
    }

    try {
      // Атомарное списание ставки
      const user = await User.findOneAndUpdate(
        { _id: userId, balance: { $gte: numericBet } },
        { $inc: { balance: -numericBet, 'stats.totalBets': 1, 'stats.totalWagered': numericBet } },
        { new: true }
      );

      if (!user) {
        return socket.emit('game_error', { message: 'Недостаточно средств!' });
      }

      activeBets.set(String(userId), { betAmount: numericBet });
      Transaction.create({ userId, amount: numericBet, type: 'bet', description: 'Ставка Crash' }).catch(err => console.error('Bet ledger error:', err.message));
      socket.emit('bet_accepted', { newBalance: user.balance });
      io.emit('player_bet_placed', { username: user.username || 'Игрок', betAmount: numericBet });
    } catch (e) {
      socket.emit('game_error', { message: 'Ошибка базы данных' });
    }
  });

  // Игрок нажимает кнопку "Забрать деньги" (Cashout) в реальном времени
  socket.on('cashout', async (data) => {
    const userKey = String(socket.userId || '');

    if (gameState !== 'IN_GAME') {
      return socket.emit('game_error', { message: 'Забирать деньги можно только во время полета!' });
    }
    if (!activeBets.has(userKey)) {
      return socket.emit('game_error', { message: 'Ваша ставка не найдена в этом раунде' });
    }

    const playerBet = activeBets.get(userKey);
    const winMultiplier = currentMultiplier; // Фиксируем икс на сервере в миллисекунду клика
    activeBets.delete(userKey); // Удаляем из списка активных, защищая от повторного клика

    const winnings = Math.round(playerBet.betAmount * winMultiplier * 100) / 100;

    try {
      const updatedUser = await User.findByIdAndUpdate(
        userKey,
        { $inc: { balance: winnings, 'stats.totalWins': 1, 'stats.totalWon': winnings } },
        { new: true }
      );

      if (!updatedUser) {
        return socket.emit('game_error', { message: 'Пользователь не найден' });
      }

      Transaction.create({ userId: userKey, amount: winnings, type: 'win', description: `Выигрыш Crash ×${winMultiplier.toFixed(2)}` }).catch(err => console.error('Win ledger error:', err.message));
      socket.emit('cashout_success', { winnings, newBalance: updatedUser.balance });
      io.emit('player_cashed_out', {
        username: updatedUser.username || 'Игрок',
        winMultiplier: winMultiplier.toFixed(2),
        winnings
      });
    } catch (e) {
      socket.emit('game_error', { message: 'Ошибка начисления выигрыша' });
    }
  });
});

// ==========================================
// Регистрация, вход и личный кабинет
// ==========================================
app.post('/api/auth/register', authLimiter, async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  const requestedUsername = String(req.body?.username || '').trim().slice(0, 32);
  const referralCode = String(req.body?.referralCode || '').trim().toUpperCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return res.status(400).json({ error: 'Введите корректный email' });
  if (password.length < 10 || password.length > 128) return res.status(400).json({ error: 'Пароль должен содержать от 10 до 128 символов' });
  let referrer = null;
  try {
    if (await User.exists({ email })) return res.status(409).json({ error: 'Аккаунт с таким email уже существует' });
    if (referralCode) {
      referrer = await User.findOne({ referralCode }).select('_id');
      if (!referrer) return res.status(400).json({ error: 'Реферальный код не найден' });
    }
    const safeName = requestedUsername || email.split('@')[0].replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 20) || 'player';
    const user = await User.create({
      email,
      username: `${safeName}_${crypto.randomBytes(2).toString('hex')}`,
      passwordHash: await bcrypt.hash(password, 12),
      referralCode: createReferralCode(),
      referredBy: referrer?._id || null
    });
    if (referrer) await User.updateOne({ _id: referrer._id }, { $inc: { referralsCount: 1 } });
    const token = setAuthCookie(req, res, user._id);
    return res.status(201).json({ success: true, token, user: { id: user._id, email: user.email, username: user.username } });
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ error: 'Email или имя уже заняты' });
    console.error('Registration error:', err.message);
    return res.status(500).json({ error: 'Не удалось создать аккаунт' });
  }
});

app.post('/api/auth/login', authLimiter, async (req, res) => {
  const email = String(req.body?.email || '').trim().toLowerCase();
  const password = String(req.body?.password || '');
  try {
    const user = await User.findOne({ email }).select('+passwordHash');
    if (!user || !user.passwordHash || !(await bcrypt.compare(password, user.passwordHash))) {
      authDebug('[auth-login] rejected credentials');
      return res.status(401).json({ error: 'Неверный email или пароль' });
    }
    const token = setAuthCookie(req, res, user._id);
    authDebug('[auth-login] success; token issued');
    return res.json({ success: true, token, user: { id: user._id, email: user.email, username: user.username } });
  } catch (err) {
    return res.status(500).json({ error: 'Ошибка входа' });
  }
});

app.post('/api/auth/logout', (req, res) => {
  const secure = req.secure || process.env.NODE_ENV === 'production';
  if (secure) res.append('Set-Cookie', 'session=; Max-Age=0; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Path=/; HttpOnly; Secure; SameSite=None; Partitioned');
  else res.clearCookie('session', { httpOnly: true, sameSite: 'lax', secure: false, path: '/' });
  return res.json({ success: true });
});

app.get('/api/me', requireAuth, async (req, res) => {
  try {
    const user = await User.findById(req.userId).select('-passwordHash').lean();
    if (!user) return res.status(404).json({ error: 'Аккаунт не найден' });
    const transactions = await Transaction.find({ userId: req.userId }).sort({ createdAt: -1 }).limit(12).lean();
    return res.json({
      user: {
        id: user._id, email: user.email, username: user.username, role: user.role,
        balance: user.balance, referralCode: user.referralCode,
        referralLink: `${req.protocol}://${req.get('host')}/?ref=${encodeURIComponent(user.referralCode || '')}`,
        referralsCount: user.referralsCount, referralEarnings: user.referralEarnings,
        dailyBonusStreak: user.dailyBonusStreak, lastDailyClaimDay: user.lastDailyClaimDay, creatorStatus: user.creatorStatus,
        stats: user.stats, createdAt: user.createdAt
      },
      transactions: transactions.map(t => ({ amount: t.amount, type: t.type, status: t.status, description: t.description, createdAt: t.createdAt }))
    });
  } catch (err) {
    return res.status(500).json({ error: 'Не удалось загрузить кабинет' });
  }
});

// Дальнейшие пользовательские API требуют действующую сессию.
app.use('/api', (req, res, next) => {
  if (req.path.startsWith('/auth/')) return next();
  return requireAuth(req, res, next);
});

const slotLimiter = rateLimit({
  windowMs: 60 * 1000, limit: 30, standardHeaders: 'draft-7', legacyHeaders: false,
  message: { error: 'Слишком много вращений подряд. Подождите минуту.' }
});
const SLOT_GAMES = {
  'penalty-pulse': {
    name: 'Canopy Kick', scatter: 'whistle',
    symbols: [
      { id: 'ball', weight: 30 }, { id: 'glove', weight: 25 }, { id: 'boot', weight: 20 },
      { id: 'whistle', weight: 2 }, { id: 'trophy', weight: 12 }, { id: 'wild', weight: 11 }
    ],
    pays: {
      ball: { 3: 0.5, 4: 1.5, 5: 5 }, glove: { 3: 0.75, 4: 2, 5: 7 },
      boot: { 3: 1, 4: 3, 5: 10 }, whistle: { 3: 1.5, 4: 5, 5: 15 },
      trophy: { 3: 2, 4: 7, 5: 25 }, wild: { 3: 2, 4: 8, 5: 30 }
    }
  },
  sandstorm: {
    name: 'Nigeria Savanna', scatter: 'scarab',
    symbols: [
      { id: 'shell', weight: 30 }, { id: 'camel', weight: 25 }, { id: 'palm', weight: 20 },
      { id: 'lamp', weight: 14 }, { id: 'scarab', weight: 2 }, { id: 'wild', weight: 9 }
    ],
    pays: {
      shell: { 3: 0.5, 4: 1.5, 5: 5 }, camel: { 3: 0.75, 4: 2.5, 5: 8 },
      palm: { 3: 1, 4: 4, 5: 12 }, lamp: { 3: 1.5, 4: 6, 5: 20 },
      scarab: { 3: 2, 4: 8, 5: 30 }, wild: { 3: 3, 4: 10, 5: 35 }
    }
  }
};
const SLOT_LINES = [
  [1, 1, 1, 1, 1], [0, 0, 0, 0, 0], [2, 2, 2, 2, 2],
  [0, 1, 2, 1, 0], [2, 1, 0, 1, 2]
];
function drawSlotSymbol(game) {
  const symbols = game.symbols;
  let roll = crypto.randomInt(100);
  for (const symbol of symbols) {
    roll -= symbol.weight;
    if (roll < 0) return symbol.id;
  }
  return symbols[symbols.length - 1].id;
}
function evaluateSlotLines(grid, game, totalBet) {
  const lineWins = [];
  for (let lineIndex = 0; lineIndex < SLOT_LINES.length; lineIndex++) {
    const path = SLOT_LINES[lineIndex];
    const values = path.map((row, reel) => grid[reel][row]);
    const target = values.find(symbol => symbol !== 'wild') || 'wild';
    let count = 0;
    for (const symbol of values) {
      if (symbol === target || symbol === 'wild') count++;
      else break;
    }
    const multiplier = count >= 3 ? (game.pays[target]?.[count] || 0) : 0;
    if (!multiplier) continue;
    const prize = Math.round((totalBet / SLOT_LINES.length) * multiplier * 100) / 100;
    lineWins.push({ line: lineIndex + 1, symbol: target, count, multiplier, payout: prize,
      cells: path.slice(0, count).map((row, reel) => [reel, row]) });
  }
  return lineWins;
}
function makeSlotOutcome(gameId, betAmount) {
  const game = SLOT_GAMES[gameId];
  const grid = Array.from({ length: 5 }, () => Array.from({ length: 3 }, () => drawSlotSymbol(game)));
  let feature = null;
  const scatterCells = [];
  for (let reel = 0; reel < grid.length; reel++) {
    for (let row = 0; row < grid[reel].length; row++) {
      if (grid[reel][row] === game.scatter) scatterCells.push([reel, row]);
    }
  }
  if (scatterCells.length >= 3 && gameId === 'penalty-pulse') {
    const kicks = Array.from({ length: 3 }, () => {
      const goal = crypto.randomInt(100) < 43;
      return { goal, multiplier: goal ? crypto.randomInt(1, 4) : 0 };
    });
    const goals = kicks.filter(kick => kick.goal).length;
    feature = { type: 'penalty-shootout', scatterCount: scatterCells.length, scatterCells, kicks,
      bonusPayout: Math.round(kicks.reduce((sum, kick) => sum + kick.multiplier, 0) * betAmount * 100) / 100 };
  } else if (scatterCells.length >= 3 && gameId === 'sandstorm') {
    const reel = crypto.randomInt(5);
    grid[reel] = ['wild', 'wild', 'wild'];
    feature = { type: 'sandstorm-wild', scatterCount: scatterCells.length, scatterCells, reel };
  }
  const lineWins = evaluateSlotLines(grid, game, betAmount);
  const linePayout = lineWins.reduce((sum, win) => sum + win.payout, 0);
  const featurePayout = feature?.bonusPayout || 0;
  const payout = Math.round((linePayout + featurePayout) * 100) / 100;
  return { grid, lineWins, feature, payout };
}
function slotRoundResponse(round, duplicate = false) {
  return { success: true, duplicate, game: round.gameId, betAmount: round.betAmount,
    grid: round.grid, lineWins: round.lineWins, feature: round.feature,
    payout: round.payout, balance: round.balanceAfter };
}

app.post('/api/slots/spin', slotLimiter, async (req, res) => {
  if (process.env.NODE_ENV === 'production' && (process.env.ENABLE_SLOTS !== 'true' || process.env.MONGODB_DB !== 'naira_luck_demo')) {
    return res.status(503).json({ error: 'Демо-слоты требуют ENABLE_SLOTS=true и отдельную базу naira_luck_demo.' });
  }
  const gameId = String(req.body?.game || '');
  const betAmount = Number(req.body?.betAmount);
  const spinId = String(req.body?.spinId || '');
  if (!SLOT_GAMES[gameId]) return res.status(400).json({ error: 'Выберите доступный слот.' });
  if (!Number.isSafeInteger(betAmount) || betAmount < 5 || betAmount > 500 || betAmount % 5 !== 0) {
    return res.status(400).json({ error: 'Ставка должна быть от 5 до 500 ₦ с шагом 5 ₦.' });
  }
  if (!/^[a-f0-9-]{32,36}$/i.test(spinId)) return res.status(400).json({ error: 'Не удалось проверить вращение. Повторите попытку.' });
  const userId = req.userId;
  const outcome = makeSlotOutcome(gameId, betAmount);
  const session = await mongoose.startSession();
  let result;
  try {
    await session.withTransaction(async () => {
      const prior = await SlotRound.findOne({ userId, spinId }).session(session);
      if (prior) {
        if (prior.gameId !== gameId || prior.betAmount !== betAmount) {
          const e = new Error('Идентификатор вращения уже использован. Начните новое вращение.'); e.appCode = 'SPIN_ID_REUSED'; throw e;
        }
        result = slotRoundResponse(prior, true);
        return;
      }
      const charged = await User.findOneAndUpdate(
        { _id: userId, balance: { $gte: betAmount } },
        { $inc: { balance: -betAmount, 'stats.totalBets': 1, 'stats.totalWagered': betAmount } },
        { new: true, session }
      );
      if (!charged) { const e = new Error('Недостаточно виртуального баланса.'); e.appCode = 'INSUFFICIENT_BALANCE'; throw e; }
      let balanceAfter = charged.balance;
      if (outcome.payout > 0) {
        const credited = await User.findByIdAndUpdate(userId,
          { $inc: { balance: outcome.payout, 'stats.totalWins': 1, 'stats.totalWon': outcome.payout } },
          { new: true, session });
        if (!credited) throw new Error('Аккаунт не найден.');
        balanceAfter = credited.balance;
      }
      const record = new SlotRound({ userId, spinId, gameId, betAmount, grid: outcome.grid,
        lineWins: outcome.lineWins, feature: outcome.feature, payout: outcome.payout, balanceAfter });
      await record.save({ session });
      const ledger = [{ userId, amount: betAmount, type: 'bet', description: `Демо-слот ${SLOT_GAMES[gameId].name}` }];
      if (outcome.payout > 0) ledger.push({ userId, amount: outcome.payout, type: 'win', description: `Выигрыш в ${SLOT_GAMES[gameId].name}` });
      await Transaction.create(ledger, { session });
      result = slotRoundResponse(record);
    });
    return res.json(result);
  } catch (err) {
    if (err.code === 11000) {
      const prior = await SlotRound.findOne({ userId, spinId }).lean();
      if (prior && prior.gameId === gameId && prior.betAmount === betAmount) return res.json(slotRoundResponse(prior, true));
    }
    if (err.appCode === 'INSUFFICIENT_BALANCE') return res.status(409).json({ error: err.message });
    if (err.appCode === 'SPIN_ID_REUSED') return res.status(409).json({ error: err.message });
    console.error('Slot spin error:', err.message);
    return res.status(503).json({ error: 'Не удалось завершить вращение. Баланс не изменён; попробуйте ещё раз.' });
  } finally {
    await session.endSession();
  }
});

app.post('/api/creator/apply', async (req, res) => {
  try {
    const user = await User.findById(req.userId);
    if (!user) return res.status(404).json({ error: 'Аккаунт не найден' });
    if (user.role === 'creator' || user.creatorStatus === 'approved') return res.json({ success: true, status: 'approved' });
    if (user.creatorStatus === 'pending') return res.status(409).json({ error: 'Заявка уже ожидает проверки', status: 'pending' });
    user.creatorStatus = 'pending';
    await user.save();
    return res.json({ success: true, status: 'pending', message: 'Заявка отправлена на ручную проверку.' });
  } catch (err) {
    return res.status(500).json({ error: 'Не удалось отправить заявку' });
  }
});

app.post('/api/bonus/daily/claim', async (req, res) => {
  const today = lagosDay();
  const session = await mongoose.startSession();
  let result;
  try {
    await session.withTransaction(async () => {
      const user = await User.findById(req.userId).session(session);
      if (!user) { const e = new Error('Аккаунт не найден'); e.appCode = 'USER_MISSING'; throw e; }
      if (user.lastDailyClaimDay === today) { const e = new Error('Ежедневный бонус уже получен сегодня'); e.appCode = 'DAILY_ALREADY_CLAIMED'; throw e; }
      const streak = user.lastDailyClaimDay === previousCalendarDay(today) ? (user.dailyBonusStreak % 7) + 1 : 1;
      const amount = DAILY_BONUS_AMOUNTS[(streak - 1) % DAILY_BONUS_AMOUNTS.length] || 50;
      const updated = await User.findOneAndUpdate(
        { _id: req.userId, lastDailyClaimDay: user.lastDailyClaimDay ?? null },
        { $set: { lastDailyClaim: new Date(), lastDailyClaimDay: today, dailyBonusStreak: streak }, $inc: { balance: amount } },
        { new: true, session }
      );
      if (!updated) { const e = new Error('Бонус уже получен. Обновите кабинет.'); e.appCode = 'DAILY_ALREADY_CLAIMED'; throw e; }
      await Transaction.create([{ userId: req.userId, amount, type: 'daily_bonus', description: `Ежедневный бонус, день серии ${streak}` }], { session });
      result = { success: true, amount, streak, balance: updated.balance, nextClaimDay: today };
    });
    return res.json(result);
  } catch (err) {
    if (err.appCode === 'DAILY_ALREADY_CLAIMED') return res.status(409).json({ error: err.message, nextClaimDay: today });
    if (err.appCode === 'USER_MISSING') return res.status(404).json({ error: err.message });
    console.error('Daily bonus transaction error:', err.message);
    return res.status(503).json({ error: 'Не удалось безопасно начислить бонус. Проверьте, что MongoDB поддерживает транзакции (replica set).' });
  } finally {
    await session.endSession();
  }
});

// ==========================================
// 1. API: Пополнение баланса через USDT (TRC20)
// ==========================================
app.post('/api/deposit', async (req, res) => {
  if (process.env.ENABLE_DEPOSITS !== 'true') {
    return res.status(404).json({ error: 'Пополнения отключены в демонстрационном режиме.' });
  }
  const { txHash } = req.body || {};
  const userId = req.userId;
  if (!txHash || typeof txHash !== 'string' || !txHash.trim()) return res.status(400).json({ error: 'Отсутствует хэш транзакции' });

  try {
    const cleanHash = txHash.trim();
    const depositResult = await verifyDeposit(cleanHash);
    if (!depositResult || !depositResult.success) {
      return res.status(400).json({ success: false, message: depositResult?.reason || 'Не удалось подтвердить транзакцию' });
    }

    const session = await mongoose.startSession();
    let newBalance;
    try {
      await session.withTransaction(async () => {
        await Transaction.create([{
          userId, amount: depositResult.amount, type: 'deposit', txHash: cleanHash,
          status: 'completed', description: 'Подтверждённый депозит USDT TRC20'
        }], { session });

        const updatedUser = await User.findByIdAndUpdate(userId,
          { $inc: { balance: depositResult.amount } }, { new: true, session });
        if (!updatedUser) { const e = new Error('Пользователь не найден'); e.appCode = 'USER_MISSING'; throw e; }
        newBalance = updatedUser.balance;

        // Разовый фиксированный бонус срабатывает после первого подтверждённого депозита.
        if (REFERRAL_INVITER_BONUS > 0 && REFERRAL_NEW_USER_BONUS > 0) {
          const invited = await User.findById(userId).select('referredBy referralRewardGranted').session(session);
          if (invited?.referredBy && !invited.referralRewardGranted) {
            const claimed = await User.findOneAndUpdate(
              { _id: userId, referredBy: invited.referredBy, referralRewardGranted: { $ne: true } },
              { $set: { referralRewardGranted: true } }, { new: true, session }
            );
            if (claimed) {
              const inviter = await User.findByIdAndUpdate(invited.referredBy,
                { $inc: { balance: REFERRAL_INVITER_BONUS, referralEarnings: REFERRAL_INVITER_BONUS } }, { new: true, session });
              const invitee = await User.findByIdAndUpdate(userId,
                { $inc: { balance: REFERRAL_NEW_USER_BONUS } }, { new: true, session });
              if (!inviter || !invitee) throw new Error('Referral account missing; aborting deposit transaction');
              await Transaction.create([
                { userId: inviter._id, amount: REFERRAL_INVITER_BONUS, type: 'referral_bonus', description: 'Бонус за приглашённого друга после первого депозита' },
                { userId: invitee._id, amount: REFERRAL_NEW_USER_BONUS, type: 'referral_bonus', description: 'Приветственный бонус по реферальной ссылке' }
              ], { session });
              newBalance = invitee.balance;
            }
          }
        }
      });
    } finally {
      await session.endSession();
    }
    return res.json({ success: true, message: 'Баланс успешно пополнен!', newBalance });
  } catch (err) {
    if (err.code === 11000) return res.status(409).json({ success: false, message: 'Этот хэш транзакции уже был активирован ранее' });
    if (err.appCode === 'USER_MISSING') return res.status(404).json({ error: err.message });
    console.error('Deposit processing error:', err.message);
    return res.status(503).json({ error: 'Не удалось безопасно обработать депозит. Проверьте подключение и поддержку MongoDB transactions.' });
  }
});

// ==========================================
// 3. API: СИСТЕМА БОНУСОВ И ПРОМОКОДОВ
// ==========================================
app.post('/api/promo/activate', authLimiter, async (req, res) => {
  const { promoCode } = req.body || {};
  const userId = req.userId;
  if (!promoCode) return res.status(400).json({ error: 'Введите промокод' });
  const cleanCode = String(promoCode).trim().toUpperCase();
  const session = await mongoose.startSession();
  let result;
  try {
    await session.withTransaction(async () => {
      const userExists = await User.exists({ _id: userId }).session(session);
      if (!userExists) { const e = new Error('Пользователь не найден'); e.appCode = 'USER_MISSING'; throw e; }
      const promo = await Promo.findOne({ code: cleanCode }).session(session);
      if (!promo) { const e = new Error('Промокод не существует'); e.appCode = 'PROMO_MISSING'; throw e; }
      if (promo.usedBy.some(id => id.toString() === String(userId))) {
        const e = new Error('Вы уже активировали этот промокод'); e.appCode = 'PROMO_USED'; throw e;
      }
      const updatedPromo = await Promo.findOneAndUpdate(
        { _id: promo._id, usedBy: { $ne: userId } }, { $push: { usedBy: userId } }, { new: true, session }
      );
      if (!updatedPromo) { const e = new Error('Вы уже активировали этот промокод'); e.appCode = 'PROMO_USED'; throw e; }
      const updatedUser = await User.findByIdAndUpdate(userId, { $inc: { balance: promo.reward } }, { new: true, session });
      if (!updatedUser) { const e = new Error('Пользователь не найден'); e.appCode = 'USER_MISSING'; throw e; }
      await Transaction.create([{ userId, amount: promo.reward, type: 'promo', description: `Промокод ${cleanCode}` }], { session });
      result = { success: true, message: `Промокод успешно активирован! Начислено ${promo.reward} ₦`, newBalance: updatedUser.balance };
    });
    return res.json(result);
  } catch (err) {
    if (err.appCode === 'PROMO_MISSING') return res.status(404).json({ error: err.message });
    if (err.appCode === 'PROMO_USED') return res.status(400).json({ error: err.message });
    if (err.appCode === 'USER_MISSING') return res.status(404).json({ error: err.message });
    console.error('Promo transaction error:', err.message);
    return res.status(503).json({ error: 'Не удалось безопасно активировать промокод. Проверьте, что MongoDB поддерживает транзакции (replica set).' });
  } finally {
    await session.endSession();
  }
});

app.get('/api/user/me', async (req, res) => {
  try {
    const user = await User.findById(req.userId).select('balance');
    if (!user) return res.status(404).json({ error: 'Аккаунт не найден' });
    return res.json({ balance: user.balance });
  } catch (e) {
    return res.status(500).json({ error: 'Не удалось загрузить баланс' });
  }
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => console.log(`Server running on port ${PORT}`));
