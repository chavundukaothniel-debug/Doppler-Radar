const test = require('node:test'), assert = require('node:assert/strict');
const fs = require('fs'), os = require('os'), path = require('path');
const { createApp } = require('../server');
const { readFilters, filterRows, instant } = require('../history');
const { validateResult, summarize } = require('../test-results');
const { historyPdf, resultsPdf } = require('../reports');
const trial = overrides => ({ label: 'Slow approach - repeat 1', performedAt: '2026-10-26T08:10:00+02:00', scenario: 'Slow approach', sensorId: 'Combined', durationSeconds: 60, expectedCount: 1, detectedCount: 1, expectedAlarm: true, alarmObserved: true, actualDistance: 3, measuredDistance: 2.8, alertDelaySeconds: 0, smsReceived: 'yes', notes: 'Measured at the same moment.', ...overrides });

test('history time filters handle offsets, inclusive boundaries, types, sensor and invalid ranges', () => {
  const filters = readFilters(new URLSearchParams({ from: '2026-10-26T08:00:00+02:00', to: '2026-10-26T08:30:00+02:00', type: 'GSM', timezone: 'Africa/Harare' }));
  const rows = [
    { timestamp: '2026-10-26T05:59:59.999Z', type: 'GSM' },
    { timestamp: '2026-10-26T06:00:00Z', type: 'GSM' },
    { timestamp: '2026-10-26T06:30:00Z', type: 'GSM' },
    { timestamp: '2026-10-26T06:30:00.001Z', type: 'GSM' },
    { timestamp: '2026-10-26T06:10:00Z', type: 'HARDWARE' },
  ];
  assert.deepEqual(filterRows(rows, filters), [rows[2], rows[1]]);
  assert.throws(() => instant('2026-02-30T08:00:00Z', 'Start'));
  assert.throws(() => instant('2026-10-26T08:00:00', 'Start'));
  assert.throws(() => readFilters(new URLSearchParams({ from: '2026-10-26T09:00:00Z', to: '2026-10-26T08:00:00Z' })));
  assert.throws(() => readFilters(new URLSearchParams({ timezone: 'Not/AZone' })));
  assert.throws(() => readFilters(new URLSearchParams({ type: 'invented' })));
  assert.equal(filterRows([{ timestamp: rows[1].timestamp, sensorId: 'Combined' }], { ...filters, type: '', sensor: 'Combined' }).length, 1);
});

test('manual results distinguish untested values, zero delay, count mismatches and observed failures', () => {
  const valid = validateResult(trial()); assert.equal(valid.alertDelaySeconds, 0);
  assert.throws(() => validateResult(trial({ expectedCount: 1.5 })));
  assert.throws(() => validateResult(trial({ detectedCount: true })));
  assert.throws(() => validateResult(trial({ expectedAlarm: 'true' })));
  assert.throws(() => validateResult(trial({ alarmObserved: false })));
  const rows = [valid, validateResult(trial({ label: 'Missed', detectedCount: 0, alarmObserved: false, alertDelaySeconds: '', smsReceived: 'not-tested', measuredDistance: '' })), validateResult(trial({ label: 'Empty room', scenario: 'Empty area', expectedCount: 0, detectedCount: 1, expectedAlarm: false, actualDistance: '', measuredDistance: '', smsReceived: 'not-tested' }))];
  const summary = summarize(rows);
  assert.equal(summary.trials, 3); assert.equal(summary.exactCountRate, 33.3);
  assert.equal(summary.meanAbsoluteDistanceError, 0.2); assert.equal(summary.averageAlertDelay, 0);
  assert.equal(summary.distancePairs, 1); assert.equal(summary.delaySamples, 1);
  assert.equal(summary.smsTrials, 1); assert.equal(summary.missed, 1);
  assert.equal(summary.missedAlarms, 1); assert.equal(summary.falseAlarms, 1); assert.equal(summary.falseDetections, 1);
  assert.equal(summarize([]).meanAbsoluteDistanceError, null); assert.equal(summarize([]).exactCountRate, null);
});

test('PDF reports paginate retained history and long notes, escape PDF literals and describe empty ranges', () => {
  const filters = readFilters(new URLSearchParams({ timezone: 'Africa/Harare' }));
  const rows = Array.from({ length: 420 }, (_, index) => ({ timestamp: new Date(Date.UTC(2026, 9, 26, 6, 0, index)).toISOString(), type: 'GSM', event: `Event ${index} (phone) \\ checked`, status: 'SENT' }));
  const pdf = historyPdf(rows, filters, 420, 10000).toString('ascii');
  assert(pdf.startsWith('%PDF-1.4')); assert(pdf.includes('Event 419')); assert(pdf.includes('\\(phone\\) \\\\ checked'));
  assert(pdf.includes('Africa/Harare')); assert.match(pdf, /\/Count ([2-9]|\d{2,})/);
  assert(historyPdf([], filters, 0, 10000).toString().includes('No events match'));
  const long = resultsPdf([{ ...validateResult(trial({ notes: 'Long note '.repeat(149) })), id: 'fixture' }], filters).toString();
  assert(long.includes('Long note')); assert(long.includes('SMS received: yes')); assert(long.includes('Page 2'));
});

test('history exports include older retained events; test results persist, edit and enforce authentication', async t => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'radar-history-'));
  fs.mkdirSync(path.join(root, 'data'));
  const oldEvents = Array.from({ length: 420 }, (_, index) => ({ timestamp: new Date(Date.UTC(2026, 9, 26, 6, 0, index)).toISOString(), type: index % 2 ? 'GSM' : 'HARDWARE', event: `Retained event ${index}`, status: 'ONLINE' }));
  fs.writeFileSync(path.join(root, 'data', 'events.json'), JSON.stringify(oldEvents));
  const app = createApp({ root, deviceKey: 'test-only-key' });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  t.after(async () => { await new Promise(resolve => app.server.close(resolve)); fs.rmSync(root, { recursive: true, force: true }); });
  const base = 'http://127.0.0.1:' + app.server.address().port; let cookie = '';
  const request = (url, body, method = 'POST') => fetch(base + url, { method: body === undefined ? 'GET' : method, headers: { Cookie: cookie, 'Content-Type': 'application/json' }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
  for (const url of ['/api/history', '/api/history.pdf', '/api/test-results', '/api/test-results.pdf']) assert.equal((await request(url)).status, 401);
  const login = await request('/api/auth/login', { username: 'admin', password: 'ChangeMe!2026' }); cookie = login.headers.get('set-cookie').split(';')[0];
  const history = await (await request('/api/history')).json();
  assert.equal(history.total, 420); assert.equal(history.events.length, 100); assert.equal(history.limit, 10000);
  assert.equal((await (await request('/api/history?offset=400')).json()).events.length, 20);
  const params = new URLSearchParams({ from: '2026-10-26T08:00:00+02:00', to: '2026-10-26T08:00:01+02:00', timezone: 'Africa/Harare' });
  assert.equal((await (await request('/api/history?' + params)).json()).total, 2);
  const pdfResponse = await request('/api/history.pdf?' + params);
  assert.match(pdfResponse.headers.get('content-type'), /application\/pdf/); assert.match(pdfResponse.headers.get('content-disposition'), /attachment/);
  const pdf = await pdfResponse.text(); assert(pdf.includes('Retained event 0')); assert(pdf.includes('Retained event 1')); assert(!pdf.includes('Retained event 2'));
  assert.equal((await request('/api/history?from=bad')).status, 400);
  const saved = await request('/api/test-results', trial()); assert.equal(saved.status, 201); const id = (await saved.json()).result.id;
  const edited = await request('/api/test-results/' + id, trial({ label: 'Corrected distance', measuredDistance: '2.9' }), 'PATCH'); assert.equal(edited.status, 200);
  const records = await (await request('/api/test-results')).json(); assert.equal(records.results.length, 1); assert.equal(records.results[0].measuredDistance, 2.9); assert.equal(records.summary.meanAbsoluteDistanceError, 0.1);
  assert.equal(JSON.parse(fs.readFileSync(path.join(root, 'data', 'test-results.json')))[0].id, id);
  assert.equal((await (await request('/api/test-results?from=2027-01-01T00:00:00Z')).json()).summary.trials, 0);
  assert((await (await request('/api/test-results.pdf')).text()).startsWith('%PDF-1.4'));
  assert.equal((await request('/api/test-results', trial({ detectedCount: -1 }))).status, 400);
  const viewer = await request('/api/auth/login', { username: 'viewer', password: 'ChangeMe!2026' }); cookie = viewer.headers.get('set-cookie').split(';')[0];
  assert.equal((await request('/api/test-results', trial())).status, 403); assert.equal((await request('/api/test-results/' + id, trial(), 'PATCH')).status, 403);
  assert.equal((await request('/api/history.pdf')).status, 200);
});
