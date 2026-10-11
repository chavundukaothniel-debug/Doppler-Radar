(() => {
  const POLL_MS = 200;
  const pages = [['Dashboard','Overview'],['Live Radar','Live location view'],['Recordings','Record and replay tests'],['Targets','Current target telemetry'],['Sensors','Radar health'],['Alerts','Security events'],['GSM','Cellular alert status'],['System Status','Controller health'],['Event History','Persisted events'],['Analytics','Stored engineering events'],['Settings','Commissioning policy'],['Admin','User management']];
  const permitted = { Administrator:pages.map(([name])=>name), Operator:pages.filter(([name])=>!['Admin','Analytics','Settings'].includes(name)).map(([name])=>name), Viewer:pages.filter(([name])=>!['Admin','Event History','Analytics','Settings'].includes(name)).map(([name])=>name) };
  const state = { user:null, page:'Dashboard', telemetry:emptyTelemetry(), polling:false, eventFilter:'All', apiConnected:false, trails:new Map(), positions:new Map(), radarRange:7, radarMode:'stabilized' };
  const el = id => document.getElementById(id);
  const esc = value => String(value ?? '—').replace(/[&<>"']/g, char => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#039;'}[char]));
  const n = (value,digits=2) => Number.isFinite(Number(value)) ? Number(value).toFixed(digits) : '—';
  const time = value => value ? new Date(value).toLocaleTimeString([], {hour:'2-digit',minute:'2-digit',second:'2-digit'}) : '—';
  const dateTime = value => value ? new Date(value).toLocaleString() : '—';
  const targets = () => Array.isArray(state.telemetry.targets) ? state.telemetry.targets : [];
  const sensors = () => Array.isArray(state.telemetry.sensors) ? state.telemetry.sensors : [];
  const online = () => Boolean(state.telemetry.connected && state.telemetry.system?.esp);
  const radar1Unlocated = () => false; // Unlocated trigger is diagnostic, never an active target.
  const detail = (label,value,tone='') => `<div class="detail-row"><span>${esc(label)}</span><b class="${tone}">${esc(value)}</b></div>`;
  function emptyTelemetry(){ return {connected:false,lastData:null,targets:[],sensors:[{id:1,online:false},{id:2,online:false}],gsm:{},system:{packets:0,uptime:'0s'},events:[]}; }
  async function api(url, options={}) { const response = await fetch(url,{headers:{'Content-Type':'application/json',...(options.headers||{})},...options}); const data = await response.json().catch(()=>({})); if(!response.ok) throw new Error(data.error || 'Request failed.'); return data; }
  function toast(message,type=''){const item=el('toast');item.textContent=message;item.className=`toast show ${type}`;clearTimeout(window.dopplerToast);window.dopplerToast=setTimeout(()=>item.className='toast',3500);}
  function setTheme(theme){theme='light';document.documentElement.dataset.theme=theme;localStorage.setItem('doppler-theme',theme);el('themeToggle').textContent=theme==='dark'?'Light mode':'Dark mode';}
  function renderNavigation(){const navigationKey=state.user.role+'|'+state.page;if(state.navigationKey===navigationKey)return;state.navigationKey=navigationKey;const available=permitted[state.user.role]||permitted.Viewer;el('navigation').innerHTML=pages.filter(([name])=>available.includes(name)).map(([name,caption])=>`<button class="nav-item ${state.page===name?'active':''}" type="button" data-page="${name}"><span>${esc(name)}</span><small>${esc(caption)}</small></button>`).join('');document.querySelectorAll('[data-page]').forEach(button=>button.onclick=()=>{state.page=button.dataset.page;render();});}
  function updateHeader(){
    const active=online(), status=el('connectionStatus'), notice=el('telemetryNotice');
    status.className=`status-chip ${active?'':'offline'}`;
    status.textContent=!state.apiConnected&&active?'DASHBOARD RECONNECTING':active?'ESP8266 ONLINE':'ESP8266 OFFLINE';
    el('pageTitle').textContent=state.page;
    el('pageEyebrow').textContent='DOPPLER RADAR SYSTEM';
    notice.classList.toggle('hidden',active&&state.apiConnected);
    notice.textContent=state.apiConnected?'WAITING FOR HARDWARE DATA · No recent controller telemetry.':'DASHBOARD RECONNECTING · Live targets cleared; device status is the last received report.';
  }
  function rememberPositions(){
    const now=Date.parse(state.telemetry.lastData)||Date.now();
    const ids=new Set(targets().map(t=>t.targetId));
    for(const id of state.trails.keys())if(!ids.has(id))state.trails.delete(id);
    for(const id of state.positions.keys())if(!ids.has(id))state.positions.delete(id);
    for(const t of targets()){
      const old=state.positions.get(t.targetId);
      const at=Date.parse(t.timestamp)||now;
      // Polling the same server snapshot must not repeatedly smooth a measurement.
      const sampleKey=Number.isFinite(t.lastSeenUptimeMs)?`${t.firstSeenUptimeMs}:${t.lastSeenUptimeMs}`:at;
      if(old&&old.sampleKey===sampleKey)continue;
      const dt=old?at-old.at:0;
      const step=old?Math.hypot(t.x-old.x,t.y-old.y):0;
      // A short display-only filter; cap lag to 120 mm and reset at identity gaps.
      // No prediction, persistence extension or influence on alarms/recordings.
      const reset=!old||dt<=0||dt>=1200||t.trackingStatus==='AMBIGUOUS'||old.sensorId!==t.sensorId||old.firstSeen!==t.firstSeenUptimeMs||t.lastSeenUptimeMs<old.lastSeen;
      const alpha=reset?1:Math.max(dt/(dt+180),step?1-0.12/step:0);
      state.positions.set(t.targetId,{x:reset?t.x:old.x+alpha*(t.x-old.x),y:reset?t.y:old.y+alpha*(t.y-old.y),at,sampleKey,sensorId:t.sensorId,firstSeen:t.firstSeenUptimeMs,lastSeen:t.lastSeenUptimeMs});
      if(reset)state.trails.delete(t.targetId);
      const points=state.trails.get(t.targetId)||[], last=points.at(-1);
      if(!last||last.x!==t.x||last.y!==t.y)points.push({x:t.x,y:t.y,at});
      state.trails.set(t.targetId,points.filter(p=>now-p.at<3000).slice(-32));
    }
  }

  function plotTarget(t){return state.radarMode==='stabilized'&&state.positions.has(t.targetId)?{...t,...state.positions.get(t.targetId)}:t;}
  function radarPoint(t,range=state.radarRange){return {x:50+Number(t.x)*50/range,y:55-Number(t.y)*50/range};}

  function radar(){
    const range=state.radarRange;
    const fields=[1,2].map(sensorId=>{
      const sensor=sensors().find(s=>s.id===sensorId);
      const measured=targets().filter(t=>t.sensorId===sensorId);
      const position=t=>{const p=radarPoint(t,range);return {left:p.x,top:p.y/60*100};};
      const ringCount=range===1?4:range;
      const rings=Array.from({length:ringCount},(_,i)=>{const r=(i+1)*50/ringCount;return `<path class="range" d="M ${50-r*.8660254} ${55-r*.5} A ${r} ${r} 0 0 1 ${50+r*.8660254} ${55-r*.5}"/><text class="range-label" x="51" y="${55-r+2.5}">${n((i+1)*range/ringCount,range===1?2:0)} m</text>`;}).join('');
      const axes=[-60,-45,-30,-15,0,15,30,45,60].map(a=>{const rad=a*Math.PI/180,x=50+50*Math.sin(rad),y=55-50*Math.cos(rad);return `<line class="bearing-line" x1="50" y1="55" x2="${x}" y2="${y}"/><text class="bearing-label" text-anchor="middle" x="${50+53*Math.sin(rad)}" y="${55-53*Math.cos(rad)}">${a}°</text>`;}).join('');
      const visible=measured.filter(t=>Math.hypot(Number(t.x),Number(t.y))<=range);
      const marks=visible.map(t=>{const p=position(plotTarget(t));return `<div class="target-marker sensor-${sensorId} ${t.displayState==='LAST_KNOWN'?'last-known':t.alarmQualified?'qualified':t.moving?'moving':'stationary'} ${t.trackingStatus==='AMBIGUOUS'?'ambiguous':''}" style="left:${p.left}%;top:${p.top}%" title="${esc(t.targetId+' · '+targetDirection(t)+' · measured X '+n(t.x,3)+' m / Y '+n(t.y,3)+' m')}"><span>${esc(t.targetId)}</span></div>`;}).join('');
      const trails=visible.filter(t=>t.moving).map(t=>{const points=(state.trails.get(t.targetId)||[]).filter(p=>Math.hypot(p.x,p.y)<=range).map(p=>{const q=radarPoint(p,range);return q.x+','+q.y;}).join(' ');return `<polyline points="${points}" fill="none" stroke="${t.alarmQualified?'#dc2626':'#2563eb'}" stroke-opacity=".4" stroke-width=".5"/>`;}).join('');
      const arrows=visible.map(t=>{const v=radarVector(t,range);return v?`<line class="trigger-vector" x1="${v.x1}" y1="${v.y1}" x2="${v.x2}" y2="${v.y2}" stroke="#dc2626" stroke-width="1" marker-end="url(#direction-${sensorId})"><title>${esc(t.targetId)}: ${t.direction==='APPROACHING'?'toward sensor':'away from sensor'}</title></line>`:'';}).join('');
      const readings=measured.map(t=>`<div class="radar-reading ${t.displayState==='LAST_KNOWN'?'last-known':t.alarmQualified?'qualified':t.moving?'moving':'stationary'}"><strong>${esc(t.targetId)}</strong><span>${n(t.distance)} m · ${n(Math.atan2(t.x,t.y)*180/Math.PI,1)}°</span><span>${n(Number.isFinite(t.rawSpeedCmS)?t.rawSpeedCmS/100:t.speed)} m/s radial</span><span>${esc(t.trackingStatus==='AMBIGUOUS'?'IDENTITY UNCERTAIN':targetDirection(t))}</span></div>`).join('');
      return `<div class="sensor-field"><h3>SENSOR ${String(sensorId).padStart(2,'0')} <small>${online()&&sensor?.online?'ONLINE':'OFFLINE'}</small></h3><div class="radar-grid"><svg class="trail-layer" viewBox="0 0 100 60" aria-hidden="true"><path class="coverage-zone" d="M 50 55 L 6.699 30 A 50 50 0 0 1 93.301 30 Z"/>${rings}${axes}<defs><marker id="direction-${sensorId}" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="4" markerHeight="4" orient="auto-start-reverse"><path d="M 0 0 L 10 5 L 0 10 z" fill="#dc2626"/></marker></defs>${trails}${arrows}</svg><span class="radar-origin" title="Sensor position"></span>${marks}<span class="sensor-origin-label">SENSOR · 0 m</span></div><div class="radar-readings">${readings||'<p>No fresh radar returns</p>'}</div><p>${range} m view · ${measured.length-visible.length} returns outside view</p></div>`;
    }).join('');
    const empty=!online()?'ESP8266 OFFLINE · WAITING FOR HARDWARE DATA':!targets().length?'NO CURRENT RADAR RETURNS · RADAR SCANNING':'';
    return `<div class="radar-controls"><label for="radarScale">View range</label><select id="radarScale" class="select-control">${[1,3,7].map(r=>`<option value="${r}" ${r===range?'selected':''}>${r} metres</option>`).join('')}</select><label for="radarMode">Nodes</label><select id="radarMode" class="select-control"><option value="stabilized" ${state.radarMode==='stabilized'?'selected':''}>Reduce jitter</option><option value="measured" ${state.radarMode==='measured'?'selected':''}>Measured position</option></select></div><div class="radar-legend"><span class="stationary">Stationary return</span><span class="moving">Moving return</span><span class="qualified">Red arrow: triggered movement toward / away</span></div><div class="radar-wrap">${fields}</div>${empty?`<div class="radar-caption">${empty}</div>`:''}<p class="panel-note">Forward view: −60° to +60° coverage guide. Each sensor has its own origin. Reduce jitter gently filters node positions; readings and alarms use measured data. No positions are predicted during missing readings.</p>`;
  }
  function radarVector(t,range=7){
    if(!t.alarmQualified||!t.moving||!['APPROACHING','MOVING AWAY'].includes(t.direction))return null;
    const plotted=plotTarget(t),dx=Number(plotted.x)*50/range,dy=-Number(plotted.y)*50/range,r=Math.hypot(dx,dy);
    if(!Number.isFinite(r)||r===0)return null;
    const toward=t.direction==='APPROACHING';
    const step=toward?-Math.min(8,r*.75):Math.min(8,Math.max(0,49-r));
    if(step===0)return null;
    return {x1:50+dx,y1:55+dy,x2:50+dx+dx/r*step,y2:55+dy+dy/r*step};
  }
  function targetDirection(t){
    if(t.displayState==='LAST_KNOWN'||Number(t.lastSeenAgeMs)>=1200)return 'LAST SEEN · awaiting return';
    const speed=Number.isFinite(t.rawSpeedCmS)?t.rawSpeedCmS/100:Number(t.speed);
    return !t.moving&&Math.abs(speed)>=0.05?'MOVEMENT UNCONFIRMED':t.direction;
  }
  function detectionCards(){return targets().length?targets().map(t=>{
    const movement=t.displacementMm===null?'Unreported':n(Math.abs(t.displacementMm)/1000);
    const percent=t.displacementMm===null?0:Math.min(100,Math.abs(t.displacementMm)/8);
    return `<article class="detection-card ${t.alarmQualified?'qualified':''}"><div class="panel-heading"><strong>${esc(t.targetId)}</strong><span class="state-badge ${t.alarmQualified?'alert':'tracking'}">${t.alarmQualified?'ALERT QUALIFIED':'MONITORING'}</span></div>${detail('Sensor',String(t.sensorId).padStart(2,'0'))}${detail('Distance',`${n(t.distance)} m`)}${detail('Speed (filtered)',`${n(t.speed)} m/s`)}${detail('Direction',targetDirection(t))}<p class="movement-label">MOVEMENT <b>${movement} m / 0.80 m</b></p><progress value="${percent}" max="100" aria-label="Movement toward alarm threshold"></progress>${detail('GSM',t.gsmSent?'SMS SENT ✓':t.notificationQueued?'QUEUED / see GSM status':'Not triggered')}</article>`;
  }).join(''):'<div class="empty-state"><strong>NO CURRENT RADAR RETURNS</strong><span>Waiting for radar returns</span></div>';}

  function status(label,isOnline,hint,stateLabel=null){return `<section class="status-box ${isOnline?'online':''}"><span>${esc(label)}</span><b>${stateLabel||(isOnline?'ONLINE':'WAITING')}</b><small>${esc(hint)}</small></section>`;}
  function dashboard(){
    const gsm=state.telemetry.gsm||{},system=state.telemetry.system||{};
    return `<section class="summary-grid">${status('ESP8266',online(),'Uno + NodeMCU controller') }${status('GSM',online()&&gsm.connected,gsm.network?'Network registered':'Network unavailable',online()&&gsm.connected?'ONLINE':'OFFLINE')}${sensors().map(s=>status(`SENSOR 0${s.id}`,online()&&s.online,`${s.targetCount||0} reported targets`,online()&&s.online?'ONLINE':'OFFLINE')).join('')}</section><section class="dashboard-grid"><article class="panel radar-panel"><div class="panel-heading"><div><p class="eyebrow">REAL HARDWARE TELEMETRY</p><h2>Live radar</h2></div><span class="panel-note">Up to 3 real returns per sensor</span></div>${radar()}</article><article class="panel"><div class="panel-heading"><h2>Detected targets</h2><span class="state-badge tracking">${targets().length}</span></div>${detectionCards()}</article></section><section class="status-grid">${status('WI-FI',online(),system.wifiRssi?`${system.wifiRssi} dBm`:'No recent telemetry',online()?'ONLINE':'OFFLINE')}${status('BUZZER',online(),system.buzzerDrive||'Unreported',!online()?'OFFLINE':system.buzzerOn?'ACTIVE':'READY')}${status('LED',online(),system.ledStatus||'Unreported',!online()?'OFFLINE':system.ledStatus)}${status('DASHBOARD/API',state.apiConnected,'Authenticated live data',state.apiConnected?'ONLINE':'OFFLINE')}</section>${sensorPage()}<section class="panel"><h2>Recent events</h2>${recentEvents()}</section>`;
  }
  function recentEvents(){return (state.telemetry.events||[]).slice(0,8).map(e=>`<div class="detail-row"><span>${esc(time(e.timestamp))}</span><b>${esc(e.event)}</b></div>`).join('')||'<div class="empty-state">NO HISTORICAL DATA AVAILABLE</div>';}

  function targetTable(){
    const uno=radar1Unlocated();
    if(!targets().length&&!uno)return '<div class="empty-state"><strong>No active detections</strong><span>Radar targets and Uno approach triggers will appear here in real time.</span></div>';
    const measured=targets().map(target=>`<tr><td>${esc(target.targetId)}</td><td>RADAR ${esc(target.sensorId)}</td><td>${n(target.x)} m, ${n(target.y)} m</td><td>${n(target.distance)} m</td><td>${n(target.speed)} m/s</td><td><span class="direction ${target.direction==='APPROACHING'?'approaching':''}">${esc(target.direction)}</span></td><td>${esc(time(target.timestamp))}</td></tr>`).join('');
    const trigger=uno?`<tr class="trigger-row"><td>RADAR 1 DETECTION</td><td>RADAR 1 / UNO</td><td>No fresh position</td><td>Within 3 m</td><td>Unavailable</td><td><span class="direction approaching">APPROACHING</span></td><td>${esc(time(state.telemetry.lastData))}</td></tr>`:'';
    return `<div class="table-scroll"><table><thead><tr><th>Target</th><th>Sensor</th><th>Position</th><th>Distance</th><th>Speed</th><th>Direction</th><th>Time</th></tr></thead><tbody>${trigger}${measured}</tbody></table></div>`;
  }
  function liveRadar(){return `<section class="panel radar-panel full-radar"><div class="panel-heading"><div><p class="eyebrow">LIVE COORDINATES</p><h2>Two-sensor radar field</h2></div><span class="panel-note">Radar 1 + 2 measured coordinates</span></div>${radar()}</section><section class="panel"><div class="panel-heading"><div><p class="eyebrow">LIVE DETECTIONS</p><h2>Detected targets</h2></div></div>${targetTable()}</section>`;}
  function sensorPage(){
    return `<section class="sensor-grid">${sensors().map(sensor=>{
      const trigger=sensor.mode==='trigger';
      return `<article class="panel"><div class="panel-heading"><div><p class="eyebrow">${trigger?'UNO / DIGITAL INPUT':sensor.mode==='linked'?'UNO / MEASURED DATA':'RD-03D / UART'}</p><h2>Radar sensor ${sensor.id}</h2></div><span class="state-badge ${sensor.detectionActive?'alert':''}">${trigger?(sensor.detectionActive?'APPROACHING':'TRIGGER INPUT'):(sensor.online?'ONLINE':sensor.linkOnline?'RADAR WAIT':'WAITING')}</span></div>${trigger?`${detail('Approach detection',sensor.detectionActive?'ACTIVE':'CLEAR')}${detail('Trigger pin',sensor.triggerActive?'HIGH':'LOW')}${detail('Triggers received',sensor.triggerCount||0)}${detail('Last trigger age',sensor.lastTriggerAgeMs>=0&&sensor.lastTriggerAgeMs!==null?`${n(sensor.lastTriggerAgeMs/1000,1)} s`:'NEVER')}${detail('Health','Unknown (no heartbeat)')}${detail('Approach threshold','Within 3 m')}`:`${detail('Connection',sensor.online?'Receiving frames':'No recent frame')}${detail('Range','7 m')}${detail('FOV','120° guide (−60° to +60°)')}${detail('Target',sensor.targetCount?'Detected':'None')}${detail('Last update',time(state.telemetry.lastData))}${detail('Tracked targets',sensor.targetCount||0)}${detail(sensor.mode==='linked'?'Measurement age':'Frame age',sensor.lastFrameAgeMs===null?'Unknown':`${sensor.lastFrameAgeMs} ms`)}${sensor.mode==='linked'?`${detail('Uno data link',sensor.linkOnline?'Receiving packets':'No recent packet')}${detail('Packets received',sensor.frames||0)}${detail('Rejected packets',sensor.rejected||0)}${detail('RX overflows',sensor.overflows||0)}${detail('Approach trigger',sensor.triggerActive?'HIGH':'LOW')}${detail('Triggers received',sensor.triggerCount||0)}`:''}`}</article>`;
    }).join('')}</section>`;
  }
  function events(){const list=(state.telemetry.events||[]).filter(event=>state.eventFilter==='All'||event.type===state.eventFilter);return `<section class="panel"><div class="panel-heading"><div><p class="eyebrow">PERSISTED SECURITY LOG</p><h2>Event history</h2></div><select id="eventFilter" class="select-control"><option>All</option><option>HARDWARE</option><option>TARGET DETECTION</option><option>GSM</option></select></div>${list.length?`<div class="table-scroll"><table><thead><tr><th>Time</th><th>Type</th><th>Event</th><th>Status</th></tr></thead><tbody>${list.map(event=>`<tr><td>${esc(dateTime(event.timestamp))}</td><td>${esc(event.type)}</td><td>${esc(event.event)}</td><td><span class="direction ${event.status==='ALERT'?'approaching':''}">${esc(event.status)}</span></td></tr>`).join('')}</tbody></table></div>`:'<div class="empty-state"><strong>No events recorded</strong><span>Hardware connection, approaching-target, SMS, and call events will be listed here.</span></div>'}</section>`;}
  function gsmPage(){
    const gsm=state.telemetry.gsm||{};
    return `<section class="two-column"><article class="panel"><div class="panel-heading"><div><p class="eyebrow">MODEM TELEMETRY</p><h2>GSM module</h2></div><span class="state-badge">${!online()?'STALE':gsm.connected?'CONNECTED':'WAITING'}</span></div>
      ${detail('Identity',gsm.model||'Unknown')}${detail('SIM',gsm.simReady?'READY':'WAITING')}
      ${detail('Network registration',gsm.network?'REGISTERED':'NOT REGISTERED')}
      ${detail('Signal quality',gsm.connected&&gsm.signal!==null?`CSQ ${gsm.signal}/31`:'Unknown')}
      ${detail('SMS service centre',gsm.smscConfigured?'CONFIGURED':'UNCONFIRMED')}
      ${detail('Current operation',gsm.stage||'IDLE')}
      ${detail('SMS state',gsm.sms||'NOT SENT')}${detail('Last SMS',gsm.lastSms||'NEVER')}
      ${detail('SMS error',gsm.smsError||'None',gsm.smsError?'danger':'')}
      ${detail('Call state',gsm.call||'IDLE')}${detail('Last call',gsm.lastCall||'NEVER')}
      ${detail('Call error',gsm.callError||'None',gsm.callError?'danger':'')}
      ${detail('Call diagnostic',gsm.callDiagnostic||'None')}${detail('Release error',gsm.cleanupError||'None',gsm.cleanupError?'danger':'')}
      ${detail('Modem error',gsm.statusError||'None',gsm.statusError?'danger':'')}
      </article><article class="panel"><div class="panel-heading"><div><p class="eyebrow">ALERT POLICY</p><h2>Local response</h2></div></div>
      ${detail('Both sensors','Persistent measured radial movement')}${detail('GSM threshold','800 mm from episode baseline')}
      ${detail('Buzzer',state.telemetry.system?.buzzerPattern||'UNREPORTED')}
      ${detail('GPIO14 drive',state.telemetry.system?.buzzerDrive||'UNREPORTED')}${detail('Alarm hold','5 seconds after last trigger')}
      ${detail('SMS policy','Once per continuous track; 30 s modem cooldown')}${detail('Calls',gsm.callsEnabled?'FIRST / hang-up requested at 20 s':'DISABLED')}
      </article></section>`;
  }
  function systemPage(){
    const system=state.telemetry.system||{};
    return `<section class="two-column"><article class="panel"><div class="panel-heading"><div><p class="eyebrow">CONTROLLER HEALTH</p><h2>${esc(state.telemetry.controller||'Controller')}</h2></div></div>
      ${detail('Connection',online()?'CONNECTED':'OFFLINE')}${detail('Last telemetry',dateTime(state.telemetry.lastData))}
      ${detail('Firmware',system.firmware||'Unknown')}${detail('Uptime',system.uptime||'Unknown')}${detail('Packets accepted',system.packets||0)}
      ${detail('Wi-Fi RSSI',system.wifiRssi?`${system.wifiRssi} dBm`:'Unknown')}${detail('Sequence',system.sequence||0)}
      </article><article class="panel"><div class="panel-heading"><div><p class="eyebrow">OUTPUTS</p><h2>Local security state</h2></div></div>
      ${detail('Alarm',system.alarmActive?'ACTIVE':'CLEAR')}${detail('Source',system.alarmActive?system.alarmSource:'NONE')}
      ${detail('Red LED',system.alarmActive?'FLASHING':'OFF')}${detail('Green LED',system.greenLed?'ON':'OFF')}
      ${detail('Buzzer command',system.buzzerStatus||'UNREPORTED')}${detail('GPIO14 drive',system.buzzerDrive||'UNREPORTED')}${detail('Waveform restarts',system.buzzerRestarts||0)}${detail('Uno triggers',sensors()[0]?.triggerCount||0)}
      </article></section>`;
  }
  async function adminPage(){const host=el('content');host.innerHTML='<section class="panel"><p class="eyebrow">ACCESS CONTROL</p><h2>User management</h2><p class="muted-copy">Loading authorised accounts…</p></section>';try{const data=await api('/api/users');host.innerHTML=`<section class="panel"><div class="panel-heading"><div><p class="eyebrow">ACCESS CONTROL</p><h2>User management</h2></div><button class="button secondary" id="createUser" type="button">Create user</button></div><div class="table-scroll"><table><thead><tr><th>Username</th><th>Role</th><th>Status</th><th>Last login</th><th>Actions</th></tr></thead><tbody>${data.users.map(user=>`<tr><td>${esc(user.username)}</td><td>${esc(user.role)}</td><td>${user.enabled?'ACTIVE':'DISABLED'}</td><td>${esc(dateTime(user.lastLogin))}</td><td><button class="inline-button" data-user-action="toggle" data-user-id="${user.id}">${user.enabled?'Disable':'Enable'}</button> <button class="inline-button" data-user-action="role" data-user-id="${user.id}">Role</button> <button class="inline-button" data-user-action="reset" data-user-id="${user.id}">Reset password</button></td></tr>`).join('')}</tbody></table></div></section>`;el('createUser').onclick=createUser;document.querySelectorAll('[data-user-action]').forEach(button=>button.onclick=()=>updateUser(button.dataset.userAction,button.dataset.userId));}catch(error){toast(error.message,'error');}}
  async function createUser(){const username=prompt('Username (3–32 letters, numbers, . _ or -):');if(!username)return;const password=prompt('Temporary password (12+ characters):');if(!password)return;const role=prompt('Role: Administrator, Operator, or Viewer','Viewer');if(!role)return;try{await api('/api/users',{method:'POST',body:JSON.stringify({username,password,role})});toast('User created.');adminPage();}catch(error){toast(error.message,'error');}}
  async function updateUser(action,id){let body;if(action==='role'){const role=prompt('Role: Administrator, Operator, or Viewer');if(!role)return;body={role};}if(action==='reset'){const password=prompt('New temporary password (12+ characters):');if(!password)return;body={password};}if(!confirm('Confirm this account update?'))return;try{await api(`/api/users/${id}/${action==='reset'?'reset-password':action}`,{method:'PATCH',body:JSON.stringify(body||{})});toast('User updated.');adminPage();}catch(error){toast(error.message,'error');}}
  function analyticsPage(){
    const events=state.telemetry.events||[], detections=events.filter(e=>e.type==='TARGET DETECTION');
    if(!events.length)return '<section class="panel empty-state">NO HISTORICAL DATA AVAILABLE</section>';
    const count=(name,value)=>`<div class="detail-row"><span>${name}</span><b>${value}</b></div>`;
    const bars=(heading,rows)=>`<article class="panel"><h2>${heading}</h2>${rows.map(([name,value])=>`<div class="analytics-row"><span>${name}</span><progress value="${value}" max="${Math.max(1,...rows.map(r=>r[1]))}"></progress><b>${value}</b></div>`).join('')}</article>`;
    const days=new Map();for(const e of detections){const key=new Date(e.timestamp).toLocaleDateString();days.set(key,(days.get(key)||0)+1);}
    return `<section class="two-column">${bars('Detections by day',[...days.entries()])}${bars('Sensor activity',[[ 'Sensor 01',detections.filter(e=>e.sensorId===1).length],['Sensor 02',detections.filter(e=>e.sensorId===2).length]])}${bars('Recent detection distance (m)',detections.filter(e=>Number.isFinite(e.distance)).slice(0,10).reverse().map(e=>[time(e.timestamp),e.distance]))}${bars('Recent detected speed (m/s)',detections.filter(e=>Number.isFinite(e.speed)).slice(0,10).reverse().map(e=>[time(e.timestamp),Math.abs(e.speed)]))}${bars('Movement direction',[['Approaching',detections.filter(e=>e.direction==='APPROACHING').length],['Moving away',detections.filter(e=>e.direction==='MOVING AWAY').length]])}<article class="panel"><h2>Stored measurements</h2>${count('Qualified movement events',events.filter(e=>e.type==='MOVEMENT THRESHOLD').length)}${count('Modem SMS submissions',events.filter(e=>e.type==='GSM'&&e.status==='SENT').length)}${count('Current controller uptime',state.telemetry.system?.uptime||'Unavailable')}<p class="panel-note">Based on retained real events (up to 300; API shows latest 100). Continuous distance, speed and uptime history are not recorded.</p></article></section>`;
  }

  const replay={samples:[],index:0,timer:null};
  async function recordingsPage(){
    clearInterval(replay.timer);
    const host=el('content');host.innerHTML='<section class="panel">Loading recordings…</section>';
    try{
      const data=await api('/api/recordings');if(state.page!=='Recordings')return;
      host.innerHTML=`<section class="panel"><p class="eyebrow">REAL SENSOR TESTS</p><h2>Record measurements</h2><p>Label what is actually happening. Record an empty room, standing still, then slow and fast walks toward and away from each sensor.</p><p id="recordStatus">${data.active?'RECORDING · '+esc(data.active.label)+' · '+data.active.samples+' samples':'Recording stopped'} ${esc(data.error||'')}</p>${state.user.role!=='Viewer'?'<label>Test label <input id="testLabel" maxlength="120" placeholder="Empty room / fast walk toward Sensor 02"></label> <button class="button" id="startRecording">Start recording</button> <button class="button secondary" id="stopRecording">Stop recording</button>':''}<p class="panel-note">Saves received telemetry snapshots, including empty returns. Firmware .6 adds decoded sensor slots before tracking. This is not raw RF data or a capture of every UART frame. Each recording is limited to 20 MB; up to 20 recordings are kept.</p></section><section class="panel"><p class="eyebrow">PLAYBACK ONLY · HARDWARE UNAFFECTED</p><h2>Replay a test</h2><select class="select-control" id="recordSelect"><option value="">Choose a recording</option>${data.recordings.map(r=>'<option value="'+r.id+'">'+esc(r.label)+' · '+esc(dateTime(r.startedAt))+'</option>').join('')}</select> <button class="button secondary" id="loadRecording">Load replay</button> <a id="downloadRecording" class="inline-button hidden">Download measurements</a><p id="replayInfo">No test loaded. Live monitoring continues on the other pages.</p><button class="button secondary" id="playRecording">Play / pause</button> <input type="range" id="replaySeek" min="0" max="0" value="0" aria-label="Replay sample"><div id="replayView"></div></section>`;
      if(el('startRecording'))el('startRecording').onclick=async()=>{try{await api('/api/recordings/start',{method:'POST',body:JSON.stringify({label:el('testLabel').value})});recordingsPage();}catch(e){toast(e.message,'error');}};
      if(el('stopRecording'))el('stopRecording').onclick=async()=>{try{await api('/api/recordings/stop',{method:'POST',body:'{}'});recordingsPage();}catch(e){toast(e.message,'error');}};
      el('loadRecording').onclick=async()=>{
        const id=el('recordSelect').value;if(!id)return;
        try{const response=await fetch('/api/recordings/'+id);if(!response.ok)throw Error('Could not load recording.');const lines=(await response.text()).trim().split(/\r?\n/).map(line=>JSON.parse(line));
          clearInterval(replay.timer);replay.timer=null;replay.samples=lines.filter(row=>row.type==='sample');replay.index=0;
          el('replaySeek').max=Math.max(0,replay.samples.length-1);el('replaySeek').value=0;
          const link=el('downloadRecording');link.href='/api/recordings/'+id;link.classList.remove('hidden');showReplay();
        }catch(e){toast(e.message,'error');}
      };
      el('replaySeek').oninput=e=>{clearInterval(replay.timer);replay.timer=null;replay.index=Number(e.target.value);showReplay();};
      el('playRecording').onclick=()=>{if(replay.timer){clearInterval(replay.timer);replay.timer=null;return;}if(!replay.samples.length)return;
        if(replay.index>=replay.samples.length-1)replay.index=0;
        const started=Date.now(),origin=Date.parse(replay.samples[replay.index].receivedAt);
        replay.timer=setInterval(()=>{if(state.page!=='Recordings'){clearInterval(replay.timer);replay.timer=null;return;}
          const targetTime=origin+Date.now()-started;
          while(replay.index<replay.samples.length-1&&Date.parse(replay.samples[replay.index+1].receivedAt)<=targetTime)replay.index++;
          showReplay(targetTime);if(replay.index>=replay.samples.length-1){clearInterval(replay.timer);replay.timer=null;}
        },100);
      };
    }catch(e){if(state.page==='Recordings')host.innerHTML='<section class="panel">'+esc(e.message)+'</section>';}
  }
  let recordingStatusAt=0;
  async function refreshRecordingStatus(){
    if(Date.now()-recordingStatusAt<2000)return;recordingStatusAt=Date.now();
    try{const data=await api('/api/recordings');if(state.page==='Recordings'&&el('recordStatus'))el('recordStatus').textContent=(data.active?'RECORDING · '+data.active.label+' · '+data.active.samples+' samples':'Recording stopped')+' '+(data.error||'');}catch{}
  }
  function showReplay(at){
    const row=replay.samples[replay.index];if(!row){el('replayInfo').textContent='No telemetry samples recorded.';el('replayView').innerHTML='';return;}
    const gap=at?Math.max(0,at-Date.parse(row.receivedAt)):0;
    el('replaySeek').value=replay.index;
    el('replayInfo').textContent='REPLAY · '+(replay.index+1)+' / '+replay.samples.length+' · '+dateTime(row.receivedAt)+(gap>=1200?' · DATA GAP — targets cleared':'');
    const live=state.telemetry,trails=state.trails,positions=state.positions;
    try{
      state.telemetry={...row.telemetry,targets:gap>=1200?[]:row.telemetry.targets};state.trails=new Map();state.positions=new Map();
      el('replayView').innerHTML=radar()+'<h3>Decoded sensor slots (before tracking)</h3><div class="table-scroll"><table><thead><tr><th>Sensor / slot</th><th>Fresh / valid</th><th>X / Y (mm)</th><th>Speed (cm/s)</th></tr></thead><tbody>'+row.measurements.map(m=>'<tr><td>'+m.sensorId+' / '+m.slot+'</td><td>'+m.fresh+' / '+m.valid+'</td><td>'+m.xMm+' / '+m.yMm+'</td><td>'+m.speedCmS+'</td></tr>').join('')+'</tbody></table></div><p class="panel-note">'+(row.measurements.length?'Invalid slots are diagnostics, not objects.':'Older firmware: decoded slots were not supplied.')+'</p>';
      const scale=el('radarScale');if(scale)scale.onchange=e=>{state.radarRange=Number(e.target.value);showReplay();};
      const mode=el('radarMode');if(mode)mode.onchange=e=>{state.radarMode=e.target.value;showReplay();};
    }finally{state.telemetry=live;state.trails=trails;state.positions=positions;}
  }

  function settingsPage(){return '<section class="panel"><h2>Commissioning settings</h2>'+detail('Range','7 m')+detail('Minimum radial speed','5 cm/s')+detail('Distance smoothing','EMA 0.35')+detail('Persistence','4 samples; 40 mm over 400–1000 ms')+detail('Movement threshold','800 mm')+detail('Missing return grace','5 s for confirmed stationary; 1.2 s otherwise')+detail('Modem cooldown','30 s after transaction')+'<p class="muted-copy">Policy is configured in the existing firmware. This page is read-only. Wi-Fi, recipient and device key remain in secrets.h.</p></section>';}
  function render(){if(!state.user)return;const available=permitted[state.user.role]||permitted.Viewer;if(!available.includes(state.page))state.page='Dashboard';renderNavigation();updateHeader();if(state.page==='Admin')return adminPage();if(state.page==='Recordings')return recordingsPage();const views={Dashboard:dashboard,'Live Radar':liveRadar,Targets:()=>`<section class="panel"><div class="panel-heading"><div><p class="eyebrow">LIVE TABLE</p><h2>Current targets</h2></div></div>${targetTable()}</section>`,Sensors:sensorPage,Alerts:events,GSM:gsmPage,Analytics:analyticsPage,Settings:settingsPage,'System Status':systemPage,'Event History':events};el('content').innerHTML=alarmBanner()+views[state.page]();const scale=el('radarScale');if(scale)scale.onchange=event=>{state.radarRange=Number(event.target.value);render();};const mode=el('radarMode');if(mode)mode.onchange=event=>{state.radarMode=event.target.value;render();};const filter=el('eventFilter');if(filter){filter.value=state.eventFilter;filter.onchange=event=>{state.eventFilter=event.target.value;render();};}}
  function alarmBanner(){
    const system=state.telemetry.system||{};
    if(!online()||!system.alarmActive)return '';
    return `<div class="alarm-banner" role="status"><strong>ALARM ACTIVE</strong><span>${esc(system.alarmSource)}</span><span>Movement siren active</span></div>`;
  }
  function handlePollFailure(){
    state.apiConnected=false;
    const lastData=Date.parse(state.telemetry.lastData);
    if(!Number.isFinite(lastData)||Date.now()-lastData>15000){
      state.telemetry=emptyTelemetry();
    }else{
      state.telemetry={...state.telemetry,targets:[],
        system:{...state.telemetry.system,alarmActive:false},
        sensors:sensors().map(sensor=>({...sensor,targetCount:0,triggerActive:false,detectionActive:false}))};
    }
    state.trails.clear();
    state.positions.clear();
  }
  async function poll(){if(!state.user||state.polling)return;state.polling=true;try{state.telemetry=await api('/api/telemetry',{signal:AbortSignal.timeout(4000)});state.apiConnected=true;rememberPositions();if(state.page!=='Recordings')render();else {updateHeader();refreshRecordingStatus();}}catch(error){if(/Authentication required|No active session/.test(error.message))return signOut(false);handlePollFailure();if(state.page!=='Recordings')render();else updateHeader();}finally{state.polling=false;}}
  async function signOut(send=true){if(send){try{await api('/api/auth/logout',{method:'POST'});}catch{}}clearInterval(replay.timer);state.user=null;state.telemetry=emptyTelemetry();state.positions.clear();state.trails.clear();el('app').classList.add('hidden');el('loginView').classList.remove('hidden');el('loginForm').reset();}
  async function signIn(event){event.preventDefault();const form=event.currentTarget,button=form.querySelector('button[type="submit"]');button.disabled=true;el('loginError').textContent='';try{const data=await api('/api/auth/login',{method:'POST',body:JSON.stringify({username:form.username.value,password:form.password.value})});state.user=data.user;el('accountName').textContent=state.user.username.toUpperCase();el('accountRole').textContent=state.user.role;el('loginView').classList.add('hidden');el('app').classList.remove('hidden');render();await poll();if(state.user.mustChangePassword)toast('This is an initial account. Reset its password from the administrator console before deployment.');}catch(error){el('loginError').textContent=error.message;}finally{button.disabled=false;}}
  async function restore(){try{const data=await api('/api/auth/session');state.user=data.user;el('accountName').textContent=state.user.username.toUpperCase();el('accountRole').textContent=state.user.role;el('loginView').classList.add('hidden');el('app').classList.remove('hidden');render();await poll();}catch{}}
  document.addEventListener('DOMContentLoaded',()=>{const initial='light';setTheme(initial);el('loginForm').addEventListener('submit',signIn);el('logoutButton').onclick=()=>signOut();el('themeToggle').classList.add('hidden');const tick=()=>el('clock').textContent=new Date().toLocaleString([],{dateStyle:'medium',timeStyle:'medium'});tick();setInterval(tick,1000);restore();setInterval(poll,POLL_MS);});
})();
