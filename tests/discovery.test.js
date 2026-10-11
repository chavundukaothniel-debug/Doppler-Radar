const test=require('node:test'),assert=require('node:assert/strict'),crypto=require('node:crypto'),dgram=require('node:dgram');
const {createApp}=require('../server');
const {discoveryReply,startDiscovery,localAddressFor}=require('../discovery');
const nonce='0123456789abcdef';
test('discovery response binds the nonce and HTTP port to the existing device key',()=>{
  const reply=JSON.parse(discoveryReply(Buffer.from(JSON.stringify({type:'DOPPLER_DISCOVER_V1',nonce})),'test-key',8080));
  assert.equal(reply.port,8080);assert.equal(reply.nonce,nonce);
  assert.equal(reply.proof,crypto.createHash('sha256').update(`test-key|${nonce}|8080|127.0.0.1`).digest('hex'));
  assert.notEqual(reply.proof,crypto.createHash('sha256').update(`wrong-key|${nonce}|8080|127.0.0.1`).digest('hex'));
  assert.equal(JSON.stringify(reply).includes('test-key'),false);
  for(const invalid of ['{}','bad',JSON.stringify({type:'DOPPLER_DISCOVER_V1',nonce:'bad'})])assert.equal(discoveryReply(Buffer.from(invalid),'test-key',8080),null);
  assert.equal(discoveryReply(Buffer.alloc(257),'test-key',8080),null);
  assert.equal(discoveryReply(Buffer.from(JSON.stringify({type:'DOPPLER_DISCOVER_V1',nonce})),'',8080),null);
});
test('select the interface on the controller subnet, not the virtual adapter',()=>{
  const interfaces={Virtual:[{family:'IPv4',address:'192.168.56.1',netmask:'255.255.255.0'}],WiFi:[{family:'IPv4',address:'192.168.1.10',netmask:'255.255.255.0'}]};
  assert.equal(localAddressFor('192.168.1.50',interfaces),'192.168.1.10');
  assert.equal(localAddressFor('10.0.0.2',interfaces),null);
});
test('UDP discovery returns the actual HTTP port and closes with the server',async()=>{
  const app=createApp({deviceKey:'test-key',store:{loadUsers:()=>[],loadEvents:()=>[],saveEvents:()=>{}}});
  await new Promise(r=>app.server.listen(0,'127.0.0.1',r));
  const discovery=startDiscovery(app.server,'test-key',{port:0}),client=dgram.createSocket('udp4');
  try{
    await new Promise(r=>discovery.once('listening',r));
    const response=new Promise((resolve,reject)=>{const timeout=setTimeout(()=>reject(Error('Discovery timeout')),2000);client.once('message',(bytes,remote)=>{clearTimeout(timeout);resolve({reply:JSON.parse(bytes),remote});});});
    client.send(Buffer.from(JSON.stringify({type:'DOPPLER_DISCOVER_V1',nonce})),discovery.address().port,'127.0.0.1');
    const {reply,remote}=await response;assert.equal(reply.port,app.server.address().port);assert.equal(remote.address,'127.0.0.1');
    assert.equal(reply.type,'DOPPLER_SERVER_V1');assert.equal(reply.nonce,nonce);
  }finally{client.close();await new Promise(r=>app.server.close(r));}
});
