#include <WiFi.h>
#include <HTTPClient.h>
#include <ArduinoJson.h>
#include <SoftwareSerial.h>
#include <math.h>

#include "secrets.h"

// ESP32 connections provided for the dissertation prototype.
constexpr int RADAR_1_RX_PIN = 33;
constexpr int RADAR_1_TX_PIN = 32;
constexpr int RADAR_2_RX_PIN = 16;
constexpr int RADAR_2_TX_PIN = 17;
constexpr int GSM_RX_PIN = 14;
constexpr int GSM_TX_PIN = 12;
constexpr int RED_LED_PIN = 25;
constexpr int GREEN_LED_PIN = 26;
constexpr int BUZZER_PIN = 27;

constexpr uint32_t DEBUG_BAUD = 115200;
constexpr uint32_t RADAR_1_BAUD = 256000;
constexpr uint32_t RADAR_2_BAUD = 256000;
constexpr uint32_t GSM_BAUD = 9600;
constexpr uint32_t TELEMETRY_INTERVAL_MS = 1000;
constexpr uint32_t GSM_STATUS_INTERVAL_MS = 30000;
constexpr uint32_t WIFI_RECONNECT_INTERVAL_MS = 15000;
constexpr uint32_t ALERT_COOLDOWN_MS = 90000;
constexpr float APPROACH_ALERT_SPEED_MPS = 0.25f;
constexpr uint8_t RD03D_FRAME_SIZE = 30;
constexpr uint8_t MAX_TARGETS_PER_SENSOR = 3;

HardwareSerial radar1Uart(1);
HardwareSerial radar2Uart(2);
EspSoftwareSerial::UART gsmUart;

struct RadarTarget {
  bool valid = false;
  int16_t xMillimetres = 0;
  int16_t yMillimetres = 0;
  int16_t speedCentimetresPerSecond = 0;
  float distanceMetres = 0.0f;
  float speedMetresPerSecond = 0.0f;
  float angleDegrees = 0.0f;
};

struct RadarSensor {
  HardwareSerial *serial;
  uint8_t id;
  uint8_t frame[RD03D_FRAME_SIZE]{};
  uint8_t frameIndex = 0;
  uint32_t lastByteAt = 0;
  uint32_t lastFrameAt = 0;
  uint32_t bytesReceived = 0;
  uint32_t validFrames = 0;
  uint32_t rejectedFrames = 0;
  uint32_t lastDiagnosticsAt = 0;
  uint32_t lastReportedBytes = 0;
  uint32_t lastReportedFrames = 0;
  uint8_t recentBytes[16]{};
  uint8_t recentByteIndex = 0;
  RadarTarget targets[MAX_TARGETS_PER_SENSOR];
};

RadarSensor sensor1{&radar1Uart, 1};
RadarSensor sensor2{&radar2Uart, 2};
uint32_t telemetrySequence = 0;
uint32_t lastTelemetryAt = 0;
uint32_t lastGsmStatusAt = 0;
uint32_t lastAlertAt = 0;
uint32_t lastWiFiAttemptAt = 0;
bool wifiAttemptStarted = false;
bool dashboardTelemetryConnected = false;
wl_status_t lastWiFiStatus = WL_NO_SHIELD;
bool gsmConnected = false;
bool gsmNetworkRegistered = false;
int gsmSignal = 0;
String smsState = "NOT SENT";
String callState = "IDLE";
String lastSmsAt;
String lastCallAt;

uint16_t readU16LE(const uint8_t *bytes) {
  return static_cast<uint16_t>(bytes[0]) | (static_cast<uint16_t>(bytes[1]) << 8);
}

// RD-03D X and radial-speed fields use sign-magnitude: bit 15 set means positive.
int16_t readSignedMagnitude(const uint8_t *bytes) {
  const uint16_t raw = readU16LE(bytes);
  const int16_t magnitude = static_cast<int16_t>(raw & 0x7FFF);
  return (raw & 0x8000) ? magnitude : -magnitude;
}

bool hasRadarTarget(const RadarTarget &target) {
  return target.valid && (target.xMillimetres != 0 || target.yMillimetres != 0);
}

const char *directionFor(const RadarTarget &target) {
  if (!hasRadarTarget(target) || fabs(target.speedMetresPerSecond) < 0.02f) return "STATIONARY";
  // RD-03D negative radial speed means target velocity toward the sensor.
  return target.speedMetresPerSecond < 0.0f ? "APPROACHING" : "MOVING AWAY";
}

void clearTargets(RadarSensor &sensor) {
  for (auto &target : sensor.targets) target = RadarTarget{};
}

void decodeRadarFrame(RadarSensor &sensor) {
  clearTargets(sensor);
  for (uint8_t targetIndex = 0; targetIndex < MAX_TARGETS_PER_SENSOR; ++targetIndex) {
    const uint8_t *data = &sensor.frame[4 + (targetIndex * 8)];
    const uint16_t rawX = readU16LE(data);
    const uint16_t rawY = readU16LE(data + 2);
    if (rawX == 0 && rawY == 0) continue;

    RadarTarget &target = sensor.targets[targetIndex];
    target.valid = true;
    target.xMillimetres = readSignedMagnitude(data);
    // RD-03D Y uses the documented 0x8000 forward-distance offset.
    target.yMillimetres = static_cast<int16_t>(rawY - 0x8000);
    target.speedCentimetresPerSecond = readSignedMagnitude(data + 4);
    target.distanceMetres = sqrtf(
      static_cast<float>(target.xMillimetres) * target.xMillimetres +
      static_cast<float>(target.yMillimetres) * target.yMillimetres
    ) / 1000.0f;
    target.speedMetresPerSecond = target.speedCentimetresPerSecond / 100.0f;
    target.angleDegrees = atan2f(target.xMillimetres, target.yMillimetres) * 180.0f / PI;
  }
  sensor.lastFrameAt = millis();
}

void rememberRadarByte(RadarSensor &sensor, uint8_t value) {
  sensor.recentBytes[sensor.recentByteIndex] = value;
  sensor.recentByteIndex = (sensor.recentByteIndex + 1) % sizeof(sensor.recentBytes);
  sensor.bytesReceived++;
}

void printRecentRadarBytes(const RadarSensor &sensor) {
  const uint8_t capacity = sizeof(sensor.recentBytes);
  const uint8_t count = sensor.bytesReceived < capacity ? sensor.bytesReceived : capacity;
  const uint8_t firstIndex = sensor.bytesReceived < capacity ? 0 : sensor.recentByteIndex;
  for (uint8_t offset = 0; offset < count; ++offset) {
    const uint8_t value = sensor.recentBytes[(firstIndex + offset) % capacity];
    if (value < 0x10) Serial.print('0');
    Serial.print(value, HEX);
    Serial.print(' ');
  }
}

void reportRadarDiagnostics(RadarSensor &sensor) {
  const uint32_t now = millis();
  if (now - sensor.lastDiagnosticsAt < 2000) return;
  sensor.lastDiagnosticsAt = now;

  const uint32_t receivedSinceLastReport = sensor.bytesReceived - sensor.lastReportedBytes;
  const uint32_t framesSinceLastReport = sensor.validFrames - sensor.lastReportedFrames;
  sensor.lastReportedBytes = sensor.bytesReceived;
  sensor.lastReportedFrames = sensor.validFrames;

  Serial.printf(
    "[Radar %u] %lu baud: +%lu bytes, +%lu valid frames, %lu rejected frames.\n",
    sensor.id,
    static_cast<unsigned long>(sensor.id == 1 ? RADAR_1_BAUD : RADAR_2_BAUD),
    static_cast<unsigned long>(receivedSinceLastReport),
    static_cast<unsigned long>(framesSinceLastReport),
    static_cast<unsigned long>(sensor.rejectedFrames)
  );

  if (receivedSinceLastReport == 0) {
    Serial.printf("[Radar %u] No UART data. Check 3.3V, common GND, and radar TX-to-ESP RX wiring.\n", sensor.id);
  } else if (framesSinceLastReport == 0) {
    Serial.printf("[Radar %u] Raw UART tail: ", sensor.id);
    printRecentRadarBytes(sensor);
    Serial.println();
    Serial.printf("[Radar %u] Bytes arrived, but no AA FF 03 00 ... 55 CC RD-03D frame matched.\n", sensor.id);
  }
}

void consumeRadarBytes(RadarSensor &sensor) {
  while (sensor.serial->available()) {
    const uint8_t value = static_cast<uint8_t>(sensor.serial->read());
    rememberRadarByte(sensor, value);
    const uint32_t now = millis();
    if (sensor.frameIndex > 0 && now - sensor.lastByteAt > 100) sensor.frameIndex = 0;
    sensor.lastByteAt = now;

    if (sensor.frameIndex == 0 && value != 0xAA) continue;
    if (sensor.frameIndex == 1 && value != 0xFF) { sensor.frameIndex = 0; continue; }
    if (sensor.frameIndex == 2 && value != 0x03) { sensor.frameIndex = 0; continue; }
    if (sensor.frameIndex == 3 && value != 0x00) { sensor.frameIndex = 0; continue; }

    sensor.frame[sensor.frameIndex++] = value;
    if (sensor.frameIndex != RD03D_FRAME_SIZE) continue;
    if (sensor.frame[28] == 0x55 && sensor.frame[29] == 0xCC) {
      sensor.validFrames++;
      decodeRadarFrame(sensor);
    } else {
      sensor.rejectedFrames++;
    }
    sensor.frameIndex = 0;
  }
}

void serviceRadar() {
  consumeRadarBytes(sensor1);
  consumeRadarBytes(sensor2);
}

void enableRd03dMultiTargetMode(HardwareSerial &serial) {
  const uint8_t command[] = {0xFD, 0xFC, 0xFB, 0xFA, 0x02, 0x00, 0x90, 0x00, 0x04, 0x03, 0x02, 0x01};
  serial.write(command, sizeof(command));
  serial.flush();
}

String collectGsmResponse(uint32_t timeoutMs) {
  String response;
  const uint32_t started = millis();
  while (millis() - started < timeoutMs) {
    serviceRadar();
    while (gsmUart.available()) response += static_cast<char>(gsmUart.read());
    delay(5);
  }
  return response;
}

bool executeGsmCommand(const String &command, const char *expected, uint32_t timeoutMs = 1500) {
  while (gsmUart.available()) gsmUart.read();
  gsmUart.println(command);
  const String response = collectGsmResponse(timeoutMs);
  return response.indexOf(expected) >= 0 && response.indexOf("ERROR") < 0;
}

String gsmQuery(const String &command, uint32_t timeoutMs = 1500) {
  while (gsmUart.available()) gsmUart.read();
  gsmUart.println(command);
  return collectGsmResponse(timeoutMs);
}

void refreshGsmStatus() {
  gsmConnected = executeGsmCommand("AT", "OK");
  if (!gsmConnected) {
    gsmNetworkRegistered = false;
    gsmSignal = 0;
    return;
  }
  const String registration = gsmQuery("AT+CREG?");
  gsmNetworkRegistered = registration.indexOf(",1") >= 0 || registration.indexOf(",5") >= 0;
  const String signal = gsmQuery("AT+CSQ");
  const int marker = signal.indexOf("+CSQ:");
  if (marker >= 0) gsmSignal = signal.substring(marker + 5).toInt();
}

String eventTimestamp() {
  return String(millis() / 1000UL) + "s uptime";
}

bool sendSecuritySms(const RadarSensor &sensor, const RadarTarget &target) {
  if (!gsmConnected || !gsmNetworkRegistered || String(ALERT_PHONE_NUMBER).length() < 8) return false;
  if (!executeGsmCommand("AT+CMGF=1", "OK")) return false;

  while (gsmUart.available()) gsmUart.read();
  gsmUart.print("AT+CMGS=\"");
  gsmUart.print(ALERT_PHONE_NUMBER);
  gsmUart.print("\"\r");
  const String prompt = collectGsmResponse(3000);
  if (prompt.indexOf('>') < 0) return false;

  gsmUart.print("Doppler Radar alert: approaching target on sensor ");
  gsmUart.print(sensor.id);
  gsmUart.print(", distance ");
  gsmUart.print(target.distanceMetres, 2);
  gsmUart.print(" m, speed ");
  gsmUart.print(target.speedMetresPerSecond, 2);
  gsmUart.print(" m/s.");
  gsmUart.write(static_cast<uint8_t>(26));
  const String result = collectGsmResponse(10000);
  if (result.indexOf("+CMGS:") < 0 && result.indexOf("OK") < 0) return false;
  smsState = "SENT";
  lastSmsAt = eventTimestamp();
  return true;
}

bool placeSecurityCall() {
  if (!ENABLE_GSM_CALL || !gsmConnected || !gsmNetworkRegistered || String(ALERT_PHONE_NUMBER).length() < 8) return false;
  const bool placed = executeGsmCommand(String("ATD") + ALERT_PHONE_NUMBER + ";", "OK", 5000);
  if (placed) {
    callState = "PLACED";
    lastCallAt = eventTimestamp();
  }
  return placed;
}

bool hasApproachingThreat(RadarSensor &sensor, RadarTarget *&threat) {
  for (auto &target : sensor.targets) {
    if (hasRadarTarget(target) && target.speedMetresPerSecond <= -APPROACH_ALERT_SPEED_MPS) {
      threat = &target;
      return true;
    }
  }
  return false;
}

void updateSecurityOutputs() {
  RadarTarget *threat = nullptr;
  RadarSensor *threatSensor = nullptr;
  if (hasApproachingThreat(sensor1, threat)) threatSensor = &sensor1;
  else if (hasApproachingThreat(sensor2, threat)) threatSensor = &sensor2;

  const bool alert = threatSensor != nullptr;
  digitalWrite(RED_LED_PIN, alert ? HIGH : LOW);
  digitalWrite(GREEN_LED_PIN, WiFi.status() == WL_CONNECTED && gsmConnected ? HIGH : LOW);
  digitalWrite(BUZZER_PIN, alert ? HIGH : LOW);

  if (alert && (lastAlertAt == 0 || millis() - lastAlertAt >= ALERT_COOLDOWN_MS)) {
    smsState = "SENDING";
    if (!sendSecuritySms(*threatSensor, *threat)) smsState = "FAILED";
    placeSecurityCall();
    lastAlertAt = millis();
  }
}

void addSensorJson(JsonArray sensors, const RadarSensor &sensor) {
  JsonObject output = sensors.add<JsonObject>();
  output["id"] = sensor.id;
  output["online"] = sensor.lastFrameAt > 0 && millis() - sensor.lastFrameAt < 5000;
  output["lastFrameAgeMs"] = sensor.lastFrameAt ? millis() - sensor.lastFrameAt : 60000;
  JsonArray targets = output.createNestedArray("targets");
  uint8_t targetNumber = 0;
  for (const auto &target : sensor.targets) {
    if (!hasRadarTarget(target)) continue;
    JsonObject result = targets.createNestedObject();
    result["targetId"] = String("S") + sensor.id + "-T" + (++targetNumber);
    result["x"] = target.xMillimetres / 1000.0f;
    result["y"] = target.yMillimetres / 1000.0f;
    result["distance"] = target.distanceMetres;
    result["speed"] = target.speedMetresPerSecond;
    result["angle"] = target.angleDegrees;
    result["direction"] = directionFor(target);
  }
}

void postTelemetry() {
  if (WiFi.status() != WL_CONNECTED) return;

  StaticJsonDocument<4096> document;
  document["deviceId"] = "doppler-radar-01";
  document["sequence"] = ++telemetrySequence;
  document["uptimeSeconds"] = millis() / 1000UL;
  JsonObject wifi = document.createNestedObject("wifi");
  wifi["rssi"] = WiFi.RSSI();
  JsonArray sensorOutput = document.createNestedArray("sensors");
  addSensorJson(sensorOutput, sensor1);
  addSensorJson(sensorOutput, sensor2);
  JsonObject gsm = document.createNestedObject("gsm");
  gsm["connected"] = gsmConnected;
  gsm["network"] = gsmNetworkRegistered;
  gsm["signal"] = gsmSignal;
  gsm["sms"] = smsState;
  gsm["call"] = callState;
  gsm["lastSms"] = lastSmsAt;
  gsm["lastCall"] = lastCallAt;
  JsonObject outputs = document.createNestedObject("outputs");
  outputs["redLed"] = digitalRead(RED_LED_PIN) == HIGH;
  outputs["greenLed"] = digitalRead(GREEN_LED_PIN) == HIGH;
  outputs["buzzer"] = digitalRead(BUZZER_PIN) == HIGH;

  String body;
  serializeJson(document, body);
  HTTPClient http;
  http.setConnectTimeout(1000);
  http.setTimeout(1500);
  const String endpoint = String("http://") + DASHBOARD_HOST + ":" + DASHBOARD_PORT + "/api/telemetry";
  http.begin(endpoint);
  http.addHeader("Content-Type", "application/json");
  http.addHeader("X-Device-Key", DEVICE_API_KEY);
  const int code = http.POST(body);
  if (code >= 200 && code < 300) {
    if (!dashboardTelemetryConnected) {
      Serial.printf("[Dashboard] Telemetry accepted (HTTP %d). Live dashboard link is active.\n", code);
      dashboardTelemetryConnected = true;
    }
  } else {
    Serial.printf("[Dashboard] Telemetry POST failed: %d\n", code);
    dashboardTelemetryConnected = false;
  }
  http.end();
}

void reportWiFiStatus() {
  const wl_status_t status = WiFi.status();
  if (status == lastWiFiStatus) return;
  lastWiFiStatus = status;

  if (status == WL_CONNECTED) {
    Serial.println("[Wi-Fi] Connected.");
    Serial.print("[Wi-Fi] IP address: ");
    Serial.println(WiFi.localIP());
    Serial.print("[Wi-Fi] Signal strength: ");
    Serial.print(WiFi.RSSI());
    Serial.println(" dBm");
    Serial.printf("[Dashboard] Posting to http://%s:%d/api/telemetry\n", DASHBOARD_HOST, DASHBOARD_PORT);
    return;
  }

  dashboardTelemetryConnected = false;
  if (status == WL_NO_SSID_AVAIL) Serial.println("[Wi-Fi] Network not found. Check WIFI_SSID.");
  else if (status == WL_CONNECT_FAILED) Serial.println("[Wi-Fi] Connection failed. Check WIFI_PASSWORD and signal.");
  else if (status == WL_CONNECTION_LOST) Serial.println("[Wi-Fi] Connection lost. Telemetry paused.");
  else if (status == WL_IDLE_STATUS) Serial.println("[Wi-Fi] Connecting...");
  else if (status == WL_DISCONNECTED) Serial.println("[Wi-Fi] Disconnected. Reconnect will be attempted.");
}

void ensureWiFi() {
  if (WiFi.status() == WL_CONNECTED) return;
  if (wifiAttemptStarted && millis() - lastWiFiAttemptAt < WIFI_RECONNECT_INTERVAL_MS) return;

  Serial.printf("[Wi-Fi] Attempting connection to %s...\n", WIFI_SSID);
  WiFi.mode(WIFI_STA);
  WiFi.begin(WIFI_SSID, WIFI_PASSWORD);
  wifiAttemptStarted = true;
  lastWiFiAttemptAt = millis();
}

void setup() {
  pinMode(RED_LED_PIN, OUTPUT);
  pinMode(GREEN_LED_PIN, OUTPUT);
  pinMode(BUZZER_PIN, OUTPUT);
  digitalWrite(RED_LED_PIN, LOW);
  digitalWrite(GREEN_LED_PIN, LOW);
  digitalWrite(BUZZER_PIN, LOW);

  Serial.begin(DEBUG_BAUD);
  delay(300);
  Serial.println();
  Serial.println("=== Doppler Radar System starting ===");
  Serial.println("[Serial] Open Serial Monitor at 115200 baud.");
  Serial.printf("[Radar 1] UART %lu baud: ESP RX GPIO 33 <- radar TX, ESP TX GPIO 32 -> radar RX.\n", static_cast<unsigned long>(RADAR_1_BAUD));
  Serial.printf("[Radar 2] UART %lu baud: ESP RX GPIO 16 <- radar TX, ESP TX GPIO 17 -> radar RX.\n", static_cast<unsigned long>(RADAR_2_BAUD));
  Serial.println("[Radar] Two-second UART diagnostics will report received bytes and valid RD-03D frames.");
  radar1Uart.setRxBufferSize(4096);
  radar2Uart.setRxBufferSize(4096);
  radar1Uart.begin(RADAR_1_BAUD, SERIAL_8N1, RADAR_1_RX_PIN, RADAR_1_TX_PIN);
  radar2Uart.begin(RADAR_2_BAUD, SERIAL_8N1, RADAR_2_RX_PIN, RADAR_2_TX_PIN);
  gsmUart.begin(GSM_BAUD, SWSERIAL_8N1, GSM_RX_PIN, GSM_TX_PIN, false, 256);

  enableRd03dMultiTargetMode(radar1Uart);
  enableRd03dMultiTargetMode(radar2Uart);
  ensureWiFi();
  reportWiFiStatus();
  refreshGsmStatus();
  lastGsmStatusAt = millis();
}

void loop() {
  serviceRadar();
  reportRadarDiagnostics(sensor1);
  reportRadarDiagnostics(sensor2);
  ensureWiFi();
  reportWiFiStatus();
  if (WiFi.status() == WL_CONNECTED) wifiAttemptStarted = false;

  if (millis() - lastGsmStatusAt >= GSM_STATUS_INTERVAL_MS) {
    refreshGsmStatus();
    lastGsmStatusAt = millis();
  }

  updateSecurityOutputs();
  if (millis() - lastTelemetryAt >= TELEMETRY_INTERVAL_MS) {
    postTelemetry();
    lastTelemetryAt = millis();
  }
}
