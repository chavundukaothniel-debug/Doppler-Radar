#pragma once
#include "uno_link_protocol.h"

class UnoLinkReceiver {
 public:
  RadarTarget targets[3];
  uint32_t packets = 0, rejected = 0, lastPacketAt = 0, lastMeasurementAt = 0;
  uint8_t sequence = 0;
  bool seen = false, radarFresh = false, newMeasurement = false, measurementSeen = false;

  bool fresh(uint32_t now) const { return seen && uint32_t(now - lastPacketAt) < 1000; }

  bool push(uint8_t value, uint32_t now) {
    if (!used && value != UnoLinkProtocol::MAGIC) return false;
    buffer[used++] = value;
    if (used < UnoLinkProtocol::SIZE) return false;
    uint8_t nextSequence;
    bool nextFresh;
    RadarTarget nextTargets[3];
    if (UnoLinkProtocol::decode(buffer, nextSequence, nextFresh, nextTargets)) {
      newMeasurement = nextFresh && (!measurementSeen || nextSequence != sequence);
      if (newMeasurement) { lastMeasurementAt = now; measurementSeen = true; }
      sequence = nextSequence;
      radarFresh = nextFresh;
      for (uint8_t i = 0; i < 3; ++i) targets[i] = nextTargets[i];
      ++packets;
      lastPacketAt = now;
      seen = true;
      used = 0;
      return true;
    }
    ++rejected;
    uint8_t skip = 1;
    while (skip < UnoLinkProtocol::SIZE && buffer[skip] != UnoLinkProtocol::MAGIC) ++skip;
    used = UnoLinkProtocol::SIZE - skip;
    if (used) memmove(buffer, buffer + skip, used);
    return false;
  }

 private:
  uint8_t buffer[UnoLinkProtocol::SIZE]{}, used = 0;
};
