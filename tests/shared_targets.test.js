const test=require('node:test'),assert=require('node:assert/strict');
const {normalizeTelemetry,telemetryState}=require('../server');
test('shared scene replaces duplicate sensor observations and retains six stationary objects without alarms',()=>{
  const target={x:0,y:2,distance:2,speed:0,active:true,moving:false,alarmQualified:false,lastSeenAgeMs:0};
  const p={sensors:[1,2].map(id=>({id,online:true,lastFrameAgeMs:0,targets:[target]})),sharedTargets:Array.from({length:6},(_,i)=>({...target,targetId:'T'+(i+1)}))};
  const result=normalizeTelemetry(p,telemetryState(),new Date().toISOString());
  assert.equal(result.targets.length,6);
  assert.equal(new Set(result.targets.map(t=>t.targetId)).size,6);
  assert.ok(result.targets.every(t=>!t.alarmQualified));
  p.sharedTargets=[];
  assert.equal(normalizeTelemetry(p,telemetryState(),new Date().toISOString()).targets.length,0);
});
