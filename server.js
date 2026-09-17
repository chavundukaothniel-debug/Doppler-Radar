const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const port = Number(process.env.PORT || 8080);
const root = __dirname;
const usersFile = path.join(root, 'users.json');
const sessions = new Map();
const defaults = [
  { id: 'usr_admin_001', username: 'admin', role: 'Administrator', passwordHash: 'CN28dcUpK31K5oMPRK+wWA==:etK2+v87HgS2G49j+b26jQhIPmPj0HdXHizEKSZ/OTA=' },
  { id: 'usr_rudboi_001', username: 'rudboi', role: 'Operator', passwordHash: 'CN28dcUpK31K5oMPRK+wWA==:BryH6aL32yMrqH1OUj6cLcmmh29V+ZoWl9EzyAda5aU=' },
  { id: 'usr_nyasha_001', username: 'nyasha', role: 'Viewer', passwordHash: 'CN28dcUpK31K5oMPRK+wWA==:BryH6aL32yMrqH1OUj6cLcmmh29V+ZoWl9EzyAda5aU=' }
].map(user => ({ ...user, enabled: true, mustChangePassword: true, lastLogin: null, createdAt: new Date().toISOString() }));

function loadUsers() { if (!fs.existsSync(usersFile)) fs.writeFileSync(usersFile, JSON.stringify(defaults, null, 2), { mode: 0o600 }); return JSON.parse(fs.readFileSync(usersFile, 'utf8')); }
function saveUsers(users) { fs.writeFileSync(usersFile, JSON.stringify(users, null, 2), { mode: 0o600 }); }
function hashPassword(password, salt = crypto.randomBytes(16)) { return salt.toString('base64') + ':' + crypto.pbkdf2Sync(password, salt, 210000, 32, 'sha256').toString('base64'); }
function verifyPassword(password, stored) { const [salt64, digest64] = stored.split(':'); const actual = crypto.pbkdf2Sync(password, Buffer.from(salt64, 'base64'), 210000, 32, 'sha256'); return crypto.timingSafeEqual(actual, Buffer.from(digest64, 'base64')); }
function send(res, status, data, headers = {}) { res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', ...headers }); res.end(JSON.stringify(data)); }
function publicUser(user) { const { passwordHash, ...safe } = user; return safe; }
function body(req) { return new Promise((resolve, reject) => { let data = ''; req.on('data', chunk => { data += chunk; if (data.length > 8192) reject(new Error('Request too large')); }); req.on('end', () => { try { resolve(data ? JSON.parse(data) : {}); } catch { reject(new Error('Invalid JSON')); } }); }); }
function sessionUser(req) { const id = (req.headers.cookie || '').match(/doppler_session=([^;]+)/)?.[1]; const session = id && sessions.get(id); if (!session || session.expires < Date.now()) return null; return loadUsers().find(user => user.id === session.userId && user.enabled) || null; }
function requireAdmin(req, res) { const user = sessionUser(req); if (!user) { send(res, 401, { error: 'Authentication required' }); return null; } if (user.role !== 'Administrator') { send(res, 403, { error: 'Administrator permission required' }); return null; } return user; }

http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (req.method === 'POST' && url.pathname === '/api/auth/login') {
      const { username, password } = await body(req); const user = loadUsers().find(item => item.username.toLowerCase() === String(username).toLowerCase());
      if (!user || !user.enabled || !verifyPassword(String(password || ''), user.passwordHash)) return send(res, 401, { error: 'Invalid username or password' });
      user.lastLogin = new Date().toISOString(); saveUsers(loadUsers().map(item => item.id === user.id ? user : item));
      const id = crypto.randomBytes(32).toString('base64url'); sessions.set(id, { userId: user.id, expires: Date.now() + 30 * 60 * 1000 });
      return send(res, 200, { user: publicUser(user) }, { 'Set-Cookie': `doppler_session=${id}; HttpOnly; SameSite=Strict; Path=/; Max-Age=1800` });
    }
    if (req.method === 'POST' && url.pathname === '/api/auth/logout') { const id = (req.headers.cookie || '').match(/doppler_session=([^;]+)/)?.[1]; if (id) sessions.delete(id); return send(res, 200, { ok: true }, { 'Set-Cookie': 'doppler_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' }); }
    if (req.method === 'GET' && url.pathname === '/api/auth/session') { const user = sessionUser(req); return user ? send(res, 200, { user: publicUser(user) }) : send(res, 401, { error: 'No active session' }); }
    if (url.pathname === '/api/users') {
      if (!requireAdmin(req, res)) return;
      if (req.method === 'GET') return send(res, 200, { users: loadUsers().map(publicUser) });
      if (req.method === 'POST') { const { username, password, role } = await body(req); if (!/^[a-z0-9_.-]{3,32}$/i.test(username || '') || String(password || '').length < 8 || !['Administrator','Operator','Viewer'].includes(role)) return send(res, 400, { error: 'Provide a valid username, 8+ character password, and role.' }); const users = loadUsers(); if (users.some(user => user.username.toLowerCase() === username.toLowerCase())) return send(res, 409, { error: 'Username already exists' }); const user = { id: crypto.randomUUID(), username, role, passwordHash: hashPassword(password), enabled: true, mustChangePassword: true, lastLogin: null, createdAt: new Date().toISOString() }; users.push(user); saveUsers(users); return send(res, 201, { user: publicUser(user) }); }
    }
    const userAction = url.pathname.match(/^\/api\/users\/([\w-]+)\/(toggle|role|reset-password)$/);
    if (userAction && req.method === 'PATCH') { if (!requireAdmin(req, res)) return; const [, id, action] = userAction; const users = loadUsers(); const target = users.find(user => user.id === id); if (!target) return send(res, 404, { error: 'User not found' }); const data = await body(req); if (action === 'toggle') target.enabled = !target.enabled; if (action === 'role' && ['Administrator','Operator','Viewer'].includes(data.role)) target.role = data.role; if (action === 'reset-password' && String(data.password || '').length >= 8) { target.passwordHash = hashPassword(data.password); target.mustChangePassword = true; } saveUsers(users); return send(res, 200, { user: publicUser(target) }); }
    if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) { res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' }); return fs.createReadStream(path.join(root, 'doppler-radar-dashboard.html')).pipe(res); }
    if (req.method === 'GET' && ['/security.js', '/light-ui.js'].includes(url.pathname)) { res.writeHead(200, { 'Content-Type': 'application/javascript; charset=utf-8', 'Cache-Control': 'no-store' }); return fs.createReadStream(path.join(root, url.pathname.slice(1))).pipe(res); }
    if (req.method === 'GET' && url.pathname === '/light-ui.css') { res.writeHead(200, { 'Content-Type': 'text/css; charset=utf-8', 'Cache-Control': 'no-store' }); return fs.createReadStream(path.join(root, 'light-ui.css')).pipe(res); }
    send(res, 404, { error: 'Not found' });
  } catch (error) { send(res, 400, { error: error.message || 'Bad request' }); }
}).listen(port, () => console.log(`Doppler Radar System running at http://localhost:${port}`));
