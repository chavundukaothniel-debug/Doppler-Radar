#pragma once
#include <stdint.h>
#include <string.h>

struct RadarTarget {
  int16_t x = 0, y = 0, speed = 0;
  bool valid = false;
  uint32_t distanceSquared() const {
    return uint32_t(int32_t(x) * x) + uint32_t(int32_t(y) * y);
  }
  bool approachingWithin3m() const { return valid && speed < 0 && distanceSquared() <= 9000000UL; }
};

class RadarProtocol {
 public:
  RadarTarget targets[3];
  uint32_t frames = 0, bytes = 0, rejected = 0, lastFrameAt = 0;
  bool seen = false;
  bool fresh(uint32_t now) const { return seen && uint32_t(now - lastFrameAt) < 1000; }
  bool push(uint8_t value, uint32_t now) {
    ++bytes;
    if (used && uint32_t(now - lastByteAt) > 100) used = 0;
    lastByteAt = now;
    static const uint8_t header[] = {0xAA, 0xFF, 0x03, 0x00};
    if (used < 4 && value != header[used]) {
      used = value == 0xAA ? 1 : 0;
      if (used) buffer[0] = value;
      return false;
    }
    buffer[used++] = value;
    if (used < sizeof(buffer)) return false;
    used = 0;
    if (buffer[28] != 0x55 || buffer[29] != 0xCC) {
      ++rejected;
      for (uint8_t i = 1; i < sizeof(buffer); ++i) {
        uint8_t remaining = sizeof(buffer) - i;
        if (memcmp(buffer + i, header, remaining < 4 ? remaining : 4) == 0) {
          used = remaining;
          memmove(buffer, buffer + i, used);
          break;
        }
      }
      return false;
    }
    for (uint8_t i = 0; i < 3; ++i) {
      const uint8_t *p = buffer + 4 + i * 8;
      targets[i].x = signedMagnitude(p);
      targets[i].y = signedMagnitude(p + 2);
      targets[i].speed = signedMagnitude(p + 4);
      targets[i].valid = targets[i].x != 0 || targets[i].y != 0;
    }
    ++frames;
    seen = true;
    lastFrameAt = now;
    return true;
  }
 private:
  uint8_t buffer[30]{}, used = 0;
  uint32_t lastByteAt = 0;
  static int16_t signedMagnitude(const uint8_t *p) {
    uint16_t raw = uint16_t(p[0]) | uint16_t(p[1]) << 8;
    int16_t magnitude = raw & 0x7FFF;
    return raw & 0x8000 ? magnitude : -magnitude;
  }
};
