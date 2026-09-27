#include <assert.h>
#include <iostream>
#include "../firmware/nodemcu_master/uno_link_receiver.h"

void feed(UnoLinkReceiver &link, const uint8_t *packet, uint32_t now) {
  for (uint8_t i = 0; i < UnoLinkProtocol::SIZE; ++i) link.push(packet[i], now);
}

int main() {
  RadarTarget sent[3];
  sent[0].x = -1200; sent[0].y = 2200; sent[0].speed = -35; sent[0].valid = true;
  sent[1].x = 800; sent[1].y = 1400; sent[1].speed = 28; sent[1].valid = true;
  uint8_t packet[UnoLinkProtocol::SIZE];
  UnoLinkProtocol::encode(packet, 7, true, sent);
  UnoLinkReceiver link;
  link.push(0x11, 100);
  link.push(0x99, 100);
  feed(link, packet, 100);
  assert(link.packets == 1 && link.sequence == 7 && link.radarFresh);
  assert(link.targets[0].valid && link.targets[0].x == -1200);
  assert(link.targets[0].y == 2200 && link.targets[0].speed == -35);
  assert(link.targets[1].valid && link.targets[1].speed == 28);
  assert(!link.targets[2].valid);
  assert(link.fresh(1099) && !link.fresh(1100));

  packet[10] ^= 0x40;
  feed(link, packet, 1200);
  assert(link.packets == 1 && link.rejected > 0);
  assert(!link.fresh(1200));
  UnoLinkProtocol::encode(packet, 8, false, sent);
  feed(link, packet, 1300);
  assert(link.packets == 2 && !link.radarFresh);
  for (const RadarTarget &target : link.targets) assert(!target.valid);

  UnoLinkProtocol::encode(packet, 9, true, sent);
  link.push(0xD3, 1400);
  link.push(0x00, 1400);
  feed(link, packet, 1400);
  assert(link.packets == 3 && link.sequence == 9);
  std::cout << "PASS: Uno link framing, coordinates, CRC, resync and freshness\n";
}
