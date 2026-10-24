// Display-only confirmation and bounded last-seen memory for fused scenes.
function createSceneFilter() {
  let history=[],device=null,uptime=null,lastSequence=null,lastOutput=null;
  const stationary=t=>!t.moving && Math.abs(t.rawSpeedCmS??t.speed*100)<5;
  const distance=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y);
  const radialDelta=(a,b)=>Math.abs(Math.hypot(a.x,a.y)-Math.hypot(b.x,b.y));
  return function filter(scene,now=Date.now()) {
    if(device!==scene.deviceId || (uptime!==null && scene.system.uptimeSeconds<uptime)) {
      history=[];lastSequence=null;lastOutput=null;
    }
    device=scene.deviceId;uptime=scene.system.uptimeSeconds;
    const sequence=scene.system.sequence;
    if(sequence>0 && sequence===lastSequence && lastOutput){scene.targets=lastOutput.map(t=>({...t}));return scene;}
    lastSequence=sequence;
    history=history.filter(h=>now-h.measuredAt<10000);
    const assigned=new Set(),output=[];let pending=0;
    for(const target of scene.targets){
      const rawId=target.targetId,still=stationary(target);
      const plausible=h=>distance(h.target,target)<=0.35 || (h.confirmed && now-h.measuredAt<4000 && distance(h.target,target)<=0.75 && radialDelta(h.target,target)<=0.15);
      let match=history.find(h=>!assigned.has(h) && h.rawId===rawId && distance(h.target,target)<1.2);
      if(!match && target.trackingStatus!=='AMBIGUOUS'){
        const choices=history.filter(h=>!assigned.has(h)&&stationary(h.target)&&(plausible(h)||(target.moving&&h.confirmed&&now-h.measuredAt<4000&&distance(h.target,target)<=1.2&&['APPROACHING','MOVING AWAY'].includes(target.direction)&&(Math.hypot(target.x,target.y)-Math.hypot(h.target.x,h.target.y))*(target.direction==='APPROACHING'?-1:1)>0.05))).sort((a,b)=>distance(a.target,target)-distance(b.target,target));
        const best=choices[0];
        const competing=best&&scene.targets.some(t=>t!==target&&stationary(t)&&distance(best.target,t)<=distance(best.target,target)+0.10);
        if(best&&!competing&&(!choices[1]||distance(choices[1].target,target)>distance(best.target,target)+0.10))match=best;
      }
      if(!match){match={rawId,id:rawId,target,firstAt:now,at:now,measuredAt:now-(target.lastSeenAgeMs??0),countedAt:now,lastMeasurement:null,samples:0,confirmed:false};history.push(match);}
      assigned.add(match);
      const fresh=(target.lastSeenAgeMs??0)<1200&&target.trackingStatus!=='AMBIGUOUS';
      const stamp=target.lastSeenUptimeMs??null;
      const independent=fresh&&(stamp===null||stamp!==match.lastMeasurement);
      const elapsed=stamp!==null&&match.lastMeasurement!==null?(stamp-match.lastMeasurement)/1000:(now-match.measuredAt)/1000;
      const dx=target.x-match.target.x;
      const sideways=independent&&match.confirmed&&!target.moving&&elapsed>0&&elapsed<=4&&Math.abs(dx)>=0.15&&radialDelta(match.target,target)<=0.15;
      if(independent&&(now-match.countedAt>=400||match.samples===0)){++match.samples;match.countedAt=now;match.lastMeasurement=stamp;}
      // Large stationary jumps require confirmation again, while measured sideways steps retain identity.
      if(still&&distance(match.target,target)>0.35&&!sideways){match.samples=independent?1:0;match.firstAt=now;match.confirmed=false;}
      if(independent)match.measuredAt=now-(target.lastSeenAgeMs??0);
      match.rawId=rawId;match.target=target;match.at=now;
      const confirmed=target.moving||sideways||(still&&match.samples>=2&&now-match.firstAt>=500&&target.trackingStatus!=='AMBIGUOUS');
      if(!confirmed){++pending;continue;}
      const held={...target,targetId:match.id,observedTargetId:rawId,lastSeenAgeMs:Math.max(target.lastSeenAgeMs??0,now-match.measuredAt)};
      held.displayHoldMs=still&&!sideways?10000:3500;
      if(still)held.alarmQualified=false;
      if(sideways){held.lateralMoving=true;held.displayDirection=dx<0?'SIDEWAYS LEFT':'SIDEWAYS RIGHT';held.lateralSpeed=Math.abs(dx)/elapsed;held.alarmQualified=false;}
      if(held.lastSeenAgeMs>=held.displayHoldMs)continue;
      match.confirmed=true;match.display=held;match.holdStationary=still&&!sideways;
      output.push(held);
    }
    // A missing return does not prove that a stationary object left. Retain its
    // measured location for 10 seconds, never refreshing its measurement clock.
    for(const h of history){
      if(assigned.has(h)||!h.confirmed||!h.holdStationary||!h.display)continue;
      const age=now-h.measuredAt;
      if(age>=10000)continue;
      const replaced=scene.targets.some(t=>t.targetId===h.rawId||distance(t,h.target)<=0.35);
      if(replaced)continue;
      output.push({...h.display,lastSeenAgeMs:age,displayHoldMs:10000,displayState:'LAST_KNOWN',moving:false,lateralMoving:false,alarmQualified:false,direction:'TRACKING'});
    }
    history=history.sort((a,b)=>b.at-a.at).slice(0,12);
    scene.pendingTargetCount=pending;scene.targets=output.slice(0,6);lastOutput=scene.targets.map(t=>({...t}));return scene;
  };
}
module.exports={createSceneFilter};
