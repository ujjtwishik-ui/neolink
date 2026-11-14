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
    // Создаём/обновляем аккаунт владельца при старте. Имя зарезервировано (см. register).
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
const publicUser = (u) => ({ id: u.id, username: u.username, displayName: u.display_name, avatarUrl: u.avatar_url, role: u.role });
const isOwner = (u) => u && u.username === OWNER_USERNAME;          // доступ к /admin — строго по нику
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
  if (!RECAPTCHA_SECRET) return true; // dev-режим: капча не настроена
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
// Все /api/admin/* — только для пользователя с ником CEBA
function adminOnly(req, res, next) {
  if (!isOwner(req.user)) return res.status(403).json({ error: 'Forbidden' });
  next();
}
// Блокировка записи в режиме обслуживания (кроме админов)
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
  const r = await q(`SELECT id,username,display_name,avatar_url,role FROM users
    WHERE id<>$1 AND is_blocked=FALSE AND ($2='' OR username ILIKE $3 OR display_name ILIKE $3)
    ORDER BY username LIMIT 30`, [req.user.id, s, `%${s.replace(/[%_]/g, '')}%`]);
  res.json({ users: r.rows.map(publicUser) });
}));

// ---------- global feed ----------
const msgSelect = `SELECT m.id,m.text,m.created_at,m.edited_at,m.edited_by_admin,
  u.id AS uid,u.username,u.display_name,u.avatar_url,u.role
  FROM messages m JOIN users u ON u.id=m.user_id`;
const msgOut = (r) => ({ id: r.id, text: r.text, createdAt: r.created_at, editedAt: r.edited_at, editedByAdmin: r.edited_by_admin,
  user: { id: r.uid, username: r.username, displayName: r.display_name, avatarUrl: r.avatar_url, role: r.role } });

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
  const us = ids.length ? (await q('SELECT id,username,display_name,avatar_url,role FROM users WHERE id=ANY($1)', [ids])).rows : [];
  const map = Object.fromEntries(us.map((u) => [u.id, u]));
  const convs = r.rows.filter((x) => map[x.peer]).map((x) => ({ user: publicUser(map[x.peer]), lastText: x.text, lastAt: x.created_at, lastId: Number(x.id) }))
    .sort((a, b) => b.lastId - a.lastId);
  res.json({ conversations: convs });
}));

app.get('/api/dm/:userId', auth, wrap(async (req, res) => {
  const peer = parseInt(req.params.userId); const before = parseInt(req.query.before) || 9e15;
  const pu = (await q('SELECT id,username,display_name,avatar_url,role FROM users WHERE id=$1', [peer])).rows[0];
  if (!pu) return res.status(404).json({ error: 'User not found' });
  const r = await q(`SELECT * FROM dm_messages WHERE id<$3 AND ((sender_id=$1 AND recipient_id=$2) OR (sender_id=$2 AND recipient_id=$1))
    ORDER BY id DESC LIMIT ${PAGE}`, [req.user.id, peer, before]);
  const blocked = (await q('SELECT 1 FROM blocks WHERE blocker_id=$1 AND blocked_id=$2', [req.user.id, peer])).rowCount > 0;
  res.json({ peer: publicUser(pu), blocked, messages: r.rows.reverse().map(dmOut) });
}));

app.post('/api/dm/:userId', auth, writeGuard, sendLimiter, wrap(async (req, res) => {
  const peer = parseInt(req.params.userId); const text = cleanText(req.body?.text);
  if (!text || !peer || peer === req.user.id) return res.status(400).json({ error: 'Bad request' });
  const pu = (await q('SELECT id,is_blocked FROM users WHERE id=$1', [peer])).rows[0];
  if (!pu || pu.is_blocked) return res.status(404).json({ error: 'User not found' });
  const bl = await q('SELECT 1 FROM blocks WHERE (blocker_id=$1 AND blocked_id=$2) OR (blocker_id=$2 AND blocked_id=$1)', [req.user.id, peer]);
  if (bl.rowCount) return res.status(403).json({ error: 'Messaging is blocked' });
  if (!(await verifyCaptcha(req.body?.captcha, clientIp(req)))) return res.status(400).json({ error: 'Captcha failed' });
  const r = await q('INSERT INTO dm_messages (sender_id,recipient_id,text) VALUES ($1,$2,$3) RETURNING *', [req.user.id, peer, text]);
  const out = dmOut(r.rows[0]);
  emitDm('dm:new', r.rows[0], out);
  await audit(req.user, 'dm_send', { id: out.id, to: peer }, clientIp(req));
  res.json({ message: out });
}));

app.patch('/api/dm/msg/:id', auth, writeGuard, wrap(async (req, res) => {
  const text = cleanText(req.body?.text);
  const m = (await q('SELECT * FROM dm_messages WHERE id=$1', [req.params.id])).rows[0];
  if (!text || !m) return res.status(400).json({ error: 'Bad request' });
  if (m.sender_id !== req.user.id) return res.status(403).json({ error: 'Not your message' });
  if (Date.now() - new Date(m.created_at) > EDIT_WINDOW_MS) return res.status(403).json({ error: 'Время редактирования истекло (15 мин)' });
  const r = await q('UPDATE dm_messages SET text=$1, edited_at=NOW() WHERE id=$2 RETURNING *', [text, m.id]);
  emitDm('dm:update', r.rows[0], dmOut(r.rows[0]));
  await audit(req.user, 'dm_edit', { id: m.id, old: m.text.slice(0, 200) }, clientIp(req));
  res.json({ message: dmOut(r.rows[0]) });
}));

app.delete('/api/dm/msg/:id', auth, wrap(async (req, res) => {
  const m = (await q('SELECT * FROM dm_messages WHERE id=$1', [req.params.id])).rows[0];
  if (!m) return res.status(404).json({ error: 'Not found' });
  if (m.sender_id !== req.user.id) return res.status(403).json({ error: 'Not your message' });
  if (Date.now() - new Date(m.created_at) > EDIT_WINDOW_MS) return res.status(403).json({ error: 'Время удаления истекло (15 мин)' });
  await q('DELETE FROM dm_messages WHERE id=$1', [m.id]);
  emitDm('dm:delete', m, { id: m.id, senderId: m.sender_id, recipientId: m.recipient_id });
  await audit(req.user, 'dm_delete', { id: m.id, text: m.text.slice(0, 200) }, clientIp(req));
  res.json({ ok: true });
}));

app.post('/api/blocks/:userId', auth, wrap(async (req, res) => {
  const t = parseInt(req.params.userId);
  if (!t || t === req.user.id) return res.status(400).json({ error: 'Bad request' });
  await q('INSERT INTO blocks (blocker_id,blocked_id) VALUES ($1,$2) ON CONFLICT DO NOTHING', [req.user.id, t]);
  await audit(req.user, 'user_block', { target: t }, clientIp(req)); res.json({ ok: true });
}));
app.delete('/api/blocks/:userId', auth, wrap(async (req, res) => {
  await q('DELETE FROM blocks WHERE blocker_id=$1 AND blocked_id=$2', [req.user.id, parseInt(req.params.userId)]);
  await audit(req.user, 'user_unblock', { target: req.params.userId }, clientIp(req)); res.json({ ok: true });
}));

// ---------- ADMIN (только CEBA) ----------
const admin = express.Router();
app.use('/api/admin', auth, adminOnly, admin);

admin.get('/users', wrap(async (req, res) => {
  const s = String(req.query.q || '').trim();
  const r = await q(`SELECT id,username,display_name,avatar_url,role,is_blocked,created_at,last_login FROM users
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
  const keys = Object.keys(f);
  if (!keys.length) return res.status(400).json({ error: 'Nothing to update' });
  try {
    const r = await q(`UPDATE users SET ${keys.map((k, i) => `${k}=$${i + 1}`).join(',')} WHERE id=$${keys.length + 1} RETURNING id,username,display_name,avatar_url,role,is_blocked`, [...keys.map((k) => f[k]), id]);
    await audit(req.user, 'admin_user_update', { target: id, changes: f }, clientIp(req));
    if (f.is_blocked) io.in(`user:${id}`).disconnectSockets(true);
    res.json({ user: r.rows[0] });
  } catch (e) { if (e.code === '23505') return res.status(409).json({ error: 'Username занят' }); throw e; }
}));

admin.post('/users/:id/reset-password', wrap(async (req, res) => {
  const pw = req.body?.password;
  if (typeof pw !== 'string' || pw.length < 8 || pw.length > 72) return res.status(400).json({ error: 'Пароль: 8–72 символа' });
  const r = await q('UPDATE users SET password_hash=$1 WHERE id=$2 RETURNING id', [await bcrypt.hash(pw, 12), parseInt(req.params.id)]);
  if (!r.rowCount) return res.status(404).json({ error: 'Not found' });
  await audit(req.user, 'admin_password_reset', { target: r.rows[0].id }, clientIp(req));
  res.json({ ok: true });
}));

admin.delete('/users/:id', wrap(async (req, res) => {
  const id = parseInt(req.params.id);
  if (id === req.user.id) return res.status(400).json({ error: 'Нельзя удалить владельца' });
  const r = await q('DELETE FROM users WHERE id=$1 RETURNING username', [id]);
  if (!r.rowCount) return res.status(404).json({ error: 'Not found' });
  io.in(`user:${id}`).disconnectSockets(true);
  await audit(req.user, 'admin_user_delete', { target: id, username: r.rows[0].username }, clientIp(req));
  res.json({ ok: true });
}));

admin.get('/feed', wrap(async (req, res) => {
  const page = Math.max(1, parseInt(req.query.page) || 1);
  const total = (await q('SELECT COUNT(*)::int AS n FROM messages')).rows[0].n;
  const r = await q(`${msgSelect} ORDER BY m.id DESC LIMIT ${PAGE} OFFSET $1`, [(page - 1) * PAGE]);
  res.json({ messages: r.rows.map(msgOut), page, pages: Math.max(1, Math.ceil(total / PAGE)), total });
}));
admin.patch('/feed/:id', wrap(async (req, res) => {
  const text = cleanText(req.body?.text);
  if (!text) return res.status(400).json({ error: 'Bad text' });
  const old = (await q('SELECT text FROM messages WHERE id=$1', [req.params.id])).rows[0];
  if (!old) return res.status(404).json({ error: 'Not found' });
  await q('UPDATE messages SET text=$1, edited_at=NOW(), edited_by_admin=TRUE WHERE id=$2', [text, req.params.id]);
  const out = msgOut(await getFeedMsg(req.params.id));
  io.to('global').emit('message:update', out);
  await audit(req.user, 'admin_feed_edit', { id: out.id, old: old.text.slice(0, 200) }, clientIp(req));
  res.json({ message: out });
}));
admin.delete('/feed/:id', wrap(async (req, res) => {
  const r = await q('DELETE FROM messages WHERE id=$1 RETURNING id,text', [req.params.id]);
  if (!r.rowCount) return res.status(404).json({ error: 'Not found' });
  io.to('global').emit('message:delete', { id: r.rows[0].id });
  await audit(req.user, 'admin_feed_delete', { id: r.rows[0].id, text: r.rows[0].text.slice(0, 200) }, clientIp(req));
  res.json({ ok: true });
}));

admin.get('/dm/pairs', wrap(async (req, res) => {
  const r = await q(`SELECT a.id AS a_id, a.username AS a_name, b.id AS b_id, b.username AS b_name, p.cnt, p.last_at
    FROM (SELECT LEAST(sender_id,recipient_id) AS a, GREATEST(sender_id,recipient_id) AS b, COUNT(*)::int AS cnt, MAX(created_at) AS last_at
          FROM dm_messages GROUP BY 1,2) p
    JOIN users a ON a.id=p.a JOIN users b ON b.id=p.b ORDER BY p.last_at DESC LIMIT 300`);
  res.json({ pairs: r.rows });
}));
admin.get('/dm/:a/:b', wrap(async (req, res) => {
  const a = parseInt(req.params.a), b = parseInt(req.params.b), page = Math.max(1, parseInt(req.query.page) || 1);
  const cond = `((sender_id=$1 AND recipient_id=$2) OR (sender_id=$2 AND recipient_id=$1))`;
  const total = (await q(`SELECT COUNT(*)::int AS n FROM dm_messages WHERE ${cond}`, [a, b])).rows[0].n;
  const r = await q(`SELECT * FROM dm_messages WHERE ${cond} ORDER BY id DESC LIMIT ${PAGE} OFFSET $3`, [a, b, (page - 1) * PAGE]);
  await audit(req.user, 'admin_dm_view', { a, b, page }, clientIp(req));
  res.json({ messages: r.rows.map(dmOut), page, pages: Math.max(1, Math.ceil(total / PAGE)), total });
}));
admin.patch('/dm/msg/:id', wrap(async (req, res) => {
  const text = cleanText(req.body?.text);
  if (!text) return res.status(400).json({ error: 'Bad text' });
  const old = (await q('SELECT text FROM dm_messages WHERE id=$1', [req.params.id])).rows[0];
  if (!old) return res.status(404).json({ error: 'Not found' });
  const r = await q('UPDATE dm_messages SET text=$1, edited_at=NOW(), edited_by_admin=TRUE WHERE id=$2 RETURNING *', [text, req.params.id]);
  emitDm('dm:update', r.rows[0], dmOut(r.rows[0]));
  await audit(req.user, 'admin_dm_edit', { id: r.rows[0].id, old: old.text.slice(0, 200) }, clientIp(req));
  res.json({ message: dmOut(r.rows[0]) });
}));
admin.delete('/dm/msg/:id', wrap(async (req, res) => {
  const r = await q('DELETE FROM dm_messages WHERE id=$1 RETURNING *', [req.params.id]);
  if (!r.rowCount) return res.status(404).json({ error: 'Not found' });
  emitDm('dm:delete', r.rows[0], { id: r.rows[0].id, senderId: r.rows[0].sender_id, recipientId: r.rows[0].recipient_id });
  await audit(req.user, 'admin_dm_delete', { id: r.rows[0].id }, clientIp(req));
  res.json({ ok: true });
}));

admin.get('/audit', wrap(async (req, res) => {
  const w = [], p = [];
  if (req.query.action) { p.push(req.query.action); w.push(`action=$${p.length}`); }
  if (req.query.username) { p.push(`%${String(req.query.username).replace(/[%_]/g, '')}%`); w.push(`username ILIKE $${p.length}`); }
  const r = await q(`SELECT * FROM audit_logs ${w.length ? 'WHERE ' + w.join(' AND ') : ''} ORDER BY id DESC LIMIT 200`, p);
  res.json({ logs: r.rows });
}));

admin.get('/maintenance', wrap(async (_, res) => res.json({ maintenance: await isMaintenance() })));
admin.post('/maintenance', wrap(async (req, res) => {
  const on = !!req.body?.enabled;
  await q(`INSERT INTO settings (key,value) VALUES ('maintenance',$1) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value`, [JSON.stringify(on)]);
  io.emit('maintenance', { enabled: on });
  await audit(req.user, 'admin_maintenance', { enabled: on }, clientIp(req));
  res.json({ maintenance: on });
}));

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
