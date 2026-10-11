const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const test = require('node:test');
const { createApp } = require('../server');

function request(port, pathname, options = {}) {
  return fetch(`http://127.0.0.1:${port}${pathname}`, options);
}

test('authenticated device telemetry is normalized and visible to a signed-in user', async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'doppler-test-'));
  const { server } = createApp({ root, deviceKey: 'test-device-key' });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = server.address().port;
  t.after(() => {
    server.close();
    fs.rmSync(root, { recursive: true, force: true });
  });

  const denied = await request(port, '/api/telemetry', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Device-Key': 'wrong-key' },
    body: JSON.stringify({}),
  });
  assert.equal(denied.status, 401);

  const accepted = await request(port, '/api/telemetry', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Device-Key': 'test-device-key' },
    body: JSON.stringify({
      deviceId: 'bench-esp32', sequence: 7, uptimeSeconds: 126,
      wifi: { rssi: -57 },
      sensors: [{ id: 1, online: true, lastFrameAgeMs: 15, targets: [{ targetId: 'S1-T1', x: 0.5, y: 2.1, speed: -0.42 }] }, { id: 2, online: true, targets: [] }],
      gsm: { connected: true, network: true, signal: 21, sms: 'SENT' },
      outputs: { redLed: true, greenLed: true, buzzer: true },
    }),
  });
  assert.equal(accepted.status, 202);

  const login = await request(port, '/api/auth/login', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'ChangeMe!2026' }),
  });
  assert.equal(login.status, 200);
  const cookie = login.headers.get('set-cookie').split(';')[0];
  const telemetry = await request(port, '/api/telemetry', { headers: { Cookie: cookie } });
  assert.equal(telemetry.status, 200);
  const data = await telemetry.json();
  assert.equal(data.connected, true);
  assert.equal(data.targets[0].direction, 'APPROACHING');
  assert.equal(data.system.buzzerStatus, 'DRIVE ON');
  assert.ok(data.events.some((event) => event.type === 'TARGET DETECTION'));
  assert.equal(data.targets[0].alarmQualified, false);
});
