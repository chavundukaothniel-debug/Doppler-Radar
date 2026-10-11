#include <cassert>
#include <cstring>
#include <iostream>
#include "../firmware/nodemcu_master/buzzer_output.h"

uint32_t clockUs = 0;
unsigned starts = 0, stops = 0;
bool waveform = false, allowStart = true;
void pinMode(uint8_t pin, int mode) { assert(pin == 14 && mode == OUTPUT); }
void tone(uint8_t pin, int hz) { assert(pin == 14 && (hz == 4000 || hz == 3600 || hz == 4600)); ++starts; waveform = allowStart; }
void noTone(uint8_t pin) { assert(pin == 14); ++stops; waveform = false; }
uint32_t micros() { clockUs += 25; return clockUs; }
int digitalRead(uint8_t pin) { assert(pin == 14); return waveform && (clockUs / 125 % 2); }
int main() {
  BuzzerOutput b(14); b.begin(); b.update(true, 0);
  assert(starts == 1 && b.enabled());
  b.update(true, 500); assert(std::strcmp(b.state(), "GPIO TOGGLING") == 0);
  waveform = false;
  b.update(true, 1000); assert(b.restarts == 1 && starts == 2);
  b.update(true, 1500); assert(std::strcmp(b.state(), "GPIO TOGGLING") == 0);
  waveform = false; allowStart = false;
  b.update(true, 2000); assert(std::strcmp(b.state(), "DRIVE UNCONFIRMED") == 0);
  const unsigned count = starts;
  b.update(true, 2001); assert(starts == count);
  b.update(false, 2250); assert(!b.enabled() && !waveform);
  const unsigned stopped = stops;
  b.update(false, 2251); assert(stops == stopped);
  allowStart = true;
  b.update(true, 0xFFFFFF00); b.update(true, 0x100);
  assert(std::strcmp(b.state(), "GPIO TOGGLING") == 0);
  BuzzerOutput siren(14); siren.begin();
  const unsigned before = starts;
  siren.update(true, 0, 3600); assert(starts == before + 1);
  siren.update(true, 149, 3600); assert(starts == before + 1);
  siren.update(true, 150, 4600); assert(starts == before + 2);
  siren.update(true, 300, 3600); assert(starts == before + 3);
  siren.update(false, 450); assert(!siren.enabled());
  std::cout << "PASS: GPIO14 two-tone drive; stalled waveform recovery; bounded retries; silence; rollover\n";
}
