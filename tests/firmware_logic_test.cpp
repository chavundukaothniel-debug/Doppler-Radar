#include <assert.h>
#include <iostream>
#include <string>
#include <vector>
#include "../firmware/nodemcu_master/alarm_logic.h"
#include "../firmware/nodemcu_master/gsm_controller.h"
#include "../firmware/nodemcu_master/radar_protocol.h"

std::string drain(GsmController &g, uint32_t now) {
  std::string out;
  while (g.hasTx()) { out += char(g.nextTx()); g.txSent(now); }
  return out;
}
void reply(GsmController &g, const std::string &s, uint32_t now) {
  for (char c : s) g.feed(c, now);
}
void exchange(GsmController &g, const char *cmd, const char *response, uint32_t now) {
  assert(drain(g, now) == cmd);
  reply(g, response, now);
}
void ready(GsmController &g) {
  g.begin(100);
  exchange(g, "AT\r", "\r\nOK\r\n", 100);
  exchange(g, "ATE0\r", "ATE0\r\nOK\r\n", 110);
  exchange(g, "AT+CMEE=2\r", "OK\r\n", 120);
  exchange(g, "ATI\r", "WIS800C\r\nOK\r\n", 130);
  exchange(g, "AT+CPIN?\r", "+CPIN: READY\r\nOK\r\n", 140);
  exchange(g, "AT+CREG?\r", "+CREG: 0,5\r\nOK\r\n", 150);
  exchange(g, "AT+CSQ\r", "+CSQ: 23,0\r\nOK\r\n", 160);
  exchange(g, "AT+CSCA?\r", "+CSCA: \"+10000000000\",145\r\nOK\r\n", 170);
  assert(g.connected && g.registered && g.simReady && g.smscConfigured && g.signal == 23);
}
void sendToPrompt(GsmController &g, uint32_t now) {
  g.queueAlert(1, now);
  g.tick(now);
  exchange(g, "AT+CMGF=1\r", "OK\r\n", now);
  exchange(g, "AT+CSCS=\"GSM\"\r", "OK\r\n", now);
  exchange(g, "AT+CSMP=17,167,0,0\r", "OK\r\n", now);
  assert(drain(g, now) == "AT+CMGS=\"+10000000000\"\r");
}
void submit(GsmController &g, uint32_t now) {
  sendToPrompt(g, now);
  reply(g, "\r\n> ", now);
  const std::string message = drain(g, now);
  assert(message.find("Radar 1") != std::string::npos && message.back() == 26);
}
std::vector<uint8_t> frame(int16_t x, int16_t y, int16_t speed) {
  std::vector<uint8_t> data(30, 0);
  data[0]=0xAA; data[1]=0xFF; data[2]=3; data[28]=0x55; data[29]=0xCC;
  auto put = [&](unsigned offset, int16_t n) {
    uint16_t raw = n >= 0 ? (uint16_t(n) | 0x8000) : uint16_t(-n);
    data[offset]=raw & 255; data[offset+1]=raw >> 8;
  };
  put(4,x); put(6,y); put(8,speed);
  return data;
}
void testRadar() {
  RadarProtocol r;
  const auto target=frame(-1200, 1600, -1);
  for (uint8_t b : {0x12,0xAA,0xAA}) r.push(b,0);
  for (uint8_t b : target) r.push(b,0);
  assert(r.frames==1 && r.fresh(0) && r.targets[0].approachingWithin3m());
  assert(r.targets[0].distanceSquared()==4000000);
  for (uint8_t b : frame(1800,2400,-5)) r.push(b,1);
  assert(r.targets[0].approachingWithin3m()); // exactly 3 m
  for (uint8_t b : frame(1801,2400,-5)) r.push(b,2);
  assert(!r.targets[0].approachingWithin3m());
  for (uint8_t b : frame(0,2000,5)) r.push(b,3);
  assert(!r.targets[0].approachingWithin3m());
  auto damaged=target; damaged.erase(damaged.begin()+10);
  for(uint8_t b:damaged) r.push(b,4);
  for(uint8_t b:target) r.push(b,4);
  assert(r.targets[0].speed==-1 && r.lastFrameAt==4 && r.rejected==1);
  assert(!r.fresh(1004));
  auto empty=frame(0,0,0);
  for(uint8_t b:empty) r.push(b,1005);
  assert(!r.targets[0].valid && !r.targets[1].valid);
  for(uint8_t b:frame(-32767,-32767,-1)) r.push(b,1006);
  assert(!r.targets[0].approachingWithin3m());
}
void testAlarm() {
  AlarmLogic a;
  assert(!a.active(0));
  a.trigger(1,0);
  assert(a.active(0) && a.pulse(0));
  assert(a.pulse(249) && !a.pulse(250) && a.pulse(500));
  assert(a.buzzer(0) && a.buzzer(1999) && a.buzzer(2000) && a.buzzer(2250));
  assert(a.buzzerFrequency(0)==3600 && a.buzzerFrequency(149)==3600);
  assert(a.buzzerFrequency(150)==4600 && a.buzzerFrequency(300)==3600);
  a.trigger(2,600);
  assert(a.events==1 && a.sources==3 && a.startedAt==0);
  assert(a.active(5599) && !a.active(5600));
  a.trigger(1,0xFFFFFFF0);
  assert(a.active(40) && a.pulse(40));
  assert(!a.active(6000));
}
void testDelayedSmsAndCall() {
  GsmController g("+10000000000", true);
  ready(g); g.queueAlert(1,1000); g.tick(1000);
  exchange(g,"ATD+10000000000;\r","OK\r\n",1000);
  assert(g.callPlacedCount==1 && std::string(g.call)=="DIALING");
  assert(std::string(g.sms)=="QUEUED");
  g.tick(3000);
  exchange(g,"AT+CLCC\r","+CLCC: 1,0,3,0,0\r\nOK\r\n",3000);
  assert(std::string(g.call)=="RINGING");
  g.tick(5000);
  exchange(g,"AT+CLCC\r","+CLCC: 1,0,0,0,0\r\nOK\r\n",5000);
  assert(std::string(g.call)=="ACTIVE");
  g.tick(21000); exchange(g,"ATH\r","OK\r\n",21000);
  assert(std::string(g.call)=="ENDED");
  g.tick(22999); assert(!g.hasTx());
  g.tick(23000);
  exchange(g,"AT+CMGF=1\r","OK\r\n",23000);
  exchange(g,"AT+CSCS=\"GSM\"\r","OK\r\n",23000);
  exchange(g,"AT+CSMP=17,167,0,0\r","OK\r\n",23000);
  assert(drain(g,23000)=="AT+CMGS=\"+10000000000\"\r");
  reply(g,"\r\n> ",23000);
  const auto body=drain(g,23000);
  assert(body.find("Radar 1")!=std::string::npos && body.back()==26);
  AlarmLogic a; a.trigger(1,23000);
  for(uint32_t n=23000;n<83000;n+=250) {
    g.tick(n); a.trigger(1,n);
    assert(a.pulse(n)==(((n-23000)/250)%2==0));
    assert(a.buzzer(n));
    assert(a.buzzerFrequency(n)==(((n-23000)/150)%2?4600:3600));
  }
  assert(std::string(g.sms)=="SENDING");
  reply(g,"+CMGS: 42\r\nOK\r\n",83000);
  assert(std::string(g.sms)=="SENT" && g.smsSentCount==1);
}
void testSmsFailuresAndCooldown() {
  GsmController g("+10000000000",false);
  ready(g); submit(g,1000);
  reply(g,"+CMS ERROR: PS busy\r\n",1100);
  assert(std::string(g.sms)=="FAILED" && std::string(g.smsError).find("PS busy")!=std::string::npos);
  assert(!g.hasTx()); // A final CMS error already exits SMS entry mode.
  g.queueAlert(1,20000); g.tick(20000); assert(!g.hasTx());
  g.tick(31099); assert(!g.hasTx());
  g.tick(31100); assert(drain(g,31100)=="AT+CMGF=1\r");
  GsmController falseOK("+10000000000",false);
  ready(falseOK); submit(falseOK,1000); reply(falseOK,"OK\r\n",1200);
  assert(std::string(falseOK.sms)=="FAILED" && falseOK.smsSentCount==0);
  GsmController timeout("+10000000000",false);
  ready(timeout); submit(timeout,1000); timeout.tick(66000);
  assert(std::string(timeout.smsError).find("TIMEOUT")!=std::string::npos);
  assert(drain(timeout,66000)=="\x1b");
  timeout.tick(68000); exchange(timeout,"AT\r","OK\r\n",68000);
  timeout.queueAlert(2,68001); timeout.tick(68001); assert(!timeout.hasTx());
  timeout.tick(96000); assert(drain(timeout,96000)=="AT+CMGF=1\r");
  GsmController prompt("+10000000000",false);
  ready(prompt); sendToPrompt(prompt,1000); prompt.tick(11000);
  assert(std::string(prompt.smsError)=="CMGS prompt: TIMEOUT");
  GsmController local("0771234567",false);
  ready(local); local.queueAlert(1,1000); local.tick(1000);
  exchange(local,"AT+CMGF=1\r","OK\r\n",1000);
  exchange(local,"AT+CSCS=\"GSM\"\r","OK\r\n",1000);
  exchange(local,"AT+CSMP=17,167,0,0\r","OK\r\n",1000);
  assert(drain(local,1000)=="AT+CMGS=\"0771234567\"\r");
  GsmController invalid("+123\";ATD123",true);
  ready(invalid); invalid.queueAlert(1,1000); invalid.tick(1000);
  assert(std::string(invalid.sms)=="DISABLED" && !invalid.hasTx());
}
void testCallFailures() {
  GsmController terminal("+10000000000",true);
  ready(terminal); terminal.queueAlert(1,1000); terminal.tick(1000);
  exchange(terminal,"ATD+10000000000;\r","NO CARRIER\r\n",1000);
  terminal.tick(3000); exchange(terminal,"AT+CEER\r","+CEER: No service\r\nOK\r\n",3000);
  assert(std::string(terminal.callError)=="NO CARRIER");
  terminal.tick(3001); assert(drain(terminal,3001)=="AT+CMGF=1\r");
  GsmController g("+10000000000",true);
  ready(g); g.queueAlert(1,1000); g.tick(1000);
  exchange(g,"ATD+10000000000;\r","ERROR\r\n",1000);
  assert(std::string(g.callError)=="ATD: ERROR" && g.callPlacedCount==0);
  g.tick(3000); exchange(g,"AT+CEER\r","+CEER: Call barred\r\nOK\r\n",3000);
  assert(std::string(g.callDiagnostic)=="+CEER: Call barred");
  g.tick(3001); assert(drain(g,3001)=="AT+CMGF=1\r");

  GsmController t("+10000000000",true);
  ready(t); t.queueAlert(1,1000); t.tick(1000);
  assert(drain(t,1000)=="ATD+10000000000;\r");
  t.tick(11000); exchange(t,"ATH\r","ERROR\r\n",11000);
  assert(std::string(t.callError)=="ATD: TIMEOUT");
  exchange(t,"AT+CHUP\r","OK\r\n",11000);
  assert(std::string(t.cleanupError)=="ATH: ERROR");
  t.tick(13000); exchange(t,"AT+CEER\r","ERROR\r\n",13000);
  t.tick(13001); assert(drain(t,13001)=="AT+CMGF=1\r");

  GsmController noCarrier("+10000000000",true);
  ready(noCarrier); noCarrier.queueAlert(1,1000); noCarrier.tick(1000);
  exchange(noCarrier,"ATD+10000000000;\r","OK\r\n",1000);
  reply(noCarrier,"NO CARRIER\r\n",1200);
  assert(std::string(noCarrier.call)=="FAILED");
  noCarrier.tick(3200); exchange(noCarrier,"AT+CEER\r","+CEER: No route\r\nOK\r\n",3200);
  assert(std::string(noCarrier.callError)=="NO CARRIER");
  noCarrier.tick(3201); assert(drain(noCarrier,3201)=="AT+CMGF=1\r");

  GsmController release("+10000000000",true);
  ready(release); release.queueAlert(1,1000); release.tick(1000);
  exchange(release,"ATD+10000000000;\r","OK\r\n",1000);
  release.tick(21000); exchange(release,"ATH\r","ERROR\r\n",21000);
  exchange(release,"AT+CHUP\r","ERROR\r\n",21000);
  assert(std::string(release.sms)=="FAILED");
  assert(std::string(release.smsError)=="Skipped: call release unconfirmed");
  release.tick(23000); exchange(release,"AT+CEER\r","ERROR\r\n",23000);
  release.tick(23001); assert(!release.hasTx());

  GsmController optional("+10000000000",true);
  ready(optional); optional.queueAlert(1,1000); optional.tick(1000);
  exchange(optional,"ATD+10000000000;\r","OK\r\n",1000);
  optional.tick(3000); exchange(optional,"AT+CLCC\r","ERROR\r\n",3000);
  assert(std::string(optional.call)=="DIALING");
  optional.tick(6000); assert(!optional.hasTx());
  optional.tick(21000); exchange(optional,"ATH\r","OK\r\n",21000);
  optional.tick(23000); assert(drain(optional,23000)=="AT+CMGF=1\r");
}
int main() {
  testRadar(); testAlarm(); testDelayedSmsAndCall(); testSmsFailuresAndCooldown(); testCallFailures();
  std::cout << "PASS: radar; buzzer timing; call-first SMS; PS busy; timeout/backoff; call errors and fallback\n";
}
