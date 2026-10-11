#pragma once
#include "radar_protocol.h"

// Both sketches keep this wire format identical. All coordinates are signed mm;
// speed is signed cm/s. A CRC rejects partial/noisy software-UART packets.
struct UnoLinkProtocol {
  static constexpr uint8_t SIZE = 22;
  static constexpr uint8_t MAGIC = 0xD3;

  static uint8_t crc(const uint8_t *data) {
    uint8_t value = 0;
    for (uint8_t i = 0; i < SIZE - 1; ++i) {
      value ^= data[i];
      for (uint8_t bit = 0; bit < 8; ++bit)
        value = value & 0x80 ? uint8_t((value << 1) ^ 0x07) : uint8_t(value << 1);
    }
    return value;
  }

  static void encode(uint8_t *data, uint8_t sequence, bool fresh, const RadarTarget *targets) {
    data[0] = MAGIC;
    data[1] = sequence;
    data[2] = fresh ? 1 : 0;
    for (uint8_t i = 0; i < 3; ++i) {
      if (fresh && targets[i].valid) data[2] |= uint8_t(1 << (i + 1));
      const int16_t values[3] = {targets[i].x, targets[i].y, targets[i].speed};
      for (uint8_t j = 0; j < 3; ++j) {
        const uint16_t raw = fresh && targets[i].valid ? uint16_t(values[j]) : 0;
        data[3 + i * 6 + j * 2] = uint8_t(raw);
        data[4 + i * 6 + j * 2] = uint8_t(raw >> 8);
      }
    }
    data[SIZE - 1] = crc(data);
  }

  static bool decode(const uint8_t *data, uint8_t &sequence, bool &fresh, RadarTarget *targets) {
    if (data[0] != MAGIC || (data[2] & 0xF0) || crc(data) != data[SIZE - 1]) return false;
    sequence = data[1];
    fresh = data[2] & 1;
    for (uint8_t i = 0; i < 3; ++i) {
      const uint8_t offset = 3 + i * 6;
      const uint16_t x = uint16_t(data[offset]) | uint16_t(data[offset + 1]) << 8;
      const uint16_t y = uint16_t(data[offset + 2]) | uint16_t(data[offset + 3]) << 8;
      const uint16_t speed = uint16_t(data[offset + 4]) | uint16_t(data[offset + 5]) << 8;
      targets[i].valid = fresh && (data[2] & (1 << (i + 1)));
      targets[i].x = targets[i].valid ? int16_t(x) : 0;
      targets[i].y = targets[i].valid ? int16_t(y) : 0;
      targets[i].speed = targets[i].valid ? int16_t(speed) : 0;
    }
    return true;
  }
};
