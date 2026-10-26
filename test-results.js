const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { instant } = require('./history');
const SCENARIOS = ['Empty area', 'Stationary', 'Slow approach', 'Fast approach', 'Moving away', 'Sideways', 'Multiple people', 'Obstruction / edge', 'Connection / GSM'];
const MAX_RESULTS = 10000;

function validateResult(body) {
  const text = (key, max, required = false) => {
    if (body[key] != null && typeof body[key] !== 'string') throw Error(`Invalid ${key}.`);
    const value = (body[key] || '').trim();
    if ((required && !value) || value.length > max) throw Error(`${key} must contain ${required ? '1' : '0'} to ${max} characters.`);
    return value;
  };
  const number = (key, min, max, required = false, integer = false) => {
    if (body[key] === '' || body[key] == null) { if (required) throw Error(`${key} is required.`); return null; }
    if (!['number', 'string'].includes(typeof body[key]) || (typeof body[key] === 'string' && !body[key].trim())) throw Error(`Invalid ${key}.`);
    const value = Number(body[key]);
    if (!Number.isFinite(value) || value < min || value > max || (integer && !Number.isInteger(value))) throw Error(`${key} must be ${integer ? 'a whole number ' : ''}between ${min} and ${max}.`);
    return value;
  };
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw Error('Provide a test result.');
  const performedAt = instant(body.performedAt, 'Test time');
  if (performedAt === null) throw Error('Test time is required.');
  if (!SCENARIOS.includes(body.scenario)) throw Error('Choose a test scenario.');
  if (!['1', '2', 'Combined'].includes(String(body.sensorId))) throw Error('Choose a sensor or the combined view.');
  if (typeof body.expectedAlarm !== 'boolean' || typeof body.alarmObserved !== 'boolean') throw Error('Choose expected and observed alarm results.');
  if (!['not-tested', 'yes', 'no'].includes(body.smsReceived)) throw Error('Choose an SMS result.');
  const recordingId = text('recordingId', 36);
  if (recordingId && !/^[a-f0-9-]{36}$/.test(recordingId)) throw Error('Invalid recording reference.');
  const result = {
    label: text('label', 120, true), performedAt: new Date(performedAt).toISOString(), scenario: body.scenario,
    sensorId: String(body.sensorId), durationSeconds: number('durationSeconds', 1, 86400, true),
    expectedCount: number('expectedCount', 0, 6, true, true), detectedCount: number('detectedCount', 0, 6, true, true),
    expectedAlarm: body.expectedAlarm, alarmObserved: body.alarmObserved,
    actualDistance: number('actualDistance', 0.01, 50), measuredDistance: number('measuredDistance', 0.01, 50),
    alertDelaySeconds: number('alertDelaySeconds', 0, 86400), smsReceived: body.smsReceived,
    recordingId, notes: text('notes', 1500),
  };
  if (!result.alarmObserved && result.alertDelaySeconds !== null) throw Error('Leave alarm delay blank when no alarm was observed.');
  return result;
}

function summarize(rows) {
  const positive = rows.filter(r => r.expectedCount > 0), empty = rows.filter(r => r.expectedCount === 0);
  const expectedAlarms = rows.filter(r => r.expectedAlarm), quiet = rows.filter(r => !r.expectedAlarm);
  const distancePairs = rows.filter(r => r.actualDistance !== null && r.measuredDistance !== null);
  const delays = rows.filter(r => r.expectedAlarm && r.alarmObserved && r.alertDelaySeconds !== null);
  const sms = rows.filter(r => r.expectedAlarm && r.smsReceived !== 'not-tested');
  const fraction = (a, b) => b ? Number((a * 100 / b).toFixed(1)) : null;
  const missed = positive.filter(r => r.detectedCount < r.expectedCount).length;
  const falseDetections = empty.filter(r => r.detectedCount > 0).length;
  const missedAlarms = expectedAlarms.filter(r => !r.alarmObserved).length;
  const falseAlarms = quiet.filter(r => r.alarmObserved).length;
  const smsFailures = sms.filter(r => r.smsReceived === 'no').length;
  const average = values => values.length ? Number((values.reduce((a, b) => a + b, 0) / values.length).toFixed(3)) : null;
  const issues = [];
  if (missed) issues.push(`${missed}/${positive.length} occupied trials under-counted people. Repeat slow walks, edge positions and obstructed tests; check mounting and tracking gaps.`);
  if (falseDetections) issues.push(`${falseDetections}/${empty.length} empty-area trials showed returns. Repeat with fans off and reflective objects moved to investigate reflections.`);
  if (missedAlarms) issues.push(`${missedAlarms}/${expectedAlarms.length} expected-alarm trials had no alarm. Check that radial movement exceeded 0.80 m and compare the recording with the buzzer observation.`);
  if (falseAlarms) issues.push(`${falseAlarms}/${quiet.length} trials alarmed when none was expected. Review the movement path, reflections and tracking identity.`);
  if (smsFailures) issues.push(`${smsFailures}/${sms.length} tested expected-alarm trials had no received SMS. Check the GSM page, signal, recipient and 30-second modem cooldown.`);
  if (!rows.length) issues.push('No trials saved yet. Start with an empty-area test, then standing still and walks toward and away from the sensors.');
  else if (!issues.length) issues.push('No count or alarm mismatch in these saved trials. Test more distances, speeds and positions before drawing conclusions.');
  const groups = [...new Set(rows.map(r => `${r.scenario}|${r.sensorId}`))].map(key => {
    const group = rows.filter(r => `${r.scenario}|${r.sensorId}` === key);
    const mismatches = group.filter(r => r.expectedCount !== r.detectedCount || r.expectedAlarm !== r.alarmObserved).length;
    return { scenario: group[0].scenario, sensorId: group[0].sensorId, trials: group.length, mismatches };
  }).sort((a, b) => b.mismatches / b.trials - a.mismatches / a.trials || b.trials - a.trials);
  return { trials: rows.length, positiveTrials: positive.length, emptyTrials: empty.length,
    exactCountRate: fraction(rows.filter(r => r.expectedCount === r.detectedCount).length, rows.length),
    missed, falseDetections, missedAlarms, expectedAlarmTrials: expectedAlarms.length, falseAlarms, quietTrials: quiet.length,
    meanAbsoluteDistanceError: average(distancePairs.map(r => Math.abs(r.actualDistance - r.measuredDistance))), distancePairs: distancePairs.length,
    averageAlertDelay: average(delays.map(r => r.alertDelaySeconds)), delaySamples: delays.length,
    smsFailures, smsTrials: sms.length, issues, groups };
}

function createResults(root) {
  const directory = path.join(root, 'data'); fs.mkdirSync(directory, { recursive: true });
  const file = path.join(directory, 'test-results.json');
  const load = () => {
    if (!fs.existsSync(file)) return [];
    const rows = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (!Array.isArray(rows)) throw Error('Test-results storage is invalid.');
    return rows;
  };
  return {
    list: load,
    save(body, user, id = null) {
      const validated = validateResult(body), rows = load();
      const index = id ? rows.findIndex(row => row.id === id) : -1;
      if (id && index < 0) throw Error('Test result not found.');
      if (!id && rows.length >= MAX_RESULTS) throw Error('Test-result limit reached (10,000). Back up your results before starting a new collection.');
      const result = { ...validated, id: id || crypto.randomUUID(), createdAt: id ? rows[index].createdAt : new Date().toISOString(), updatedAt: new Date().toISOString(), enteredBy: user.username };
      if (id) rows[index] = result; else rows.unshift(result);
      const temporary = file + '.tmp';
      fs.writeFileSync(temporary, JSON.stringify(rows, null, 2), { mode: 0o600 }); fs.renameSync(temporary, file);
      return result;
    },
  };
}

module.exports = { SCENARIOS, validateResult, summarize, createResults };
