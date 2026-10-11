# Doppler Radar System

University engineering prototype using two RD-03D sensors, an Arduino Uno and an ESP8266 NodeMCU. Current active firmware: **2026-10-11.8**.

## Start the dashboard

1. Install Node.js, or use the Node runtime bundled with Codex.
2. Copy `firmware/nodemcu_master/secrets.example.h` to `secrets.h` in the same folder. Supply your Wi-Fi settings, device key and GSM recipient. The private file is ignored by Git.
3. Double-click `start.bat`. The launcher reads the device key from your private firmware configuration and opens http://localhost:8080.

Alternatively, run from this repository's root:

```powershell
$env:DOPPLER_DEVICE_KEY = 'your-device-key'
node server.js
```

The server and firmware must use the same device key. `.env.example` documents environment variables; the server does not automatically load a `.env` file.

On a fresh installation, accounts `admin`, `operator` and `viewer` start with `ChangeMe!2026`, unless `DOPPLER_INITIAL_PASSWORD` was set before the first launch. Existing account data takes precedence. Update initial passwords before deployment.

## Active hardware and upload

```text
Radar 1 TX -> Uno D0/RX (256000 baud)
Uno D7 -> existing divider -> NodeMCU D6/GPIO12 (trigger diagnostic)
Uno D8 -> existing divider -> NodeMCU D7/GPIO13 (9600-baud measured data)
Radar 2 TX -> NodeMCU RX/GPIO3 (256000 baud)
NodeMCU -> GSM, LEDs, buzzer and Wi-Fi telemetry
```

Upload both active sketches: `firmware/uno_radar_1/uno_radar_1.ino` to Arduino Uno and `firmware/nodemcu_master/nodemcu_master.ino` to NodeMCU 1.0 (ESP-12E Module). Radar TX shares board upload RX: disconnect it while uploading, then reconnect it. Keep every existing pin and divider unchanged.

Install ArduinoJson 7.x and EspSoftwareSerial for the NodeMCU. See [firmware wiring and commissioning](firmware/README.md).

## Current behavior

- Up to three actual decoded returns per sensor; the radar's configured mode determines the count. No simulated detections or fabricated human confidence.
- Separate sensor-local radar views, measured distance/bearing/radial speed, measured-position and jitter-reduced display modes, and real-position trails.
- Persistent directional movement must reach **800 mm filtered radial displacement** from its episode baseline before qualifying an alarm. A detection or trigger pin alone cannot qualify the master's alarm.
- One notification transaction per continuous track; existing GSM call option, SMS transactions and cooldown are preserved.
- Stationary returns remain visible without qualifying alarms. After four low-speed samples, an unmatched stationary track can remain for up to five seconds from its last measurement. After 1.2 seconds it is explicitly LAST SEEN, not a current confirmed measurement. Moving/unconfirmed tracks expire at 1.2 seconds.
- Repeated Uno heartbeats cannot refresh target movement history. Radar measurement sequence and communication heartbeat are tracked independently.
- Red/green LEDs indicate Wi-Fi disconnected/connected on their existing pins. Startup and Wi-Fi connection sounds are separate from the qualified-movement siren.
- NodeMCU server discovery uses Wi-Fi-subnet UDP requests and the existing device key. Both devices must share a reachable local network. Allow TCP 8080 and UDP 4210 on the Windows private network. An optional static dashboard address remains available.
- Dashboard polling and telemetry aim for 200 ms; actual network latency can be higher. Health states require recent real data.
- Recordings capture real decoded UART-slot snapshots and tracked telemetry for diagnosis and replay. Recording files remain local under `data/recordings`.

See [the current tracking update](TRACKING_UPDATE.md) for physical tests and limitations. [HANDOVER.md](HANDOVER.md) preserves the earlier restoration record; later update notes supersede historical behavior.

## Verification

Node backend checks use built-in libraries:

```powershell
node --check server.js
node --check light-ui.js
node --test tests/*.test.js
```

Actual-C++ emulator and browser regression runners are also included:

```powershell
node tests/run-avr-tests.cjs
node tests/browser-smoke.cjs
```

The AVR runner requires `avr8js` under `.build/node_modules` and the AVR compiler (`AVR_BIN` can override its location). Browser checks require Playwright (`PLAYWRIGHT_MODULE`) and Chromium (`CHROMIUM_PATH`). Test fixtures are isolated from the production dashboard and are not hardware observations.

Software compilation and regressions do not prove physical radar accuracy, audible buzzer output or SMS delivery. Bench-test the real installation.

## Backup scope

This repository contains the active firmware, GSM diagnostic, dashboard, source documentation, launcher and tests. Unused legacy ESP32 firmware/configuration, the old unused dashboard security script, machine shortcuts, private credentials, runtime accounts/events/recordings and generated build files are excluded. Existing Git history is preserved.
