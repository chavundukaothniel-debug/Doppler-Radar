const test=require('node:test'),assert=require('node:assert/strict');
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
function load(){
  const context=vm.createContext({document:{addEventListener(){}},Date});
  const source=fs.readFileSync(path.join(__dirname,'../light-ui.js'),'utf8');
  vm.runInContext(source.replace(/\}\)\(\);\s*$/,'globalThis.radarTest={coverageEstimate,radarVector,radar,state,targetDirection,rememberPositions,plotTarget};})();'),context);
  return context.radarTest;
}
test('qualified direction arrows point toward or away from the sensor origin',()=>{
  const {radarVector}=load();
  const t={x:1,y:2,moving:true,alarmQualified:true,direction:'APPROACHING'};
  const toward=radarVector(t),away=radarVector({...t,direction:'MOVING AWAY'});
  const radius=(x,y)=>Math.hypot(x-50,y-55);
  assert.ok(radius(toward.x2,toward.y2)<radius(toward.x1,toward.y1));
  assert.ok(radius(away.x2,away.y2)>radius(away.x1,away.y1));
  assert.equal(radarVector({...t,moving:false}),null);
  assert.equal(radarVector({...t,alarmQualified:false}),null);
  assert.equal(radarVector({...t,direction:'TRACKING'}),null);
  assert.ok(radius(radarVector({...t,x:0,y:6.8,direction:'MOVING AWAY'}).x2,radarVector({...t,x:0,y:6.8,direction:'MOVING AWAY'}).y2)<=49);
});

test('jitter filter processes each measurement once, limits lag and clears lost identities',()=>{
  const {state,rememberPositions,plotTarget}=load();
  const t={sensorId:1,targetId:'S1-T1',x:0,y:2,timestamp:'2026-10-11T10:00:00.000Z',lastSeenUptimeMs:100,firstSeenUptimeMs:100};
  state.telemetry={lastData:t.timestamp,targets:[t]};rememberPositions();
  assert.equal(plotTarget(t).x,0);
  const jitter={...t,x:.1,timestamp:'2026-10-11T10:00:00.200Z',lastSeenUptimeMs:300};
  state.telemetry={lastData:jitter.timestamp,targets:[jitter]};rememberPositions();
  const filtered=plotTarget(jitter).x;
  assert.ok(filtered>0&&filtered<.1);
  state.telemetry.targets=[{...jitter,timestamp:'2026-10-11T10:00:00.400Z'}];rememberPositions();
  assert.equal(plotTarget(jitter).x,filtered);
  state.radarMode='measured';assert.equal(plotTarget(jitter).x,.1);state.radarMode='stabilized';
  const fast={...jitter,x:1,timestamp:'2026-10-11T10:00:00.600Z',lastSeenUptimeMs:700};
  state.telemetry.targets=[fast];rememberPositions();assert.ok(Math.abs(fast.x-plotTarget(fast).x)<=.120001);
  const ambiguous={...fast,x:1.1,trackingStatus:'AMBIGUOUS',timestamp:'2026-10-11T10:00:00.800Z',lastSeenUptimeMs:900};
  state.telemetry.targets=[ambiguous];rememberPositions();assert.equal(plotTarget(ambiguous).x,1.1);
  const rebooted={...t,x:-1,timestamp:'2026-10-11T10:00:01.000Z',firstSeenUptimeMs:50,lastSeenUptimeMs:50};
  state.telemetry.targets=[rebooted];rememberPositions();assert.equal(plotTarget(rebooted).x,-1);
  state.telemetry.targets=[];rememberPositions();assert.equal(state.positions.size,0);assert.equal(state.trails.size,0);
});

test('forward view puts a measured target above the sensor with angle guides',()=>{
  const {radar,state}=load();state.radarMode='measured';
  state.telemetry={connected:true,system:{esp:true},sensors:[{id:1,online:true}],targets:[{sensorId:1,targetId:'S1-T1',x:0,y:3.5,distance:3.5,speed:0,moving:false,direction:'STATIONARY'}]};
  assert.match(radar(),/viewBox="0 0 100 60"/);
  assert.match(radar(),/left:50%;top:50%/);
  assert.match(radar(),/-60°/);assert.match(radar(),/60°/);
});
test('nonzero speed before persistence qualifies is shown as unconfirmed movement',()=>{
  const {targetDirection}=load();
  assert.equal(targetDirection({moving:false,direction:'STATIONARY',rawSpeedCmS:50,speed:.2}),'MOVEMENT UNCONFIRMED');
  assert.equal(targetDirection({moving:false,direction:'STATIONARY',rawSpeedCmS:0,speed:.2}),'STATIONARY');
  assert.equal(targetDirection({moving:true,direction:'APPROACHING',rawSpeedCmS:-50}),'APPROACHING');
});
test('plot labels use measured distance and stationary returns have no movement trail',()=>{
  const {radar,state}=load();
  state.telemetry={connected:true,system:{esp:true},sensors:[{id:1,online:true},{id:2,online:true}],targets:[{sensorId:1,targetId:'S1-T1',x:0,y:2,distance:2,filteredDistanceMm:1500,direction:'STATIONARY',moving:false,alarmQualified:false}]};
  state.trails.set('S1-T1',[{x:0,y:1},{x:0,y:2}]);
  const html=radar();
  assert.match(html,/2\.00 m/);
  assert.doesNotMatch(html,/1\.50 m|class="sweep"|<polyline|class="trigger-vector"/);
  assert.match(html,/stationary/);
});
test('qualified tracks render red SVG arrows and zoom keeps distant returns in the reading list',()=>{
  const {radar,state}=load();
  state.telemetry={connected:true,system:{esp:true},sensors:[{id:1,online:true}],targets:[{sensorId:1,targetId:'S1-T1',x:0,y:2,distance:2,direction:'APPROACHING',moving:true,alarmQualified:true}]};
  const html=radar();
  assert.match(html,/class="trigger-vector"/);
  assert.match(html,/marker-end="url\(#direction-1\)"/);
  assert.match(html,/toward sensor/);
  state.radarRange=1;
  const zoom=radar();
  assert.doesNotMatch(zoom,/class="trigger-vector"|class="target-marker/);
  assert.match(zoom,/2\.00 m/);
  assert.match(zoom,/1 returns outside view/);
  assert.match(zoom,/0\.25 m/);
});

test('co-facing sensors use one shared field and retain objects from either sensor',()=>{
  const {radar,state,coverageEstimate}=load();
  state.telemetry={connected:true,system:{esp:true},sensors:[{id:1,online:true},{id:2,online:true}],targets:[{sensorId:2,targetId:'T2',x:0,y:2,distance:2,speed:0,direction:'STATIONARY',moving:false}]};
  const html=radar();
  assert.equal((html.match(/class="sensor-field"/g)||[]).length,1);
  assert.equal((html.match(/class="coverage-zone"/g)||[]).length,1);
  assert.match(html,/2\/2 SENSORS ONLINE/);
  assert.match(html,/T2/);
  const estimate=coverageEstimate(7);
  assert.ok(Math.abs(estimate.width-(7*Math.sqrt(3)+0.1))<1e-9);
  assert.ok(estimate.angle>120 && estimate.angle<121);
  assert.ok(Math.abs(coverageEstimate(7,0).angle-120)<1e-9);
  assert.match(html,/geometric guide/);
});
