#pragma once
#include <stdio.h>
#include <math.h>
#include "target_tracking.h"

// Integer formatting works on AVR too; protocol values remain in mm and cm/s.
inline size_t appendSmsTarget(char *output, size_t capacity, const TargetTrack &t) {
  const unsigned distance = unsigned(t.filteredDistance);
  const unsigned speed = unsigned(fabsf(t.filteredSpeed));
  const unsigned movement = unsigned(fabsf(t.displacement()));
  const int n = snprintf(output, capacity,
    "T%u\nDirection: %s\nDistance: %u.%02u m\nSpeed: %u.%02u m/s\nMovement: %u.%02u m\n",
    t.id, t.direction < 0 ? "Towards" : t.direction > 0 ? "Away" : "Moving",
    distance/1000, (distance%1000)/10, speed/100, speed%100,
    movement/1000, (movement%1000)/10);
  return n > 0 && capacity ? (size_t(n) < capacity ? size_t(n) : capacity-1) : 0;
}
