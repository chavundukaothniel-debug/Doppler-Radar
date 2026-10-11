# October 11 tracking update — firmware 2026-10-11.8

Stationary follow-up: continuously measured stationary targets stay visible without needing movement. After four zero/low-radial-speed samples, a track can survive missing target returns for up to five seconds from its last measurement. Between 1.2 and 5 seconds it is a dim, dashed **LAST SEEN** marker, not a confirmed current detection. It retains its ID on a nearby return; movement evidence resets across a gap. After five seconds without a return, or when its sensor reports offline, it clears. Moving/unconfirmed tracks still expire at 1.2 seconds. Missing measurements cannot renew movement alarms or send notifications. This behavior requires both updated sketches; the dashboard does not extend older firmware's deleted targets.

This update targets jumping nodes and confusing position displays. Physical accuracy has not been measured here; software checks and browser fixtures cannot establish accuracy in your room.

## Install

1. Upload `firmware/uno_radar_1/uno_radar_1.ino` to the Uno. Disconnect Radar 1 TX from Uno D0 during upload, then reconnect it.
2. Upload `firmware/nodemcu_master/nodemcu_master.ino` to the NodeMCU. Disconnect Radar 2 TX from GPIO 3 during upload, then reconnect it. Keep the existing `secrets.h`.
3. Upload BOTH sketches for the new measurement-sequence behavior. An older Uno increments the sequence for every link heartbeat and cannot provide this fix.
4. Restart the dashboard using the outer folder's `start.bat`, then refresh your browser. Confirm `2026-10-11.8` in System Status.

## What changed

- Forward-facing radar fan with −60° to +60° angle guides, equal X/Y scale, and the sensor at the bottom. The operating range remains 7 m. Coverage guides do not exclude measured returns outside that angle.
- NodeMCU telemetry and browser polling aim for 200 ms instead of 500 ms. Network delays can lower the actual refresh rate.
- `Reduce jitter` applies a short, adaptive display filter. Its time constant is 180 ms and its maximum difference from the latest measured position is 120 mm. It processes each distinct measurement once, resets on ambiguity or stale gaps, and clears when the target disappears. It does not predict motion or hold nodes beyond the existing freshness timeout.
- `Measured position` immediately plots unfiltered X/Y. Hover a node for measured millimetre-resolution coordinates; the readings list shows measured distance, bearing and radial speed. Recorded measurements and alarm calculations are unchanged by the display filter.
- The server preserves millimetre coordinates rather than rounding them to centimetres. More retained digits do not establish millimetre sensor accuracy.
- Radar 1 now sends its radar-frame sequence in the existing checksummed link packet. A repeated heartbeat no longer updates tracking persistence, distance smoothing or target last-seen time. Link heartbeat and measurement freshness are tracked separately.
- Ambiguous track identity has a dashed marker outline and an explicit reading-list status.

The 800 mm movement alarm, notification latch, GSM policy, wiring, credentials and sensor configuration remain unchanged. No firmware was uploaded during this work.

## Check actual results

Keep each sensor fixed in place. Test Sensor 1 and Sensor 2 separately before testing them together. The tutorial's [written guide](https://core-electronics.com.au/guides/how-to-add-mmwave-radar-to-a-pico-to-detect-and-track-humans/) describes wall/TV reflections, possible interference between sensors and mounting between chest and head height. Its video also contains ghost returns; matching its appearance cannot guarantee identical accuracy.

Use **Recordings** to capture separate labelled tests:

1. Empty area for 60 seconds, after the startup self-test.
2. One person standing at tape-measured 1 m, 2 m and 3 m on the centre line, 15 seconds each. Put the true distance and sensor number in each recording label.
3. A slow approach/departure, followed by a sideways crossing. Compare Reduce jitter and Measured position.
4. Repeat the same tests with both sensors powered and fixed in their normal positions.

Compare the decoded slots in replay against the displayed tracks. If the decoded coordinates jump or disappear too, the fault is before the dashboard filter. If only the track ID changes, association is the likely issue. For Radar 2, inspect valid/rejected UART frame diagnostics. Radar 1 link packet counts alone do not prove the Uno is decoding every radar frame.

A classic 16 MHz Uno runs the requested 256000-baud UART at approximately 250000 baud. If Radar 1 loses decoded frames, a dashboard filter cannot fix that hardware timing constraint. Further filtering or controller changes should be based on the separate sensor tests rather than assuming the room or wiring is the cause.

## Verification

25 Node regression tests passed, including stationary grace periods, display filtering, measurement identity, millimetre preservation, stale cleanup and authenticated telemetry/recordings. The actual C++ tracker/GSM code passed AVR emulator tests, including continuous zero-speed tracking, stationary reacquisition, five-second expiry, repeated Uno heartbeat rejection and frame-sequence wrap. Desktop and 390 px mobile browser checks passed with six test-fixture targets, stationary LAST SEEN markers and reacquisition, and no page errors. Both active sketches compiled: Uno used 8814 bytes flash and 498 bytes global RAM; NodeMCU used 34396 bytes data RAM, 63119 bytes instruction RAM including cache, and 293160 bytes flash. NodeMCU verification used an isolated copy with dummy credentials.

The saved dashboard screenshots under `.build/` use test fixtures, not live hardware measurements.
