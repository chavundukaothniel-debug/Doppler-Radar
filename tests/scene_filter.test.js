const test=require('node:test'),assert=require('node:assert/strict');
const {createSceneFilter}=require('../scene-filter');
const target=(id,x=0,extra={})=>({targetId:id,sensorId:1,x,y:2,speed:0,rawSpeedCmS:0,moving:false,active:true,alarmQualified:false,trackingStatus:'TRACKED',displayHoldMs:1200,...extra});
const scene=(seq,targets)=>({deviceId:'bench',system:{sequence:seq,uptimeSeconds:seq},targets});
test('stationary ghosts need independent observations; ID churn preserves one display identity',()=>{
 const filter=createSceneFilter();
 assert.equal(filter(scene(1,[target('T1')]),1000).targets.length,0);
 assert.equal(filter(scene(1,[target('T1')]),1500).targets.length,0);
 const stable=filter(scene(2,[target('T2',.05)]),3000);
 assert.equal(stable.targets.length,1);assert.equal(stable.targets[0].targetId,'T1');
 assert.equal(stable.targets[0].observedTargetId,'T2');assert.equal(stable.targets[0].alarmQualified,false);
 assert.equal(stable.targets[0].displayHoldMs,10000);
 assert.equal(filter(scene(3,[]),5000).targets.length,1);
 assert.deepEqual(filter(scene(4,[target('noise',2)]),7000).targets.map(t=>t.targetId),['T1']);
});
test('distinct stationary objects stay distinct; ambiguous nearby IDs do not borrow confirmation',()=>{
 const filter=createSceneFilter();
 filter(scene(1,[target('A',-1),target('B',1)]),1000);
 const next=filter(scene(2,[target('C',-1.05),target('D',1.05)]),3000);
 assert.deepEqual(next.targets.map(t=>t.targetId),['A','B']);
 assert.deepEqual(filter(scene(3,[target('uncertain',-1,{trackingStatus:'AMBIGUOUS'})]),5000).targets.map(t=>t.targetId),['B']);
 const near=createSceneFilter();near(scene(1,[target('A',0),target('B',.1)]),1000);
 assert.equal(near(scene(2,[target('C',.05)]),3000).targets.length,0);
});
test('moving targets keep their evidence; reboot and long gaps clear confirmation',()=>{
 const filter=createSceneFilter();
 const moving=target('moving',0,{moving:true,speed:-.5,rawSpeedCmS:-50,alarmQualified:true});
 const result=filter(scene(10,[moving]),1000).targets[0];assert.equal(result.alarmQualified,true);
 assert.equal(filter(scene(11,[target('still')]),2000).targets.length,0);
 assert.equal(filter(scene(1,[target('still')]),4000).targets.length,0);
 assert.equal(filter(scene(2,[target('still')]),15000).targets.length,0);
});
const {createApp}=require('../server');
test('cloud stationary confirmation bridges upload intervals, holds explicit empty scenes and expires safely',async t=>{
 const events=[];
 const app=createApp({deviceKey:'scene-test',store:{loadUsers:()=>[],loadEvents:()=>[],saveEvents:value=>events.splice(0,events.length,...value)}});
 await new Promise(r=>app.server.listen(0,'127.0.0.1',r));t.after(()=>app.server.close());
 const realNow=Date.now,base=realNow();let offset=0;
 Date.now=()=>base+offset;t.after(()=>{Date.now=realNow;});
 const post=async(seq,targets)=>{
  const response=await fetch(`http://127.0.0.1:${app.server.address().port}/api/telemetry`,{method:'POST',headers:{'Content-Type':'application/json','X-Device-Key':'scene-test'},body:JSON.stringify({deviceId:'scene-bench',sequence:seq,uptimeSeconds:seq,sensors:[1,2].map(id=>({id,online:true,lastFrameAgeMs:0,targets:[]})),sharedTargets:targets})});
  assert.equal(response.status,202);await response.json();
 };
 await post(1,[target('T1',0,{y:2,distance:2,lastSeenAgeMs:0})]);assert.equal(app.getTelemetry().targets.length,0);
 offset=2000;
 await post(2,[target('T2',.03,{y:2,distance:2,lastSeenAgeMs:0})]);
 const visible=app.getTelemetry().targets;
 assert.equal(visible.length,1);assert.equal(visible[0].targetId,'T1');
 assert.equal(visible[0].displayState,'LAST_KNOWN');assert.equal(visible[0].alarmQualified,false);
 assert.equal(events.filter(e=>e.type==='TARGET DETECTION').length,1);
 offset=4000;assert.equal(app.getTelemetry().targets.length,1);
 await post(3,[]);assert.equal(app.getTelemetry().targets.length,1);
 offset=12000;assert.equal(app.getTelemetry().targets.length,0);
});

test('fast uploads can confirm stationary returns without treating a stationary jump as the same observation',()=>{
 const filter=createSceneFilter();
 for(let i=0;i<5;i++) assert.equal(filter(scene(i+1,[target('A')]),1000+i*100).targets.length,0);
 assert.equal(filter(scene(6,[target('A')]),1500).targets.length,1);
 assert.equal(filter(scene(7,[target('A',.8)]),3500).targets.length,0);
});

test('a held or retransmitted sensor measurement cannot confirm a stationary ghost',()=>{
 const filter=createSceneFilter();
 filter(scene(1,[target('held',0,{lastSeenAgeMs:0,lastSeenUptimeMs:100})]),1000);
 assert.equal(filter(scene(2,[target('held',0,{lastSeenAgeMs:2000,lastSeenUptimeMs:100})]),3000).targets.length,0);
 assert.equal(filter(scene(3,[target('held',0,{lastSeenAgeMs:0,lastSeenUptimeMs:100})]),4000).targets.length,0);
 assert.equal(filter(scene(4,[target('held',0,{lastSeenAgeMs:0,lastSeenUptimeMs:300})]),5000).targets.length,1);
});

test('stationary memory lasts ten seconds without refreshing old measurements',()=>{
 const f=createSceneFilter();f(scene(1,[target('A',0,{lastSeenUptimeMs:100})]),1000);
 f(scene(2,[target('A',0,{lastSeenUptimeMs:300})]),3000);
 const missing=f(scene(3,[]),11000).targets[0];
 assert.equal(missing.targetId,'A');assert.equal(missing.lastSeenAgeMs,8000);assert.equal(missing.alarmQualified,false);
 assert.equal(f(scene(4,[]),12999).targets.length,1);
 assert.equal(f(scene(5,[]),13000).targets.length,0);
});
test('sideways changes replace the held position, remain visible and never qualify alarms',()=>{
 const f=createSceneFilter();f(scene(1,[target('A')]),1000);f(scene(2,[target('A')]),3000);
 const changed=f(scene(3,[target('B',.5)]),5000).targets;
 assert.equal(changed.length,1);assert.equal(changed[0].targetId,'A');assert.equal(changed[0].x,.5);
 assert.equal(changed[0].displayDirection,'SIDEWAYS RIGHT');assert.equal(changed[0].lateralMoving,true);
 assert.equal(changed[0].alarmQualified,false);assert.equal(changed[0].lateralSpeed,.25);
 const stopped=f(scene(4,[target('B',.5)]),7000).targets[0];
 assert.equal(stopped.lateralMoving,undefined);assert.equal(stopped.displayHoldMs,10000);
});
test('changed radial movement does not leave a second stationary marker behind',()=>{
 const f=createSceneFilter();f(scene(1,[target('A')]),1000);f(scene(2,[target('A')]),3000);
 const moving=target('B',0,{y:1.4,moving:true,speed:-.5,rawSpeedCmS:-50,direction:'APPROACHING'});
 const result=f(scene(3,[moving]),5000).targets;
 assert.equal(result.length,1);assert.equal(result[0].targetId,'A');assert.equal(result[0].y,1.4);
});
