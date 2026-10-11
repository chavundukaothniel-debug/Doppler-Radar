#pragma once
#include <stdint.h>

// Non-blocking melodies; movement takes priority over status sounds.
struct StatusSounds {
  uint32_t bootAt = 0, wifiAt = 0;
  bool startupEnabled = true, wifiPending = false, wifiPlaying = false;
  void begin(uint32_t now, bool startup) { bootAt = now; startupEnabled = startup; }
  void connected() { wifiPending = true; }
  void disconnected() { wifiPending = wifiPlaying = false; }
  uint16_t frequency(uint32_t now, bool movement, uint16_t siren) {
    if (movement) { wifiPending = wifiPlaying = false; return siren; }
    const uint32_t bootAge = now - bootAt;
    if (startupEnabled && bootAge < 600) {
      const uint16_t notes[] = {2400, 3000, 3600};
      return bootAge % 200 < 140 ? notes[bootAge / 200] : 0;
    }
    if (wifiPending) { wifiPending = false; wifiPlaying = true; wifiAt = now; }
    if (wifiPlaying) {
      const uint32_t age = now - wifiAt;
      if (age >= 400) { wifiPlaying = false; return 0; }
      return age % 200 < 100 ? 4600 : 0;
    }
    return 0;
  }
};
