#include <Arduino.h>
#include <ESP8266WiFi.h>
#include <SoftwareSerial.h>
#include <ArduinoJson.h>
#include <math.h>
#include "secrets.h"
#include "alarm_logic.h"
#include "buzzer_output.h"
#include "gsm_controller.h"
#include "radar_protocol.h"
#include "uno_link_receiver.h"

#ifndef ENABLE_BUZZER_SELF_TEST
#define ENABLE_BUZZER_SELF_TEST true
#endif
#ifndef ENABLE_GSM_CALL
#define ENABLE_GSM_CALL true
#endif
#ifndef ENABLE_DASHBOARD_TELEMETRY
#define ENABLE_DASHBOARD_TELEMETRY true
#endif

constexpr uint8_t GSM_RX_PIN = 5, GSM_TX_PIN = 4;
constexpr uint8_t UNO_TRIGGER_PIN = 12, UNO_DATA_PIN = 13;
constexpr uint8_t ALERT_LED_PIN = 0, GREEN_LED_PIN = 2, BUZZER_PIN = 14;
constexpr uint32_t RADAR_BAUD = 256000, GSM_BAUD = 9600, LINK_BAUD = 9600;
constexpr uint32_t TELEMETRY_INTERVAL_MS = 500;
constexpr int MOTION_SPEED_THRESHOLD_CM_S = 5;

SoftwareSerial gsmSerial;
SoftwareSerial unoSerial;
GsmController gsm(ALERT_PHONE_NUMBER, ENABLE_GSM_CALL);
RadarProtocol radar;
UnoLinkReceiver unoLink;
uint32_t unoLinkOverflows = 0;
AlarmLogic alarm;
BuzzerOutput buzzer(BUZZER_PIN);
constexpr char FIRMWARE_VERSION[] = "2026-09-27.1";
uint32_t bootAt = 0;
bool startupTestDone = false;
volatile uint32_t unoRiseUs = 0;
volatile bool unoHigh = false, unoCompletedPulse = false;
bool unoQualified = false, redLedOn = false, buzzerSounding = false;
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
  gsm.queueAlert(alarm.sources, now);
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
    registerAlarm(1, now);
  }
  unoQualified = qualified;
}

void serviceUnoLink(uint32_t now) {
  const bool wasOnline = unoLink.fresh(now);
  for (uint8_t i = 0; i < 64 && unoSerial.available(); ++i) {
    if (unoLink.push(static_cast<uint8_t>(unoSerial.read()), now) && !wasOnline)
      telemetryDirty = true;
  }
  if (unoSerial.overflow()) ++unoLinkOverflows;
}

void serviceRadar(uint32_t now) {
  for (unsigned i = 0; i < 256 && Serial.available(); ++i) {
    if (!radar.push(static_cast<uint8_t>(Serial.read()), now)) continue;
    for (const RadarTarget &target : radar.targets) {
      if (target.valid && abs(target.speed) >= MOTION_SPEED_THRESHOLD_CM_S) registerAlarm(2, now);
    }
  }
}

void serviceOutputs(uint32_t now) {
  const bool pulse = alarm.pulse(now);
  if (redLedOn != pulse) {
    digitalWrite(ALERT_LED_PIN, pulse ? HIGH : LOW);
    redLedOn = pulse;
  }
  if (uint32_t(now - bootAt) >= 2000) startupTestDone = true;
  const bool requested = alarm.buzzer(now) || (ENABLE_BUZZER_SELF_TEST && !startupTestDone);
  buzzer.update(requested, now, alarm.active(now) ? alarm.buzzerFrequency(now) : 4000);
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
      Serial.print(F("[Wi-Fi] Connected: "));
      Serial.println(WiFi.localIP());
      telemetryDirty = true;
    } else Serial.println(F("[Wi-Fi] Disconnected"));
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
  uno["lastFrameAgeMs"] = unoLink.seen ? now - unoLink.lastPacketAt : 60000;
  uno["frames"] = unoLink.packets;
  uno["rejected"] = unoLink.rejected;
  uno["overflows"] = unoLinkOverflows;
  uno["triggerActive"] = unoQualified;
  uno["triggerCount"] = unoTriggers;
  uno["lastTriggerAgeMs"] = unoSeen ? int32_t(now - unoLastAt) : -1;
  JsonArray unoTargets = uno["targets"].to<JsonArray>();
  if (unoLink.fresh(now) && unoLink.radarFresh) {
    for (uint8_t i = 0; i < 3; ++i) {
      const RadarTarget &target = unoLink.targets[i];
      if (!target.valid) continue;
      JsonObject t = unoTargets.add<JsonObject>();
      t["targetId"] = String("S1-T") + (i + 1);
      t["x"] = target.x / 1000.0f;
      t["y"] = target.y / 1000.0f;
      t["distance"] = sqrtf(float(target.distanceSquared())) / 1000.0f;
      t["speed"] = target.speed / 100.0f;
      t["angle"] = atan2f(target.x, target.y) * 180.0f / PI;
      t["direction"] = target.speed < 0 ? "APPROACHING" :
                       target.speed < MOTION_SPEED_THRESHOLD_CM_S ? "STATIONARY" : "MOVING AWAY";
    }
  }
  JsonObject sensor = sensors.add<JsonObject>();
  sensor["id"] = 2;
  sensor["mode"] = "uart";
  sensor["online"] = radar.fresh(now);
  sensor["lastFrameAgeMs"] = radar.seen ? now - radar.lastFrameAt : 60000;
  sensor["frames"] = radar.frames;
  JsonArray targets = sensor["targets"].to<JsonArray>();
  if (radar.fresh(now)) {
    for (uint8_t i = 0; i < 3; ++i) {
      const RadarTarget &target = radar.targets[i];
      if (!target.valid) continue;
      JsonObject t = targets.add<JsonObject>();
      t["targetId"] = String("S2-T") + (i + 1);
      t["x"] = target.x / 1000.0f;
      t["y"] = target.y / 1000.0f;
      t["distance"] = sqrtf(float(target.distanceSquared())) / 1000.0f;
      t["speed"] = target.speed / 100.0f;
      t["angle"] = atan2f(target.x, target.y) * 180.0f / PI;
      t["direction"] = abs(target.speed) < MOTION_SPEED_THRESHOLD_CM_S ? "STATIONARY" :
                       target.speed < 0 ? "APPROACHING" : "MOVING AWAY";
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
  outputs["greenLed"] = true;
  outputs["buzzer"] = buzzerSounding;
  outputs["buzzerDrive"] = buzzer.state();
  outputs["buzzerRestarts"] = buzzer.restarts;
  outputs["buzzerPattern"] = "3600/4600 Hz alternating every 150 ms";
  String result;
  serializeJson(doc, result);
  return result;
}

// Advance HTTP a little at a time. Only connect() has a bounded 80 ms wait.
WiFiClient telemetryClient;
String httpRequest, httpStatus;
size_t httpOffset = 0;
uint32_t httpStartedAt = 0, lastPostAt = 0;
bool httpBusy = false, postAttempted = false, dashboardConnected = false;
IPAddress dashboardIp;
bool dashboardAddressValid = false;

void finishPost(bool accepted) {
  telemetryClient.abort();
  httpBusy = false;
  httpRequest = "";
  httpStatus = "";
  if (dashboardConnected != accepted) {
    dashboardConnected = accepted;
    Serial.println(accepted ? F("[Dashboard] Telemetry accepted") : F("[Dashboard] Connection/request failed"));
  }
}

void serviceTelemetry(uint32_t now) {
  if (!ENABLE_DASHBOARD_TELEMETRY || !dashboardAddressValid) return;
  if (WiFi.status() != WL_CONNECTED) {
    if (httpBusy) finishPost(false);
    return;
  }
  if (httpBusy) {
    if (uint32_t(now - httpStartedAt) > 1200) { finishPost(false); return; }
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
        finishPost(code == 202);
        return;
      }
      if (ch != '\r' && httpStatus.length() < 96) httpStatus += ch;
    }
    if (!telemetryClient.connected() && !telemetryClient.available()) finishPost(false);
    return;
  }
  const uint32_t interval = dashboardConnected ? TELEMETRY_INTERVAL_MS : 2000;
  if (postAttempted && uint32_t(now - lastPostAt) < (telemetryDirty && dashboardConnected ? 100UL : interval)) return;
  postAttempted = true;
  lastPostAt = now;
  telemetryClient.setTimeout(80);
  if (!telemetryClient.connect(dashboardIp, DASHBOARD_PORT)) { finishPost(false); return; }
  telemetryClient.setNoDelay(true);
  const String body = telemetryJson(millis());
  httpRequest = String("POST /api/telemetry HTTP/1.1\r\nHost: ") + DASHBOARD_HOST +
    "\r\nConnection: close\r\nContent-Type: application/json\r\nX-Device-Key: " + DEVICE_API_KEY +
    "\r\nContent-Length: " + body.length() + "\r\n\r\n" + body;
  httpOffset = 0;
  httpStartedAt = millis();
  httpBusy = true;
  telemetryDirty = false;
}

void reportDiagnostics(uint32_t now) {
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
    lastDiagnosticAt = now;
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
  digitalWrite(ALERT_LED_PIN, LOW);
  digitalWrite(GREEN_LED_PIN, HIGH);
  buzzer.begin();
  Serial.setRxBufferSize(4096);
  Serial.begin(RADAR_BAUD);
  Serial.setDebugOutput(false);
  Serial.printf("\nDoppler master firmware %s: Radar UART 256000, buzzer GPIO14 rapid two-tone siren\n", FIRMWARE_VERSION);
  Serial.printf("[Boot] %s\n", ESP.getResetReason().c_str());
  unoHigh = digitalRead(UNO_TRIGGER_PIN) == HIGH;
  unoRiseUs = micros();
  attachInterrupt(digitalPinToInterrupt(UNO_TRIGGER_PIN), unoEdge, CHANGE);
  gsmSerial.begin(GSM_BAUD, SWSERIAL_8N1, GSM_RX_PIN, GSM_TX_PIN, false, 256, 1024);
  // Protect each 9600-baud TX byte from ordinary interrupt jitter (~1 ms).
  // The waveform NMI remains active; RX is serviced between transmitted bytes.
  gsmSerial.enableIntTx(false);
  unoSerial.begin(LINK_BAUD, SWSERIAL_8N1, UNO_DATA_PIN, -1, false, 64, 512);
  unoSerial.enableRxGPIOPullUp(false);
  gsm.begin(millis());
  WiFi.persistent(false);
  WiFi.mode(WIFI_STA);
  dashboardAddressValid = dashboardIp.fromString(DASHBOARD_HOST);
  if (!dashboardAddressValid) Serial.println(F("[Dashboard] DASHBOARD_HOST must be a LAN IPv4 address"));
  bootAt = millis();
  if (ENABLE_BUZZER_SELF_TEST) Serial.println(F("[Buzzer] Expect a 2-second startup beep; this does not send alerts"));
}

void loop() {
  const uint32_t now = millis();
  serviceUno(now);
  serviceUnoLink(now);
  serviceRadar(now);
  serviceOutputs(now);
  serviceGsm(now);
  serviceWifi(now);
  serviceTelemetry(now);
  serviceUno(millis());
  serviceUnoLink(millis());
  serviceRadar(millis());
  serviceOutputs(millis());
  reportDiagnostics(millis());
  yield();
}
