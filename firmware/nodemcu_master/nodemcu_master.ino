#include <Arduino.h>
#include <ESP8266WiFi.h>
#include <WiFiUdp.h>
#include <bearssl/bearssl.h>
#include <SoftwareSerial.h>
#include <ArduinoJson.h>
#include <math.h>
#include "secrets.h"
#include "alarm_logic.h"
#include "buzzer_output.h"
#include "status_sounds.h"
#include "gsm_controller.h"
#include "radar_protocol.h"
#include "uno_link_receiver.h"
#include "target_tracking.h"
#include "shared_targets.h"
#include "sms_scene.h"
#include <WiFiClientSecureBearSSL.h>
#include "dashboard_ca.h"
#include <time.h>
#ifndef DASHBOARD_TLS
#define DASHBOARD_TLS true
#endif

#ifndef ENABLE_BUZZER_SELF_TEST
#define ENABLE_BUZZER_SELF_TEST true
#endif
#ifndef ENABLE_GSM_CALL
#define ENABLE_GSM_CALL true
#endif
#ifndef ENABLE_DASHBOARD_TELEMETRY
#define ENABLE_DASHBOARD_TELEMETRY true
#endif
#ifndef ENABLE_DASHBOARD_DISCOVERY
#define ENABLE_DASHBOARD_DISCOVERY true
#endif

constexpr uint8_t GSM_RX_PIN = 5, GSM_TX_PIN = 4;
constexpr uint8_t UNO_TRIGGER_PIN = 12, UNO_DATA_PIN = 13;
constexpr uint8_t ALERT_LED_PIN = 0, GREEN_LED_PIN = 2, BUZZER_PIN = 14;
constexpr uint32_t RADAR_BAUD = 256000, GSM_BAUD = 9600, LINK_BAUD = 9600;
constexpr uint32_t TELEMETRY_INTERVAL_MS = 200;
constexpr int MOTION_SPEED_THRESHOLD_CM_S = 5;

SoftwareSerial gsmSerial;
SoftwareSerial unoSerial;
GsmController gsm(ALERT_PHONE_NUMBER, ENABLE_GSM_CALL);
RadarProtocol radar;
UnoLinkReceiver unoLink;
SharedTargets sharedTargets;
bool sharedMeasurementsDirty = false;
uint32_t unoLinkOverflows = 0;
AlarmLogic alarm;
BuzzerOutput buzzer(BUZZER_PIN);
StatusSounds statusSounds;
constexpr char FIRMWARE_VERSION[] = "2026-10-24.3";
uint8_t radarRxTail[16]{}, radarRxTailIndex = 0;
uint32_t bootAt = 0;
volatile uint32_t unoRiseUs = 0;
volatile bool unoHigh = false, unoCompletedPulse = false;
bool unoQualified = false, redLedOn = true, greenLedOn = false, buzzerSounding = false;
bool unoSeen = false, telemetryDirty = true;
uint32_t unoTriggers = 0, unoLastAt = 0, telemetrySequence = 0;
uint32_t lastWiFiAttemptAt = 0, lastDiagnosticAt = 0;
bool wifiAttempted = false, wifiWasConnected = false;

// ISR records edges only. Tone, serial and modem work stays in loop().
void IRAM_ATTR unoEdge() {
  const uint32_t now = micros();
  if (digitalRead(UNO_TRIGGER_PIN)) {
    unoRiseUs = now;
    unoHigh = true;
  } else {
    if (unoHigh && uint32_t(now - unoRiseUs) >= 3000) unoCompletedPulse = true;
    unoHigh = false;
  }
}

const char *alarmSource() {
  return alarm.sources == 1 ? "RADAR 1 / UNO" : alarm.sources == 2 ? "RADAR 2" :
         alarm.sources == 3 ? "RADARS 1 AND 2" : "NONE";
}

void registerAlarm(uint8_t source, uint32_t now) {
  const uint8_t oldSources = alarm.sources;
  const bool wasActive = alarm.active(now);
  alarm.trigger(source, now);
  if (!wasActive || oldSources != alarm.sources) telemetryDirty = true;
}

void serviceUno(uint32_t now) {
  noInterrupts();
  const bool high = unoHigh, completed = unoCompletedPulse;
  const uint32_t rise = unoRiseUs;
  unoCompletedPulse = false;
  interrupts();
  const bool qualified = high && uint32_t(micros() - rise) >= 3000;
  if (qualified || completed) {
    if (!unoQualified) {
      ++unoTriggers;
      unoSeen = true;
      telemetryDirty = true;
    }
    unoLastAt = now;
    // D6 remains diagnostic. Only fresh measured tracks authorize alarms.
  }
  unoQualified = qualified;
}

void serviceUnoLink(uint32_t now) {
  const bool wasOnline = unoLink.fresh(now);
  for (uint8_t i = 0; i < 64 && unoSerial.available(); ++i) {
    if (unoLink.push(static_cast<uint8_t>(unoSerial.read()), now)) {
      if (!wasOnline) telemetryDirty = true;
      if (unoLink.newMeasurement) sharedMeasurementsDirty = true;
    }
  }
  if (unoSerial.overflow()) ++unoLinkOverflows;
}

void serviceRadar(uint32_t now) {
  for (unsigned i = 0; i < 256 && Serial.available(); ++i) {
    const uint8_t value = static_cast<uint8_t>(Serial.read());
    radarRxTail[radarRxTailIndex] = value;
    radarRxTailIndex = (radarRxTailIndex + 1) % sizeof(radarRxTail);
    if (!radar.push(value, now)) continue;
    sharedMeasurementsDirty = true;
  }
}

void serviceTracking(uint32_t now) {
  static uint32_t sentCount = 0;
  auto &tracker = sharedTargets.tracker;
  if (sharedMeasurementsDirty) {
    sharedTargets.update(unoLink.targets, unoLink.fresh(now) && unoLink.radarFresh,
      radar.targets, radar.fresh(now), now);
    sharedMeasurementsDirty = false;
  }
  tracker.expire(now);
  bool notify = false;
  uint8_t stationary = 0;
  char summary[576]{};
  size_t used = 0;
  uint16_t firstId = 0;
  for (auto &t : tracker.tracks) {
    if (!t.present || uint32_t(now-t.lastSeen) >= TargetTracker::staleMs) continue;
    if (!t.moving) { ++stationary; continue; }
    if (t.alarmQualified) {
      registerAlarm(3,now);
      if (!t.notificationQueued) { notify=true; firstId=t.id; }
    }
    used += appendSmsTarget(summary+used,sizeof(summary)-used,t);
  }
  snprintf(summary+used,sizeof(summary)-used,"Stationary: %u",stationary);
  if (notify && gsm.queueMovement(1,firstId,"SUMMARY",0,0,now,summary)) {
    for (auto &t : tracker.tracks) if (t.present && t.moving && t.alarmQualified) t.notificationQueued=true;
    telemetryDirty=true;
  }
  if (sentCount != gsm.smsSentCount) {
    sentCount=gsm.smsSentCount;
    // Only the queued transaction's identified target is delivery-confirmed.
    for (auto &t : tracker.tracks) if (t.id==gsm.sentTarget) t.gsmSent=true;
    telemetryDirty=true;
  }
}

void addTrackedTargets(JsonArray output, uint8_t sensorId, uint32_t now) {
  if (sensorId != 1) return;
  for (const auto &t : sharedTargets.tracker.tracks) {
    if (!t.present || uint32_t(now - t.lastSeen) >= t.retentionMs()) continue;
    JsonObject item = output.add<JsonObject>();
    item["targetId"] = String("T") + t.id;
    item["x"] = t.x / 1000.0f; item["y"] = t.y / 1000.0f;
    item["distance"] = t.distance / 1000.0f; item["speed"] = t.filteredSpeed / 100.0f;
    item["rawSpeedCmS"] = t.speed;
    item["trackingStatus"] = t.associationAmbiguous ? "AMBIGUOUS" : "TRACKED";
    item["filteredDistanceMm"] = t.filteredDistance;
    item["baselineDistanceMm"] = t.baselineDistance;
    item["displacementMm"] = t.displacement();
    item["direction"] = t.directionName(); item["moving"] = t.moving;
    item["active"] = true; item["alarmQualified"] = t.alarmQualified;
    item["gsmSent"] = t.gsmSent; item["notificationQueued"] = t.notificationQueued;
    item["firstSeenUptimeMs"] = t.firstSeen;
    item["lastSeenAgeMs"] = uint32_t(now - t.lastSeen);
    item["lastSeenUptimeMs"] = t.lastSeen;
    item["displayHoldMs"] = t.retentionMs();
  }
}

void addSensorObservations(JsonArray output, const RadarTarget *slots) {
  for (uint8_t i=0; i<3; ++i) {
    if (!slots[i].valid) continue;
    JsonObject item=output.add<JsonObject>();
    item["x"]=slots[i].x/1000.0f; item["y"]=slots[i].y/1000.0f;
    item["distance"]=sqrtf(float(slots[i].distanceSquared()))/1000.0f;
    item["speed"]=slots[i].speed/100.0f; item["active"]=true;
  }
}

void serviceOutputs(uint32_t now) {
  const bool connected = WiFi.status() == WL_CONNECTED;
  if (redLedOn != !connected) {
    digitalWrite(ALERT_LED_PIN, connected ? LOW : HIGH);
    redLedOn = !connected;
    telemetryDirty = true;
  }
  if (greenLedOn != connected) {
    digitalWrite(GREEN_LED_PIN, connected ? HIGH : LOW);
    greenLedOn = connected;
    telemetryDirty = true;
  }
  const uint16_t frequency = statusSounds.frequency(now, alarm.active(now), alarm.buzzerFrequency(now));
  buzzer.update(frequency != 0, now, frequency);
  buzzerSounding = buzzer.enabled();
}

void serviceGsm(uint32_t now) {
  for (unsigned i = 0; i < 128 && gsmSerial.available(); ++i) gsm.feed(char(gsmSerial.read()), now);
  if (gsmSerial.overflow()) gsm.transportError(now);
  gsm.tick(now);
  // Limit SoftwareSerial transmission to about one millisecond per loop.
  if (gsm.hasTx()) {
    gsmSerial.write(gsm.nextTx());
    gsm.txSent(millis());
  }
}

void serviceWifi(uint32_t now) {
  const bool connected = WiFi.status() == WL_CONNECTED;
  if (connected != wifiWasConnected) {
    wifiWasConnected = connected;
    if (connected) {
      statusSounds.connected();
      Serial.print(F("[Wi-Fi] Connected: "));
      Serial.println(WiFi.localIP());
      telemetryDirty = true;
    } else {
      statusSounds.disconnected();
      telemetryDirty = true;
      Serial.println(F("[Wi-Fi] Disconnected"));
    }
  }
  if (!connected && (!wifiAttempted || uint32_t(now - lastWiFiAttemptAt) >= 15000)) {
    wifiAttempted = true;
    lastWiFiAttemptAt = now;
    WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  }
}

String telemetryJson(uint32_t now) {
  JsonDocument doc;
  doc["deviceId"] = "doppler-radar-8266";
  doc["controller"] = "ESP8266 + UNO";
  doc["firmware"] = FIRMWARE_VERSION;
  doc["sequence"] = ++telemetrySequence;
  doc["uptimeSeconds"] = now / 1000UL;
  doc["wifi"]["rssi"] = WiFi.RSSI();
  JsonArray sensors = doc["sensors"].to<JsonArray>();
  JsonObject uno = sensors.add<JsonObject>();
  uno["id"] = 1;
  uno["mode"] = "linked";
  uno["linkOnline"] = unoLink.fresh(now);
  uno["online"] = unoLink.fresh(now) && unoLink.radarFresh;
  uno["lastFrameAgeMs"] = unoLink.measurementSeen ? now - unoLink.lastMeasurementAt : 60000;
  uno["frames"] = unoLink.packets;
  uno["rejected"] = unoLink.rejected;
  uno["overflows"] = unoLinkOverflows;
  uno["triggerActive"] = unoQualified;
  uno["triggerCount"] = unoTriggers;
  uno["lastTriggerAgeMs"] = unoSeen ? int32_t(now - unoLastAt) : -1;
  JsonArray unoTargets = uno["targets"].to<JsonArray>();
  if (unoLink.fresh(now) && unoLink.radarFresh) addSensorObservations(unoTargets, unoLink.targets);
  JsonObject sensor = sensors.add<JsonObject>();
  sensor["id"] = 2;
  sensor["mode"] = "uart";
  sensor["online"] = radar.fresh(now);
  sensor["lastFrameAgeMs"] = radar.seen ? now - radar.lastFrameAt : 60000;
  sensor["frames"] = radar.frames;
  JsonArray targets = sensor["targets"].to<JsonArray>();
  if (radar.fresh(now)) addSensorObservations(targets, radar.targets);
  addTrackedTargets(doc["sharedTargets"].to<JsonArray>(), 1, now);
  // Latest decoded sensor slots, before smoothing/association; not raw RF samples.
  JsonArray measurements = doc["measurements"].to<JsonArray>();
  for (uint8_t id = 1; id <= 2; ++id) {
    const bool fresh = id == 1 ? unoLink.fresh(now) && unoLink.radarFresh : radar.fresh(now);
    const RadarTarget *slots = id == 1 ? unoLink.targets : radar.targets;
    for (uint8_t slot = 0; slot < 3; ++slot) {
      JsonObject m = measurements.add<JsonObject>();
      m["sensorId"] = id; m["slot"] = slot; m["fresh"] = fresh;
      m["valid"] = fresh && slots[slot].valid;
      m["xMm"] = slots[slot].x; m["yMm"] = slots[slot].y;
      m["speedCmS"] = slots[slot].speed;
    }
  }
  JsonObject modem = doc["gsm"].to<JsonObject>();
  modem["connected"] = gsm.connected;
  modem["network"] = gsm.registered;
  modem["simReady"] = gsm.simReady;
  modem["smscConfigured"] = gsm.smscConfigured;
  modem["model"] = gsm.identity;
  modem["stage"] = gsm.stage();
  modem["signal"] = gsm.signal;
  modem["sms"] = gsm.sms;
  modem["call"] = gsm.call;
  modem["smsError"] = gsm.smsError;
  modem["callError"] = gsm.callError;
  modem["statusError"] = gsm.statusError;
  modem["callDiagnostic"] = gsm.callDiagnostic;
  modem["cleanupError"] = gsm.cleanupError;
  modem["callsEnabled"] = gsm.callsEnabled;
  modem["smsSentCount"] = gsm.smsSentCount;
  modem["callPlacedCount"] = gsm.callPlacedCount;
  modem["lastSms"] = gsm.smsSentCount ? String(gsm.smsSentAt / 1000) + "s uptime" : "NEVER";
  modem["lastCall"] = gsm.callPlacedCount ? String(gsm.callPlacedAt / 1000) + "s uptime" : "NEVER";
  JsonObject outputs = doc["outputs"].to<JsonObject>();
  outputs["alarmActive"] = alarm.active(now);
  outputs["alarmSource"] = alarmSource();
  outputs["alarmEvents"] = alarm.events;
  outputs["redLed"] = redLedOn;
  outputs["greenLed"] = greenLedOn;
  outputs["ledMode"] = "WIFI_STATUS";
  outputs["buzzer"] = buzzerSounding;
  outputs["buzzerDrive"] = buzzer.state();
  outputs["buzzerRestarts"] = buzzer.restarts;
  outputs["buzzerPattern"] = "Startup: 3 rising notes; Wi-Fi: 2 high beeps; movement: 3600/4600 Hz siren";
  String result;
  serializeJson(doc, result);
  return result;
}

// Advance HTTP incrementally; TCP connection waits are bounded to 200 ms.
BearSSL::WiFiClientSecure secureTelemetryClient;
WiFiClient plainTelemetryClient;
WiFiClient &telemetryClient = DASHBOARD_TLS ? static_cast<WiFiClient&>(secureTelemetryClient) : plainTelemetryClient;
BearSSL::X509List dashboardTrust(DASHBOARD_CA);
BearSSL::Session dashboardSession;
bool tlsReady = false;
String httpRequest, httpStatus;
size_t httpOffset = 0;
uint32_t httpStartedAt = 0, lastPostAt = 0;
bool httpBusy = false, postAttempted = false, dashboardConnected = false;
uint32_t acceptedPosts = 0, failedPosts = 0, lastAcceptedAt = 0;
const char *lastPostResult = "NOT ATTEMPTED";
IPAddress dashboardIp;
bool dashboardAddressValid = false;
uint16_t dashboardPort = DASHBOARD_PORT;
WiFiUDP discoveryUdp;
bool discoveryStarted = false;
uint32_t lastDiscoveryAt = 0;
String discoveryNonce;

String discoveryProof(const String &nonce, uint16_t port, const String &address) {
  const String input = String(DEVICE_API_KEY) + "|" + nonce + "|" + port + "|" + address;
  br_sha256_context context;
  uint8_t digest[32];
  br_sha256_init(&context);
  br_sha256_update(&context, input.c_str(), input.length());
  br_sha256_out(&context, digest);
  char hex[65];
  for (uint8_t i = 0; i < 32; ++i) snprintf(hex + 2*i, 3, "%02x", digest[i]);
  return String(hex);
}

void serviceDiscovery(uint32_t now) {
  if (DASHBOARD_TLS || !ENABLE_DASHBOARD_DISCOVERY || !ENABLE_DASHBOARD_TELEMETRY) return;
  if (WiFi.status() != WL_CONNECTED) {
    if (discoveryStarted) discoveryUdp.stop();
    discoveryStarted = false;
    dashboardConnected = false;
    dashboardAddressValid = dashboardIp.fromString(DASHBOARD_HOST);
    return;
  }
  if (!discoveryStarted) {
    discoveryStarted = discoveryUdp.begin(4211);
    lastDiscoveryAt = now - 3000;
  }
  if (!discoveryStarted || httpBusy) return;
  // Read one bounded datagram per loop; no blocking hostname resolution.
  const int packetSize = discoveryUdp.parsePacket();
  if (packetSize > 0) {
    char response[257];
    const IPAddress sender = discoveryUdp.remoteIP();
    const int n = discoveryUdp.read(response, sizeof(response)-1);
    if (packetSize <= 256 && n > 0 && !discoveryNonce.isEmpty() && uint32_t(now-lastDiscoveryAt) <= 3000) {
      response[n] = 0;
      JsonDocument reply;
      if (!deserializeJson(reply, response)) {
        const uint16_t port = reply["port"] | 0;
        const String nonce = reply["nonce"] | "";
        const String proof = reply["proof"] | "";
        const String address = reply["address"] | "";
        if (String(reply["type"] | "") == "DOPPLER_SERVER_V1" && port &&
            nonce == discoveryNonce && address == sender.toString() && proof == discoveryProof(nonce, port, address)) {
          dashboardIp = sender; dashboardPort = port; dashboardAddressValid = true;
          discoveryNonce = "";
          Serial.printf("[Dashboard] Discovered %s:%u\n", dashboardIp.toString().c_str(), dashboardPort);
        }
      }
    }
  }
  if (dashboardConnected || uint32_t(now-lastDiscoveryAt) < 3000) return;
  char nonce[17];
  snprintf(nonce, sizeof(nonce), "%08lx%08lx", static_cast<unsigned long>(ESP.random()), static_cast<unsigned long>(ESP.random()));
  discoveryNonce = nonce;
  const String query = String("{\"type\":\"DOPPLER_DISCOVER_V1\",\"nonce\":\"") + nonce + "\"}";
  IPAddress broadcast;
  const IPAddress local = WiFi.localIP(), mask = WiFi.subnetMask();
  for (uint8_t i = 0; i < 4; ++i) broadcast[i] = local[i] | uint8_t(~mask[i]);
  if (discoveryUdp.beginPacket(broadcast, 4210)) {
    discoveryUdp.write(reinterpret_cast<const uint8_t *>(query.c_str()), query.length());
    discoveryUdp.endPacket();
  }
  lastDiscoveryAt = now;
}

void finishPost(bool accepted, const char *reason = "CONNECTION CLOSED") {
  lastPostResult = accepted ? "ACCEPTED" : reason;
  if (accepted) { ++acceptedPosts; lastAcceptedAt = millis(); }
  else ++failedPosts;
  telemetryClient.stop();
  httpBusy = false;
  httpRequest = "";
  httpStatus = "";
  if (dashboardConnected != accepted) {
    dashboardConnected = accepted;
    if (accepted) Serial.println(F("[Dashboard] Telemetry accepted"));
    else Serial.printf("[Dashboard] Request failed: %s\n", reason);
  }
}

void serviceTelemetry(uint32_t now) {
  if (!ENABLE_DASHBOARD_TELEMETRY) return;
  if (WiFi.status() != WL_CONNECTED) {
    if (httpBusy) finishPost(false, "WI-FI DISCONNECTED");
    return;
  }
  if (!DASHBOARD_TLS && !dashboardAddressValid) return;
  if (DASHBOARD_TLS && (!tlsReady || time(nullptr) < 1700000000)) return;
  if (httpBusy) {
    if (uint32_t(now - httpStartedAt) > 3200) { finishPost(false, "HTTP RESPONSE TIMEOUT"); return; }
    if (httpOffset < httpRequest.length()) {
      const int available = telemetryClient.availableForWrite();
      if (available > 0) {
        const size_t n = min(size_t(available), min(size_t(128), httpRequest.length() - httpOffset));
        httpOffset += telemetryClient.write(reinterpret_cast<const uint8_t *>(httpRequest.c_str() + httpOffset), n);
      }
    }
    for (unsigned i = 0; i < 128 && telemetryClient.available(); ++i) {
      const char ch = char(telemetryClient.read());
      if (ch == '\n') {
        int code = 0;
        sscanf(httpStatus.c_str(), "HTTP/%*s %d", &code);
        if (code != 202) Serial.printf("[Dashboard] HTTP %d\n", code);
        finishPost(code == 202, "HTTP REJECTED");
        return;
      }
      if (ch != '\r' && httpStatus.length() < 96) httpStatus += ch;
    }
    if (!telemetryClient.connected() && !telemetryClient.available()) finishPost(false);
    return;
  }
  const uint32_t interval = DASHBOARD_TLS ? 2000 : dashboardConnected ? TELEMETRY_INTERVAL_MS : 2000;
  if (postAttempted && uint32_t(now - lastPostAt) < (!DASHBOARD_TLS && telemetryDirty && dashboardConnected ? 100UL : interval)) return;
  postAttempted = true;
  lastPostAt = now;
  telemetryClient.setTimeout(DASHBOARD_TLS ? 15000 : 200);
  if (DASHBOARD_TLS) {
    IPAddress resolved;
    if (!WiFi.hostByName("doppler-radar.onrender.com",resolved,5000)) {
      Serial.println(F("[Dashboard] DNS failed: hotspot cannot resolve doppler-radar.onrender.com"));
      finishPost(false,"DNS FAILED"); return;
    }
    Serial.printf("[Dashboard] HTTPS connecting: IP=%s heap=%u largestBlock=%u UTC=%lu\n",
      resolved.toString().c_str(),ESP.getFreeHeap(),ESP.getMaxFreeBlockSize(),static_cast<unsigned long>(time(nullptr)));
    if (!secureTelemetryClient.connect("doppler-radar.onrender.com",443)) {
      char detail[160]{};
      const int error=secureTelemetryClient.getLastSSLError(detail,sizeof(detail));
      Serial.printf("[Dashboard] HTTPS failed: TLS error=%d detail=%s heap=%u\n",error,detail,ESP.getFreeHeap());
      finishPost(false,"HTTPS CONNECT FAILED"); return;
    }
  } else if (!plainTelemetryClient.connect(dashboardIp,dashboardPort)) {
    finishPost(false,"TCP CONNECT FAILED"); return;
  }
  telemetryClient.setNoDelay(true);
  const String body = telemetryJson(millis());
  httpRequest = String("POST /api/telemetry HTTP/1.1\r\nHost: ") + (DASHBOARD_TLS ? String("doppler-radar.onrender.com") : dashboardIp.toString() + ":" + dashboardPort) +
    "\r\nConnection: close\r\nContent-Type: application/json\r\nX-Device-Key: " + DEVICE_API_KEY +
    "\r\nContent-Length: " + body.length() + "\r\n\r\n" + body;
  httpOffset = 0;
  httpStartedAt = millis();
  httpBusy = true;
  telemetryDirty = false;
}

void reportDiagnostics(uint32_t now) {
  static uint32_t lastTrackingLog = 0;
  if (uint32_t(now - lastTrackingLog) >= 1000) {
    lastTrackingLog = now;
    for (uint8_t s = 0; s < 1; ++s) for (const auto &t : sharedTargets.tracker.tracks)
      if (t.present && t.moving) Serial.printf("[S%u-T%u] Tracking: %.2f m | displacement=%.2f m | %s\n",
        s + 1, t.id, t.filteredDistance / 1000, t.displacement() / 1000, t.directionName());
  }
  static String lastSms, lastCall, lastError;
  static const char *lastBuzzer = "";
  if (strcmp(lastBuzzer, buzzer.state()) != 0) {
    lastBuzzer = buzzer.state();
    Serial.printf("[Buzzer GPIO14] %s; restarts=%lu\n", lastBuzzer, static_cast<unsigned long>(buzzer.restarts));
    telemetryDirty = true;
  }
  const String error = String(gsm.smsError) + " | " + gsm.callError + " | " + gsm.statusError + " | " + gsm.callDiagnostic + " | " + gsm.cleanupError;
  if (lastSms != gsm.sms || lastCall != gsm.call || lastError != error) {
    lastSms = gsm.sms; lastCall = gsm.call; lastError = error;
    Serial.printf("[GSM] SMS=%s Call=%s Stage=%s\n", gsm.sms, gsm.call, gsm.stage());
    if (gsm.smsError[0]) Serial.printf("[SMS] %s\n", gsm.smsError);
    if (gsm.callError[0]) Serial.printf("[Call] %s\n", gsm.callError);
    if (gsm.callDiagnostic[0]) Serial.printf("[Call cause] %s\n", gsm.callDiagnostic);
    if (gsm.cleanupError[0]) Serial.printf("[Modem cleanup] %s\n", gsm.cleanupError);
    if (gsm.statusError[0]) Serial.printf("[GSM] %s\n", gsm.statusError);
    telemetryDirty = true;
  }
  if (uint32_t(now - lastDiagnosticAt) >= 5000) {
    static uint32_t previousBytes = 0, previousFrames = 0;
    const uint32_t newBytes = radar.bytes - previousBytes;
    const uint32_t newFrames = radar.frames - previousFrames;
    previousBytes = radar.bytes; previousFrames = radar.frames;
    lastDiagnosticAt = now;
    Serial.printf("[Dashboard health] Wi-Fi=%s RSSI=%d accepted=%lu failed=%lu lastAcceptedAge=%ld ms result=%s\n",
      WiFi.status() == WL_CONNECTED ? "CONNECTED" : "DISCONNECTED", WiFi.RSSI(),
      static_cast<unsigned long>(acceptedPosts), static_cast<unsigned long>(failedPosts),
      acceptedPosts ? static_cast<long>(now - lastAcceptedAt) : -1L, lastPostResult);
    Serial.printf("[Radar 2] RX bytes=%lu (+%lu) frames=%lu (+%lu) rejected=%lu age=%ld ms\n",
      static_cast<unsigned long>(radar.bytes), static_cast<unsigned long>(newBytes),
      static_cast<unsigned long>(radar.frames), static_cast<unsigned long>(newFrames),
      static_cast<unsigned long>(radar.rejected), radar.seen ? static_cast<long>(now-radar.lastFrameAt) : -1L);
    if (!newBytes) Serial.println(F("[Radar 2] No UART bytes in last 5 seconds"));
    else if (!newFrames) {
      Serial.print(F("[Radar 2] Bytes arriving; no valid AA FF 03 00 ... 55 CC frame. RX tail: "));
      const uint8_t count = radar.bytes < sizeof(radarRxTail) ? radar.bytes : sizeof(radarRxTail);
      const uint8_t first = radar.bytes < sizeof(radarRxTail) ? 0 : radarRxTailIndex;
      for (uint8_t i = 0; i < count; ++i) Serial.printf("%02X ", radarRxTail[(first+i)%sizeof(radarRxTail)]);
      Serial.println();
    }
    Serial.printf("[Status] Radar2=%lu frames Uno=%lu packets (%lu rejected, %lu overflow), %lu triggers Alarm=%s GSM=%s CSQ=%d\n",
      static_cast<unsigned long>(radar.frames), static_cast<unsigned long>(unoLink.packets),
      static_cast<unsigned long>(unoLink.rejected), static_cast<unsigned long>(unoLinkOverflows),
      static_cast<unsigned long>(unoTriggers), alarm.active(now) ? alarmSource() : "OFF",
      gsm.registered ? "REGISTERED" : "WAITING", gsm.signal);
    if (Serial.hasOverrun() || Serial.hasRxError()) Serial.println(F("[Radar 2] UART overrun or framing error"));
  }
}

void setup() {
  pinMode(UNO_TRIGGER_PIN, INPUT);
  pinMode(ALERT_LED_PIN, OUTPUT);
  pinMode(GREEN_LED_PIN, OUTPUT);
  pinMode(BUZZER_PIN, OUTPUT);
  digitalWrite(ALERT_LED_PIN, HIGH);
  digitalWrite(GREEN_LED_PIN, LOW);
  buzzer.begin();
  // Bound RX allocations so verified TLS has room for its full receive record.
  // TLS handshakes can still cause missing frames; never infer motion through gaps.
  Serial.setRxBufferSize(4096);
  Serial.begin(RADAR_BAUD);
  Serial.setDebugOutput(false);
  Serial.printf("\nDoppler master firmware %s: Radar UART 256000, buzzer GPIO14 rapid two-tone siren\n", FIRMWARE_VERSION);
  Serial.printf("[Boot] %s\n", ESP.getResetReason().c_str());
  unoHigh = digitalRead(UNO_TRIGGER_PIN) == HIGH;
  unoRiseUs = micros();
  attachInterrupt(digitalPinToInterrupt(UNO_TRIGGER_PIN), unoEdge, CHANGE);
  gsmSerial.begin(GSM_BAUD, SWSERIAL_8N1, GSM_RX_PIN, GSM_TX_PIN, false, 256, 256);
  // Protect each 9600-baud TX byte from ordinary interrupt jitter (~1 ms).
  // The waveform NMI remains active; RX is serviced between transmitted bytes.
  gsmSerial.enableIntTx(false);
  unoSerial.begin(LINK_BAUD, SWSERIAL_8N1, UNO_DATA_PIN, -1, false, 128, 256);
  unoSerial.enableRxGPIOPullUp(false);
  gsm.begin(millis());
  WiFi.persistent(false);
  WiFi.mode(WIFI_STA);
  // Keep the radio awake for frequent telemetry rather than modem-sleep delays.
  WiFi.setSleepMode(WIFI_NONE_SLEEP);
  dashboardAddressValid = dashboardIp.fromString(DASHBOARD_HOST);
  if (!dashboardAddressValid) Serial.println(F("[Dashboard] Waiting for automatic Wi-Fi discovery"));
  if (DASHBOARD_TLS) {
    configTime(0, 0, "pool.ntp.org", "time.nist.gov");
    // Full-size TLS receive records preserve compatibility without disabling validation.
    secureTelemetryClient.setBufferSizes(16384,512);
    secureTelemetryClient.setTrustAnchors(&dashboardTrust);
    secureTelemetryClient.setSession(&dashboardSession);
    tlsReady = true;


  }
  bootAt = millis();
  statusSounds.begin(bootAt, ENABLE_BUZZER_SELF_TEST);
  if (ENABLE_BUZZER_SELF_TEST) Serial.println(F("[Buzzer] Startup: 3 rising notes; Wi-Fi connected: 2 high beeps; movement: alternating siren"));
}

void loop() {
  const uint32_t now = millis();
  serviceUno(now);
  serviceUnoLink(now);
  serviceRadar(now);
  serviceTracking(now);
  serviceOutputs(now);
  serviceGsm(now);
  serviceWifi(now);
  serviceDiscovery(now);
  serviceTelemetry(now);
  serviceUno(millis());
  serviceUnoLink(millis());
  serviceRadar(millis());
  serviceTracking(millis());
  serviceOutputs(millis());
  reportDiagnostics(millis());
  yield();
}
