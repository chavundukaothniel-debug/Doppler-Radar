(() => {
  const $ = id => document.getElementById(id);
  const esc = value => String(value ?? '').replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#039;' }[char]));
  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const filters = { history: { from: '', to: '', type: '', sensor: '' }, results: { from: '', to: '', sensor: '' } };
  const types = ['HARDWARE', 'TARGET DETECTION', 'TARGET DIRECTION', 'MOVEMENT TRACKING', 'MOVEMENT THRESHOLD', 'GSM'];
  let activePage = '', generation = 0;
  const dateTime = value => new Date(value).toLocaleString();
  const localInput = value => {
    const date = value ? new Date(value) : new Date();
    return new Date(date.getTime() - date.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
  };
  async function api(url, options = {}) {
    const response = await fetch(url, { ...options, headers: { 'Content-Type': 'application/json' } });
    const data = await response.json();
    if (!response.ok) throw Error(data.error || 'Request failed.');
    return data;
  }
  function query(kind) {
    const values = filters[kind], params = new URLSearchParams({ timezone });
    for (const key of ['from', 'to']) {
      if (!values[key]) continue;
      const date = new Date(values[key]);
      if (!Number.isFinite(date.getTime()) || localInput(date) !== values[key]) throw Error('Choose a valid local date and time.');
      // The controls select minutes. Include the entire ending minute.
      if (key === 'to') date.setSeconds(59, 999);
      params.set(key, date.toISOString());
    }
    if (values.from && values.to && new Date(values.from) > new Date(values.to)) throw Error('Start time must be before or equal to end time.');
    if (values.sensor) params.set('sensor', values.sensor);
    if (values.type) params.set('type', values.type);
    return params;
  }
  function controls(kind) {
    const value = filters[kind];
    return `<form id="rangeForm" class="report-filters">
      <label class="field">From <input name="from" type="datetime-local" value="${esc(value.from)}"></label>
      <label class="field">To <input name="to" type="datetime-local" value="${esc(value.to)}"></label>
      <label class="field">${kind === 'history' ? 'Sensor reference' : 'Tested sensor'} <select name="sensor" class="select-control"><option value="">All</option>${['1', '2', 'Combined'].map(sensor => `<option value="${sensor}" ${value.sensor === sensor ? 'selected' : ''}>${sensor === 'Combined' ? 'Combined view' : 'Sensor ' + sensor}</option>`).join('')}</select></label>
      ${kind === 'history' ? `<label class="field">Event type <select class="select-control" name="type"><option value="">All</option>${types.map(type => `<option ${value.type === type ? 'selected' : ''}>${type}</option>`).join('')}</select></label>` : ''}
      <div class="report-actions"><button class="button secondary" type="submit">Apply / refresh</button><button class="button secondary" id="clearRange" type="button">All time</button><button class="button report-primary" id="downloadPdf" type="button">Download PDF</button></div>
    </form><p class="panel-note">Times use ${esc(timezone)}. The entire ending minute is included. Leave a boundary blank for an open range. Downloads use the filters currently entered.</p><p id="reportError" class="form-error" role="alert"></p>`;
  }
  function readControls(kind) {
    const form = $('rangeForm');
    for (const key of Object.keys(filters[kind])) filters[kind][key] = form.elements[key].value;
  }
  function bindControls(kind, load) {
    $('rangeForm').onsubmit = event => { event.preventDefault(); readControls(kind); load(); };
    $('clearRange').onclick = () => {
      for (const key of Object.keys(filters[kind])) { filters[kind][key] = ''; $('rangeForm').elements[key].value = ''; }
      load();
    };
    $('downloadPdf').onclick = async () => {
      const button = $('downloadPdf'); button.disabled = true; $('reportError').textContent = '';
      try {
        readControls(kind);
        const response = await fetch(`/api/${kind === 'history' ? 'history' : 'test-results'}.pdf?${query(kind)}`);
        if (!response.ok) { const data = await response.json(); throw Error(data.error || 'Could not download PDF.'); }
        if (!response.headers.get('content-type')?.includes('application/pdf')) throw Error('The server did not return a PDF.');
        const url = URL.createObjectURL(await response.blob()), link = document.createElement('a');
        link.href = url; link.download = `radar-${kind === 'history' ? 'history' : 'test-results'}.pdf`; document.body.append(link); link.click(); link.remove();
        setTimeout(() => URL.revokeObjectURL(url), 1000);
      } catch (error) { if ($('reportError')) $('reportError').textContent = error.message; }
      finally { button.disabled = false; }
    };
  }
  async function historyPage() {
    activePage = 'history'; const current = ++generation; let offset = 0, request = 0;
    $('content').innerHTML = `<section class="panel"><p class="eyebrow">SAVED EVENTS</p><h2>Event history</h2>${controls('history')}<div id="historyRows" aria-live="polite">Loading history…</div></section>`;
    const load = async (reset = true) => {
      if (reset) offset = 0;
      const token = ++request;
      try {
        $('reportError').textContent = '';
        const params = query('history'); params.set('offset', offset);
        const data = await api('/api/history?' + params);
        if (current !== generation || activePage !== 'history' || token !== request || !$('historyRows')) return;
        $('historyRows').innerHTML = `<p>${data.total ? `${offset + 1}–${Math.min(offset + 100, data.total)} of ${data.total}` : '0'} matching events. The PDF includes every match.</p>
          <p class="panel-note">${data.retained} events retained (limit ${data.limit.toLocaleString()}). Oldest retained: ${data.oldest ? esc(dateTime(data.oldest)) : 'none'}. Earlier discarded events cannot be recovered. Shared-scene events use the combined reference; older shared events may use Sensor 1.</p>
          ${data.events.length ? `<div class="table-scroll"><table><thead><tr><th>Time</th><th>Type / sensor</th><th>Event</th><th>Status</th></tr></thead><tbody>${data.events.map(event => `<tr><td>${esc(dateTime(event.timestamp))}</td><td>${esc(event.type)}<br>${event.sensorId ? esc(event.sensorId === 'Combined' ? 'Combined view' : 'Sensor ' + event.sensorId) : ''}</td><td>${esc(event.event)}</td><td>${esc(event.status)}</td></tr>`).join('')}</tbody></table></div>` : '<p class="empty-state">No events match the selected period and filters.</p>'}
          <div class="report-actions"><button class="button secondary" id="previousHistory" ${offset === 0 ? 'disabled' : ''}>Previous</button><button class="button secondary" id="nextHistory" ${offset + 100 >= data.total ? 'disabled' : ''}>Next</button></div>`;
        $('previousHistory').onclick = () => { offset = Math.max(0, offset - 100); load(false); };
        $('nextHistory').onclick = () => { offset += 100; load(false); };
      } catch (error) { if (current === generation && $('reportError') && token === request) { $('reportError').textContent = error.message; $('historyRows').textContent = 'History could not be loaded. Check the filters and refresh.'; } }
    };
    bindControls('history', load); await load();
  }

  function guide() {
    return `<section class="panel"><p class="eyebrow">YOUR TEST CHECKLIST</p><h2>Collect useful data</h2><details open><summary>What to test and what to enter</summary><ol class="collection-guide">
      <li>Check <b>Sensors</b>, <b>GSM</b> and <b>System Status</b>. Record mounting position, firmware, lighting/obstructions and Wi-Fi or GSM problems in Notes.</li>
      <li>Open <b>Recordings</b>, enter a clear label such as “Combined · slow approach · 3 m · repeat 1”, then select <b>Start recording</b>. After the trial, select <b>Stop recording</b> on that page, then return here.</li>
      <li>Test an <b>empty area for 60 seconds</b>, then one person <b>standing still</b>. Enter actual people as 0 or 1, people shown on screen, and whether an alarm occurred. These trials normally should not alarm.</li>
      <li>Repeat <b>slow approach, fast approach, moving away and sideways</b> at measured 1 m, 3 m and 5 m positions where possible. Use a tape measure for actual distance from the sensor, and enter the displayed distance for the same person at the same moment.</li>
      <li>For an expected alarm, move at least <b>0.80 m radially</b> toward or away from the sensor in one continuous track. Sideways movement alone should not qualify. Start timing from the beginning of that movement; enter observed delay to the buzzer/alarm and check SMS receipt on the phone. Allow the modem cooldown between trials.</li>
      <li>Test <b>multiple people, edges and obstructions</b>. Select Combined for normal dashboard counts. Use Sensor 1 or 2 only when testing that sensor separately with a known per-sensor reading. Repeat each condition at least <b>5 times</b>, using a separate result for every repeat.</li>
      <li>Save a result below, link its recording and review <b>Areas to improve</b>. Leave unmeasured values blank. Repeat weak conditions after making one change, then export the before/after periods as PDFs.</li>
    </ol><p class="panel-note">One result is one controlled trial. Enter actual observations; do not infer successful SMS delivery from the modem's SENT status. Live history records events; Recordings capture telemetry only while started.</p></details></section>`;
  }
  const select = (name, label, options, required = true) => `<label class="field">${label}<select class="select-control" name="${name}" ${required ? 'required' : ''}><option value="">Choose…</option>${options.map(([value, caption]) => `<option value="${esc(value)}">${esc(caption)}</option>`).join('')}</select></label>`;
  const number = (name, label, min, max, step = 'any', required = false) => `<label class="field">${label}<input name="${name}" type="number" min="${min}" max="${max}" step="${step}" ${required ? 'required' : ''}></label>`;
  function resultForm(scenarios, recordings) {
    return `<section class="panel"><h2 id="resultFormTitle">Enter a test result</h2><p>Count people for the selected sensor/view. Distance fields refer to one identified person at the same moment. Required fields are marked *.</p>
      <form id="trialForm"><div class="trial-fields">
        <label class="field">Test label *<input name="label" required maxlength="120" placeholder="Slow approach · 3 m · repeat 1"></label>
        <label class="field">Test date and time *<input name="performedAt" type="datetime-local" required value="${localInput()}"></label>
        ${select('scenario', 'Scenario *', scenarios.map(value => [value, value]))}
        ${select('sensorId', 'Tested sensor / view *', [['Combined', 'Combined view'], ['1', 'Sensor 1'], ['2', 'Sensor 2']])}
        ${number('durationSeconds', 'Trial duration (seconds) *', 1, 86400, 'any', true)}
        ${number('expectedCount', 'Actual people present (0–6) *', 0, 6, 1, true)}
        ${number('detectedCount', 'People shown by radar (0–6) *', 0, 6, 1, true)}
        ${select('expectedAlarm', 'Should an alarm occur? *', [['false', 'No'], ['true', 'Yes - qualifying radial movement']])}
        ${select('alarmObserved', 'Did an alarm occur? *', [['false', 'No'], ['true', 'Yes']])}
        ${number('actualDistance', 'Tape-measured distance (m)', 0.01, 50)}
        ${number('measuredDistance', 'Radar distance for same person (m)', 0.01, 50)}
        ${number('alertDelaySeconds', 'Observed alarm delay (seconds)', 0, 86400)}
        ${select('smsReceived', 'SMS received on phone? *', [['not-tested', 'Not tested'], ['yes', 'Yes'], ['no', 'No']])}
        <label class="field">Recording (optional)<select class="select-control" name="recordingId"><option value="">No recording linked</option>${recordings.map(row => `<option value="${row.id}">${esc(row.label)} · ${esc(dateTime(row.startedAt))}</option>`).join('')}</select></label>
      </div><label class="field">Notes / conditions / change tested<textarea name="notes" maxlength="1500" rows="3" placeholder="Person at left edge; fan on; alarm sounded after 2.1 s; SMS not received after 60 s."></textarea></label>
      <p class="panel-note">Distance and delay may be left blank. For SMS, use “Not tested” unless you checked the receiving phone. An alarm delay applies only when an alarm occurred. Form times use ${esc(timezone)}.</p>
      <div class="report-actions"><button class="button report-primary" type="submit">Save test result</button><button class="button secondary" id="resetTrial" type="button">New / clear form</button></div><p id="trialMessage" role="status" aria-live="polite"></p></form></section>`;
  }
  function summaryHtml(summary) {
    const value = (number, suffix = '') => number === null ? 'Not measured' : esc(number) + suffix;
    return `<section class="panel"><p class="eyebrow">BASED ON YOUR SAVED OBSERVATIONS</p><h2>Areas to improve</h2><p>${summary.trials} matching trials. Use repeated tests under the same conditions to compare changes.</p>
      <div class="summary-grid"><article class="metric-card"><span>EXACT PEOPLE COUNT</span><strong>${value(summary.exactCountRate, '%')}</strong><small>${summary.trials} trials</small></article>
      <article class="metric-card"><span>MISSED EXPECTED ALARMS</span><strong>${summary.missedAlarms} / ${summary.expectedAlarmTrials}</strong><small>Unexpected alarms: ${summary.falseAlarms} / ${summary.quietTrials}</small></article>
      <article class="metric-card"><span>MEAN DISTANCE ERROR</span><strong>${value(summary.meanAbsoluteDistanceError, ' m')}</strong><small>${summary.distancePairs} matched measurements</small></article>
      <article class="metric-card"><span>MEAN ALARM DELAY</span><strong>${value(summary.averageAlertDelay, ' s')}</strong><small>${summary.delaySamples} observed delays</small></article></div>
      <ul class="collection-guide">${summary.issues.map(issue => `<li>${esc(issue)}</li>`).join('')}</ul>
      ${summary.groups.length ? `<div class="table-scroll"><table><thead><tr><th>Scenario</th><th>Sensor / view</th><th>Trials</th><th>Count or alarm mismatches</th></tr></thead><tbody>${summary.groups.map(group => `<tr><td>${esc(group.scenario)}</td><td>${esc(group.sensorId)}</td><td>${group.trials}</td><td>${group.mismatches} / ${group.trials}</td></tr>`).join('')}</tbody></table></div>` : ''}
      <p class="panel-note">A mismatch means the observed people count or alarm differs from the expected result. A matching trial may still have distance error, delay or SMS failure. Blank measurements and untested SMS are excluded; small samples do not establish reliability.</p></section>`;
  }
  async function resultsPage(user) {
    activePage = 'results'; const current = ++generation; let editId = null, rows = [], request = 0;
    $('content').innerHTML = '<section class="panel">Loading test results…</section>';
    try {
      const [initial, recordingData] = await Promise.all([api('/api/test-results'), api('/api/recordings')]);
      if (current !== generation || activePage !== 'results') return;
      const canEdit = user.role !== 'Viewer';
      $('content').innerHTML = guide() + (canEdit ? resultForm(initial.scenarios, recordingData.recordings) : '') + `<section class="panel"><h2>Review and export test results</h2>${controls('results')}</section><div id="resultSummary"></div><section class="panel"><h2>Saved trials</h2><div id="savedTrials"></div></section>`;
      const paint = data => {
        rows = data.results;
        $('resultSummary').innerHTML = summaryHtml(data.summary);
        $('savedTrials').innerHTML = rows.length ? `<div class="table-scroll"><table><thead><tr><th>Time / label</th><th>Scenario / sensor</th><th>People actual / shown</th><th>Alarm expected / observed</th><th>SMS received</th><th>Action</th></tr></thead><tbody>${rows.map(row => `<tr><td>${esc(dateTime(row.performedAt))}<br>${esc(row.label)}</td><td>${esc(row.scenario)} / ${esc(row.sensorId)}</td><td>${row.expectedCount} / ${row.detectedCount}</td><td>${row.expectedAlarm ? 'Yes' : 'No'} / ${row.alarmObserved ? 'Yes' : 'No'}</td><td>${esc(row.smsReceived)}</td><td>${canEdit ? `<button class="inline-button" type="button" data-edit-trial="${row.id}">View / edit</button>` : esc(row.notes)}</td></tr>`).join('')}</tbody></table></div>` : '<p>No test results match these filters.</p>';
        document.querySelectorAll('[data-edit-trial]').forEach(button => button.onclick = () => {
          const row = rows.find(item => item.id === button.dataset.editTrial); editId = row.id;
          for (const [key, value] of Object.entries(row)) {
            const field = $('trialForm').elements[key];
            if (!field) continue;
            if (key === 'recordingId' && value && !Array.from(field.options).some(option => option.value === value)) field.add(new Option('Archived recording · ' + value, value));
            field.value = key === 'performedAt' ? localInput(value) : value ?? '';
          }
          $('resultFormTitle').textContent = 'Edit test result'; $('trialMessage').textContent = ''; $('trialForm').scrollIntoView({ behavior: 'smooth', block: 'start' });
        });
      };
      const load = async () => {
        const token = ++request;
        try {
          $('reportError').textContent = '';
          const data = await api('/api/test-results?' + query('results'));
          if (current === generation && token === request && $('savedTrials')) paint(data);
        } catch (error) { if (current === generation && $('reportError') && token === request) $('reportError').textContent = error.message; }
      };
      bindControls('results', load); await load();
      if (!canEdit) return;
      const form = $('trialForm'); form.elements.smsReceived.value = 'not-tested';
      $('resetTrial').onclick = () => { editId = null; form.reset(); form.elements.performedAt.value = localInput(); form.elements.smsReceived.value = 'not-tested'; $('resultFormTitle').textContent = 'Enter a test result'; $('trialMessage').textContent = ''; };
      form.onsubmit = async event => {
        event.preventDefault(); const button = form.querySelector('[type=submit]'); button.disabled = true;
        try {
          const data = Object.fromEntries(new FormData(form));
          const date = new Date(data.performedAt);
          if (!Number.isFinite(date.getTime()) || localInput(date) !== data.performedAt) throw Error('Choose a valid local test time.');
          data.performedAt = date.toISOString(); data.expectedAlarm = data.expectedAlarm === 'true'; data.alarmObserved = data.alarmObserved === 'true';
          await api('/api/test-results' + (editId ? '/' + editId : ''), { method: editId ? 'PATCH' : 'POST', body: JSON.stringify(data) });
          $('resetTrial').click(); $('trialMessage').className = 'success-copy';
          $('trialMessage').textContent = 'Test result saved. The summary below follows the selected review filters.';
          await load();
        } catch (error) { if ($('trialMessage')) { $('trialMessage').className = 'form-error'; $('trialMessage').textContent = error.message; } }
        finally { button.disabled = false; }
      };
    } catch (error) { if (current === generation) $('content').innerHTML = `<section class="panel form-error">${esc(error.message)}</section>`; }
  }
  window.RadarReports = { historyPage, resultsPage, leave: () => { activePage = ''; generation++; }, reset: () => { activePage = ''; generation++; for (const values of Object.values(filters)) for (const key of Object.keys(values)) values[key] = ''; } };
})();
