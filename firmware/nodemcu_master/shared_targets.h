#pragma once
#include "target_tracking.h"

// Co-facing radars less than 100 mm apart. One-to-one matching prevents
// collapsing separate returns from the same radar. Opposite motion is distinct.
class SharedTargets {
 public:
  TargetTracker tracker;
  void update(const RadarTarget *a, bool freshA, const RadarTarget *b, bool freshB, uint32_t now) {
    RadarTarget merged[6]{};
    bool used[3]{};
    uint8_t count = 0;
    if (freshA) for (uint8_t i=0; i<3; ++i) {
      if (!a[i].valid) continue;
      merged[count++] = a[i];
      int best = -1; float score = 1e10f;
      if (freshB) for (uint8_t j=0; j<3; ++j) {
        if (used[j] || !b[j].valid || (a[i].speed <= -5 && b[j].speed >= 5) || (a[i].speed >= 5 && b[j].speed <= -5)) continue;
        float dx=float(a[i].x)-b[j].x, dy=float(a[i].y)-b[j].y;
        float radial=fabsf(sqrtf(float(a[i].distanceSquared()))-sqrtf(float(b[j].distanceSquared())));
        float d=dx*dx+dy*dy;
        if (radial <= 200 && d <= 350.0f*350 && d < score) { best=j; score=d; }
      }
      if (best >= 0) used[best]=true;
    }
    if (freshB) for (uint8_t j=0; j<3; ++j) if (!used[j] && b[j].valid) merged[count++]=b[j];
    tracker.update(merged,now,count);
  }
};
