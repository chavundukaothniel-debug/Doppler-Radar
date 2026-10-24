const assert=require('node:assert/strict'),crypto=require('node:crypto'),path=require('node:path');
const {createApp}=require('../server');
const {chromium}=require(process.env.PLAYWRIGHT_MODULE||'playwright');
(async()=>{
  const salt=crypto.randomBytes(16),password='Browser-bench-only';
  const user={id:'bench',username:'bench',role:'Administrator',enabled:true,passwordHash:`${salt.toString('base64')}:${crypto.pbkdf2Sync(password,salt,210000,32,'sha256').toString('base64')}`};
  const app=createApp({store:{loadUsers:()=>[user],saveUsers:()=>{},loadEvents:()=>[],saveEvents:()=>{}},deviceKey:'browser-key'});
  await new Promise(r=>app.server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${app.server.address().port}`;
  let browser,interval;const errors=[];
  const payload={controller:'ESP8266 + UNO',sensors:[1,2].map(id=>({id,online:true,lastFrameAgeMs:20,targets:[1,2,3].map(n=>({targetId:`S${id}-T${n}`,x:(n-2)*0.5,y:3+n/2,distance:3+n/2,speed:id===1?-0.45:0.45,direction:id===1?'APPROACHING':'MOVING AWAY',moving:true,active:true,lastSeenAgeMs:10,filteredDistanceMm:3000+n*500,baselineDistanceMm:4000+n*500,displacementMm:id===1?-820:350,alarmQualified:id===1,notificationQueued:id===1,gsmSent:id===1&&n===1}))})),gsm:{connected:true,network:true,sms:'SENT'},outputs:{alarmActive:true,alarmSource:'RADAR 1',redLed:true,greenLed:true,buzzer:true}};
  const post=async()=>{const r=await fetch(`${base}/api/telemetry`,{method:'POST',headers:{'Content-Type':'application/json','X-Device-Key':'browser-key'},body:JSON.stringify(payload)});assert.equal(r.status,202);await r.json();};
  try{
    browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH||undefined});
    const page=await browser.newPage({viewport:{width:1440,height:1100}});page.on('pageerror',e=>errors.push(e.message));
    await page.goto(base);await page.locator('[name=username]').fill('bench');await page.locator('[name=password]').fill(password);await page.locator('#loginForm button[type=submit]').click();
    await page.getByText('ESP8266 OFFLINE',{exact:true}).waitFor();assert.equal(await page.locator('.target-marker').count(),0);
    await post();interval=setInterval(()=>post().catch(e=>errors.push(e.message)),400);
    await page.locator('.target-marker').nth(5).waitFor();assert.equal(await page.locator('.detection-card').count(),6);assert.equal(await page.locator('.range').count(),7);assert.equal(await page.locator('.coverage-zone').count(),1);assert.equal(await page.locator('html').getAttribute('data-theme'),'light');
    assert.equal(await page.locator('.trail-layer').first().getAttribute('viewBox'),'0 0 100 60');
    await page.locator('#radarMode').selectOption('measured');
    assert.equal(await page.locator('#radarMode').inputValue(),'measured');
    await page.locator('#radarMode').selectOption('stabilized');
    await page.screenshot({path:path.resolve('.build/dashboard-desktop.png'),fullPage:true});
    await page.setViewportSize({width:390,height:844});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    await page.screenshot({path:path.resolve('.build/dashboard-mobile.png'),fullPage:true});
    const first=payload.sensors[0].targets[0],original={...first};
    Object.assign(first,{moving:false,speed:0,rawSpeedCmS:0,direction:'STATIONARY',alarmQualified:false,displayHoldMs:5000,lastSeenAgeMs:1800});
    await post();await page.locator('.target-marker.last-known').waitFor();
    assert.equal(await page.locator('.target-marker').count(),6);
    await page.getByText('LAST SEEN · awaiting return',{exact:true}).first().waitFor();
    Object.assign(first,original);delete first.displayHoldMs;delete first.rawSpeedCmS;
    await post();await page.waitForFunction(()=>document.querySelectorAll('.target-marker.last-known').length===0);
    await page.locator('[data-page="Analytics"]').click();await page.getByText('Sensor activity',{exact:true}).waitFor();
    await page.locator('[data-page="Settings"]').click();await page.getByText('0.80 m',{exact:true}).waitFor();await page.locator('[data-page="Dashboard"]').click();
    clearInterval(interval);interval=null;
    await page.waitForFunction(()=>document.querySelectorAll('.target-marker').length===0,{},{timeout:5000});
    await page.waitForFunction(()=>document.getElementById('connectionStatus').textContent==='ESP8266 OFFLINE',{},{timeout:17000});
    await page.route('**/api/telemetry',route=>route.abort());
    await page.waitForFunction(()=>document.getElementById('telemetryNotice').textContent.includes('DASHBOARD RECONNECTING'),{},{timeout:5000});
    assert.equal(await page.locator('.target-marker').count(),0);
    assert.deepEqual(errors,[]);console.log('PASS: six hardware-data fixtures, white theme, rings/FOV, progress, admin views, desktop/mobile, stale cleanup and hardware offline; no browser errors');
  }finally{if(interval)clearInterval(interval);if(browser)await browser.close();await new Promise(r=>app.server.close(r));}
})().catch(e=>{console.error(e);process.exitCode=1;});

