#pragma once
#include <stdint.h>

struct AlarmLogic {
  static constexpr uint32_t holdMs = 5000;
  static constexpr uint32_t pulseMs = 250;
  bool seen = false;
  uint32_t lastAt = 0;
  uint32_t startedAt = 0;
  uint32_t events = 0;
  uint8_t sources = 0;

  bool active(uint32_t now) const { return seen && uint32_t(now - lastAt) < holdMs; }
  void trigger(uint8_t source, uint32_t now) {
    if (!active(now)) {
      startedAt = now;
      sources = 0;
      ++events;
    }
    sources |= source;
    seen = true;
    lastAt = now;
  }
  bool buzzer(uint32_t now) const {
    return active(now);
  }
  uint16_t buzzerFrequency(uint32_t now) const {
    return uint32_t(now - startedAt) / 150 % 2 ? 4600 : 3600;
  }
  bool pulse(uint32_t now) const {
    return active(now) && ((uint32_t(now - startedAt) / pulseMs) % 2 == 0);
  }
};
