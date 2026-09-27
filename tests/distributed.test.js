const assert = require('node:assert/strict');
const test = require('node:test');
const {createApp, normalizeTelemetry, telemetryState} = require('../server');

function payload(overrides={}) {
  return {
    firmware:'2026-09-26.2', deviceId:'nodemcu-bench', controller:'ESP8266 + UNO', sequence:5, uptimeSeconds:100,
    sensors:[{id:1,mode:'trigger',online:null,triggerActive:false,triggerCount:1,lastTriggerAgeMs:600,targets:[]},
      {id:2,mode:'uart',online:true,lastFrameAgeMs:20,targets:[]}],
    outputs:{alarmActive:true,alarmSource:'RADAR 1 / UNO',alarmEvents:1,redLed:false,greenLed:true,buzzer:true,buzzerDrive:'GPIO TOGGLING',buzzerRestarts:1,buzzerPattern:'3600/4600 Hz alternating every 150 ms'},
    gsm:{connected:true,network:true,simReady:true,signal:23,sms:'FAILED',smsError:'CMGS result: +CMS ERROR: 500',call:'DIALING',callPlacedCount:1},
    ...overrides,
  };
}

test('Uno trigger health stays unknown while recent approach drives the siren', () => {
  const t=normalizeTelemetry(payload(),telemetryState(),new Date().toISOString());
  assert.equal(t.sensors[0].online,null);
  assert.equal(t.sensors[0].mode,'trigger');
  assert.equal(t.sensors[0].triggerCount,1);
  assert.equal(t.sensors[0].detectionActive,true);
  assert.equal(t.system.alarmActive,true);
  assert.equal(t.system.buzzerStatus,'DRIVE ON');
  assert.equal(t.system.ledStatus,'ALERT');
  assert.equal(t.system.buzzerOn,true);
  assert.equal(t.gsm.smsError,'CMGS result: +CMS ERROR: 500');
  assert.equal(t.controller,'ESP8266 + UNO');
  assert.equal(t.system.firmware,'2026-09-26.2');
  assert.equal(t.system.buzzerDrive,'GPIO TOGGLING');
  assert.equal(t.system.buzzerRestarts,1);
});

test('offline UART and trigger-only channels cannot fabricate measured targets', () => {
  const t=normalizeTelemetry(payload({sensors:[
    {id:1,mode:'trigger',online:true,targets:[{x:1,y:2}]},
    {id:2,online:true,lastFrameAgeMs:60000,targets:[{x:1,y:2}]},
  ],gsm:{signal:99}}),telemetryState(),new Date().toISOString());
  assert.deepEqual(t.targets,[]);
  assert.equal(t.gsm.signal,null);
  assert.equal(t.sensors[0].lastFrameAgeMs,null);
  assert.equal(t.sensors[1].online,false);
});

test('trigger counters produce an event after the pulse ends, without logging every telemetry packet', async (t) => {
  let writes=0;
  const store={loadEvents:()=>[],saveEvents:()=>{writes++},loadUsers:()=>[]};
  const app=createApp({deviceKey:'bench-key',store});
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  t.after(()=>app.server.close());
  const url=`http://127.0.0.1:${app.server.address().port}/api/telemetry`;
  const post=async(body)=>{
    const r=await fetch(url,{method:'POST',headers:{'Content-Type':'application/json','X-Device-Key':'bench-key'},body:JSON.stringify(body)});
    assert.equal(r.status,202);
    await r.json();
  };
  await post(payload());
  let current=app.getTelemetry();
  assert.equal(current.targets.length,0);
  assert.ok(current.events.some(e=>e.event.includes('Radar 1 / Uno')));
  assert.ok(current.events.some(e=>e.event.includes('+CMS ERROR: 500')));
  assert.ok(current.events.some(e=>e.event.includes('call dial command')));
  const eventCount=current.events.length;
  await post(payload({sequence:6}));
  assert.equal(writes,1);
  assert.equal(app.getTelemetry().events.length,eventCount);
  const update=payload({sequence:7});
  update.sensors[0].triggerCount=2;
  update.gsm={...update.gsm,sms:'SENT',smsSentCount:1,smsError:'',call:'ENDED'};
  await post(update);
  current=app.getTelemetry();
  assert.equal(current.events.filter(e=>e.event.includes('Radar 1 / Uno')).length,2);
  assert.ok(current.events.some(e=>e.event.includes('Security SMS sent')));
});

test('Radar 1 detection expires after five seconds without inventing coordinates', () => {
  const recent=payload();
  recent.sensors[0].lastTriggerAgeMs=4999;
  const active=normalizeTelemetry(recent,telemetryState(),new Date().toISOString());
  assert.equal(active.sensors[0].detectionActive,true);
  assert.deepEqual(active.targets,[]);
  const expired=payload();
  expired.sensors[0].lastTriggerAgeMs=5000;
  const stale=normalizeTelemetry(expired,telemetryState(),new Date().toISOString());
  assert.equal(stale.sensors[0].detectionActive,false);
  expired.sensors[0].triggerActive=true;
  const held=normalizeTelemetry(expired,telemetryState(),new Date().toISOString());
  assert.equal(held.sensors[0].detectionActive,true);
});
