/**
 * NeonLink backend: Express (REST) + Socket.io (realtime) + PostgreSQL (Neon).
 * Все секреты — только из переменных окружения.
 */
require('dotenv').config();
const fs = require('fs');
const path = require('path');
const http = require('http');
const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const { Pool } = require('pg');
const { Server } = require('socket.io');

const {
  DATABASE_URL, JWT_SECRET, RECAPTCHA_SECRET, RECAPTCHA_SITE_KEY,
  OWNER_USERNAME = 'CEBA', OWNER_PASSWORD, CORS_ORIGINS = '', PORT = 3000,
} = process.env;

if (!DATABASE_URL) throw new Error('DATABASE_URL is not set');
if (!JWT_SECRET || JWT_SECRET.length < 16) throw new Error('JWT_SECRET is not set (min 16 chars)');

const EDIT_WINDOW_MS = 15 * 60 * 1000;   // окно редактирования/удаления своих сообщений
const MAX_TEXT = 2000;
const PAGE = 50;

// ---------- DB ----------
const isLocal = /localhost|127\.0\.0\.1/.test(DATABASE_URL);
const pool = new Pool({ connectionString: DATABASE_URL, ssl: isLocal ? false : { rejectUnauthorized: false }, max: 10 });
const q = (text, params) => pool.query(text, params);

async function initDb() {
  await q(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
  if (OWNER_PASSWORD) {
    const hash = await bcrypt.hash(OWNER_PASSWORD, 12);
    const ex = await q('SELECT id FROM users WHERE LOWER(username)=LOWER($1)', [OWNER_USERNAME]);
    if (!ex.rows.length) {
      await q(`INSERT INTO users (username,password_hash,display_name,role) VALUES ($1,$2,$1,'owner')`, [OWNER_USERNAME, hash]);
      console.log(`Owner account "${OWNER_USERNAME}" created`);
    } else {
      await q(`UPDATE users SET role='owner', is_blocked=FALSE WHERE id=$1`, [ex.rows[0].id]);
    }
  }
}

async function isMaintenance() {
  const r = await q(`SELECT value FROM settings WHERE key='maintenance'`);
  return r.rows[0]?.value === true;
}

async function audit(user, action, details = {}, ip = '') {
  try {
    await q('INSERT INTO audit_logs (user_id, username, action, details, ip) VALUES ($1,$2,$3,$4,$5)',
      [user?.id ?? null, user?.username ?? null, action, JSON.stringify(details), ip]);
  } catch (e) { console.error('audit failed', e.message); }
}

// ---------- helpers ----------
// ДОБАВЛЕНА ГАЛОЧКА (checkmark) В ПУБЛИЧНЫЙ ПРОФИЛЬ
const publicUser = (u) => ({ 
  id: u.id, 
  username: u.username, 
  displayName: u.display_name, 
  avatarUrl: u.avatar_url, 
  role: u.role,
  checkmark: u.checkmark 
});
const isOwner = (u) => u && u.username === OWNER_USERNAME;
const isStaff = (u) => u && (u.role === 'admin' || u.role === 'owner' || isOwner(u));
const USERNAME_RE = /^[A-Za-z0-9_]{3,32}$/;

function cleanText(t) {
  if (typeof t !== 'string') return null;
  const s = t.trim();
  return s.length && s.length <= MAX_TEXT ? s : null;
}
function cleanAvatar(u) {
  if (u === '' || u == null) return '';
  if (typeof u !== 'string' || u.length > 200000) return null;
  return /^(https:\/\/|data:image\/(png|jpeg|webp|gif);base64,)/i.test(u) ? u : null;
}
const clientIp = (req) => req.ip || req.socket?.remoteAddress || '';

async function verifyCaptcha(token, ip) {
  if (!RECAPTCHA_SECRET) return true;
  if (!token) return false;
  try {
    const r = await fetch('https://www.google.com/recaptcha/api/siteverify', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ secret: RECAPTCHA_SECRET, response: token, remoteip: ip }),
    });
    const d = await r.json();
    return d.success === true && (d.score === undefined || d.score >= 0.5);
  } catch { return false; }
}

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch((e) => {
  console.error(e); res.status(500).json({ error: 'Server error' });
});

// ---------- app ----------
const app = express();
app.set('trust proxy', 1);
const server = http.createServer(app);
const allowed = CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean);
const corsOpts = { origin: (o, cb) => cb(null, !o || allowed.includes(o) || o === `http://localhost:${PORT}`), credentials: false };
const io = new Server(server, { cors: corsOpts });

app.use(helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: { policy: 'cross-origin' } }));
app.use(cors(corsOpts));
app.use(express.json({ limit: '300kb' }));

const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 30, standardHeaders: true, legacyHeaders: false });
const regLimiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: 10, standardHeaders: true, legacyHeaders: false });
const sendLimiter = rateLimit({ windowMs: 60 * 1000, limit: 30, keyGenerator: (req) => `u${req.user?.id}`, validate: false });

app.get('/healthz', (_, res) => res.send('ok'));
app.get('/api/config', wrap(async (_, res) => res.json({ recaptchaSiteKey: RECAPTCHA_SITE_KEY || '', maintenance: await isMaintenance(), editWindowMs: EDIT_WINDOW_MS })));

// ---------- auth middleware ----------
async function auth(req, res, next) {
  const h = req.headers.authorization || '';
  try {
    const p = jwt.verify(h.startsWith('Bearer ') ? h.slice(7) : '', JWT_SECRET);
    const r = await q('SELECT * FROM users WHERE id=$1', [p.id]);
    const u = r.rows[0];
    if (!u) return res.status(401).json({ error: 'Unauthorized' });
    if (u.is_blocked) return res.status(403).json({ error: 'Account blocked' });
    req.user = u; next();
  } catch { res.status(401).json({ error: 'Unauthorized' }); }
}
function adminOnly(req, res, next) {
  if (!isOwner(req.user)) return res.status(403).json({ error: 'Forbidden' });
  next();
}
async function writeGuard(req, res, next) {
  if (!isStaff(req.user) && (await isMaintenance())) return res.status(503).json({ error: 'Maintenance mode: sending is disabled' });
  next();
}
const signToken = (u) => jwt.sign({ id: u.id }, JWT_SECRET, { expiresIn: '30d' });

// ---------- auth routes ----------
app.post('/api/auth/register', regLimiter, wrap(async (req, res) => {
  const { username, password, displayName, captcha } = req.body || {};
  if (await isMaintenance()) return res.status(503).json({ error: 'Registration is disabled (maintenance mode)' });
  if (!(await verifyCaptcha(captcha, clientIp(req)))) return res.status(400).json({ error: 'Captcha failed' });
  if (!USERNAME_RE.test(username || '')) return res.status(400).json({ error: 'Username: 3–32 символа, латиница/цифры/_' });
  if (typeof password !== 'string' || password.length < 8 || password.length > 72) return res.status(400).json({ error: 'Пароль: 8–72 символа' });
  if (username.toLowerCase() === OWNER_USERNAME.toLowerCase()) return res.status(400).json({ error: 'Username зарезервирован' });
  const dn = (typeof displayName === 'string' && displayName.trim().slice(0, 64)) || username;
  const hash = await bcrypt.hash(password, 12);
  try {
    const r = await q(`INSERT INTO users (username,password_hash,display_name) VALUES ($1,$2,$3) RETURNING *`, [username, hash, dn]);
    await audit(r.rows[0], 'register', {}, clientIp(req));
    res.json({ token: signToken(r.rows[0]), user: publicUser(r.rows[0]) });
  } catch (e) {
    if (e.code === '23505') return res.status(409).json({ error: 'Username уже занят' });
    throw e;
  }
}));

app.post('/api/auth/login', authLimiter, wrap(async (req, res) => {
  const { username, password } = req.body || {};
  const r = await q('SELECT * FROM users WHERE LOWER(username)=LOWER($1)', [String(username || '')]);
  const u = r.rows[0];
  const ok = u && typeof password === 'string' && (await bcrypt.compare(password, u.password_hash));
  if (!ok) { await audit(null, 'login_failed', { username: String(username || '').slice(0, 64) }, clientIp(req)); return res.status(401).json({ error: 'Неверный логин или пароль' }); }
  if (u.is_blocked) return res.status(403).json({ error: 'Account blocked' });
  await q('UPDATE users SET last_login=NOW() WHERE id=$1', [u.id]);
  await audit(u, 'login', {}, clientIp(req));
  res.json({ token: signToken(u), user: publicUser(u) });
}));

app.get('/api/me', auth, (req, res) => res.json({ user: publicUser(req.user), isAdmin: isOwner(req.user) }));

app.patch('/api/me', auth, wrap(async (req, res) => {
  const { displayName, avatarUrl } = req.body || {};
  const dn = typeof displayName === 'string' ? displayName.trim().slice(0, 64) : req.user.display_name;
  const av = avatarUrl === undefined ? req.user.avatar_url : cleanAvatar(avatarUrl);
  if (!dn || av === null) return res.status(400).json({ error: 'Invalid data' });
  const r = await q('UPDATE users SET display_name=$1, avatar_url=$2 WHERE id=$3 RETURNING *', [dn, av, req.user.id]);
  await audit(req.user, 'profile_update', {}, clientIp(req));
  res.json({ user: publicUser(r.rows[0]) });
}));

app.get('/api/users', auth, wrap(async (req, res) => {
  const s = String(req.query.q || '').trim();
  const r = await q(`SELECT id,username,display_name,avatar_url,role,checkmark FROM users
    WHERE id<>$1 AND is_blocked=FALSE AND ($2='' OR username ILIKE $3 OR display_name ILIKE $3)
    ORDER BY username LIMIT 30`, [req.user.id, s, `%${s.replace(/[%_]/g, '')}%`]);
  res.json({ users: r.rows.map(publicUser) });
}));

// ---------- global feed ----------
// ДОБАВЛЕН u.checkmark В ЗАПРОС
const msgSelect = `SELECT m.id,m.text,m.created_at,m.edited_at,m.edited_by_admin,
  u.id AS uid,u.username,u.display_name,u.avatar_url,u.role,u.checkmark
  FROM messages m JOIN users u ON u.id=m.user_id`;
const msgOut = (r) => ({ 
  id: r.id, 
  text: r.text, 
  createdAt: r.created_at, 
  editedAt: r.edited_at, 
  editedByAdmin: r.edited_by_admin,
  user: { id: r.uid, username: r.username, displayName: r.display_name, avatarUrl: r.avatar_url, role: r.role, checkmark: r.checkmark } 
});

app.get('/api/messages', auth, wrap(async (req, res) => {
  const before = parseInt(req.query.before) || 9e15;
  const r = await q(`${msgSelect} WHERE m.id<$1 ORDER BY m.id DESC LIMIT ${PAGE}`, [before]);
  res.json({ messages: r.rows.reverse().map(msgOut) });
}));

async function getFeedMsg(id) { return (await q(`${msgSelect} WHERE m.id=$1`, [id])).rows[0]; }

app.post('/api/messages', auth, writeGuard, sendLimiter, wrap(async (req, res) => {
  const text = cleanText(req.body?.text);
  if (!text) return res.status(400).json({ error: 'Empty or too long' });
  if (!(await verifyCaptcha(req.body?.captcha, clientIp(req)))) return res.status(400).json({ error: 'Captcha failed' });
  const ins = await q('INSERT INTO messages (user_id,text) VALUES ($1,$2) RETURNING id', [req.user.id, text]);
  const out = msgOut(await getFeedMsg(ins.rows[0].id));
  io.to('global').emit('message:new', out);
  await audit(req.user, 'message_send', { id: out.id }, clientIp(req));
  res.json({ message: out });
}));

// (Остальные роуты сообщений patch/delete остаются без изменений, они не требуют checkmark в ответе)
app.patch('/api/messages/:id', auth, writeGuard, wrap(async (req, res) => {
  const text = cleanText(req.body?.text);
  const m = (await q('SELECT * FROM messages WHERE id=$1', [req.params.id])).rows[0];
  if (!text || !m) return res.status(400).json({ error: 'Bad request' });
  if (m.user_id !== req.user.id) return res.status(403).json({ error: 'Not your message' });
  if (Date.now() - new Date(m.created_at) > EDIT_WINDOW_MS) return res.status(403).json({ error: 'Время редактирования истекло (15 мин)' });
  await q('UPDATE messages SET text=$1, edited_at=NOW() WHERE id=$2', [text, m.id]);
  const out = msgOut(await getFeedMsg(m.id));
  io.to('global').emit('message:update', out);
  await audit(req.user, 'message_edit', { id: m.id, old: m.text.slice(0, 200) }, clientIp(req));
  res.json({ message: out });
}));

app.delete('/api/messages/:id', auth, wrap(async (req, res) => {
  const m = (await q('SELECT * FROM messages WHERE id=$1', [req.params.id])).rows[0];
  if (!m) return res.status(404).json({ error: 'Not found' });
  if (m.user_id !== req.user.id) return res.status(403).json({ error: 'Not your message' });
  if (Date.now() - new Date(m.created_at) > EDIT_WINDOW_MS) return res.status(403).json({ error: 'Время удаления истекло (15 мин)' });
  await q('DELETE FROM messages WHERE id=$1', [m.id]);
  io.to('global').emit('message:delete', { id: m.id });
  await audit(req.user, 'message_delete', { id: m.id, text: m.text.slice(0, 200) }, clientIp(req));
  res.json({ ok: true });
}));

// ---------- direct messages ----------
// Добавляем checkmark для пиров в диалогах
const dmOut = (r) => ({ id: r.id, senderId: r.sender_id, recipientId: r.recipient_id, text: r.text,
  createdAt: r.created_at, editedAt: r.edited_at, editedByAdmin: r.edited_by_admin });
const emitDm = (ev, row, payload) => { io.to(`user:${row.sender_id}`).to(`user:${row.recipient_id}`).emit(ev, payload); };

app.get('/api/dm/conversations', auth, wrap(async (req, res) => {
  const r = await q(`
    SELECT DISTINCT ON (peer) peer, text, created_at, id FROM (
      SELECT CASE WHEN sender_id=$1 THEN recipient_id ELSE sender_id END AS peer, text, created_at, id
      FROM dm_messages WHERE sender_id=$1 OR recipient_id=$1) t
    ORDER BY peer, id DESC`, [req.user.id]);
  const ids = r.rows.map((x) => x.peer);
  const us = ids.length ? (await q('SELECT id,username,display_name,avatar_url,role,checkmark FROM users WHERE id=ANY($1)', [ids])).rows : [];
  const map = Object.fromEntries(us.map((u) => [u.id, u]));
  const convs = r.rows.filter((x) => map[x.peer]).map((x) => ({ user: publicUser(map[x.peer]), lastText: x.text, lastAt: x.created_at, lastId: Number(x.id) }))
    .sort((a, b) => b.lastId - a.lastId);
  res.json({ conversations: convs });
}));

app.get('/api/dm/:userId', auth, wrap(async (req, res) => {
  const peer = parseInt(req.params.userId); const before = parseInt(req.query.before) || 9e15;
  const pu = (await q('SELECT id,username,display_name,avatar_url,role,checkmark FROM users WHERE id=$1', [peer])).rows[0];
  if (!pu) return res.status(404).json({ error: 'User not found' });
  const r = await q(`SELECT * FROM dm_messages WHERE id<$3 AND ((sender_id=$1 AND recipient_id=$2) OR (sender_id=$2 AND recipient_id=$1))
    ORDER BY id DESC LIMIT ${PAGE}`, [req.user.id, peer, before]);
  const blocked = (await q('SELECT 1 FROM blocks WHERE blocker_id=$1 AND blocked_id=$2', [req.user.id, peer])).rowCount > 0;
  res.json({ peer: publicUser(pu), blocked, messages: r.rows.reverse().map(dmOut) });
}));

// ... Остальные DM роуты (post/patch/delete) без изменений ...

// ---------- КАНАЛЫ ----------
app.get('/api/channels', auth, wrap(async (req, res) => {
  const r = await q('SELECT * FROM channels ORDER BY id DESC');
  res.json({ channels: r.rows });
}));

app.post('/api/channels', auth, wrap(async (req, res) => {
  const { name, description } = req.body;
  if (!name) return res.status(400).json({ error: 'Нужно имя канала' });
  const r = await q('INSERT INTO channels (owner_id, name, description) VALUES ($1, $2, $3) RETURNING *', [req.user.id, name, description]);
  await audit(req.user, 'channel_create', { id: r.rows[0].id }, clientIp(req));
  res.json({ channel: r.rows[0] });
}));

// ---------- ИСТОРИИ ----------
app.get('/api/stories', auth, wrap(async (req, res) => {
  const r = await q(`SELECT s.*, u.username, u.display_name, u.avatar_url, u.checkmark 
                     FROM stories s JOIN users u ON u.id = s.user_id 
                     WHERE s.created_at > NOW() - INTERVAL '24 hours' ORDER BY s.id DESC`);
  res.json({ stories: r.rows });
}));

app.post('/api/stories', auth, wrap(async (req, res) => {
  if (req.user.checkmark !== 'green' && req.user.username !== 'CEBA') {
    return res.status(403).json({ error: 'Только пользователи с зеленой галочкой могут выкладывать истории' });
  }
  const { content } = req.body;
  if (!content) return res.status(400).json({ error: 'Пустая история' });
  const r = await q('INSERT INTO stories (user_id, content) VALUES ($1, $2) RETURNING *', [req.user.id, content]);
  await audit(req.user, 'story_create', { id: r.rows[0].id }, clientIp(req));
  res.json({ story: r.rows[0] });
}));

// ---------- ADMIN (только CEBA) ----------
const admin = express.Router();
app.use('/api/admin', auth, adminOnly, admin);

admin.get('/users', wrap(async (req, res) => {
  const s = String(req.query.q || '').trim();
  const r = await q(`SELECT id,username,display_name,avatar_url,role,is_blocked,created_at,last_login,checkmark FROM users
    WHERE ($1='' OR username ILIKE $2 OR display_name ILIKE $2) ORDER BY id LIMIT 500`, [s, `%${s.replace(/[%_]/g, '')}%`]);
  res.json({ users: r.rows });
}));

admin.patch('/users/:id', wrap(async (req, res) => {
  const id = parseInt(req.params.id); const b = req.body || {};
  const u = (await q('SELECT * FROM users WHERE id=$1', [id])).rows[0];
  if (!u) return res.status(404).json({ error: 'Not found' });
  const self = u.id === req.user.id;
  const f = {};
  if (b.username !== undefined) {
    if (!USERNAME_RE.test(b.username)) return res.status(400).json({ error: 'Bad username' });
    if (self && b.username !== u.username) return res.status(400).json({ error: 'Нельзя переименовать владельца' });
    if (!self && b.username.toLowerCase() === OWNER_USERNAME.toLowerCase()) return res.status(400).json({ error: 'Username зарезервирован' });
    f.username = b.username;
  }
  if (b.displayName !== undefined) { if (!String(b.displayName).trim()) return res.status(400).json({ error: 'Bad display name' }); f.display_name = String(b.displayName).trim().slice(0, 64); }
  if (b.avatarUrl !== undefined) { const a = cleanAvatar(b.avatarUrl); if (a === null) return res.status(400).json({ error: 'Bad avatar' }); f.avatar_url = a; }
  if (b.role !== undefined) {
    if (!['user', 'admin', 'owner'].includes(b.role)) return res.status(400).json({ error: 'Bad role' });
    if (self && b.role !== 'owner') return res.status(400).json({ error: 'Нельзя менять роль владельца' });
    f.role = b.role;
  }
  if (b.isBlocked !== undefined) {
    if (self && b.isBlocked) return res.status(400).json({ error: 'Нельзя заблокировать себя' });
    f.is_blocked = !!b.isBlocked;
  }
  // ДОБАВЛЕНА ОБРАБОТКА ГАЛОЧКИ
  if (b.checkmark !== undefined) {
    if (![null, 'green', 'blue', 'gold', ''].includes(b.checkmark)) return res.status(400).json({ error: 'Bad checkmark' });
    f.checkmark = b.checkmark === '' ? null : b.checkmark;
  }
  
  const keys = Object.keys(f);
  if (!keys.length) return res.status(400).json({ error: 'Nothing to update' });
  try {
    const r = await q(`UPDATE users SET ${keys.map((k, i) => `${k}=$${i + 1}`).join(',')} WHERE id=$${keys.length + 1} RETURNING id,username,display_name,avatar_url,role,is_blocked,checkmark`, [...keys.map((k) => f[k]), id]);
    await audit(req.user, 'admin_user_update', { target: id, changes: f }, clientIp(req));
    if (f.is_blocked) io.in(`user:${id}`).disconnectSockets(true);
    res.json({ user: r.rows[0] });
  } catch (e) { if (e.code === '23505') return res.status(409).json({ error: 'Username занят' }); throw e; }
}));

// ДОБАВЛЕНА АДМИНКА ДЛЯ КАНАЛОВ
admin.get('/channels', wrap(async (req, res) => {
  const r = await q(`SELECT c.*, u.username AS owner_name FROM channels c JOIN users u ON u.id = c.owner_id ORDER BY c.id DESC`);
  res.json({ channels: r.rows });
}));

admin.patch('/channels/:id', wrap(async (req, res) => {
  const id = parseInt(req.params.id); const b = req.body || {};
  const f = {};
  if (b.name !== undefined) f.name = String(b.name).trim().slice(0, 64);
  if (b.description !== undefined) f.description = String(b.description).trim();
  if (b.checkmark !== undefined) {
    if (![null, 'green', 'blue', 'gold', ''].includes(b.checkmark)) return res.status(400).json({ error: 'Bad checkmark' });
    f.checkmark = b.checkmark === '' ? null : b.checkmark;
  }
  const keys = Object.keys(f);
  if (!keys.length) return res.status(400).json({ error: 'Nothing to update' });
  const r = await q(`UPDATE channels SET ${keys.map((k, i) => `${k}=$${i + 1}`).join(',')} WHERE id=$${keys.length + 1} RETURNING *`, [...keys.map((k) => f[k]), id]);
  await audit(req.user, 'admin_channel_update', { target: id, changes: f }, clientIp(req));
  res.json({ channel: r.rows[0] });
}));

// ... Остальные админ-роуты (аудит, обслуживание и т.д.) остаются без изменений ...

// ---------- Socket.io ----------
io.use(async (socket, next) => {
  try {
    const p = jwt.verify(socket.handshake.auth?.token || '', JWT_SECRET);
    const u = (await q('SELECT * FROM users WHERE id=$1', [p.id])).rows[0];
    if (!u || u.is_blocked) return next(new Error('unauthorized'));
    socket.data.user = u; next();
  } catch { next(new Error('unauthorized')); }
});
io.on('connection', (socket) => {
  socket.join('global');
  socket.join(`user:${socket.data.user.id}`);
});

// ---------- static frontend ----------
const htmlDir = path.join(__dirname, 'html');
app.get('/admin', (_, res) => res.sendFile(path.join(htmlDir, 'admin.html')));
app.use(express.static(htmlDir));
app.use('/api', (_, res) => res.status(404).json({ error: 'Not found' }));

initDb().then(() => server.listen(PORT, () => console.log(`NeonLink on :${PORT}`)))
  .catch((e) => { console.error('Startup failed:', e); process.exit(1); });