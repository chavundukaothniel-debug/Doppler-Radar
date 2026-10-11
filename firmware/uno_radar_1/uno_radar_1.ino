#include <Arduino.h>
#include <avr/interrupt.h>
#include "radar_protocol.h"
#include "uno_link_protocol.h"
#include "target_tracking.h"

constexpr uint8_t UNO_TRIGGER_PIN = 7;
constexpr uint8_t UNO_DATA_PIN = 8;
constexpr uint32_t RADAR_BAUD = 256000;
constexpr uint32_t TRIGGER_HOLD_MS = 1000;
constexpr uint32_t LINK_INTERVAL_MS = 100;
RadarProtocol radar;
TargetTracker tracker;
bool approachSeen = false;
uint32_t lastApproachAt = 0;
uint32_t lastLinkAt = 0;
volatile uint8_t linkBytes[UnoLinkProtocol::SIZE];
volatile uint8_t linkByte = 0, linkPhase = 0;
volatile bool linkBusy = false;

// Timer1 sends 9600-baud UART on D8 without blocking radar RX interrupts.
ISR(TIMER1_COMPA_vect) {
  if (linkPhase == 0) {
    PORTB &= ~_BV(PB0); // Start bit.
    linkPhase = 1;
  } else if (linkPhase <= 8) {
    if (linkBytes[linkByte] & (1 << (linkPhase - 1))) PORTB |= _BV(PB0);
    else PORTB &= ~_BV(PB0);
    ++linkPhase;
  } else if (linkPhase == 9) {
    PORTB |= _BV(PB0); // Stop bit.
    linkPhase = 10;
  } else if (++linkByte == UnoLinkProtocol::SIZE) {
    linkBusy = false;
    TIMSK1 &= ~_BV(OCIE1A);
  } else {
    PORTB &= ~_BV(PB0);
    linkPhase = 1;
  }
}

void sendLink(uint32_t now) {
  if (linkBusy || uint32_t(now - lastLinkAt) < LINK_INTERVAL_MS) return;
  uint8_t packet[UnoLinkProtocol::SIZE];
  // Heartbeats must not turn the same radar frame into new movement evidence.
  UnoLinkProtocol::encode(packet, uint8_t(radar.frames), radar.fresh(now), radar.targets);
  noInterrupts();
  for (uint8_t i = 0; i < UnoLinkProtocol::SIZE; ++i) linkBytes[i] = packet[i];
  linkByte = 0;
  linkPhase = 0;
  linkBusy = true;
  TCNT1 = 0;
  TIMSK1 |= _BV(OCIE1A);
  interrupts();
  lastLinkAt = now;
}

void setup() {
  pinMode(UNO_TRIGGER_PIN, OUTPUT);
  digitalWrite(UNO_TRIGGER_PIN, LOW);
  pinMode(UNO_DATA_PIN, OUTPUT);
  digitalWrite(UNO_DATA_PIN, HIGH); // UART idle is HIGH.
  TCCR1A = 0;
  TCCR1B = 0;
  TCNT1 = 0;
  OCR1A = 207; // 16 MHz / (8 * 208) = 9615 baud (0.16% fast).
  TCCR1B = _BV(WGM12) | _BV(CS11);
  // UART0 is reserved for Radar 1. No serial printing or software UART delays.
  Serial.begin(RADAR_BAUD);
}

void loop() {
  for (uint8_t count = 0; count < 64 && Serial.available(); ++count) {
    const uint32_t now = millis();
    if (!radar.push(static_cast<uint8_t>(Serial.read()), now)) continue;
    tracker.update(radar.targets, now);
    for (const TargetTrack &target : tracker.tracks) {
      if (target.alarmQualified) {
        approachSeen = true;
        lastApproachAt = now;
        digitalWrite(UNO_TRIGGER_PIN, HIGH);
      }
    }
  }
  tracker.expire(millis());
  const bool active = approachSeen && uint32_t(millis() - lastApproachAt) < TRIGGER_HOLD_MS;
  digitalWrite(UNO_TRIGGER_PIN, active ? HIGH : LOW);
  sendLink(millis());
}
