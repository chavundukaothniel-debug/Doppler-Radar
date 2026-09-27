const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const {createApp} = require('../server');
const {chromium} = require(process.env.PLAYWRIGHT_MODULE || 'playwright');

(async()=>{
  const salt=crypto.randomBytes(16), password='Browser-bench-only';
  const user={id:'bench',username:'bench',role:'Administrator',enabled:true,
    passwordHash:`${salt.toString('base64')}:${crypto.pbkdf2Sync(password,salt,210000,32,'sha256').toString('base64')}`};
  const store={loadUsers:()=>[user],saveUsers:()=>{},loadEvents:()=>[],saveEvents:()=>{}};
  const {server}=createApp({store,deviceKey:'browser-key'});
  await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
  let browser;
  try {
    const base=`http://127.0.0.1:${server.address().port}`;
    const posted=await fetch(`${base}/api/telemetry`,{method:'POST',headers:{'Content-Type':'application/json','X-Device-Key':'browser-key'},body:JSON.stringify({
      firmware:'2026-09-26.2',controller:'ESP8266 + UNO',deviceId:'browser-fixture',sequence:10,uptimeSeconds:100,
      sensors:[{id:1,mode:'trigger',online:null,triggerActive:false,triggerCount:7,lastTriggerAgeMs:500},
        {id:2,online:true,lastFrameAgeMs:10,targets:[]}],
      outputs:{alarmActive:true,alarmSource:'RADAR 1 / UNO',alarmEvents:2,redLed:false,buzzer:true,buzzerDrive:'GPIO TOGGLING',buzzerRestarts:2,buzzerPattern:'3600/4600 Hz alternating every 150 ms',greenLed:true},
      gsm:{connected:true,network:true,simReady:true,signal:23,sms:'FAILED',smsError:'CMGS result: +CMS ERROR: 500',
        call:'RINGING',callsEnabled:true,model:'WIS800C',stage:'CLCC',smscConfigured:true,callError:'ATD: TIMEOUT',callDiagnostic:'+CEER: Call barred',cleanupError:'ATH: ERROR'},
    })});
    assert.equal(posted.status,202);
    await posted.json();
    browser=await chromium.launch({headless:true,executablePath:process.env.CHROMIUM_PATH||undefined,args:['--no-sandbox']});
    const page=await browser.newPage({viewport:{width:1440,height:1000}});
    const errors=[];
    page.on('pageerror',error=>errors.push(error.message));
    await page.goto(base,{waitUntil:'domcontentloaded'});
    await page.locator('[name=username]').fill('bench');
    await page.locator('[name=password]').fill(password);
    await page.locator('#loginForm button[type=submit]').click();
    await page.getByText('ALARM ACTIVE',{exact:true}).waitFor();
    await page.getByText('RADAR 1: APPROACHING',{exact:true}).waitFor();
    await page.locator('[data-page="Targets"]').click();
    await page.getByText('RADAR 1 DETECTION',{exact:true}).waitFor();
    await page.locator('[data-page="Dashboard"]').click();
    await page.screenshot({path:'/tmp/doppler-desktop.png',fullPage:true});
    await page.locator('[data-page="GSM"]').click();
    await page.getByText('CMGS result: +CMS ERROR: 500',{exact:true}).waitFor();
    await page.getByText('WIS800C',{exact:true}).waitFor();
    await page.getByText('RINGING',{exact:true}).waitFor();
    await page.getByText('GPIO TOGGLING',{exact:true}).waitFor();
    await page.getByText('+CEER: Call barred',{exact:true}).waitFor();
    await page.getByText('ATD: TIMEOUT',{exact:true}).waitFor();
    await page.setViewportSize({width:390,height:844});
    await page.screenshot({path:'/tmp/doppler-mobile-gsm.png',fullPage:true});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    await page.locator('[data-page="Sensors"]').click();
    await page.getByText('Unknown (no heartbeat)',{exact:true}).waitFor();
    const before=await page.locator('html').getAttribute('data-theme');
    await page.locator('#themeToggle').click();
    assert.notEqual(await page.locator('html').getAttribute('data-theme'),before);
    await page.screenshot({path:'/tmp/doppler-mobile-sensors.png',fullPage:true});
    assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    const tracked=await fetch(`${base}/api/telemetry`,{method:'POST',headers:{'Content-Type':'application/json','X-Device-Key':'browser-key'},body:JSON.stringify({
      firmware:'2026-09-27.1',controller:'ESP8266 + UNO',deviceId:'browser-fixture',sequence:11,uptimeSeconds:101,
      sensors:[{id:1,mode:'linked',linkOnline:true,online:true,lastFrameAgeMs:30,frames:12,rejected:0,overflows:0,
        triggerActive:true,triggerCount:8,lastTriggerAgeMs:20,
        targets:[{targetId:'S1-T1',x:-1.2,y:2.2,distance:2.51,speed:-0.35,direction:'APPROACHING'}]},
        {id:2,mode:'uart',online:true,lastFrameAgeMs:10,targets:[]}],
      outputs:{alarmActive:true,alarmSource:'RADAR 1 / UNO',alarmEvents:3,redLed:true,buzzer:true,greenLed:true},
      gsm:{connected:true,network:true,signal:23,sms:'FAILED',call:'RINGING'},
    })});
    assert.equal(tracked.status,202);
    await page.locator('[data-page="Live Radar"]').click();
    await page.locator('.target-marker.sensor-1.approaching').waitFor();
    assert.equal(await page.locator('.radar-trigger').count(),0);
    await page.screenshot({path:'/tmp/doppler-mobile-uno-tracking.png',fullPage:true});
    const layout=await page.evaluate(()=>({width:innerWidth,scroll:document.documentElement.scrollWidth,overflow:[...document.querySelectorAll('*')].filter(element=>element.getBoundingClientRect().right>innerWidth+1).slice(0,8).map(element=>({tag:element.tagName,className:element.className,right:Math.round(element.getBoundingClientRect().right)}))}));
    assert.equal(layout.scroll<=layout.width,true,JSON.stringify(layout));
    assert.deepEqual(errors,[]);
    console.log('PASS: desktop/mobile; Uno alert; modem errors/call status; unknown sensor health; theme toggle; no JS errors/overflow');
  } finally {
    if(browser)await browser.close();
    await new Promise(resolve=>server.close(resolve));
  }
})().catch(error=>{console.error(error);process.exitCode=1;});
