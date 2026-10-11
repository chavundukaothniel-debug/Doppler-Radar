const test = require('node:test');
const assert = require('node:assert/strict');
const {normalizeTelemetry, telemetryState} = require('../server');

test('Wi-Fi indicator LEDs do not imply movement alarm', () => {
  const disconnected = normalizeTelemetry({outputs:{ledMode:'WIFI_STATUS',redLed:true,greenLed:false,alarmActive:false}}, telemetryState(), new Date().toISOString());
  assert.equal(disconnected.system.ledStatus, 'WI-FI DISCONNECTED');
  assert.equal(disconnected.system.alarmActive, false);
  const connectedAlarm = normalizeTelemetry({outputs:{ledMode:'WIFI_STATUS',redLed:false,greenLed:true,alarmActive:true,buzzer:true}}, telemetryState(), new Date().toISOString());
  assert.equal(connectedAlarm.system.ledStatus, 'WI-FI CONNECTED');
  assert.equal(connectedAlarm.system.alarmActive, true);
  assert.equal(connectedAlarm.system.buzzerOn, true);
});
