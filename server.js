const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = __dirname;
const MAX_BODY_BYTES = 32 * 1024;
const SESSION_TTL_MS = 30 * 60 * 1000;
const HARDWARE_ONLINE_MS = 15 * 1000;
const SENSOR_HEALTH_MS = 5000;
const MAX_EVENTS = 300;

function ensureDirectory(directory) {
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
}

function writePrivateJson(file, data) {
  fs.writeFileSync(file, JSON.stringify(data, null, 2), { mode: 0o600 });
}

function hashPassword(password, salt = crypto.randomBytes(16)) {
  return `${salt.toString('base64')}:${crypto.pbkdf2Sync(password, salt, 210000, 32, 'sha256').toString('base64')}`;
}

function createDefaultUsers() {
  const initialPassword = process.env.DOPPLER_INITIAL_PASSWORD || 'ChangeMe!2026';
  return [
    ['usr_admin_001', 'admin', 'Administrator'],
    ['usr_operator_001', 'operator', 'Operator'],
    ['usr_viewer_001', 'viewer', 'Viewer'],
  ].map(([id, username, role]) => ({
    id,
    username,
    role,
    passwordHash: hashPassword(initialPassword),
    enabled: true,
    mustChangePassword: true,
    lastLogin: null,
    createdAt: new Date().toISOString(),
  }));
}

function verifyPassword(password, stored) {
  const [salt64, digest64] = String(stored).split(':');
  if (!salt64 || !digest64) return false;
  const expected = Buffer.from(digest64, 'base64');
  const actual = crypto.pbkdf2Sync(String(password || ''), Buffer.from(salt64, 'base64'), 210000, expected.length, 'sha256');
  return expected.length === actual.length && crypto.timingSafeEqual(actual, expected);
}

function createStore(root = ROOT) {
  const dataDir = path.join(root, 'data');
  const usersFile = path.join(dataDir, 'users.json');
  const eventsFile = path.join(dataDir, 'events.json');
  ensureDirectory(dataDir);
  function loadUsers() {
    if (!fs.existsSync(usersFile)) writePrivateJson(usersFile, createDefaultUsers());
    return JSON.parse(fs.readFileSync(usersFile, 'utf8'));
  }
  function saveUsers(users) { writePrivateJson(usersFile, users); }
  function loadEvents() {
    if (!fs.existsSync(eventsFile)) return [];
    try {
      const data = JSON.parse(fs.readFileSync(eventsFile, 'utf8'));
      return Array.isArray(data) ? data.slice(0, MAX_EVENTS) : [];
    } catch { return []; }
  }
  function saveEvents(events) { writePrivateJson(eventsFile, events.slice(0, MAX_EVENTS)); }
  return { loadUsers, saveUsers, loadEvents, saveEvents };
}

function sendJson(res, status, data, headers = {}) {
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  });
  res.end(JSON.stringify(data));
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let received = 0;
    const chunks = [];
    req.on('data', (chunk) => {
      received += chunk.length;
      if (received > MAX_BODY_BYTES) {
        reject(new Error('Request body is too large.'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => {
      try {
        const raw = Buffer.concat(chunks).toString('utf8');
        resolve(raw ? JSON.parse(raw) : {});
      } catch { reject(new Error('Request body must be valid JSON.')); }
    });
    req.on('error', reject);
  });
}

function safeText(value, fallback = '') {
  return typeof value === 'string' ? value.trim().slice(0, 120) : fallback;
}

function finiteNumber(value, fallback = 0, min = -Infinity, max = Infinity) {
  if (value === null || value === undefined) return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? Math.min(Math.max(number, min), max) : fallback;
}

function telemetryState() {
  return {
    connected: false,
    lastData: null,
    deviceId: 'doppler-radar-01',
    targets: [],
    sensors: [1, 2].map((id) => ({ id, online: false, targetCount: 0, lastFrameAgeMs: null })),
    gsm: { connected: false, network: false, signal: 0, sms: 'NOT SENT', call: 'IDLE', lastSms: null, lastCall: null },
    system: { esp: false, uptime: '0s', uptimeSeconds: 0, packets: 0, sequence: 0, wifiRssi: null, buzzerStatus: 'READY', ledStatus: 'READY' },
  };
}

function directionFor(speedMps) {
  if (speedMps < -0.02) return 'APPROACHING';
  if (speedMps > 0.02) return 'MOVING AWAY';
  return 'STATIONARY';
}

function normalizeTarget(raw, sensorId, index, receivedAt) {
  const speed = finiteNumber(raw?.speed, 0, -10, 10);
  const x = finiteNumber(raw?.x, 0, -8, 8);
  const y = finiteNumber(raw?.y, 0, 0, 8);
  const distance = finiteNumber(raw?.distance, Math.hypot(x, y), 0, 10);
  const angle = finiteNumber(raw?.angle, Math.atan2(x, y || 0.001) * 180 / Math.PI, -180, 180);
  return {
    targetId: safeText(raw?.targetId, `S${sensorId}-T${index + 1}`),
    sensorId,
    x: Number(x.toFixed(3)), y: Number(y.toFixed(3)), distance: Number(distance.toFixed(3)), speed: Number(speed.toFixed(2)),
    direction: ['APPROACHING', 'MOVING AWAY', 'STATIONARY', 'TRACKING'].includes(raw?.direction) ? raw.direction : directionFor(speed),
    rawSpeedCmS: finiteNumber(raw?.rawSpeedCmS, null, -1000, 1000),
    trackingStatus: safeText(raw?.trackingStatus, 'UNREPORTED'),
    angle: Number(angle.toFixed(1)), timestamp: receivedAt,
    moving: raw?.moving === true, active: raw?.active === true,
    filteredDistanceMm: finiteNumber(raw?.filteredDistanceMm, null, 0, 7000),
    baselineDistanceMm: finiteNumber(raw?.baselineDistanceMm, null, 0, 7000),
    displacementMm: finiteNumber(raw?.displacementMm, null, -7000, 7000),
    alarmQualified: raw?.alarmQualified === true && raw?.moving === true && Math.abs(Number(raw?.displacementMm)) >= 800,
    gsmSent: raw?.gsmSent === true, notificationQueued: raw?.notificationQueued === true,
    firstSeenUptimeMs: finiteNumber(raw?.firstSeenUptimeMs, null, 0),
    lastSeenAgeMs: finiteNumber(raw?.lastSeenAgeMs, null, 0, 60000),
    lastSeenUptimeMs: finiteNumber(raw?.lastSeenUptimeMs, null, 0, 0xFFFFFFFF),
    displayHoldMs: raw?.displayHoldMs === 5000 && raw?.moving !== true && Math.abs(Number(raw?.rawSpeedCmS ?? speed * 100)) < 5 ? 5000 : 1200,
  };
}

function normalizeTelemetry(payload, previous, receivedAt) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) throw new Error('Telemetry must be a JSON object.');
  const inputSensors = Array.isArray(payload.sensors) ? payload.sensors : [];
  const sensorsWithTargets = [1, 2].map((id) => {
    const input = inputSensors.find((sensor) => Number(sensor?.id) === id) || {};
    const targets = (Array.isArray(input.targets) ? input.targets : []).slice(0, 6)
      .filter(t => t && Number.isFinite(Number(t.x)) && Number.isFinite(Number(t.y)))
      .map((target, index) => normalizeTarget(target, id, index, receivedAt))
      .filter(t => t.distance > 0 && t.distance <= 7 &&
        (t.lastSeenAgeMs === null || t.lastSeenAgeMs < t.displayHoldMs) &&
        (t.active || (t.lastSeenAgeMs === null && Math.abs(t.speed) >= 0.05)));
    const triggerOnly = input.mode === 'trigger';
    const linked = input.mode === 'linked';
    const frameAge = finiteNumber(input.lastFrameAgeMs, null, 0, 60000);
    const isOnline = input.online === true && (frameAge === null || frameAge < SENSOR_HEALTH_MS);
    const triggerCount = Math.floor(finiteNumber(input.triggerCount, 0, 0, 0xFFFFFFFF));
    const triggerAge = finiteNumber(input.lastTriggerAgeMs, null, -1, 0xFFFFFFFF);
    return {
      id, mode: triggerOnly ? 'trigger' : linked ? 'linked' : 'uart', online: triggerOnly ? null : isOnline,
      linkOnline: linked ? input.linkOnline === true : null,
      targetCount: triggerOnly || !isOnline ? 0 : targets.length,
      lastFrameAgeMs: triggerOnly ? null : frameAge,
      frames: linked ? Math.floor(finiteNumber(input.frames, 0, 0, 0xFFFFFFFF)) : null,
      rejected: linked ? Math.floor(finiteNumber(input.rejected, 0, 0, 0xFFFFFFFF)) : null,
      overflows: linked ? Math.floor(finiteNumber(input.overflows, 0, 0, 0xFFFFFFFF)) : null,
      triggerActive: (triggerOnly || linked) && input.triggerActive === true,
      triggerCount, lastTriggerAgeMs: triggerAge,
      detectionActive: (triggerOnly || linked) && (input.triggerActive === true || (triggerCount > 0 && Number.isFinite(triggerAge) && triggerAge >= 0 && triggerAge < 5000)),
      targets: triggerOnly || !isOnline ? [] : targets,
    };
  });
  const gsm = payload.gsm && typeof payload.gsm === 'object' ? payload.gsm : {};
  const outputs = payload.outputs && typeof payload.outputs === 'object' ? payload.outputs : {};
  const uptimeSeconds = Math.floor(finiteNumber(payload.uptimeSeconds, 0, 0, 365 * 24 * 60 * 60));
  return {
    connected: true,
    lastData: receivedAt,
    deviceId: safeText(payload.deviceId, previous.deviceId),
    controller: safeText(payload.controller, 'ESP controller'),
    targets: Array.isArray(payload.sharedTargets)
      ? payload.sharedTargets.slice(0, 6).map((t,i) => normalizeTarget(t, 1, i, receivedAt))
        .filter(t => t.active && t.distance > 0 && t.distance <= 7 && t.lastSeenAgeMs !== null && t.lastSeenAgeMs < t.displayHoldMs)
      : sensorsWithTargets.flatMap((sensor) => sensor.targets),
    sensors: sensorsWithTargets.map(({ targets, ...sensor }) => sensor),
    gsm: {
      connected: Boolean(gsm.connected), network: Boolean(gsm.network), signal: Number(gsm.signal) === 99 ? null : Math.floor(finiteNumber(gsm.signal, 0, 0, 31)),
      simReady: Boolean(gsm.simReady), smscConfigured: Boolean(gsm.smscConfigured),
      model: safeText(gsm.model), stage: safeText(gsm.stage), callsEnabled: Boolean(gsm.callsEnabled),
      smsError: safeText(gsm.smsError), callError: safeText(gsm.callError), statusError: safeText(gsm.statusError),
      callDiagnostic: safeText(gsm.callDiagnostic), cleanupError: safeText(gsm.cleanupError),
      smsSentCount: Math.floor(finiteNumber(gsm.smsSentCount, 0, 0, 0xFFFFFFFF)),
      callPlacedCount: Math.floor(finiteNumber(gsm.callPlacedCount, 0, 0, 0xFFFFFFFF)),
      sms: safeText(gsm.sms, 'NOT SENT'), call: safeText(gsm.call, 'IDLE'), lastSms: safeText(gsm.lastSms, '') || null, lastCall: safeText(gsm.lastCall, '') || null,
    },
    system: {
      firmware: safeText(payload.firmware, 'Unknown'),
      buzzerDrive: safeText(outputs.buzzerDrive, 'UNREPORTED'),
      buzzerRestarts: Math.floor(finiteNumber(outputs.buzzerRestarts, 0, 0, 0xFFFFFFFF)),
      buzzerPattern: safeText(outputs.buzzerPattern, 'UNREPORTED'),
      esp: true, uptime: `${uptimeSeconds}s`, uptimeSeconds, packets: previous.system.packets + 1,
      sequence: Math.floor(finiteNumber(payload.sequence, previous.system.sequence + 1, 0, 0xFFFFFFFF)),
      wifiRssi: Math.round(finiteNumber(payload.wifi?.rssi, 0, -120, 0)) || null,
      alarmActive: typeof outputs.alarmActive === 'boolean' ? outputs.alarmActive : Boolean(outputs.redLed),
      alarmSource: safeText(outputs.alarmSource, 'UNKNOWN'),
      alarmEvents: Math.floor(finiteNumber(outputs.alarmEvents, 0, 0, 0xFFFFFFFF)),
      redLed: Boolean(outputs.redLed), greenLed: Boolean(outputs.greenLed), buzzerOn: Boolean(outputs.buzzer),
      buzzerStatus: outputs.buzzer ? 'DRIVE ON' : outputs.alarmActive ? 'BEEP GAP' : 'OFF',
      ledStatus: outputs.ledMode === 'WIFI_STATUS'
        ? outputs.greenLed ? 'WI-FI CONNECTED' : outputs.redLed ? 'WI-FI DISCONNECTED' : 'OFF'
        : outputs.alarmActive || outputs.redLed ? 'ALERT' : outputs.greenLed ? 'READY' : 'OFF',
    },
  };
}

function appendEvents(previous, current, events) {
  const next = [...events];
  const now = current.lastData;
  if (!previous.connected) next.unshift({ timestamp: now, type: 'HARDWARE', event: 'Controller telemetry connection established.', status: 'ONLINE' });
  current.targets.forEach((target) => {
    const old = previous.targets.find(t => t.targetId === target.targetId && t.sensorId === target.sensorId);
    if (!old) next.unshift({ timestamp: now, type: 'TARGET DETECTION', sensorId: target.sensorId,
      direction: target.direction, distance: target.distance, speed: target.speed,
      event: `${target.targetId} detected on Sensor ${target.sensorId}: ${target.direction}.`, status: 'MONITORING' });
    if (target.alarmQualified && !old?.alarmQualified) next.unshift({ timestamp: now, type: 'MOVEMENT THRESHOLD',
      sensorId: target.sensorId, direction: target.direction, distance: target.distance, speed: target.speed,
      displacementMm: target.displacementMm, event: `${target.targetId}: ${(Math.abs(target.displacementMm)/1000).toFixed(2)} m movement; ${target.direction}.`, status: 'ALERT' });
    if (old && target.direction !== old.direction && (target.moving || old.moving)) next.unshift({ timestamp: now, type: 'TARGET DIRECTION',
      sensorId: target.sensorId, direction: target.direction,
      event: `${target.targetId}: ${target.direction}.`, status: 'MONITORING' });
    if (old && target.displacementMm !== null && !target.alarmQualified &&
        Math.floor(Math.abs(target.displacementMm)/200) > Math.floor(Math.abs(old.displacementMm || 0)/200))
      next.unshift({ timestamp: now, type: 'MOVEMENT TRACKING', sensorId: target.sensorId,
        displacementMm: target.displacementMm, direction: target.direction,
        event: `${target.targetId}: ${(Math.abs(target.displacementMm)/1000).toFixed(2)} m / 0.80 m; ${target.direction}.`, status: 'MONITORING' });
  });
  const oldUno = previous.sensors.find((sensor) => sensor.id === 1);
  const uno = current.sensors.find((sensor) => sensor.id === 1);
  if (uno.triggerCount !== (oldUno?.triggerCount || 0) && uno.triggerCount > 0 &&
      !current.targets.some((target) => target.sensorId === 1 && target.direction === 'APPROACHING')) {
    next.unshift({ timestamp: now, type: 'HARDWARE', event: 'Radar 1 / Uno trigger received. Measured movement is required for alarm qualification.', status: 'DIAGNOSTIC' });
  }
  if (current.system.alarmActive && (!previous.system.alarmActive || current.system.alarmEvents !== previous.system.alarmEvents)) {
    next.unshift({ timestamp: now, type: 'HARDWARE', event: `Alarm active: ${current.system.alarmSource}. LED and buzzer alarm requested.`, status: 'ALERT' });
  }
  for (const field of ['smsError', 'callError', 'statusError', 'cleanupError', 'callDiagnostic']) {
    if (current.gsm[field] && current.gsm[field] !== previous.gsm[field]) {
      next.unshift({ timestamp: now, type: 'GSM', event: current.gsm[field], status: 'FAILED' });
    }
  }
  if ((current.gsm.smsSentCount > 0 && current.gsm.smsSentCount !== previous.gsm.smsSentCount) || (current.gsm.sms === 'SENT' && previous.gsm.sms !== 'SENT')) next.unshift({ timestamp: now, type: 'GSM', event: 'Security SMS sent by GSM module.', status: 'SENT' });
  if ((current.gsm.callPlacedCount > 0 && current.gsm.callPlacedCount !== previous.gsm.callPlacedCount) || (current.gsm.call === 'PLACED' && previous.gsm.call !== 'PLACED')) next.unshift({ timestamp: now, type: 'GSM', event: 'GSM accepted the call dial command; connection is unconfirmed.', status: 'DIAL REQUEST' });
  return next.slice(0, MAX_EVENTS);
}

function publicTelemetry(state, events) {
  const online = Boolean(state.lastData && Date.now() - Date.parse(state.lastData) <= HARDWARE_ONLINE_MS);
  const age = state.lastData ? Math.max(0, Date.now() - Date.parse(state.lastData)) : Infinity;
  const targets = online ? state.targets.filter(t => (t.lastSeenAgeMs || 0) + age < (t.displayHoldMs || 1200) &&
    state.sensors.some(s => (state.sharedScene || s.id === t.sensorId) && s.online && (s.lastFrameAgeMs || 0) + age < SENSOR_HEALTH_MS))
    .map(t => {
      const measurementAge = (t.lastSeenAgeMs || 0) + age;
      return {...t, lastSeenAgeMs:measurementAge, displayState:measurementAge >= 1200 ? 'LAST_KNOWN' : 'LIVE',
        ...(measurementAge >= 1200 ? {moving:false, alarmQualified:false, direction:'TRACKING'} : {})};
    }) : [];
  return {
    ...state,
    connected: online,
    system: { ...state.system, esp: online && state.system.esp, alarmActive: online && Boolean(state.system.alarmActive),
      ...(online ? {} : { buzzerStatus: 'OFFLINE', buzzerDrive: 'OFFLINE', ledStatus: 'OFFLINE', redLed: false, greenLed: false, buzzerOn: false }) },
    gsm: { ...state.gsm, connected: online && state.gsm.connected, network: online && state.gsm.network },
    sensors: state.sensors.map((sensor) => ({ ...sensor,
      lastFrameAgeMs: sensor.lastFrameAgeMs === null ? null : Math.min(60000, (sensor.lastFrameAgeMs || 0) + age),
      targetCount: state.sharedScene ? (online && sensor.online ? sensor.targetCount : 0) : targets.filter(t => t.sensorId === sensor.id).length,
      online: sensor.mode === 'trigger' ? null : online && sensor.online && (sensor.lastFrameAgeMs || 0) + age < SENSOR_HEALTH_MS,
      linkOnline: sensor.mode === 'linked' ? online && sensor.linkOnline && (sensor.lastFrameAgeMs || 0) + age < SENSOR_HEALTH_MS : sensor.linkOnline,
      triggerActive: online && sensor.triggerActive, detectionActive: online && sensor.detectionActive })),
    targets,
    events: events.slice(0, 100),
  };
}

function publicUser(user) { const { passwordHash, ...safe } = user; return safe; }

function createApp(options = {}) {
  const root = options.root || ROOT;
  const store = options.store || createStore(root);
  const deviceKey = options.deviceKey ?? process.env.DOPPLER_DEVICE_KEY ?? '';
  const sessions = new Map();
  const recorder = require('./recordings').createRecorder(root);
  const filterCloudScene = require('./scene-filter').createSceneFilter();
  let liveTelemetry = telemetryState();
  let events = store.loadEvents();

  function sessionUser(req) {
    const id = (req.headers.cookie || '').match(/doppler_session=([^;]+)/)?.[1];
    const session = id && sessions.get(id);
    if (!session || session.expiresAt < Date.now()) { if (id) sessions.delete(id); return null; }
    return store.loadUsers().find((user) => user.id === session.userId && user.enabled) || null;
  }
  function requireUser(req, res) { const user = sessionUser(req); if (!user) { sendJson(res, 401, { error: 'Authentication required.' }); return null; } return user; }
  function requireAdmin(req, res) { const user = requireUser(req, res); if (!user) return null; if (user.role !== 'Administrator') { sendJson(res, 403, { error: 'Administrator permission required.' }); return null; } return user; }
  function serveFile(res, filename, type) { res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); fs.createReadStream(path.join(root, filename)).pipe(res); }

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    try {
      if (req.method === 'POST' && url.pathname === '/api/auth/login') {
        const { username, password } = await readJson(req);
        const users = store.loadUsers();
        const user = users.find((item) => item.username.toLowerCase() === String(username || '').toLowerCase());
        if (!user || !user.enabled || !verifyPassword(password, user.passwordHash)) return sendJson(res, 401, { error: 'Invalid username or password.' });
        user.lastLogin = new Date().toISOString(); store.saveUsers(users);
        const sessionId = crypto.randomBytes(32).toString('base64url');
        sessions.set(sessionId, { userId: user.id, expiresAt: Date.now() + SESSION_TTL_MS });
        return sendJson(res, 200, { user: publicUser(user) }, { 'Set-Cookie': `doppler_session=${sessionId}; HttpOnly; SameSite=Strict; Path=/; Max-Age=${SESSION_TTL_MS / 1000}` });
      }
      if (req.method === 'POST' && url.pathname === '/api/auth/logout') {
        const id = (req.headers.cookie || '').match(/doppler_session=([^;]+)/)?.[1];
        if (id) sessions.delete(id);
        return sendJson(res, 200, { ok: true }, { 'Set-Cookie': 'doppler_session=; HttpOnly; SameSite=Strict; Path=/; Max-Age=0' });
      }
      if (req.method === 'GET' && url.pathname === '/api/auth/session') {
        const user = sessionUser(req);
        return user ? sendJson(res, 200, { user: publicUser(user) }) : sendJson(res, 401, { error: 'No active session.' });
      }
      if (req.method === 'POST' && url.pathname === '/api/telemetry') {
        if (!deviceKey) return sendJson(res, 503, { error: 'DOPPLER_DEVICE_KEY is not configured on the dashboard server.' });
        const expected = Buffer.from(deviceKey), actual = Buffer.from(String(req.headers['x-device-key'] || ''));
        if (actual.length !== expected.length || !crypto.timingSafeEqual(actual, expected)) return sendJson(res, 401, { error: 'Invalid device credential.' });
        const payload = await readJson(req);
        if (Number(payload.sequence)>0 && payload.deviceId===liveTelemetry.deviceId &&
            Number(payload.sequence)===liveTelemetry.system.sequence && Number(payload.uptimeSeconds)>=liveTelemetry.system.uptimeSeconds) {
          return sendJson(res,202,{accepted:true,duplicate:true,sequence:liveTelemetry.system.sequence});
        }
        const next = normalizeTelemetry(payload, liveTelemetry, new Date().toISOString());
        if (Array.isArray(payload.sharedTargets)) {
          next.sharedScene = true;
          filterCloudScene(next);
        }
        recorder.append(payload, next);
        const updatedEvents = appendEvents(liveTelemetry, next, events);
        if (updatedEvents[0] !== events[0]) store.saveEvents(updatedEvents);
        events = updatedEvents; liveTelemetry = next;
        return sendJson(res, 202, { accepted: true, sequence: liveTelemetry.system.sequence });
      }
      if (req.method === 'GET' && url.pathname === '/api/telemetry') { if (!requireUser(req, res)) return; return sendJson(res, 200, publicTelemetry(liveTelemetry, events)); }
      if (url.pathname === '/api/recordings') {
        if (!requireUser(req,res)) return;
        if (req.method === 'GET') return sendJson(res,200,recorder.status());
      }
      if (req.method === 'POST' && ['/api/recordings/start','/api/recordings/stop'].includes(url.pathname)) {
        const user=requireUser(req,res);if(!user)return;
        if(user.role==='Viewer')return sendJson(res,403,{error:'Operator permission required.'});
        const body=await readJson(req);
        const recording=url.pathname.endsWith('/start')?recorder.start(body.label):recorder.stop();
        return sendJson(res,200,{recording});
      }
      const recordingMatch=url.pathname.match(/^\/api\/recordings\/([a-f0-9-]{36})$/);
      if (req.method==='GET' && recordingMatch) {
        if(!requireUser(req,res))return;
        const recordedText=recorder.read(recordingMatch[1]);
        res.writeHead(200,{'Content-Type':'application/x-ndjson','Cache-Control':'no-store','Content-Disposition':'attachment; filename="radar-'+recordingMatch[1]+'.jsonl"'});
        return res.end(recordedText);
      }
      if (url.pathname === '/api/users') {
        if (!requireAdmin(req, res)) return;
        if (req.method === 'GET') return sendJson(res, 200, { users: store.loadUsers().map(publicUser) });
        if (req.method === 'POST') {
          const { username, password, role } = await readJson(req);
          if (!/^[a-z0-9_.-]{3,32}$/i.test(username || '') || String(password || '').length < 12 || !['Administrator', 'Operator', 'Viewer'].includes(role)) return sendJson(res, 400, { error: 'Provide a valid username, a 12+ character password, and a valid role.' });
          const users = store.loadUsers();
          if (users.some((user) => user.username.toLowerCase() === username.toLowerCase())) return sendJson(res, 409, { error: 'Username already exists.' });
          const user = { id: crypto.randomUUID(), username, role, passwordHash: hashPassword(password), enabled: true, mustChangePassword: true, lastLogin: null, createdAt: new Date().toISOString() };
          users.push(user); store.saveUsers(users); return sendJson(res, 201, { user: publicUser(user) });
        }
      }
      const userAction = url.pathname.match(/^\/api\/users\/([\w-]+)\/(toggle|role|reset-password)$/);
      if (userAction && req.method === 'PATCH') {
        if (!requireAdmin(req, res)) return;
        const [, id, action] = userAction; const users = store.loadUsers(); const target = users.find((user) => user.id === id);
        if (!target) return sendJson(res, 404, { error: 'User not found.' });
        const data = await readJson(req);
        if (action === 'toggle') target.enabled = !target.enabled;
        if (action === 'role') { if (!['Administrator', 'Operator', 'Viewer'].includes(data.role)) return sendJson(res, 400, { error: 'Invalid role.' }); target.role = data.role; }
        if (action === 'reset-password') { if (String(data.password || '').length < 12) return sendJson(res, 400, { error: 'Password must contain at least 12 characters.' }); target.passwordHash = hashPassword(data.password); target.mustChangePassword = true; }
        store.saveUsers(users); return sendJson(res, 200, { user: publicUser(target) });
      }
      if (req.method === 'GET' && (url.pathname === '/' || url.pathname === '/index.html')) return serveFile(res, 'doppler-radar-dashboard.html', 'text/html; charset=utf-8');
      if (req.method === 'GET' && url.pathname === '/light-ui.css') return serveFile(res, 'light-ui.css', 'text/css; charset=utf-8');
      if (req.method === 'GET' && url.pathname === '/light-ui.js') return serveFile(res, 'light-ui.js', 'application/javascript; charset=utf-8');
      sendJson(res, 404, { error: 'Not found.' });
    } catch (error) { sendJson(res, 400, { error: error.message || 'Bad request.' }); }
  });
  return { server, getTelemetry: () => publicTelemetry(liveTelemetry, events) };
}

if (require.main === module) {
  const port = Number(process.env.PORT || 8080);
  const app = createApp();
  app.server.listen(port, '0.0.0.0', () => {
    require('./discovery').startDiscovery(app.server, process.env.DOPPLER_DEVICE_KEY || '');
    console.log(`Doppler Radar System running at http://localhost:${port}`);
    if (!process.env.DOPPLER_DEVICE_KEY) console.warn('Hardware telemetry is disabled until DOPPLER_DEVICE_KEY is set.');
  });
}

module.exports = { createApp, normalizeTelemetry, telemetryState };
