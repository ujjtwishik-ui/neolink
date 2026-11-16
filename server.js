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
if (!JWT_SECRET || JWT_SECRET.length < 16) throw new Error('JWT_SECRET is not set');

const EDIT_WINDOW_MS = 15 * 60 * 1000;
const MAX_TEXT = 2000;
const PAGE = 50;

const pool = new Pool({ connectionString: DATABASE_URL, ssl: /localhost|127\.0\.0\.1/.test(DATABASE_URL) ? false : { rejectUnauthorized: false }, max: 10 });
const q = (text, params) => pool.query(text, params);

async function initDb() {
  await q(fs.readFileSync(path.join(__dirname, 'schema.sql'), 'utf8'));
  if (OWNER_PASSWORD) {
    const hash = await bcrypt.hash(OWNER_PASSWORD, 12);
    const ex = await q('SELECT id FROM users WHERE LOWER(username)=LOWER($1)', [OWNER_USERNAME]);
    if (!ex.rows.length) await q(`INSERT INTO users (username,password_hash,display_name,role) VALUES ($1,$2,$1,'owner')`, [OWNER_USERNAME, hash]);
    else await q(`UPDATE users SET role='owner', is_blocked=FALSE WHERE id=$1`, [ex.rows[0].id]);
  }
}

async function isMaintenance() { const r = await q(`SELECT value FROM settings WHERE key='maintenance'`); return r.rows[0]?.value === true; }
async function audit(user, action, details = {}, ip = '') { try { await q('INSERT INTO audit_logs (user_id, username, action, details, ip) VALUES ($1,$2,$3,$4,$5)', [user?.id ?? null, user?.username ?? null, action, JSON.stringify(details), ip]); } catch (e) {} }

const publicUser = (u) => ({ id: u.id, username: u.username, displayName: u.display_name, avatarUrl: u.avatar_url, role: u.role, checkmark: u.checkmark });
const isOwner = (u) => u && u.username === OWNER_USERNAME;
const isStaff = (u) => u && (u.role === 'admin' || u.role === 'owner' || isOwner(u));
const USERNAME_RE = /^[A-Za-z0-9_]{3,32}$/;

function cleanText(t) { if (typeof t !== 'string') return null; const s = t.trim(); return s.length && s.length <= MAX_TEXT ? s : null; }
function cleanAvatar(u) { if (u === '' || u == null) return ''; if (typeof u !== 'string' || u.length > 200000) return null; return /^(https:\/\/|data:image\/(png|jpeg|webp|gif);base64,)/i.test(u) ? u : null; }
const clientIp = (req) => req.ip || req.socket?.remoteAddress || '';

async function verifyCaptcha(token, ip) {
  if (!RECAPTCHA_SECRET) return true; if (!token) return false;
  try {
    const r = await fetch('https://www.google.com/recaptcha/api/siteverify', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ secret: RECAPTCHA_SECRET, response: token, remoteip: ip }) });
    const d = await r.json(); return d.success === true && (d.score === undefined || d.score >= 0.5);
  } catch { return false; }
}

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch((e) => { console.error(e); res.status(500).json({ error: 'Server error' }); });

const app = express(); app.set('trust proxy', 1);
const server = http.createServer(app);
const corsOpts = { origin: (o, cb) => cb(null, !o || CORS_ORIGINS.split(',').includes(o) || o === `http://localhost:${PORT}`), credentials: false };
const io = new Server(server, { cors: corsOpts });

app.use(helmet({ contentSecurityPolicy: false, crossOriginResourcePolicy: { policy: 'cross-origin' } }));
app.use(cors(corsOpts)); app.use(express.json({ limit: '300kb' }));

const authLimiter = rateLimit({ windowMs: 15 * 60 * 1000, limit: 30 });
const regLimiter = rateLimit({ windowMs: 60 * 60 * 1000, limit: 10 });
const sendLimiter = rateLimit({ windowMs: 60 * 1000, limit: 30, keyGenerator: (req) => `u${req.user?.id}`, validate: false });

app.get('/healthz', (_, res) => res.send('ok'));
app.get('/api/config', wrap(async (_, res) => res.json({ recaptchaSiteKey: RECAPTCHA_SITE_KEY || '', maintenance: await isMaintenance(), editWindowMs: EDIT_WINDOW_MS })));

async function auth(req, res, next) {
  const h = req.headers.authorization || '';
  try {
    const p = jwt.verify(h.startsWith('Bearer ') ? h.slice(7) : '', JWT_SECRET);
    const u = (await q('SELECT * FROM users WHERE id=$1', [p.id])).rows[0];
    if (!u) return res.status(401).json({ error: 'Unauthorized' }); if (u.is_blocked) return res.status(403).json({ error: 'Account blocked' });
    req.user = u; next();
  } catch { res.status(401).json({ error: 'Unauthorized' }); }
}
function adminOnly(req, res, next) { if (!isOwner(req.user)) return res.status(403).json({ error: 'Forbidden' }); next(); }
async function writeGuard(req, res, next) { if (!isStaff(req.user) && (await isMaintenance())) return res.status(503).json({ error: 'Maintenance mode' }); next(); }
const signToken = (u) => jwt.sign({ id: u.id }, JWT_SECRET, { expiresIn: '30d' });

app.post('/api/auth/register', regLimiter, wrap(async (req, res) => {
  const { username, password, displayName, captcha } = req.body || {};
  if (await isMaintenance()) return res.status(503).json({ error: 'Registration is disabled' });
  if (!(await verifyCaptcha(captcha, clientIp(req)))) return res.status(400).json({ error: 'Captcha failed' });
  if (!USERNAME_RE.test(username || '')) return res.status(400).json({ error: 'Bad username' });
  if (typeof password !== 'string' || password.length < 8) return res.status(400).json({ error: 'Bad password' });
  if (username.toLowerCase() === OWNER_USERNAME.toLowerCase()) return res.status(400).json({ error: 'Reserved username' });
  const dn = (typeof displayName === 'string' && displayName.trim().slice(0, 64)) || username;
  try {
    const r = await q(`INSERT INTO users (username,password_hash,display_name) VALUES ($1,$2,$3) RETURNING *`, [username, await bcrypt.hash(password, 12), dn]);
    res.json({ token: signToken(r.rows[0]), user: publicUser(r.rows[0]) });
  } catch (e) { if (e.code === '23505') return res.status(409).json({ error: 'Username taken' }); throw e; }
}));

app.post('/api/auth/login', authLimiter, wrap(async (req, res) => {
  const { username, password } = req.body || {};
  const u = (await q('SELECT * FROM users WHERE LOWER(username)=LOWER($1)', [String(username || '')])).rows[0];
  if (!u || typeof password !== 'string' || !(await bcrypt.compare(password, u.password_hash))) return res.status(401).json({ error: 'Invalid credentials' });
  if (u.is_blocked) return res.status(403).json({ error: 'Blocked' });
  res.json({ token: signToken(u), user: publicUser(u) });
}));

app.get('/api/me', auth, (req, res) => res.json({ user: publicUser(req.user), isAdmin: isOwner(req.user) }));
app.patch('/api/me', auth, wrap(async (req, res) => {
  const av = req.body.avatarUrl === undefined ? req.user.avatar_url : cleanAvatar(req.body.avatarUrl);
  const dn = typeof req.body.displayName === 'string' ? req.body.displayName.trim().slice(0, 64) : req.user.display_name;
  const r = await q('UPDATE users SET display_name=$1, avatar_url=$2 WHERE id=$3 RETURNING *', [dn, av, req.user.id]);
  res.json({ user: publicUser(r.rows[0]) });
}));

app.get('/api/users', auth, wrap(async (req, res) => {
  const s = String(req.query.q || '').trim();
  const r = await q(`SELECT id,username,display_name,avatar_url,role,checkmark FROM users WHERE id<>$1 AND is_blocked=FALSE AND ($2='' OR username ILIKE $3) ORDER BY username LIMIT 30`, [req.user.id, s, `%${s.replace(/[%_]/g, '')}%`]);
  res.json({ users: r.rows.map(publicUser) });
}));

const msgSelect = `SELECT m.id,m.text,m.created_at,m.edited_at,m.edited_by_admin, u.id AS uid,u.username,u.display_name,u.avatar_url,u.role,u.checkmark FROM messages m JOIN users u ON u.id=m.user_id`;
const msgOut = (r) => ({ id: r.id, text: r.text, createdAt: r.created_at, editedAt: r.edited_at, editedByAdmin: r.edited_by_admin, user: { id: r.uid, username: r.username, displayName: r.display_name, avatarUrl: r.avatar_url, role: r.role, checkmark: r.checkmark } });

app.get('/api/messages', auth, wrap(async (req, res) => {
  const r = await q(`${msgSelect} WHERE m.id<$1 ORDER BY m.id DESC LIMIT ${PAGE}`, [parseInt(req.query.before) || 9e15]);
  res.json({ messages: r.rows.reverse().map(msgOut) });
}));
app.post('/api/messages', auth, writeGuard, sendLimiter, wrap(async (req, res) => {
  const text = cleanText(req.body?.text); if (!text) return res.status(400).json({ error: 'Bad request' });
  const ins = await q('INSERT INTO messages (user_id,text) VALUES ($1,$2) RETURNING id', [req.user.id, text]);
  const out = msgOut((await q(`${msgSelect} WHERE m.id=$1`, [ins.rows[0].id])).rows[0]);
  io.to('global').emit('message:new', out); res.json({ message: out });
}));

const dmOut = (r) => ({ id: r.id, senderId: r.sender_id, recipientId: r.recipient_id, text: r.text, createdAt: r.created_at });
app.get('/api/dm/conversations', auth, wrap(async (req, res) => {
  const r = await q(`SELECT DISTINCT ON (peer) peer, text, created_at, id FROM (SELECT CASE WHEN sender_id=$1 THEN recipient_id ELSE sender_id END AS peer, text, created_at, id FROM dm_messages WHERE sender_id=$1 OR recipient_id=$1) t ORDER BY peer, id DESC`, [req.user.id]);
  const ids = r.rows.map((x) => x.peer);
  const us = ids.length ? (await q('SELECT id,username,display_name,avatar_url,role,checkmark FROM users WHERE id=ANY($1)', [ids])).rows : [];
  const map = Object.fromEntries(us.map((u) => [u.id, u]));
  res.json({ conversations: r.rows.filter((x) => map[x.peer]).map((x) => ({ user: publicUser(map[x.peer]), lastText: x.text, lastAt: x.created_at, lastId: Number(x.id) })).sort((a, b) => b.lastId - a.lastId) });
}));
app.get('/api/dm/:userId', auth, wrap(async (req, res) => {
  const peer = parseInt(req.params.userId);
  const pu = (await q('SELECT id,username,display_name,avatar_url,role,checkmark FROM users WHERE id=$1', [peer])).rows[0];
  if (!pu) return res.status(404).json({ error: 'Not found' });
  const r = await q(`SELECT * FROM dm_messages WHERE ((sender_id=$1 AND recipient_id=$2) OR (sender_id=$2 AND recipient_id=$1)) ORDER BY id DESC LIMIT 50`, [req.user.id, peer]);
  res.json({ peer: publicUser(pu), messages: r.rows.reverse().map(dmOut) });
}));
app.post('/api/dm/:userId', auth, writeGuard, wrap(async (req, res) => {
  const peer = parseInt(req.params.userId); const text = cleanText(req.body?.text);
  const r = await q('INSERT INTO dm_messages (sender_id,recipient_id,text) VALUES ($1,$2,$3) RETURNING *', [req.user.id, peer, text]);
  io.to(`user:${peer}`).to(`user:${req.user.id}`).emit('dm:new', dmOut(r.rows[0]));
  res.json({ message: dmOut(r.rows[0]) });
}));

// --- КАНАЛЫ ---
app.get('/api/channels', auth, wrap(async (req, res) => {
  const query = isOwner(req.user) ? 'SELECT * FROM channels ORDER BY id DESC' : 
    `SELECT c.* FROM channels c JOIN channel_members m ON c.id = m.channel_id WHERE m.user_id = $1 ORDER BY c.id DESC`;
  const r = await q(query, isOwner(req.user) ? [] : [req.user.id]);
  res.json({ channels: r.rows });
}));

app.post('/api/channels', auth, wrap(async (req, res) => {
  if (req.user.checkmark !== 'green' && req.user.username !== 'CEBA') return res.status(403).json({ error: 'Нужна зеленая галка' });
  const { name, description } = req.body;
  const invite_code = Math.floor(100000 + Math.random() * 900000).toString();
  const r = await q('INSERT INTO channels (owner_id, name, description, invite_code) VALUES ($1, $2, $3, $4) RETURNING *', [req.user.id, name, description, invite_code]);
  await q('INSERT INTO channel_members (channel_id, user_id) VALUES ($1, $2)', [r.rows[0].id, req.user.id]);
  res.json({ channel: r.rows[0] });
}));

app.post('/api/channels/join', auth, wrap(async (req, res) => {
  const { code } = req.body;
  const ch = (await q('SELECT id, name FROM channels WHERE invite_code = $1', [code])).rows[0];
  if (!ch) return res.status(404).json({ error: 'Канал с таким кодом не найден' });
  await q('INSERT INTO channel_members (channel_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [ch.id, req.user.id]);
  res.json({ channel: ch });
}));

app.patch('/api/channels/:id', auth, wrap(async (req, res) => {
  const chId = parseInt(req.params.id);
  const ch = (await q('SELECT * FROM channels WHERE id=$1', [chId])).rows[0];
  if (!ch) return res.status(404).json({ error: 'Not found' });
  if (ch.owner_id !== req.user.id && req.user.username !== 'CEBA') return res.status(403).json({ error: 'Нет прав' });

  const f = {}; const b = req.body;
  if (b.name !== undefined) f.name = b.name;
  if (b.description !== undefined) f.description = b.description;
  if (b.avatar_url !== undefined) f.avatar_url = b.avatar_url;

  const keys = Object.keys(f); if (!keys.length) return res.json({ ok: true });
  const r = await q(`UPDATE channels SET ${keys.map((k, i) => `${k}=$${i+1}`).join(',')} WHERE id=$${keys.length+1} RETURNING *`, [...keys.map(k => f[k]), chId]);
  res.json({ channel: r.rows[0] });
}));

app.delete('/api/channels/:id', auth, wrap(async (req, res) => {
  const ch = (await q('SELECT * FROM channels WHERE id=$1', [req.params.id])).rows[0];
  if (!ch) return res.status(404).json({ error: 'Not found' });
  if (ch.owner_id !== req.user.id && req.user.username !== 'CEBA') return res.status(403).json({ error: 'Нет прав' });
  await q('DELETE FROM channels WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
}));

app.delete('/api/channels/:id/leave', auth, wrap(async (req, res) => {
  await q('DELETE FROM channel_members WHERE channel_id=$1 AND user_id=$2', [req.params.id, req.user.id]);
  res.json({ ok: true });
}));

app.get('/api/channels/:id/messages', auth, wrap(async (req, res) => {
  const r = await q(`SELECT m.*, u.username, u.display_name, u.avatar_url, u.role, u.checkmark FROM channel_messages m JOIN users u ON u.id = m.user_id WHERE m.channel_id = $1 ORDER BY m.id ASC LIMIT 100`, [req.params.id]);
  res.json({ messages: r.rows.map(row => ({ id: row.id, text: row.text, createdAt: row.created_at, user: { id: row.user_id, username: row.username, displayName: row.display_name, avatarUrl: row.avatar_url, role: row.role, checkmark: row.checkmark } })) });
}));

app.post('/api/channels/:id/messages', auth, writeGuard, wrap(async (req, res) => {
  const text = cleanText(req.body?.text); if (!text) return res.status(400).json({ error: 'Empty' });
  const ins = await q('INSERT INTO channel_messages (channel_id, user_id, text) VALUES ($1, $2, $3) RETURNING id', [req.params.id, req.user.id, text]);
  const row = (await q(`SELECT m.*, u.username, u.display_name, u.avatar_url, u.role, u.checkmark FROM channel_messages m JOIN users u ON u.id = m.user_id WHERE m.id = $1`, [ins.rows[0].id])).rows[0];
  const out = { id: row.id, text: row.text, createdAt: row.created_at, user: { id: row.user_id, username: row.username, displayName: row.display_name, avatarUrl: row.avatar_url, role: row.role, checkmark: row.checkmark } };
  io.to(`channel:${req.params.id}`).emit('channel:new', { channelId: req.params.id, message: out });
  res.json({ message: out });
}));

// --- ИСТОРИИ ---
app.get('/api/stories', auth, wrap(async (req, res) => {
  const r = await q(`SELECT s.*, u.username, u.display_name, u.avatar_url, u.checkmark FROM stories s JOIN users u ON u.id = s.user_id WHERE s.created_at > NOW() - INTERVAL '24 hours' ORDER BY s.id DESC`);
  res.json({ stories: r.rows });
}));
app.post('/api/stories', auth, wrap(async (req, res) => {
  if (req.user.checkmark !== 'green' && req.user.username !== 'CEBA') return res.status(403).json({ error: 'Need green checkmark' });
  await q('INSERT INTO stories (user_id, content) VALUES ($1, $2)', [req.user.id, req.body.content]);
  res.json({ ok: true });
}));
app.delete('/api/stories/:id', auth, wrap(async (req, res) => {
  const st = (await q('SELECT * FROM stories WHERE id=$1', [req.params.id])).rows[0];
  if (st.user_id === req.user.id || req.user.username === 'CEBA') await q('DELETE FROM stories WHERE id=$1', [st.id]);
  res.json({ ok: true });
}));

// --- ADMIN ---
const admin = express.Router(); app.use('/api/admin', auth, adminOnly, admin);

admin.get('/users', wrap(async (req, res) => { const r = await q(`SELECT * FROM users ORDER BY id`); res.json({ users: r.rows }); }));
admin.patch('/users/:id', wrap(async (req, res) => {
  const f = {}; const b = req.body;
  if (b.username) f.username = b.username;
  if (b.displayName) f.display_name = b.displayName;
  if (b.avatarUrl !== undefined) f.avatar_url = b.avatarUrl;
  if (b.role) f.role = b.role;
  if (b.isBlocked !== undefined) f.is_blocked = b.isBlocked;
  if (b.checkmark !== undefined) f.checkmark = b.checkmark === '' ? null : b.checkmark;
  const keys = Object.keys(f); if (!keys.length) return res.json({ ok: true });
  const r = await q(`UPDATE users SET ${keys.map((k, i) => `${k}=$${i + 1}`).join(',')} WHERE id=$${keys.length + 1} RETURNING *`, [...keys.map((k) => f[k]), req.params.id]);
  res.json({ user: r.rows[0] });
}));

admin.get('/channels', wrap(async (req, res) => {
  const r = await q(`SELECT c.*, u.username AS owner_name FROM channels c JOIN users u ON u.id = c.owner_id ORDER BY c.id DESC`);
  res.json({ channels: r.rows });
}));
admin.patch('/channels/:id', wrap(async (req, res) => {
  const f = {}; const b = req.body;
  if (b.name !== undefined) f.name = b.name;
  if (b.description !== undefined) f.description = b.description;
  if (b.avatar_url !== undefined) f.avatar_url = b.avatar_url;
  if (b.checkmark !== undefined) f.checkmark = b.checkmark === '' ? null : b.checkmark;
  const keys = Object.keys(f); if (!keys.length) return res.json({ ok: true });
  const r = await q(`UPDATE channels SET ${keys.map((k, i) => `${k}=$${i + 1}`).join(',')} WHERE id=$${keys.length + 1} RETURNING *`, [...keys.map((k) => f[k]), req.params.id]);
  res.json({ channel: r.rows[0] });
}));
admin.delete('/channels/:id', wrap(async (req, res) => {
  await q('DELETE FROM channels WHERE id=$1', [req.params.id]);
  res.json({ ok: true });
}));

admin.get('/feed', wrap(async (req, res) => {
  const r = await q(`${msgSelect} ORDER BY m.id DESC LIMIT 50`);
  res.json({ messages: r.rows.map(msgOut) });
}));
admin.patch('/feed/:id', wrap(async (req, res) => {
  await q('UPDATE messages SET text=$1, edited_at=NOW(), edited_by_admin=TRUE WHERE id=$2', [req.body.text, req.params.id]);
  const out = msgOut((await q(`${msgSelect} WHERE m.id=$1`, [req.params.id])).rows[0]);
  io.to('global').emit('message:update', out); res.json({ message: out });
}));
admin.delete('/feed/:id', wrap(async (req, res) => {
  await q('DELETE FROM messages WHERE id=$1', [req.params.id]);
  io.to('global').emit('message:delete', { id: parseInt(req.params.id) }); res.json({ ok: true });
}));
admin.get('/audit', wrap(async (req, res) => { const r = await q(`SELECT * FROM audit_logs ORDER BY id DESC LIMIT 100`); res.json({ logs: r.rows }); }));
admin.get('/maintenance', wrap(async (_, res) => res.json({ maintenance: await isMaintenance() })));
admin.post('/maintenance', wrap(async (req, res) => {
  const on = !!req.body?.enabled;
  await q(`INSERT INTO settings (key,value) VALUES ('maintenance',$1) ON CONFLICT (key) DO UPDATE SET value=EXCLUDED.value`, [JSON.stringify(on)]);
  io.emit('maintenance', { enabled: on }); res.json({ maintenance: on });
}));

io.use(async (socket, next) => {
  try {
    const p = jwt.verify(socket.handshake.auth?.token || '', JWT_SECRET);
    const u = (await q('SELECT * FROM users WHERE id=$1', [p.id])).rows[0];
    if (!u || u.is_blocked) return next(new Error('unauthorized'));
    socket.data.user = u; next();
  } catch { next(new Error('unauthorized')); }
});
io.on('connection', (socket) => {
  socket.join('global'); socket.join(`user:${socket.data.user.id}`);
  socket.on('join:channel', (channelId) => socket.join(`channel:${channelId}`));
});

const htmlDir = path.join(__dirname, 'html');
app.get('/admin', (_, res) => res.sendFile(path.join(htmlDir, 'admin.html')));
app.use(express.static(htmlDir));
app.use('/api', (_, res) => res.status(404).json({ error: 'Not found' }));
initDb().then(() => server.listen(PORT, () => console.log(`NeonLink on :${PORT}`))).catch((e) => { console.error(e); process.exit(1); });