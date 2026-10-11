const test=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),os=require('os'),path=require('path');
const {createApp}=require('../server');
test('authenticated recording saves empty and measured slots, excludes secrets and never replays into live state',async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'radar-record-'));const {server,getTelemetry}=createApp({root,deviceKey:'secret-key'});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>{server.close();fs.rmSync(root,{recursive:true,force:true});});
 const url='http://127.0.0.1:'+server.address().port;let cookie='';
 const req=(p,body,headers={})=>fetch(url+p,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json',Cookie:cookie,...headers},...(body===undefined?{}:{body:JSON.stringify(body)})});
 assert.equal((await req('/api/recordings/start',{label:'empty room'})).status,401);
 const login=await req('/api/auth/login',{username:'admin',password:'ChangeMe!2026'});cookie=login.headers.get('set-cookie').split(';')[0];
 const start=await req('/api/recordings/start',{label:'empty room'});const id=(await start.json()).recording.id;
 assert.equal((await req('/api/recordings/start',{})).status,400);
 for(const valid of [false,true])assert.equal((await req('/api/telemetry',{sequence:valid?2:1,secrets:'DO-NOT-RECORD',sensors:[],measurements:[{sensorId:2,slot:0,fresh:true,valid,xMm:0,yMm:valid?1234:0,speedCmS:0}]},{'X-Device-Key':'secret-key'})).status,202);
 await req('/api/recordings/stop',{});
 const before=getTelemetry();const text=await (await req('/api/recordings/'+id)).text();const rows=text.trim().split('\n').map(JSON.parse);
 assert.equal(rows.length,3);assert.equal(rows[1].measurements[0].valid,false);assert.equal(rows[2].measurements[0].yMm,1234);
 assert(!text.includes('secret-key'));assert(!text.includes('DO-NOT-RECORD'));assert.deepEqual(getTelemetry(),before);
 assert.equal((await req('/api/recordings/00000000-0000-0000-0000-000000000000')).status,400);
});
