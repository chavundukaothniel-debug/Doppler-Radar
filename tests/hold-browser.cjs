const assert=require('node:assert/strict'),crypto=require('node:crypto');
const {createApp}=require('../server');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
(async()=>{
 const password='Fixture-only',salt=crypto.randomBytes(16);
 const user={id:'bench',username:'bench',role:'Administrator',enabled:true,passwordHash:`${salt.toString('base64')}:${crypto.pbkdf2Sync(password,salt,210000,32,'sha256').toString('base64')}`};
 const app=createApp({deviceKey:'hold-key',store:{loadUsers:()=>[user],saveUsers:()=>{},loadEvents:()=>[],saveEvents:()=>{}}});
 await new Promise(r=>app.server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${app.server.address().port}`;
 let browser;const errors=[];let sequence=0;
 const still={targetId:'T1',x:0,y:2,distance:2,speed:0,rawSpeedCmS:0,moving:false,active:true,alarmQualified:false,direction:'STATIONARY',trackingStatus:'TRACKED',lastSeenAgeMs:0};
 const post=async(targets)=>{sequence++;const r=await fetch(base+'/api/telemetry',{method:'POST',headers:{'Content-Type':'application/json','X-Device-Key':'hold-key'},body:JSON.stringify({deviceId:'hold-bench',uptimeSeconds:sequence,sequence,sensors:[1,2].map(id=>({id,online:true,lastFrameAgeMs:0,targets:[]})),sharedTargets:targets})});assert.equal(r.status,202);await r.json();};
 try{
  browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH});const page=await browser.newPage({viewport:{width:1440,height:1000}});page.on('pageerror',e=>errors.push(e.message));
  await page.goto(base);await page.locator('[name=username]').fill('bench');await page.locator('[name=password]').fill(password);await page.locator('#loginForm button').click();
  await post([still]);await page.getByText('CONFIRMING RADAR RETURNS · Waiting for repeated observations',{exact:true}).waitFor();
  await new Promise(r=>setTimeout(r,600));await post([still]);await page.locator('.target-marker.stationary').waitFor();
  await post([]);await page.locator('.target-marker.last-known').waitFor();assert.equal(await page.locator('.target-marker').count(),1);
  await post([{...still,targetId:'T2',x:.5,distance:Math.hypot(.5,2)}]);await page.getByText('SIDEWAYS RIGHT',{exact:true}).first().waitFor();
  assert.equal(await page.locator('.target-marker').count(),1);assert.equal(await page.locator('.trigger-vector').count(),0);
  await post([{...still,targetId:'T2',x:.5,y:1.7,distance:Math.hypot(.5,1.7),moving:true,direction:'APPROACHING',speed:-.3,rawSpeedCmS:-30}]);
  await page.locator('.trigger-vector').waitFor();assert.equal(await page.locator('.trigger-vector').getAttribute('stroke'),'#2563eb');
  await page.setViewportSize({width:390,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
  assert.deepEqual(errors,[]);console.log('PASS: real browser confirmation, held stationary node, sideways no arrow/alarm, blue approaching arrow before alarm, and phone layout');
 }finally{if(browser)await browser.close();await new Promise(r=>app.server.close(r));}
})().catch(e=>{console.error(e);process.exitCode=1;});
