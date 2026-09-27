#pragma once
#include <Arduino.h>

// GPIO readback verifies a waveform, not acoustic output from the transducer.
class BuzzerOutput {
 public:
  explicit BuzzerOutput(uint8_t pin) : pin_(pin) {}
  void begin() { pinMode(pin_, OUTPUT); noTone(pin_); }
  void update(bool requested, uint32_t now, uint16_t frequency = 4000) {
    if (requested != enabled_) {
      enabled_ = requested;
      observed_ = false;
      if (requested) {
        frequency_ = frequency;
        tone(pin_, frequency_);
      } else noTone(pin_);
      checkedAt_ = now;
    } else if (requested && frequency != frequency_) {
      frequency_ = frequency;
      tone(pin_, frequency_);
    }
    if (!enabled_ || uint32_t(now - checkedAt_) < 500) return;
    checkedAt_ = now;
    const int initial = digitalRead(pin_);
    const uint32_t start = micros();
    observed_ = false;
    // At the lowest alarm pitch an edge occurs every 139 us. Interrupts remain enabled.
    while (uint32_t(micros() - start) < 400) {
      if (digitalRead(pin_) != initial) { observed_ = true; break; }
    }
    if (!observed_) {
      ++restarts;
      noTone(pin_);
      pinMode(pin_, OUTPUT);
      tone(pin_, frequency_);
    }
  }
  bool enabled() const { return enabled_; }
  const char *state() const {
    return !enabled_ ? "OFF" : observed_ ? "GPIO TOGGLING" : "DRIVE UNCONFIRMED";
  }
  uint32_t restarts = 0;
 private:
  uint8_t pin_;
  uint16_t frequency_ = 4000;
  bool enabled_ = false, observed_ = false;
  uint32_t checkedAt_ = 0;
};
