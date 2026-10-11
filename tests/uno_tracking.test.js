const assert = require('node:assert/strict');
const test = require('node:test');
const {normalizeTelemetry, telemetryState} = require('../server');

function packet(linkOnline=true, radarOnline=true) {
  return {
    deviceId:'tracking-bench', sequence:1, uptimeSeconds:10,
    sensors:[
      {id:1, mode:'linked', linkOnline, online:radarOnline, lastFrameAgeMs:25,
        frames:12, rejected:2, overflows:1, triggerActive:true, triggerCount:3, lastTriggerAgeMs:10,
        targets:[{targetId:'S1-T1',x:-1.2,y:2.2,distance:2.51,speed:-0.35,direction:'APPROACHING'}]},
      {id:2, mode:'uart', online:true, lastFrameAgeMs:25,
        targets:[{targetId:'S2-T1',x:0.3,y:1.5,speed:0.2,direction:'MOVING AWAY'}]},
    ], outputs:{alarmActive:true,alarmSource:'RADAR 1 / UNO'},
  };
}

test('linked Uno targets retain measured position and independent trigger', () => {
  const result=normalizeTelemetry(packet(),telemetryState(),new Date().toISOString());
  assert.equal(result.sensors[0].mode,'linked');
  assert.equal(result.sensors[0].online,true);
  assert.equal(result.sensors[0].linkOnline,true);
  assert.equal(result.sensors[0].targetCount,1);
  assert.equal(result.sensors[0].triggerCount,3);
  assert.equal(result.sensors[0].detectionActive,true);
  assert.equal(result.sensors[0].rejected,2);
  assert.equal(result.sensors[0].overflows,1);
  assert.equal(result.targets.length,2);
  assert.deepEqual(result.targets.map(target=>target.targetId),['S1-T1','S2-T1']);
  assert.equal(result.targets[0].x,-1.2);
  assert.equal(result.targets[0].speed,-0.35);
});

test('stale or failed Uno radar packets never plot old coordinates', () => {
  const stale=packet(false,false);
  stale.sensors[0].lastFrameAgeMs=60000;
  const result=normalizeTelemetry(stale,telemetryState(),new Date().toISOString());
  assert.equal(result.sensors[0].online,false);
  assert.equal(result.sensors[0].targetCount,0);
  assert.deepEqual(result.targets.map(target=>target.sensorId),[2]);
  assert.equal(result.sensors[0].detectionActive,true);
  const noRadar=normalizeTelemetry(packet(true,false),telemetryState(),new Date().toISOString());
  assert.equal(noRadar.sensors[0].linkOnline,true);
  assert.equal(noRadar.sensors[0].online,false);
  assert.deepEqual(noRadar.targets.map(target=>target.sensorId),[2]);
});
