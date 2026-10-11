#include "../firmware/nodemcu_master/target_tracking.h"
#include "../firmware/nodemcu_master/uno_link_receiver.h"
#include "../firmware/nodemcu_master/gsm_controller.h"
#include <string.h>
volatile uint16_t testResult = 0;
#define CHECK(condition) do { if (!(condition)) { testResult = __LINE__; for (;;) {} } } while (0)
RadarTarget returns[3];
TargetTracker tracker;
GsmController modem("+10000000000", false);
char transmitted[192];
void sample(int16_t y, int16_t speed, uint32_t at, int16_t x = 0) {
  returns[0].valid = true; returns[0].x = x; returns[0].y = y; returns[0].speed = speed;
  tracker.update(returns, at);
}
void reset() { tracker = TargetTracker{}; for (auto &r : returns) r = RadarTarget{}; }
void drain(uint32_t at) {
  uint16_t n = 0;
  while (modem.hasTx()) { transmitted[n++] = char(modem.nextTx()); modem.txSent(at); }
  transmitted[n] = 0;
}
void reply(const char *text, uint32_t at) { while (*text) modem.feed(*text++, at); }
int main() {
  // Zero radial speed must not delete a continuously measured person.
  for (uint32_t at = 100; at <= 20100; at += 100) sample(2000, 0, at);
  const uint16_t heldStationaryId = tracker.tracks[0].id;
  CHECK(tracker.tracks[0].present && !tracker.tracks[0].moving);
  CHECK(tracker.tracks[0].retentionMs() == 5000);
  tracker.expire(23000);
  CHECK(tracker.tracks[0].present && !tracker.tracks[0].alarmQualified);
  sample(2010, 0, 23100);
  CHECK(tracker.tracks[0].id == heldStationaryId);
  CHECK(tracker.tracks[0].displacement() == 0);
  tracker.expire(28100);
  CHECK(!tracker.tracks[0].present);
  reset();
  {
    UnoLinkReceiver link;
    TargetTracker linkedTracker;
    RadarTarget sent[3]; sent[0].valid = true; sent[0].y = 2000; sent[0].speed = -50;
    uint8_t packet[UnoLinkProtocol::SIZE];
    UnoLinkProtocol::encode(packet, 255, true, sent);
    for (uint32_t at = 100; at <= 1400; at += 100) {
      for (uint8_t i = 0; i < UnoLinkProtocol::SIZE; ++i) link.push(packet[i], at);
      if (link.newMeasurement) linkedTracker.update(link.targets, at);
      linkedTracker.expire(at);
      CHECK(link.newMeasurement == (at == 100));
      CHECK(link.lastMeasurementAt == 100);
      CHECK(link.fresh(at)); // Link heartbeat is independent of measurement freshness.
    }
    CHECK(!linkedTracker.tracks[0].present); // Repeated packets cannot keep a target alive.
    UnoLinkProtocol::encode(packet, 0, true, sent); // Frame sequence wraps.
    for (uint8_t i = 0; i < UnoLinkProtocol::SIZE; ++i) link.push(packet[i], 1500);
    CHECK(link.newMeasurement && link.lastMeasurementAt == 1500);
    UnoLinkProtocol::encode(packet, 1, false, sent);
    for (uint8_t i = 0; i < UnoLinkProtocol::SIZE; ++i) link.push(packet[i], 1600);
    CHECK(!link.newMeasurement && !link.radarFresh);
  }
  tracker.update(returns, 100);
  CHECK(!tracker.tracks[0].present); // Empty area.
  for (int i = 0; i < 40; ++i) sample(5000 + (i % 2 ? 10 : -10), 0, 100 + i * 100);
  CHECK(!tracker.tracks[0].moving && !tracker.tracks[0].alarmQualified);
  reset();
  for (int i = 0; i < 40; ++i) sample(5000 + (i % 2 ? 15 : -15), -8, 100 + i * 100);
  CHECK(!tracker.tracks[0].moving && !tracker.tracks[0].alarmQualified); // Speed noise alone.
  reset(); sample(5600, -30, 100);
  for (int i = 1; i <= 10; ++i) sample(5600 - i * 30, -30, 100 + i * 100);
  CHECK(tracker.tracks[0].moving && !tracker.tracks[0].alarmQualified); // 0.3 m.
  reset(); sample(5600, -50, 100);
  for (int i = 1; i <= 14; ++i) sample(5600 - i * 50, -50, 100 + i * 100);
  CHECK(tracker.tracks[0].moving && !tracker.tracks[0].alarmQualified); // 0.7 m.
  reset(); sample(5600, -50, 100);
  for (int i = 1; i <= 20; ++i) sample(5600 - i * 50, -50, 100 + i * 100);
  CHECK(tracker.tracks[0].alarmQualified && tracker.tracks[0].direction == -1);
  CHECK(tracker.tracks[0].baselineDistance == 5600);
  tracker.tracks[0].notificationQueued = true;
  for (int i = 21; i <= 30; ++i) sample(5600 - i * 50, -50, 100 + i * 100);
  CHECK(tracker.tracks[0].notificationQueued); // Latch survives continuous event.
  tracker.expire(3300);
  CHECK(tracker.tracks[0].present); // Single missed frame.
  tracker.expire(4400);
  CHECK(!tracker.tracks[0].present); // Lost target / latch cleanup.
  reset(); sample(2500, 50, 100);
  for (int i = 1; i <= 20; ++i) sample(2500 + i * 50, 50, 100 + i * 100);
  CHECK(tracker.tracks[0].alarmQualified && tracker.tracks[0].direction == 1);
  for (int i = 21; i <= 42; ++i) sample(3500, 0, 100 + i * 100);
  CHECK(!tracker.tracks[0].moving && !tracker.tracks[0].alarmQualified); // Person stops.
  reset(); sample(5000, -50, 100); sample(3600, -50, 200); sample(4950, -50, 300);
  CHECK(!tracker.tracks[0].alarmQualified); // One bad jump cannot qualify.
  reset(); sample(4000, 10, 100, -1000);
  for (int i = 1; i <= 20; ++i) sample(4000, i < 10 ? -5 : 5, 100 + i * 100, -1000 + i * 100);
  CHECK(!tracker.tracks[0].alarmQualified); // Crossing / reversal, no 800 mm radial change.
  reset(); sample(5000, -30, 100, -1000);
  returns[1].valid = true; returns[1].x = 1000; returns[1].y = 3000; returns[1].speed = 30;
  tracker.update(returns, 200);
  const uint16_t firstId = tracker.tracks[0].id, secondId = tracker.tracks[1].id;
  RadarTarget swap = returns[0]; returns[0] = returns[1]; returns[1] = swap;
  returns[1].y = 4970; returns[0].y = 3030;
  tracker.update(returns, 300);
  CHECK(tracker.tracks[0].id == firstId && tracker.tracks[0].x == -1000);
  CHECK(tracker.tracks[1].id == secondId && tracker.tracks[1].x == 1000);
  reset(); sample(5000, -5, 100);
  for (int i = 1; i <= 30; ++i) sample(5000-i*5, -5, 100+i*100);
  CHECK(tracker.tracks[0].moving && !tracker.tracks[0].alarmQualified); // Slow 5 cm/s movement.
  const float beforeSpike = tracker.tracks[0].filteredSpeed;
  sample(4845, -100, 3200);
  CHECK(tracker.tracks[0].filteredSpeed < beforeSpike && tracker.tracks[0].filteredSpeed > -40);
  reset(); sample(5600, -50, 100);
  for (int i = 1; i <= 20; ++i) sample(5600-i*50, -50, 100+i*100);
  CHECK(tracker.tracks[0].alarmQualified);
  sample(4650, 50, 2200);
  CHECK(!tracker.tracks[0].alarmQualified); // Opposite speed immediately suspends qualification.
  tracker.tracks[0].notificationQueued = true;
  returns[1].valid = true; returns[1].x = 20; returns[1].y = 4650; returns[1].speed = 50;
  tracker.update(returns,2300);
  CHECK(tracker.tracks[0].associationAmbiguous && !tracker.tracks[0].alarmQualified);
  CHECK(tracker.tracks[0].displacement() == 0 && tracker.tracks[0].notificationQueued);
  // A target that stood still past the stationary timeout must be able to move again.
  reset(); sample(5000, 0, 100);
  for (int i = 1; i <= 40; ++i) sample(5000, 0, 100+i*100);
  CHECK(tracker.tracks[0].present && !tracker.tracks[0].moving);
  const uint16_t stationaryId = tracker.tracks[0].id;
  for (int i = 1; i <= 24; ++i) sample(5000-i*50, -50, 4100+i*100);
  CHECK(tracker.tracks[0].id == stationaryId);
  CHECK(tracker.tracks[0].moving && tracker.tracks[0].alarmQualified);
  for (int i = 1; i <= 30; ++i) sample(3800, 0, 6500+i*100);
  CHECK(!tracker.tracks[0].moving && !tracker.tracks[0].alarmQualified);
  for (int i = 1; i <= 24; ++i) sample(3800+i*50, 50, 9500+i*100);
  CHECK(tracker.tracks[0].moving && tracker.tracks[0].alarmQualified && tracker.tracks[0].direction == 1);
  // Fast measured motion with a 300 ms gap: retain identity without inventing positions.
  reset(); sample(6000, -400, 100); sample(5600, -400, 200);
  const uint16_t fastId = tracker.tracks[0].id;
  sample(4400, -400, 500);
  CHECK(tracker.tracks[0].id == fastId && tracker.tracks[0].y == 4400);
  sample(3200, -400, 800);
  CHECK(tracker.tracks[0].id == fastId && tracker.tracks[0].y == 3200);
  tracker.expire(2000); CHECK(!tracker.tracks[0].present);
  // Exercise actual GSM controller: AT sequence, useful message, submission and no repeat.
  modem.begin(100);
  drain(100); CHECK(strcmp(transmitted,"AT\r") == 0); reply("OK\r\n",100);
  drain(110); reply("OK\r\n",110); drain(120); reply("OK\r\n",120);
  drain(130); reply("WIS800C\r\nOK\r\n",130);
  drain(140); reply("+CPIN: READY\r\nOK\r\n",140);
  drain(150); reply("+CREG: 0,1\r\nOK\r\n",150);
  drain(160); reply("+CSQ: 23,0\r\nOK\r\n",160);
  drain(170); reply("+CSCA: \"+100\",145\r\nOK\r\n",170);
  CHECK(modem.queueMovement(1,12,"APPROACHING",4200,810,1000));
  modem.tick(1000); drain(1000); CHECK(strcmp(transmitted,"AT+CMGF=1\r") == 0);
  reply("OK\r\n",1000); drain(1000); reply("OK\r\n",1000);
  drain(1000); reply("OK\r\n",1000); drain(1000); reply(">",1000); drain(1000);
  CHECK(strstr(transmitted,"MOVEMENT ALERT") && strstr(transmitted,"S1-T12"));
  CHECK(strstr(transmitted,"Movement: 0.81 m") && !strstr(transmitted,"Human"));
  reply("+CMGS: 3\r\nOK\r\n",1100);
  CHECK(modem.smsSentCount == 1 && modem.sentSensor == 1 && modem.sentTarget == 12);
  CHECK(modem.queueMovement(2,7,"MOVING AWAY",5300,820,1100));
  modem.tick(1200); CHECK(!modem.hasTx());
  modem.tick(29999); CHECK(!modem.hasTx());
  modem.tick(31100); drain(31100); CHECK(strcmp(transmitted,"AT+CMGF=1\r") == 0);
  reply("OK\r\n",31100); drain(31100); reply("OK\r\n",31100);
  drain(31100); reply("OK\r\n",31100); drain(31100); reply(">",31100); drain(31100);
  CHECK(strstr(transmitted,"S2-T7") && strstr(transmitted,"MOVING AWAY"));
  CHECK(strstr(transmitted,"Movement: 0.82 m"));
  reply("+CMGS: 4\r\nOK\r\n",31200);
  CHECK(modem.smsSentCount == 2 && modem.sentSensor == 2 && modem.sentTarget == 7);
  modem.tick(31201); CHECK(!modem.hasTx());
  testResult = 65535;
  for (;;) {}
}
