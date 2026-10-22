# Render telemetry and co-facing radar update — 22 October 2026

The existing local `DEVICE_API_KEY` passed authentication on the live Render endpoint. A deliberately invalid array body returned HTTP 400 after authentication, so no synthetic telemetry was stored. The key is unchanged and is not copied into documentation. NodeMCU configuration now uses `doppler-radar.onrender.com:443`, HTTPS with CA and hostname validation, and NTP for certificate dates. LAN discovery is disabled. Keep Render's `DOPPLER_DEVICE_KEY` equal to the existing secret.

## Alerts

- Fresh, confirmed movement initiates an alert at any detected range. Noise and unconfirmed movement do not send alerts.
- A confirmed approaching target at **both measured and filtered distance <=4.000 m** starts a call first. Away-moving targets and targets above 4 m receive SMS only.
- There is no 10-second delay. The controller dials when the modem is ready and starts SMS on the next service cycle after the call ends or fails. Calls retain their existing 20-second maximum duration. No extra post-call wait is inserted. If release cannot be confirmed even after the fallback hangup command, SMS is marked failed rather than sending commands into an uncertain call state.
- Crossing into 4 m after an earlier far-range SMS permits a new close-range call/SMS sequence. Existing 30-second modem cooldown applies between SMS transactions. A continuous target is otherwise latched against repeated notifications.
- Each scene SMS gives distinct target count, track references, directions and distances; scenes of up to three targets also include radial speed in cm/s. Larger scenes use `IN` (toward), `OUT` (away), `STOP`, or `?` (uncertain) to keep all six references within one GSM text. This is radar target tracking, not human/object classification.

Example:

```text
RADAR: 2 targets
S1T1 APPROACHING 3.2m -50cm/s
S1T2 MOVING AWAY 5.1m 40cm/s
```

## Matching overlapping observations

Firmware and dashboard use maximum-cardinality, minimum-distance one-to-one association across the two sensors, with a 350 mm position gate and compatible radial velocity. Firmware projects measurements to the current timestamp before matching. Opposite signed motion is not merged; multiple returns from one sensor are never collapsed. Fused observations share notification latches. The dashboard counts each matched pair once overall, while showing it in both sensor panels.

This assumes co-facing, approximately aligned sensors less than 100 mm apart. The gate includes mounting separation and measurement noise; it needs validation with recorded real scenes. Two very close targets moving together can remain ambiguous. Sensor handoff may change the displayed track reference. Each RD-03D frame has three target slots: six distinct returns across two sensors are supported, but three overlapping targets are usually the shared-view limit. Software cannot recover targets the radar does not report. Existing wiring is receive-only, so sensor multi-target mode must already be enabled using the manufacturer's setup tool.

References: [Ai-Thinker multi-target manual](https://docs.ai-thinker.com/_media/rd-03d_multi-target_trajectory_tracking_user_manual.pdf), [ESP8266 secure client](https://github.com/esp8266/Arduino/blob/master/doc/esp8266wifi/bearssl-client-secure-class.rst).

## Deployment and physical verification

Upload the NodeMCU sketch; deploy `server.js`, `target-fusion.js`, and `light-ui.js` together to Render. The local secrets file is ignored and must stay private. A clean firmware checkout needs its own configured `secrets.h`. No USB serial device was present during this update, and the Render application deployment was not available from this workspace.

Verify serial diagnostics show `[Dashboard] Telemetry accepted` and HTTP 202, then check the authenticated dashboard with real targets. Test one person seen by both sensors, two people in opposite directions, >4 m SMS-only, approaching across 4 m, lost target before dialling, call failure followed by SMS, and failed SMS. TLS connection establishment on ESP8266 is synchronous and can delay sensor servicing and call timing, especially after Wi-Fi loss; hardware testing must establish acceptable tracking continuity on the actual network. Software tests do not validate GSM delivery or physical radar separation.
