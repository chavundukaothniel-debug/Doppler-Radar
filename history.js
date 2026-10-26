const EVENT_TYPES = ['HARDWARE', 'TARGET DETECTION', 'TARGET DIRECTION', 'MOVEMENT TRACKING', 'MOVEMENT THRESHOLD', 'GSM'];
const MAX_EVENTS = 10000;

// Require an explicit offset: a server's timezone must never reinterpret a browser's selection.
function instant(value, name) {
  if (!value) return null;
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/.test(value) || !Number.isFinite(Date.parse(value))) {
    throw Error(`${name} must be a valid date and time with a timezone.`);
  }
  const day = value.slice(0, 10);
  if (new Date(day + 'T00:00:00Z').toISOString().slice(0, 10) !== day || Number(value.slice(11, 13)) > 23 || Number(value.slice(14, 16)) > 59 || Number(value.slice(17, 19)) > 59) throw Error(`${name} is not a valid date and time.`);
  return Date.parse(value);
}

function readFilters(params) {
  const from = instant(params.get('from'), 'Start time'), to = instant(params.get('to'), 'End time');
  if (from !== null && to !== null && from > to) throw Error('Start time must be before or equal to end time.');
  const type = params.get('type') || '', sensor = params.get('sensor') || '';
  if (type && !EVENT_TYPES.includes(type)) throw Error('Invalid event type.');
  if (sensor && !['1', '2', 'Combined'].includes(sensor)) throw Error('Invalid sensor.');
  const timezone = params.get('timezone') || 'UTC';
  try { new Intl.DateTimeFormat('en-GB', { timeZone: timezone }).format(); } catch { throw Error('Invalid timezone.'); }
  return { from, to, type, sensor, timezone };
}

function filterRows(rows, filters, timestamp = 'timestamp') {
  return rows.filter(row => {
    const at = Date.parse(row[timestamp]);
    return Number.isFinite(at) && (filters.from === null || at >= filters.from) &&
      (filters.to === null || at <= filters.to) && (!filters.type || row.type === filters.type) &&
      (!filters.sensor || String(row.sensorId) === filters.sensor);
  }).sort((a, b) => Date.parse(b[timestamp]) - Date.parse(a[timestamp]));
}

module.exports = { EVENT_TYPES, MAX_EVENTS, instant, readFilters, filterRows };
