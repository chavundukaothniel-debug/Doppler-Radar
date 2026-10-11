const test=require('node:test'),assert=require('node:assert/strict');
const {createApp,normalizeTelemetry,telemetryState}=require('../server');
const target=(id='S1-T1',extra={})=>({targetId:id,x:0,y:4.2,distance:4.2,speed:-0.45,direction:'APPROACHING',moving:true,active:true,filteredDistanceMm:4200,baselineDistanceMm:5010,displacementMm:-810,alarmQualified:true,lastSeenAgeMs:20,...extra});
test('millimetre positions and measurement identity survive dashboard normalization',()=>{
  const data=normalizeTelemetry({sensors:[{id:1,online:true,targets:[target('precise',{x:.123,y:2.456,distance:2.459,lastSeenUptimeMs:900})]}]},telemetryState(),new Date().toISOString());
  assert.equal(data.targets[0].x,.123);assert.equal(data.targets[0].y,2.456);assert.equal(data.targets[0].distance,2.459);assert.equal(data.targets[0].lastSeenUptimeMs,900);
});
test('real fields survive normalization without inventing human classification',()=>{
  const data=normalizeTelemetry({sensors:[{id:1,online:true,lastFrameAgeMs:10,targets:[target()]}]},telemetryState(),new Date().toISOString());
  assert.equal(data.targets[0].displacementMm,-810);assert.equal(data.targets[0].alarmQualified,true);
  assert.equal(data.targets[0].gsmSent,false);assert.equal('humanConfidence' in data.targets[0],false);
  const ambiguous=normalizeTelemetry({sensors:[{id:1,online:true,targets:[target('uncertain',{direction:'TRACKING',trackingStatus:'AMBIGUOUS',alarmQualified:false,rawSpeedCmS:-50})]}]},telemetryState(),new Date().toISOString());
  assert.equal(ambiguous.targets[0].direction,'TRACKING');assert.equal(ambiguous.targets[0].rawSpeedCmS,-50);
  assert.equal(ambiguous.targets[0].trackingStatus,'AMBIGUOUS');assert.equal(ambiguous.targets[0].alarmQualified,false);
});
test('stationary and stale returns disappear; below threshold cannot qualify',()=>{
  const data=normalizeTelemetry({sensors:[{id:1,online:true,lastFrameAgeMs:10,targets:[target('stationary',{moving:false,active:false,speed:0}),target('stale',{lastSeenAgeMs:1200}),target('small',{displacementMm:700})]}]},telemetryState(),new Date().toISOString());
  assert.deepEqual(data.targets.map(t=>t.targetId),['small']);assert.equal(data.targets[0].alarmQualified,false);
});
test('fresh stationary reported targets remain visible without triggering alarms',()=>{
  const data=normalizeTelemetry({sensors:[{id:1,online:true,lastFrameAgeMs:10,targets:[target('still',{moving:false,active:true,speed:0,direction:'STATIONARY',alarmQualified:true,displacementMm:900})]}]},telemetryState(),new Date().toISOString());
  assert.equal(data.targets.length,1);
  assert.equal(data.targets[0].direction,'STATIONARY');
  assert.equal(data.targets[0].moving,false);
  assert.equal(data.targets[0].alarmQualified,false);
});
test('confirmed stationary holds are bounded and do not extend motion alarms',async t=>{
  const app=createApp({deviceKey:'hold-test',store:{loadUsers:()=>[],loadEvents:()=>[],saveEvents:()=>{}}});
  await new Promise(r=>app.server.listen(0,'127.0.0.1',r));t.after(()=>app.server.close());
  const payload={sensors:[{id:1,online:true,lastFrameAgeMs:0,targets:[target('still',{speed:0,rawSpeedCmS:0,moving:false,direction:'STATIONARY',alarmQualified:false,displayHoldMs:5000,lastSeenAgeMs:1800})]}]};
  const response=await fetch(`http://127.0.0.1:${app.server.address().port}/api/telemetry`,{method:'POST',headers:{'Content-Type':'application/json','X-Device-Key':'hold-test'},body:JSON.stringify(payload)});
  assert.equal(response.status,202);await response.json();
  const now=Date.now,received=Date.parse(app.getTelemetry().lastData);
  try{
    Date.now=()=>received+100;
    assert.equal(app.getTelemetry().targets[0].displayState,'LAST_KNOWN');
    assert.equal(app.getTelemetry().targets[0].alarmQualified,false);
    Date.now=()=>received+3200;assert.equal(app.getTelemetry().targets.length,0);
  }finally{Date.now=now;}
  const moving=normalizeTelemetry({sensors:[{id:1,online:true,targets:[target('moving',{displayHoldMs:5000,lastSeenAgeMs:1800})]}]},telemetryState(),new Date().toISOString());
  assert.equal(moving.targets.length,0);
});
test('six returns coexist; stale markers clear before heartbeat expiry; offline clears GSM',async t=>{
  const app=createApp({deviceKey:'test-key',store:{loadUsers:()=>[],loadEvents:()=>[],saveEvents:()=>{}}});
  await new Promise(r=>app.server.listen(0,'127.0.0.1',r));t.after(()=>app.server.close());
  const payload={sensors:[1,2].map(id=>({id,online:true,lastFrameAgeMs:10,targets:[1,2,3].map(n=>target(`S${id}-T${n}`))})),gsm:{connected:true,network:true}};
  const response=await fetch(`http://127.0.0.1:${app.server.address().port}/api/telemetry`,{method:'POST',headers:{'Content-Type':'application/json','X-Device-Key':'test-key'},body:JSON.stringify(payload)});
  assert.equal(response.status,202);await response.json();assert.equal(app.getTelemetry().targets.length,6);
  const realNow=Date.now,received=Date.parse(app.getTelemetry().lastData);
  try{
    Date.now=()=>received+1201;
    assert.equal(app.getTelemetry().connected,true);
    assert.deepEqual(app.getTelemetry().targets,[]);
    assert.ok(app.getTelemetry().sensors.every(s=>s.online&&s.targetCount===0));
    Date.now=()=>received+2500;
    assert.ok(app.getTelemetry().sensors.every(s=>s.online));
    assert.ok(app.getTelemetry().sensors.every(s=>s.lastFrameAgeMs===2510));
    Date.now=()=>received+5000;
    assert.ok(app.getTelemetry().sensors.every(s=>!s.online));
    Date.now=()=>received+15001;
    assert.equal(app.getTelemetry().connected,false);
    assert.equal(app.getTelemetry().gsm.connected,false);
    assert.equal(app.getTelemetry().gsm.network,false);
  }finally{Date.now=realNow;}
});
