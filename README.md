# Doppler Radar System

University engineering prototype using two RD-03D sensors, an Arduino Uno and an ESP8266 NodeMCU. Current active firmware: **2026-10-24.4**.

## Published dashboard (Render)

Repository root now contains package.json and render.yaml. Build: npm install --omit=dev. Start: npm start. The server binds Render's PORT on 0.0.0.0. Open https://doppler-radar.onrender.com on a phone or computer after deploying main. Render changes are left to the owner.

Set DOPPLER_DEVICE_KEY in Render to exactly the DEVICE_API_KEY in private firmware/nodemcu_master/secrets.h. Set DOPPLER_INITIAL_PASSWORD before first launch; sign in as admin and change the password. Without a persistent Render disk, account changes and recordings reset on redeployment.

Upload the updated NodeMCU sketch: it defaults to verified HTTPS to doppler-radar.onrender.com:443, including hostname resolution and time synchronization. Public CA roots are bundled; no certificate filesystem upload is needed. Existing Wi-Fi, phone and device key stay private. DASHBOARD_TLS false restores local HTTP/discovery mode. Never put an https:// prefix into DASHBOARD_HOST. TLS can pause acquisition during connection handshakes; verify with the hardware, especially at cold start.

## Shared objects and SMS

The master fuses co-facing sensors into one tracking list (up to six unique objects). Cross-sensor matches require distance within 200 mm, position within 350 mm, compatible motion, and one-to-one pairing. Separate returns from one sensor are never merged. Opposite-moving returns remain separate. Identical overlapping targets cannot be reliably distinguished by these sensors. Adjust matching tolerances after bench testing the actual mounting.

Each qualified movement SMS includes all currently moving object IDs and directions plus the number of fresh stationary objects, with every field on a separate line: target ID, direction, distance (m), speed (m/s), movement (m), then the stationary count. Larger scenes are sent as consecutive texts of at most 160 characters, split at line breaks without repeating the call. Stationary returns never initiate an SMS. The existing 800 mm movement threshold, persistence checks, modem call sequence and cooldown remain. Summaries describe the scene when queued; delivery can occur later during the existing modem cooldown. The dashboard lists shared IDs once; per-sensor raw slots remain available in recordings.

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

## History PDF downloads and test results

**Event History** (or **Alerts** for Viewers) now filters all retained events by local start/end date and time, event type and sensor reference, with a direct **Download PDF** button. Reports include every match across screen pages. The latest 10,000 events are retained; older events previously discarded are unavailable.

Use **Recordings** to capture telemetry during a test, then **Test Results** to enter actual people counts, expected/observed alarms, paired distances, alarm delay, phone-confirmed SMS receipt and notes. The page includes a test checklist, saved-result editing, areas to improve, and a separate PDF report with time/sensor filters. See [the data collection guide](DATA_COLLECTION.md) for the full procedure and field examples. Restart the server and refresh the browser after this update. A public Render installation requires deploying the updated files and persistent data storage.

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

## HTTPS memory update (24 October)

Firmware 2026-10-24.3 reduces the UART receive allocation to 4096 bytes, SoftwareSerial edge queues to 256 entries each, and pending scene queue to two complete scenes. A full queue returns false so unqueued targets retry. This frees approximately 12 KiB versus the prior firmware for TLS buffers. Each scene still includes up to six unique objects. Certificate and hostname verification remain enabled, with full 16 KiB TLS receive records. Actual free heap and secure connection success must be checked on the powered device. Synchronous handshakes can overflow serial queues; frames with gaps must be reacquired rather than interpreted as movement.

## Required Arduino memory setting for HTTPS

Before uploading NodeMCU firmware 2026-10-24.4 or newer, select Tools > MMU > 16KB cache + 48KB IRAM and 2nd Heap (shared). The ESP8266 BearSSL allocator prefers this additional heap for TLS input/output buffers, leaving ordinary RAM for certificate validation and tracking. HTTPS builds intentionally fail with a descriptive error if this setting is absent. Local HTTP builds do not require it. Telemetry JSON is constructed before the TLS handshake, checked for allocation failures, and transmitted in separate header/body buffers without duplicating the full body. The firmware defers connections if ordinary RAM is critically low. This prevents a known certificate-validator allocation failure; real connection success still requires checking the device log.

## Combined dashboard coverage view

The dashboard and Live Radar pages now show one large shared radar instead of two panels. Shared telemetry IDs are plotted once, with per-sensor health retained below. The display uses a common approximate origin because mounting offsets are not calibrated.

Ai-Thinker specifies horizontal azimuth +/-60 degrees (120 degrees total): https://en.ai-thinker.com/Uploads/file/20231016/20231016032622_13559.pdf . Parallel side-by-side sensors keep this nominal angular coverage. Using 0.10 m as the upper bound on their separation, at forward depth y = R/2 the ideal-sector union has width W = 2*y*tan(60 degrees)+0.10. The midpoint angular span at this plane is 2*atan(W/(2*y)). For R=7 m, y=3.50 m, W=12.22 m, and span approximately 120.4 degrees. This is a geometric upper-bound estimate, not measured usable coverage; actual spacing, installation and casing affect detection. The existing software range limit remains 7 m.

Validated with all 27 Node tests and desktop/mobile browser fixtures, including six objects, one shared field, direction arrows, zoom, stale cleanup and offline recovery.

## Stationary scene confirmation and cloud refresh

Shared cloud scenes now confirm stationary objects across at least two independent fresh observations, at least 0.5 s apart in total. One-packet stationary returns and ambiguous associations are excluded from the confirmed count. Repeated upload sequence numbers or unchanged measurement timestamps cannot create confirmation. A conservative one-to-one association within 0.35 m stabilizes stationary display references across changing firmware IDs; nearby competing matches remain unconfirmed. The current firmware reference remains available as Device / SMS reference where it differs. No coordinates or alarms are invented.

Confirmed readings remain visible for at least 3.5 s between normal two-second uploads. After 1.2 s they are explicitly LAST SEEN, with moving/alarm qualification cleared. The ten-second stationary-memory update below supersedes the earlier immediate-clear behavior for missing stationary observations. Per-sensor counts retain their raw observation meaning; the combined view uses the confirmed scene count. Stationary-only direction noise no longer generates repeated direction events. Existing historical events are retained.

The browser polls every 0.5 s and avoids replacing the page contents when only age counters changed. This is a display/server change and needs no firmware upload. Persistent multipath reflections can still repeat and pass confirmation: a real empty-area test remains necessary to distinguish installation effects. Firmware movement/SMS thresholds and alarm behavior are unchanged.

## Ten-second stationary memory and movement arrows (current behavior)

Confirmed stationary locations are retained for ten seconds from the last independent measurement even if an intervening scene has no returns. A held location is marked LAST SEEN and cannot qualify an alert. Repeated uploads never refresh its measurement clock. Fresh unchanged observations restart the ten-second timer; matched changed positions replace the prior position. Reboot or device change resets display memory. Unmatched readings remain uncertain; the software cannot prove physical identity when targets overlap.

Position changes with at least 0.15 m lateral displacement and at most 0.15 m radial change over up to four seconds are shown as SIDEWAYS LEFT/RIGHT with an estimated lateral speed. They do not qualify an alert. This is display inference from measured positions, not a new firmware motion alarm. Approaching and receding motion now have blue radial arrows before the existing alarm threshold, and red arrows when alarm-qualified. Stale readings have no movement arrows. The installed firmware and GSM behavior are unchanged; this dashboard-only update requires no board upload.

Validated by all 36 Node tests and a browser test covering confirmed stationary memory, sideways position replacement without an alarm, approaching arrow before alarm qualification, and mobile layout.
