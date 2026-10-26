// Small, self-contained PDF writer: exports work offline, with no browser print dialog or CDN.
const { summarize } = require('./test-results');
const ascii = value => String(value ?? '-').replace(/[\u2010-\u2015]/g, '-').replace(/\u2265/g, '>=').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').replace(/[^\x20-\x7e\n]/g, '?');
const literal = value => ascii(value).replace(/([\\()])/g, '\\$1');
function wrap(value, width) {
  const lines = [];
  for (let paragraph of ascii(value).split('\n')) {
    if (!paragraph) { lines.push(''); continue; }
    while (paragraph.length > width) {
      let at = paragraph.lastIndexOf(' ', width);
      if (at < width / 2) at = width;
      lines.push(paragraph.slice(0, at)); paragraph = paragraph.slice(at).trimStart();
    }
    lines.push(paragraph);
  }
  return lines;
}
function formatTime(value, timezone) {
  if (!value) return '-';
  return new Intl.DateTimeFormat('en-GB', { timeZone: timezone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' }).format(new Date(value));
}

function pdfDocument(title, metadata, build) {
  const width = 842, height = 595, margin = 36, bottom = 551;
  const pages = []; let commands, y;
  function text(value, x, top, size = 9, font = 'F1', color = '0.12 0.17 0.25') {
    commands.push(`BT /${font} ${size} Tf ${color} rg 1 0 0 1 ${x} ${height - top - size} Tm (${literal(value)}) Tj ET`);
  }
  function rect(x, top, w, h, color) { commands.push(`${color} rg ${x} ${height - top - h} ${w} ${h} re f`); }
  function newPage() {
    commands = []; pages.push(commands);
    text('DOPPLER RADAR SYSTEM', margin, 24, 9, 'F2', '0.13 0.35 0.65');
    text(title, margin, 42, 21, 'F2');
    y = 75;
    for (const line of metadata.flatMap(line => wrap(line, 140))) { text(line, margin, y, 8); y += 11; }
    y += 12;
  }
  function paragraph(value, bold = false) {
    for (const line of wrap(value, 135)) {
      if (y + 13 > bottom) newPage();
      text(line, margin, y, 9, bold ? 'F2' : 'F1'); y += 13;
    }
    y += 6;
  }
  function table(columns, rows) {
    const lineHeight = 12, padding = 6;
    const header = () => {
      rect(margin, y, width - 2 * margin, 23, '0.13 0.27 0.44');
      let x = margin;
      for (const column of columns) { text(column.title, x + padding, y + 6, 8, 'F2', '1 1 1'); x += column.width; }
      y += 23;
    };
    if (y + 48 > bottom) newPage(); header();
    rows.forEach((row, index) => {
      const cells = row.map((cell, i) => wrap(cell, Math.max(3, Math.floor((columns[i].width - padding * 2) / 5.1))));
      const lines = Math.max(...cells.map(cell => cell.length)); let offset = 0;
      while (offset < lines) {
        if (y + padding * 2 + lineHeight > bottom) { newPage(); header(); }
        const count = Math.min(lines - offset, Math.floor((bottom - y - padding * 2) / lineHeight));
        const rowHeight = count * lineHeight + padding * 2;
        rect(margin, y, width - 2 * margin, rowHeight, index % 2 ? '0.94 0.96 0.98' : '0.98 0.985 0.99');
        let x = margin;
        cells.forEach((cell, i) => {
          cell.slice(offset, offset + count).forEach((line, n) => text(line, x + padding, y + padding + n * lineHeight, 8.5));
          x += columns[i].width;
        });
        offset += count; y += rowHeight;
      }
    });
    y += 12;
  }
  newPage(); build({ paragraph, table });
  pages.forEach((page, i) => {
    commands = page;
    text(`Page ${i + 1} of ${pages.length}`, margin, 568, 8);
    text('Saved observations only | No simulated measurements', 480, 568, 8);
  });
  const objects = [null, '<< /Type /Catalog /Pages 2 0 R >>', '', '<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>', '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold >>'];
  const kids = [];
  for (const page of pages) {
    const pageId = objects.length, streamId = pageId + 1; kids.push(`${pageId} 0 R`);
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${width} ${height}] /Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${streamId} 0 R >>`);
    const stream = page.join('\n');
    objects.push(`<< /Length ${Buffer.byteLength(stream, 'ascii')} >>\nstream\n${stream}\nendstream`);
  }
  objects[2] = `<< /Type /Pages /Kids [${kids.join(' ')}] /Count ${pages.length} >>`;
  let result = '%PDF-1.4\n', offsets = [0];
  for (let id = 1; id < objects.length; id++) { offsets.push(Buffer.byteLength(result, 'ascii')); result += `${id} 0 obj\n${objects[id]}\nendobj\n`; }
  const xref = Buffer.byteLength(result, 'ascii');
  result += `xref\n0 ${objects.length}\n0000000000 65535 f \n` + offsets.slice(1).map(offset => `${String(offset).padStart(10, '0')} 00000 n \n`).join('');
  result += `trailer\n<< /Size ${objects.length} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(result, 'ascii');
}

function metadata(filters) {
  return [
    `Period (inclusive): ${filters.from === null ? 'First retained entry' : formatTime(filters.from, filters.timezone)} to ${filters.to === null ? 'Latest retained entry' : formatTime(filters.to, filters.timezone)}`,
    `Timezone: ${filters.timezone} | Sensor: ${filters.sensor || 'All'}${filters.type ? ' | Type: ' + filters.type : ''}`,
    `Generated: ${formatTime(Date.now(), filters.timezone)}`,
  ];
}
function historyPdf(rows, filters, retained, limit) {
  return pdfDocument('Event history', metadata(filters), ({ paragraph, table }) => {
    paragraph(`${rows.length} matching events | ${retained} retained events | Retention: latest ${limit.toLocaleString('en-GB')} events.`);
    paragraph('Events are changes in system state, not continuous measurements. Earlier discarded events cannot be recovered.');
    if (!rows.length) return paragraph('No events match this period and these filters.');
    table([{ title: 'Time', width: 110 }, { title: 'Type', width: 110 }, { title: 'Sensor', width: 50 }, { title: 'Status', width: 85 }, { title: 'Event / measurements', width: 415 }], rows.map(row => {
      const measurements = [['Distance', row.distance, 'm'], ['Speed', row.speed, 'm/s'], ['Movement', row.displacementMm == null ? null : row.displacementMm / 1000, 'm']].filter(([, value]) => Number.isFinite(value)).map(([label, value, unit]) => `${label}: ${value} ${unit}`);
      return [formatTime(row.timestamp, filters.timezone), row.type, row.sensorId || '-', row.status, row.event + (measurements.length ? '\n' + measurements.join(' | ') : '')];
    }));
  });
}
function resultsPdf(rows, filters) {
  const summary = summarize(rows);
  return pdfDocument('Test results and areas to improve', metadata(filters), ({ paragraph, table }) => {
    paragraph(`${summary.trials} saved trials | Exact people count: ${summary.exactCountRate === null ? 'Not tested' : summary.exactCountRate + '%'} | Under-counts: ${summary.missed}/${summary.positiveTrials}`, true);
    paragraph(`Empty-area returns: ${summary.falseDetections}/${summary.emptyTrials} | Missed alarms: ${summary.missedAlarms}/${summary.expectedAlarmTrials} | Unexpected alarms: ${summary.falseAlarms}/${summary.quietTrials}`);
    paragraph(`Mean absolute distance error: ${summary.meanAbsoluteDistanceError ?? 'Not measured'} m (${summary.distancePairs} pairs) | Mean alarm delay: ${summary.averageAlertDelay ?? 'Not measured'} s (${summary.delaySamples} trials) | SMS not received: ${summary.smsFailures}/${summary.smsTrials}`);
    paragraph('Based on manually entered observations. Blank measurements and untested SMS are excluded. SMS receipt must be checked on the phone. Small samples do not establish reliability.');
    summary.issues.forEach(issue => paragraph(issue));
    if (!rows.length) return;
    table([{ title: 'Scenario / sensor', width: 360 }, { title: 'Trials', width: 100 }, { title: 'Count/alarm mismatches', width: 310 }], summary.groups.map(group => [`${group.scenario} / ${group.sensorId}`, group.trials, `${group.mismatches}/${group.trials}`]));
    table([{ title: 'Time / label', width: 150 }, { title: 'Scenario / sensor', width: 120 }, { title: 'People actual/seen', width: 110 }, { title: 'Alarm expect/seen', width: 110 }, { title: 'Measurements / notes', width: 280 }], rows.map(row => [
      formatTime(row.performedAt, filters.timezone) + '\n' + row.label,
      row.scenario + '\nSensor: ' + row.sensorId + '\nDuration: ' + row.durationSeconds + ' s',
      `${row.expectedCount} / ${row.detectedCount}`,
      `${row.expectedAlarm ? 'Yes' : 'No'} / ${row.alarmObserved ? 'Yes' : 'No'}`,
      `Distance actual/seen: ${row.actualDistance ?? '-'} / ${row.measuredDistance ?? '-'} m\nAlarm delay: ${row.alertDelaySeconds ?? '-'} s\nSMS received: ${row.smsReceived}\nRecording: ${row.recordingId || '-'}\n${row.notes || ''}`,
    ]));
  });
}
module.exports = { historyPdf, resultsPdf };
