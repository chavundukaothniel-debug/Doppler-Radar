#pragma once
#include <stdint.h>
#include <math.h>
#include "radar_protocol.h"

// No hardware IDs are present in RD-03D frames. Associate measured positions,
// never frame-slot numbers; ambiguous jumps start a new baseline.
struct TargetTrack {
  bool present = false, moving = false, alarmQualified = false;
  bool notificationQueued = false, gsmSent = false;
  bool associationAmbiguous = false;
  uint16_t id = 0;
  int16_t x = 0, y = 0, speed = 0, baselineX = 0, baselineY = 0;
  float distance = 0, filteredDistance = 0, baselineDistance = 0;
  float windowDistance = 0;
  float filteredSpeed = 0;
  float velocityX = 0, velocityY = 0;
  uint8_t positionSamples = 0;
  uint32_t firstSeen = 0, lastSeen = 0, lastMotion = 0, windowAt = 0;
  uint8_t samples = 0, reversals = 0;
  uint8_t stationarySamples = 0;
  int8_t direction = 0;
  float displacement() const { return filteredDistance - baselineDistance; }
  uint32_t retentionMs() const { return stationarySamples >= 4 ? 5000UL : 1200UL; }
  const char *directionName() const {
    if (associationAmbiguous && moving) return "TRACKING";
    return !moving ? "STATIONARY" : direction < 0 ? "APPROACHING" : direction > 0 ? "MOVING AWAY" : "TRACKING";
  }
};

class TargetTracker {
 public:
  static constexpr uint32_t staleMs = 1200, stationaryMs = 1200;
  static constexpr int thresholdMm = 800, speedThresholdCmS = 5;
  TargetTrack tracks[3];
  void expire(uint32_t now) {
    for (auto &t : tracks) {
      if (!t.present) continue;
      if (uint32_t(now - t.lastSeen) >= t.retentionMs()) { t = TargetTrack{}; continue; }
      if (uint32_t(now - t.lastSeen) >= staleMs) { t.moving = t.alarmQualified = false; t.direction = 0; }
      if (t.moving && uint32_t(now - t.lastMotion) >= stationaryMs) {
        t.moving = t.alarmQualified = false;
        t.direction = 0; t.samples = t.reversals = 0;
        t.baselineDistance = t.filteredDistance;
        t.baselineX = t.x; t.baselineY = t.y;
        t.windowDistance = t.filteredDistance; t.windowAt = now;
      }
    }
  }
  void update(const RadarTarget *returns, uint32_t now) {
    expire(now);
    bool usedTrack[3]{}, usedReturn[3]{};
    // Closest pair first, independently for each sensor; slots may reorder.
    for (uint8_t pass = 0; pass < 3; ++pass) {
      int bestTrack = -1, bestReturn = -1;
      float best = 1e10f;
      for (uint8_t i = 0; i < 3; ++i) {
        if (usedTrack[i] || !tracks[i].present) continue;
        const float gate = fminf(1200, 250 + uint32_t(now - tracks[i].lastSeen) * 2.0f);
        for (uint8_t j = 0; j < 3; ++j) {
          if (usedReturn[j] || !valid(returns[j])) continue;
          float dx = float(returns[j].x) - predictedX(tracks[i], now), dy = float(returns[j].y) - predictedY(tracks[i], now);
          float d = dx * dx + dy * dy;
          if (d < gate * gate && d < best) { best = d; bestTrack = i; bestReturn = j; }
        }
      }
      if (bestTrack < 0) break;
      usedTrack[bestTrack] = usedReturn[bestReturn] = true;
      bool ambiguous = false;
      const float bestDistance = sqrtf(best);
      for (uint8_t j = 0; j < 3; ++j) {
        if (j == bestReturn || !valid(returns[j])) continue;
        const float dx = float(returns[j].x) - predictedX(tracks[bestTrack], now);
        const float dy = float(returns[j].y) - predictedY(tracks[bestTrack], now);
        if (sqrtf(dx * dx + dy * dy) <= bestDistance + 125) ambiguous = true;
      }
      for (uint8_t i = 0; i < 3; ++i) {
        if (i == bestTrack || !tracks[i].present) continue;
        const float dx = float(returns[bestReturn].x) - predictedX(tracks[i], now);
        const float dy = float(returns[bestReturn].y) - predictedY(tracks[i], now);
        if (sqrtf(dx * dx + dy * dy) <= bestDistance + 125) ambiguous = true;
      }
      TargetTrack &track = tracks[bestTrack];
      sample(track, returns[bestReturn], now);
      track.associationAmbiguous = ambiguous;
      if (ambiguous) {
        // Never transfer accumulated displacement across an uncertain identity.
        // The event notification latch remains intact to avoid repeat SMS.
        track.velocityX = track.velocityY = 0; track.positionSamples = 0;
        track.alarmQualified = false; track.samples = track.reversals = 0;
        track.direction = 0;
        track.baselineDistance = track.windowDistance = track.filteredDistance;
        track.baselineX = track.x; track.baselineY = track.y; track.windowAt = now;
      }
    }
    for (uint8_t j = 0; j < 3; ++j) {
      if (usedReturn[j] || !valid(returns[j])) continue;
      for (uint8_t i = 0; i < 3; ++i) {
        if (tracks[i].present) continue;
        TargetTrack &t = tracks[i];
        t.present = true; t.id = ++nextId;
        t.firstSeen = t.lastSeen = t.lastMotion = t.windowAt = now;
        t.x = t.baselineX = returns[j].x; t.y = t.baselineY = returns[j].y;
        t.speed = returns[j].speed;
        t.filteredSpeed = t.speed;
        t.distance = t.filteredDistance = t.baselineDistance = t.windowDistance = sqrtf(float(returns[j].distanceSquared()));
        break;
      }
    }
  }
 private:
  uint16_t nextId = 0;
  // Prediction is association-only; output coordinates always come from a frame.
  static float predictedX(const TargetTrack &t, uint32_t now) { return t.x + t.velocityX * fminf(0.4f, uint32_t(now-t.lastSeen)/1000.0f); }
  static float predictedY(const TargetTrack &t, uint32_t now) { return t.y + t.velocityY * fminf(0.4f, uint32_t(now-t.lastSeen)/1000.0f); }
  static bool valid(const RadarTarget &r) {
    return r.valid && r.y >= 0 && r.distanceSquared() > 0 && r.distanceSquared() <= 49000000UL;
  }
  static void sample(TargetTrack &t, const RadarTarget &r, uint32_t now) {
    const uint32_t dt = now - t.lastSeen;
    if (dt < 80) return; // Sampling rate cannot manufacture persistence.
    if (dt >= staleMs) {
      // Reacquisition keeps identity, but cannot bridge missing movement evidence.
      t.velocityX = t.velocityY = 0; t.positionSamples = 0;
      t.samples = t.reversals = 0; t.moving = t.alarmQualified = false; t.direction = 0;
      t.filteredDistance = t.baselineDistance = t.windowDistance = sqrtf(float(r.distanceSquared()));
      t.baselineX = r.x; t.baselineY = r.y; t.windowAt = now;
    }
    const float vx = (float(r.x)-t.x)*1000.0f/dt, vy = (float(r.y)-t.y)*1000.0f/dt;
    if (fabsf(vx) <= 8000 && fabsf(vy) <= 8000) {
      const float alpha = t.positionSamples ? 0.6f : 1.0f;
      t.velocityX += alpha*(vx-t.velocityX); t.velocityY += alpha*(vy-t.velocityY);
      if (t.positionSamples < 255) ++t.positionSamples;
    } else { t.velocityX = t.velocityY = 0; t.positionSamples = 0; }
    t.lastSeen = now; t.x = r.x; t.y = r.y; t.speed = r.speed;
    t.filteredSpeed += 0.25f * (r.speed - t.filteredSpeed);
    t.distance = sqrtf(float(r.distanceSquared()));
    t.filteredDistance += 0.35f * (t.distance - t.filteredDistance);
    const int8_t sign = r.speed <= -speedThresholdCmS ? -1 : r.speed >= speedThresholdCmS ? 1 : 0;
    if (sign) t.stationarySamples = 0;
    else if (t.stationarySamples < 255) ++t.stationarySamples;
    if (!sign) {
      t.samples = 0; t.alarmQualified = false;
      if (!t.moving) {
        t.direction = 0;
        t.baselineDistance = t.windowDistance = t.filteredDistance;
        t.baselineX = t.x; t.baselineY = t.y; t.windowAt = now;
      }
      return;
    }
    if (!t.direction) { t.direction = sign; t.windowAt = now; t.windowDistance = t.filteredDistance; }
    if (sign != t.direction) {
      t.samples = 0; t.alarmQualified = false;
      if (++t.reversals >= 3) {
        t.direction = sign; t.baselineDistance = t.filteredDistance;
        t.baselineX = t.x; t.baselineY = t.y;
        t.windowDistance = t.filteredDistance; t.windowAt = now;
        t.moving = t.alarmQualified = false; t.reversals = 0;
      }
      return;
    }
    t.reversals = 0;
    if (t.samples < 255) ++t.samples;
    if (uint32_t(now - t.windowAt) >= 400) {
      const float delta = t.filteredDistance - t.windowDistance;
      if (t.samples >= 4 && delta * sign >= 40 && t.filteredSpeed * sign >= speedThresholdCmS) {
        t.moving = true; t.lastMotion = now;
        t.windowDistance = t.filteredDistance; t.windowAt = now;
      } else if (uint32_t(now - t.windowAt) >= 1000) {
        t.windowDistance = t.filteredDistance; t.windowAt = now;
      }
    }
    const float dx = float(t.x) - t.baselineX, dy = float(t.y) - t.baselineY;
    const bool radial = fabsf(t.displacement()) >= 0.6f * sqrtf(dx * dx + dy * dy);
    t.alarmQualified = t.moving && t.samples >= 4 && t.filteredSpeed * sign >= speedThresholdCmS && uint32_t(now - t.lastMotion) < stationaryMs &&
      t.displacement() * sign >= thresholdMm && radial;
  }
};
