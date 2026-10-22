// Maximum-cardinality, minimum-distance one-to-one matching for co-facing radars.
// Same-sensor detections and targets with opposite velocities remain separate.
function fuseTargets(targets) {
  const a=targets.filter(t=>t.sensorId===1), b=targets.filter(t=>t.sensorId===2);
  let best=[], bestCost=Infinity;
  function search(i,used,pairs,cost) {
    if(i===a.length) {
      if(pairs.length>best.length || (pairs.length===best.length && cost<bestCost)) {best=pairs.slice();bestCost=cost;}
      return;
    }
    search(i+1,used,pairs,cost);
    for(let j=0;j<b.length;j++) {
      if(used.has(j)) continue;
      const x=a[i], y=b[j];
      if((x.lastSeenAgeMs??0)>=1200 || (y.lastSeenAgeMs??0)>=1200) continue;
      if(x.speed*y.speed<0 && Math.abs(x.speed)>=0.05 && Math.abs(y.speed)>=0.05) continue;
      if(Math.abs(x.speed-y.speed)>0.35) continue;
      const d=Math.hypot(x.x-y.x,x.y-y.y);
      if(d>0.35) continue;
      used.add(j); pairs.push([i,j]); search(i+1,used,pairs,cost+d*d); pairs.pop(); used.delete(j);
    }
  }
  search(0,new Set(),[],0);
  const merged=new Map(best), duplicates=new Set(best.map(p=>p[1]));
  return [...a.map((t,i)=>merged.has(i)?{...t,sensorIds:[1,2],observationIds:[t.targetId,b[merged.get(i)].targetId],gsmSent:t.gsmSent||b[merged.get(i)].gsmSent}: {...t,sensorIds:[1]}),
    ...b.filter((_,j)=>!duplicates.has(j)).map(t=>({...t,sensorIds:[2]}))];
}
module.exports={fuseTargets};
