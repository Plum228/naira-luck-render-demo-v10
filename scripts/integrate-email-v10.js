'use strict';
const fs = require('fs');
const path = require('path');
const cp = require('child_process');
const root = path.resolve(__dirname, '..');
const serverPath = path.join(root, 'server.js');
const htmlPath = path.join(root, 'public', 'auth-fix-v9.html');
let server = fs.readFileSync(serverPath, 'utf8');
let html = fs.readFileSync(htmlPath, 'utf8');
function replaceOnce(text, from, to, label) {
  if (!text.includes(from) || text.indexOf(from) !== text.lastIndexOf(from)) throw new Error('Unexpected v10 source: ' + label);
  return text.replace(from, to);
}
const begin = "app.post('/api/auth/register', authLimiter,";
const end = "app.post('/api/auth/login', authLimiter,";
if (server.includes("require('./routes/registrationRoutes')")) throw new Error('Already integrated');
const start = server.indexOf(begin), stop = server.indexOf(end);
if (start < 0 || stop < start) throw new Error('Registration route anchors not found');
server = server.slice(0, start) + "require('./routes/registrationRoutes')(app, authLimiter, createReferralCode);\nrequire('./routes/legacyEmailRoutes')(app, authLimiter);\n\n" + server.slice(stop);
server = replaceOnce(server, "if (!user || !user.passwordHash || !(await bcrypt.compare(password, user.passwordHash)))", "if (!user || !user.passwordHash || !user.emailVerifiedAt || !(await bcrypt.compare(password, user.passwordHash)))", 'login guard');
server = replaceOnce(server, 'function requireAuth(req, res, next) {', 'async function requireAuth(req, res, next) {', 'API auth signature');
server = replaceOnce(server, '    req.userId = payload.sub;\n    authDebug(`[auth] accepted:', "    if (!mongoose.Types.ObjectId.isValid(payload.sub) || !(await User.exists({ _id: payload.sub, emailVerifiedAt: { $type: 'date' } }))) return res.status(403).json({ error: 'Подтвердите адрес почты и войдите снова.' });\n    req.userId = payload.sub;\n    authDebug(`[auth] accepted:", 'API auth verification');
server = replaceOnce(server, 'io.use((socket, next) => {', 'io.use(async (socket, next) => {', 'socket auth signature');
server = replaceOnce(server, '    socket.userId = payload.sub;\n    authDebug(`[socket-auth] accepted;', "    if (!mongoose.Types.ObjectId.isValid(payload.sub) || !(await User.exists({ _id: payload.sub, emailVerifiedAt: { $type: 'date' } }))) return next(new Error('Подтвердите адрес почты'));\n    socket.userId = payload.sub;\n    authDebug(`[socket-auth] accepted;", 'socket auth verification');
if (!/id=["']tabReg["']/.test(html) || !/id=["']authForm["']/.test(html)) throw new Error('Auth UI anchors not found');
const navigation = '<script>(function(){var b=document.getElementById("tabReg"),f=document.getElementById("authForm");function go(e){e.preventDefault();e.stopImmediatePropagation();location.href="/verify-email.html"+location.search}b.addEventListener("click",go,true);f.addEventListener("submit",function(e){var s=document.getElementById("authSubmit");if(s&&s.textContent.trim()!=="Войти")go(e)},true)})()</script>';
html = replaceOnce(html, '</body>', navigation + '</body>', 'registration navigation');
const check = cp.spawnSync(process.execPath, ['--check', '-'], { input: server, encoding: 'utf8' });
if (check.status !== 0) throw new Error('server.js syntax: ' + check.stderr);
if (process.argv.includes('--write')) {
  fs.writeFileSync(serverPath, server);
  fs.writeFileSync(htmlPath, html);
  console.log('Integrated server.js and public/auth-fix-v9.html; inspect diff and test before merge.');
} else console.log('Anchors and server syntax pass; rerun with --write to apply.');
