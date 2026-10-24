# October 6 restoration: Uno + ESP8266 NodeMCU

## Radar 2 diagnostics: firmware 2026-10-06.4

The NodeMCU now logs Radar 2 total/incremental UART byte counts, valid frame counts,
rejected full frames, and last-valid-frame age every five seconds. If bytes arrive
without valid frames it prints the last sixteen received bytes as hexadecimal;
if no bytes arrive it states that explicitly. This distinguishes silence from
undecodable packets without changing the parser, pins or baud rate. Only the
NodeMCU sketch changed. Wi-Fi/discovery, GSM credentials and alarm policy are preserved.
Upload only the NodeMCU for this diagnostic update and provide several consecutive
`[Radar 2]` lines. `age=-1` means no valid frame has ever been decoded since boot.

## Automatic server discovery: firmware 2026-10-06.3

The NodeMCU now broadcasts a small discovery request on its actual Wi-Fi subnet
every three seconds while disconnected from the dashboard. The Node server replies
on UDP port 4210 with its real HTTP port. The NodeMCU uses the responding interface's
IP address; it does not pick a virtual adapter's IP from a list. A per-query nonce
and SHA-256 proof using the existing device key validate the reply before the
NodeMCU sends HTTP telemetry. The key is not sent in the discovery packet. Existing
HTTP device authentication remains unchanged. Discovery runs without blocking
radar/GSM loops and resumes after network/server failures.

The private `secrets.h` now leaves `DASHBOARD_HOST` empty to use discovery. Wi-Fi,
recipient and device key are preserved. Optional static LAN fallback remains supported;
set `ENABLE_DASHBOARD_DISCOVERY false` for static-only operation. No Uno change is
needed for this .3 update if its .2 tracker has already been uploaded.

Both computer and NodeMCU must be on the same local network. Permit Node.js on the
Windows private network for HTTP TCP 8080 and discovery UDP 4210. Networks with client
isolation or blocked broadcasts may require the optional static fallback. Restart
`node server.js` with the existing device key and upload the NodeMCU sketch once;
later DHCP address changes do not require a re-upload. Browser access on the computer
remains http://localhost:8080.

Changed: `discovery.js`, `server.js`, NodeMCU sketch/private/example configuration,
and `tests/discovery.test.js`. No wiring, UART or movement/alarm policy changed.

Verification: final .3 NodeMCU sketch compiled (33,880 bytes data RAM, 63,119 bytes
instruction RAM including cache, 291,052 bytes flash). All 13 discovery/backend
tests passed, including local UDP discovery and Wi-Fi-versus-virtual subnet selection.
Actual discovery between the physical NodeMCU and computer remains a bench test.

## Current reliability follow-up: firmware 2026-10-06.2

Both active sketches now use the same revised tracker. Measured speed is smoothed
with EMA 0.25 for display and movement confirmation; raw radar speed is preserved
as `rawSpeedCmS`. Raw speed direction must still agree with displacement. A zero or
opposite speed immediately suspends qualification; sustained reversals still require
three readings to reset the episode. The 800 mm threshold and per-track GSM latch remain.

Movement windows start at 400 ms but may extend to 1000 ms to gather 40 mm of valid
distance change. This improves slow 5 cm/s motion detection without accepting speed
alone. Where an alternative target/track match lies within 125 mm of the best-match
distance, association is marked AMBIGUOUS and displacement evidence is reset. This
conservative rule may delay alerts for closely spaced targets; it avoids trusting
uncertain identity. Already moving ambiguous returns use TRACKING direction. Their
notification latch remains intact, so ambiguity does not create repeat SMS.

Additional actual-C++ emulator regressions passed for slow movement, speed spikes,
immediate reversal suspension and ambiguous-association reset with latch retention.
All ten backend tests passed. The build results below describe the earlier .1 build;
the .2 sketches were separately compiled during this follow-up.

The supplied Wi-Fi credentials are saved only in the private active NodeMCU
`firmware/nodemcu_master/secrets.h`. SSID is ZANUPF; the password is not copied into
documentation. No private configuration previously existed in this checkout, so the
new file retains example dashboard address/key and an empty recipient until those
are configured. Do not assume telemetry or GSM is configured merely because Wi-Fi is.
Upload both revised active sketches, restart the backend and refresh the dashboard.

The detailed sections below document the initial .1 restoration; the changes above
supersede its speed/window/matching policy where applicable.

The owner confirmed this is the physically connected architecture. The legacy
ESP32 sketch and its PlatformIO configuration are retained but are not the active
firmware. **Upload both active sketches**, then restart the existing Node server.
NodeMCU firmware version: `2026-10-06.1`.

## Changed files

| File | Change |
| --- | --- |
| `firmware/nodemcu_master/target_tracking.h` and identical Uno copy | Three independent position-associated tracks, smoothing, movement persistence, baseline displacement, stale/stationary filtering. |
| `firmware/uno_radar_1/uno_radar_1.ino` | D7 now represents qualified 800 mm movement, in either direction; raw measured-data stream remains unchanged. |
| `firmware/nodemcu_master/nodemcu_master.ino` | Track both sensors, require measured qualification, latch notifications once per track, report track fields and rate-limited diagnostics. D6 still records trigger diagnostics. |
| `firmware/nodemcu_master/gsm_controller.h` | Bounded queue of six distinct movement events, useful SMS content, exact submitted target identification. Existing AT transactions, call policy and cooldown are preserved. |
| `server.js` | Carry tracking fields through the existing API, log actual target/progress/threshold events, clear stale returns and offline GSM status. |
| `light-ui.js`, `light-ui.css`, `doppler-radar-dashboard.html` | White engineering UI, separate calibrated-to-range local radar views, seven rings and approximate FOV per sensor, real-position trails, all-target movement cards, status, recent events and admin analytics/settings. |
| `tests/telemetry.test.js`, `tests/firmware_logic_test.cpp`, `tests/browser-smoke.cjs` | Update previous assumptions about human classification, SMS wording and the old UI. |
| `tests/tracking_firmware_test.cpp`, `tests/run-avr-tests.cjs`, `tests/movement_telemetry.test.js`, `tests/movement-browser.cjs` | New firmware and dashboard regression checks; fixtures are isolated to tests. |
| `.gitignore`, `README.md`, `firmware/README.md`, `HANDOVER.md` | Ignore build artifacts and document current policy, run steps and commissioning tests. |

## Connections confirmed unchanged in source

| Board/function | Existing connection |
| --- | --- |
| Uno Radar 1 UART | D0/RX, 256000 baud |
| Uno alarm / measured-data outputs | D7 / D8 |
| NodeMCU Radar 2 UART | RX/GPIO3, 256000 baud |
| NodeMCU Uno trigger / data inputs | D6/GPIO12 / D7/GPIO13, data at 9600 baud |
| NodeMCU GSM RX / TX | D1/GPIO5 / D2/GPIO4, 9600 baud |
| NodeMCU red / green LED | D3/GPIO0 / D4/GPIO2 |
| NodeMCU buzzer | D5/GPIO14 |

Existing dividers, common ground, credentials mechanism, packet framing, link
CRC, GSM AT commands and UART settings were not changed. No firmware was flashed
and physical connections were not measured. Neither active radar's RX connection
is added or altered.

## Final thresholds and tracking

- Accept nonzero, forward-facing measured returns within 7000 mm.
- Associate each sensor's three returns by closest measured position, independently
  of frame-slot order. Association gate is `min(1200, 250 + 2 × elapsedMs)` mm.
  Unmatched large jumps start fresh tracks and cannot inherit an old baseline.
- Process matched samples at intervals of at least 80 ms.
- Smooth distance with `filtered += 0.35 × (raw - filtered)`.
- Require at least 5 cm/s measured radial speed, four consistent samples, and
  at least 40 mm filtered movement in a window of at least 400 ms before moving
  becomes active. Speed alone cannot make a static distance active.
- Stop showing stationary movement after 1200 ms without credible distance change.
  Lose/reset a track after 1200 ms without a matched valid return. One missed frame
  does not delete it immediately.
- Reference distance starts at the first accepted return and persists throughout
  the movement episode. Stationarity resets it to the settled filtered distance.
  Three opposite-direction readings reset the baseline for a reversal.
- `displacementMm = filteredDistanceMm - baselineDistanceMm`.
  Negative means toward; positive means away. This is net displacement, not total
  path length or a sum of absolute consecutive changes.
- Alarm requires consistent speed direction, credible ongoing movement,
  signed displacement in that direction of at least **800 mm**, and radial
  displacement at least 60% of the measured position displacement from the
  episode baseline. Mostly sideways movement without this qualification stays quiet.
- Smoothing deliberately delays qualification: an exact physical 0.80 m step may
  need further fresh readings before the filtered displacement reaches 800 mm.
  Noise thresholds need validation against this particular installation.

Only active moving tracks enter the dashboard. No AI/human classification or
confidence is produced. RD-03D packets do not contain a reliable human classification
or permanent person identity. Closest-position association is lightweight tracking;
crossing or occluded targets can still be ambiguous. IDs are sensor-specific and
last only for the current tracked return.

## GSM, buzzer and LEDs

Qualifying fresh measured tracks renew the existing five-second local alarm hold.
Red flashes and the existing two-tone GPIO14 siren operates. Green stays on as the
existing running indicator. Ordinary below-threshold detections do not operate the
alarm. The existing two-second startup buzzer self-test remains and sends no SMS;
exclude this startup beep when performing the empty-area test.

The master marks a track's notification queued only when the modem queue accepts
it. It never queues that same continuous track again, even when the 30-second modem
cooldown expires or the target reverses. The latch clears when the track is genuinely
lost; reacquisition is a new event. Failed SMS attempts are not retried every frame.
Distinct events wait in a six-entry queue; events older than the existing 60-second
expiry are discarded. Network readiness and configured recipient are still required.
Calls remain governed by existing `ENABLE_GSM_CALL`: call first, release, then SMS.

SMS includes sensor, target ID, direction, filtered distance, radial displacement
and **uptime** at qualification. There is no established wall-clock source in the
firmware, so SMS never invents clock time. `gsmSent` belongs to the actual target
whose message obtained `+CMGS` and final `OK`; this means modem submission, not
confirmed receipt. See GSM for queued, failed, disabled or expired transaction status.

The legacy D6 trigger is diagnostic only in the master. It cannot bypass the measured
800 mm rule, even when an old Uno firmware is connected. Radar 1 requires the existing
D8/D7 measured-data link for qualification. Without fresh coordinates it cannot
qualify an alarm.

## Multi-target capability and honest visualization

The current decoder reads a 30-byte `AA FF 03 00 ... 55 CC` frame containing three
8-byte target slots. The existing Uno data link carries all three. Therefore up to
three real returns per sensor, six across the two sensors, are supported by this
parser. The [manufacturer's manual](https://aithinker-static.oss-cn-shenzhen.aliyuncs.com/docs/_media_old/rd-03d_multi-target_trajectory_tracking_user_manual.pdf)
describes single/three-target modes. Actual count depends on the radar's saved mode;
one-return operation is not upgraded by fabricating the other slots. Active sketches
do not transmit configuration through the disconnected radar RX lines.

The two radar drawings use separate local coordinate frames and 7 m scales. Approximate
60° sectors are visual coverage guides; physical sensor alignment has not been measured.
Markers and short trails use only received X/Y positions. Leader lines attach labels
to measured markers; label placement is not another detection. The continuously
rotating sweep is decorative and has no detection-generation path.

Production files were searched for random/demo/simulated telemetry. None feeds the
dashboard. Regression fixtures live only under `tests/` and use temporary test servers,
never the ordinary dashboard server. Analytics use retained real events only. The store
keeps 300 events; the API exposes the latest 100. Distance/speed charts show recorded
detection measurements; uptime is current telemetry, not invented uptime history.

## Offline behavior

Sensor/target freshness expires at 1200 ms including reported frame/last-seen age.
Controller heartbeat expires at 15 seconds. Stale markers clear before the controller
heartbeat deadline. GSM connected/network flags clear with controller expiry. API
failure clears live state immediately and displays CONNECTION LOST. The local alarm
can continue its existing five-second hold after the last qualifying reading.

## Run on Windows

Open PowerShell in this inner project directory, then:

```powershell
$env:DOPPLER_DEVICE_KEY = 'your-existing-device-key'
node server.js
```

Open http://localhost:8080. The same key must be configured in the existing NodeMCU
`secrets.h`. Use the computer's LAN IPv4 address in `DASHBOARD_HOST`, as before.
No real secrets were supplied in this checkout and none were invented or overwritten.
If commissioning a new checkout, copy the existing `secrets.example.h` to `secrets.h`
and supply Wi-Fi, recipient and device key. Initial accounts remain admin/operator/viewer,
using `ChangeMe!2026` unless the initial-password environment option was set. Existing
stored accounts take precedence. Administrator has Analytics, Settings and User
Management; normal accounts retain the simpler monitoring navigation.

Upload with the existing Arduino Uno / NodeMCU 1.0 board selections. Disconnect/reconnect
radar TX during flashing as already documented; do not move GPIOs or add sensor RX wires.
The old `platformio.ini` is for the retained ESP32 sketch and is not the build target
for these two active sketches.

## Verification performed here

- Uno sketch compiled with installed AVR core 1.8.8: 6518 bytes flash, 454 bytes globals.
- NodeMCU sketch compiled with ESP8266 core 3.1.2, ArduinoJson 7.4.2 and bundled
  EspSoftwareSerial, using isolated placeholder secrets: 33,560 / 80,192 bytes data RAM,
  62,991 / 65,536 bytes instruction RAM (including 32 KB cache reservation), and
  278,444 / 1,048,576 bytes flash. Instruction RAM headroom is limited. Production
  secrets were not touched.
- Ten Node backend tests passed, including authenticated HTTP, six returns,
  tracking fields, below-threshold handling, stale markers and offline GSM status.
- Actual C++ tracking/GSM code compiled with warnings as errors and executed in an
  AVR emulator. Empty/stationary/jitter, 0.3/0.7 m, toward/away, crossing/reversal,
  jump rejection, slot association, stale timeout, SMS content/submission and no-repeat
  scenarios passed. Emulator tests do not prove real sensor/modem behavior.
- Chrome desktop (1440 px) and mobile (390 px) checks passed for real-data-shaped test
  fixtures, rings, coverage, progress, admin views, stale cleanup, controller offline,
  and no JavaScript errors or horizontal page overflow. Test screenshots under `.build/`
  are explicitly fixtures, not recordings of live hardware.

```powershell
node --check server.js
node --check light-ui.js
node --test tests/telemetry.test.js tests/distributed.test.js tests/uno_tracking.test.js tests/movement_telemetry.test.js
node tests/run-avr-tests.cjs
node tests/movement-browser.cjs
```

AVR test runner requires installed AVR tools (set `AVR_BIN` elsewhere) and `avr8js` under
`.build/node_modules`. Browser tests require Playwright (set `PLAYWRIGHT_MODULE` if it is
not normally resolvable) and a Chromium executable (`CHROMIUM_PATH`). `.build` contains
local verification dependencies/artifacts, ignored from source control.

## Ten physical tests to perform

Allow startup self-test to finish. Check both sensors have increasing valid frame counts.
Watch the NodeMCU Serial Monitor at 256000 baud, active detections, threshold progress,
GSM transaction state and the recipient handset. Space distinct notification attempts
by the existing modem transaction duration and cooldown. For repeat tests, let the prior
return genuinely disappear for at least 1200 ms before starting another episode.

| Test | Procedure | Expected result |
| --- | --- | --- |
| 1 | Leave the monitored area empty after boot. | No active returns, SMS, red alarm or siren. |
| 2 | Put a stationary chair/wall/object in view. | No continuing credible movement; no GSM. |
| 3 | Enter view and stand still for several seconds. | Any initial movement settles inactive; no qualification unless prior motion already met the rule. |
| 4 | Start a fresh return and approach by 0.30 m. | Track shown after persistence; displacement below 800 mm; no GSM. |
| 5 | Start fresh and approach by 0.70 m. | Monitoring only; no GSM. |
| 6 | Start fresh and approach beyond 0.80 m continuously. | Filtered movement reaches 800 mm, APPROACHING, red/siren and one SMS transaction. Continue moving beyond cooldown to verify no repeated notification. |
| 7 | Start fresh and move away beyond 0.80 m. | Same qualification, MOVING AWAY, one SMS transaction. |
| 8 | Walk mostly sideways at roughly constant radius. | May show measured movement; no GSM unless persistent measured radial displacement reaches 800 mm and radial dominance qualifies. |
| 9 | Move in both sensor zones simultaneously. | Separate S1/S2 tracks and progress. If multi-target mode is already configured, also test two or three separated returns in one zone. |
| 10 | Disconnect NodeMCU telemetry/Wi-Fi. | Markers disappear at freshness timeout; ESP8266 OFFLINE after 15 s; GSM status goes offline; no replacement data. Stop the backend separately to check CONNECTION LOST. |

Keep the known classic Uno UART limitation in mind: requesting 256000 yields approximately
250000 baud on its 16 MHz UART. We preserved this existing baud setting. Valid frames,
multi-target mode, sound and SMS delivery must be verified on the actual hardware.
