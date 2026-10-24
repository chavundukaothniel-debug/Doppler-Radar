// Display-only confirmation for fused cloud scenes. Never modifies firmware alarms
// or manufactures coordinates. Missing observations are never reinserted.
function createSceneFilter() {
  let history=[], device=null, uptime=null, lastSequence=null, lastOutput=null;
  const stationary=t=>!t.moving && Math.abs(t.rawSpeedCmS ?? t.speed*100)<5;
  const distance=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y);
  return function filter(scene, now=Date.now()) {
    const currentDevice=scene.deviceId;
    const currentUptime=scene.system.uptimeSeconds;
    if (device!==currentDevice || (uptime!==null && currentUptime<uptime)) {
      history=[];lastSequence=null;lastOutput=null;
    }
    device=currentDevice;uptime=currentUptime;
    const sequence=scene.system.sequence;
    // A retransmitted packet cannot confirm a previously unconfirmed return.
    if (sequence>0 && sequence===lastSequence && lastOutput) {
      scene.targets=lastOutput.map(t=>({...t}));return scene;
    }
    lastSequence=sequence;
    history=history.filter(h=>now-h.at<6000);
    const assigned=new Set(), output=[];
    let pending=0;
    for (const target of scene.targets) {
      const rawId=target.targetId;
      const still=stationary(target);
      let match=history.find(h=>!assigned.has(h) && h.rawId===rawId && distance(h.target,target)<(still?0.35:1.2));
      if (!match && still && target.trackingStatus!=='AMBIGUOUS') {
        const choices=history.filter(h=>!assigned.has(h) && stationary(h.target) && distance(h.target,target)<=0.35)
          .sort((a,b)=>distance(a.target,target)-distance(b.target,target));
        // Do not transfer identities when either side has an equally plausible neighbour.
        const best=choices[0];
        const competing=best && scene.targets.some(t=>t!==target && stationary(t) && distance(best.target,t)<=distance(best.target,target)+0.10);
        if (best && !competing && (!choices[1] || distance(choices[1].target,target)>distance(best.target,target)+0.10)) match=best;
      }
      if (!match) {
        match={rawId,id:rawId,target,firstAt:now,at:now,countedAt:now,lastMeasurement:null,samples:0};history.push(match);
      }
      assigned.add(match);
      const fresh=(target.lastSeenAgeMs??0)<1200 && target.trackingStatus!=='AMBIGUOUS';
      const stamp=target.lastSeenUptimeMs??null;
      if (fresh && (stamp===null || stamp!==match.lastMeasurement) && (now-match.countedAt>=400 || match.samples===0)) {
        ++match.samples;match.countedAt=now;match.lastMeasurement=stamp;
      }
      match.rawId=rawId;match.target=target;match.at=now;
      const confirmed=target.moving || (still && match.samples>=2 && now-match.firstAt>=500 && target.trackingStatus!=='AMBIGUOUS');
      if (!confirmed) {++pending;continue;}
      const held={...target,targetId:match.id,observedTargetId:rawId};
      // Bridge normal 2-second uploads, but mark all >1.2-second readings LAST_KNOWN.
      held.displayHoldMs=Math.max(held.displayHoldMs,3500);
      if (still) held.alarmQualified=false;
      output.push(held);
    }
    history=history.sort((a,b)=>b.at-a.at).slice(0,12);
    scene.pendingTargetCount=pending;
    scene.targets=output;
    lastOutput=output.map(t=>({...t}));
    return scene;
  };
}
module.exports={createSceneFilter};
