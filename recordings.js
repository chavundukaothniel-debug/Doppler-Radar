const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const MAX_BYTES = 20 * 1024 * 1024, MAX_SESSIONS = 20;
function createRecorder(root) {
  const dir = path.join(root, 'data', 'recordings');
  fs.mkdirSync(dir, {recursive:true});
  let active = null, error = '';
  const file = id => { if (!/^[a-f0-9-]{36}$/.test(id)) throw Error('Invalid recording ID.'); return path.join(dir,id+'.jsonl'); };
  function list() { return fs.readdirSync(dir).filter(n=>n.endsWith('.jsonl')).map(n=>{
    const fd=fs.openSync(path.join(dir,n),'r'), b=Buffer.alloc(2048);let count;
    try {count=fs.readSync(fd,b,0,b.length,0);} finally {fs.closeSync(fd);}
    try {return {...JSON.parse(b.subarray(0,count).toString().split('\n')[0]),bytes:fs.statSync(path.join(dir,n)).size};} catch {return null;}
  }).filter(Boolean).sort((a,b)=>b.startedAt.localeCompare(a.startedAt)); }
  return {
    status:()=>({active, error, recordings:list()}),
    start(label) {
      if(active) throw Error('Stop the current recording first.');
      if(list().length>=MAX_SESSIONS) throw Error('Recording limit reached (20). Archive recordings from data/recordings first.');
      const next={id:crypto.randomUUID(),label:String(label||'Unlabelled').slice(0,120),startedAt:new Date().toISOString(),samples:0,bytes:0};error='';
      const header={...next,type:'session',schema:1,source:'Decoded UART slot snapshots and tracked telemetry; not raw RF or every UART frame'};
      fs.writeFileSync(file(next.id),JSON.stringify(header)+'\n');next.bytes=fs.statSync(file(next.id)).size;active=next;return active;
    },
    stop(){const stopped=active;active=null;return stopped;},
    append(payload,state) {
      if(!active)return;
      try {
        const measurements=(Array.isArray(payload.measurements)?payload.measurements:[]).slice(0,6).map(m=>({sensorId:Number(m.sensorId),slot:Number(m.slot),fresh:m.fresh===true,valid:m.valid===true,xMm:Number(m.xMm),yMm:Number(m.yMm),speedCmS:Number(m.speedCmS)}));
        const snapshot={connected:state.connected,lastData:state.lastData,controller:state.controller,targets:state.targets,sensors:state.sensors,system:{esp:true,sequence:state.system.sequence,uptimeSeconds:state.system.uptimeSeconds,firmware:state.system.firmware,wifiRssi:state.system.wifiRssi,alarmActive:state.system.alarmActive},gsm:{},events:[]};
        const line=JSON.stringify({type:'sample',receivedAt:state.lastData,measurements,telemetry:snapshot})+'\n';
        if(active.bytes+Buffer.byteLength(line)>MAX_BYTES){active=null;error='Recording stopped at the 20 MB limit.';return;}
        fs.appendFileSync(file(active.id),line);active.bytes+=Buffer.byteLength(line);active.samples++;
      } catch {active=null;error='Recording stopped: could not write to disk.';}
    },
    read(id){const filename=file(id);if(!fs.existsSync(filename))throw Error('Recording not found.');return fs.readFileSync(filename,'utf8');}
  };
}
module.exports={createRecorder};
