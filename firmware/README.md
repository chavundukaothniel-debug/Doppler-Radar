# Distributed Uno + NodeMCU Firmware

This directory now contains the two-board replacement for the failed ESP32 design.

| Sketch | Board | Responsibility |
| --- | --- | --- |
| [`uno_radar_1.ino`](uno_radar_1/uno_radar_1.ino) | Arduino Uno | Reads Radar 1, sends a one-second 5 V alarm trigger on D7, and streams measured targets on D8. |
| [`nodemcu_master.ino`](nodemcu_master/nodemcu_master.ino) | ESP8266 NodeMCU | Reads Radar 2, accepts the Uno trigger and target data, operates LEDs/buzzer/GSM, and posts dashboard telemetry. |

The legacy ESP32 sketch remains in `doppler_radar/`; do not upload it to either replacement board.

## Wiring

All devices, including the GSM external supply, must share one ground.

### Arduino Uno: Radar 1 processor

| Connection | Wiring |
| --- | --- |
| Radar 1 TX | Uno D0 / RX |
| Uno detection output | Uno D7 |
| Uno D7 to NodeMCU D6 | Uno D7 -> 10 kOhm -> NodeMCU D6; NodeMCU D6 -> 20 kOhm -> GND |
| Uno D8 to NodeMCU D7 | Uno D8 -> 10 kOhm -> NodeMCU D7/GPIO13; NodeMCU D7 -> 20 kOhm -> GND |
| Radar 1 power | 3.3 V and common GND, according to the radar board specification |

Each divider produces approximately 3.33 V from a 5 V Uno HIGH. Both grounds must be common. Do **not** connect either Uno output directly to the ESP8266. Keep the existing D7/D6 trigger and the new D8/D7 data wire separate.

Radar 1 RX is intentionally not used. The Uno's D1/TX is 5 V, while RD-03D logic is 3.3 V; leaving it disconnected avoids sending an unsafe configuration signal to the radar.

### NodeMCU: master controller

| Connection | NodeMCU pin |
| --- | --- |
| Radar 2 TX | RX / GPIO 3 |
| GSM TX | D1 / GPIO 5 |
| GSM RX | D2 / GPIO 4 |
| Uno trigger after divider | D6 / GPIO 12 |
| Uno measured-data link after divider | D7 / GPIO 13 |
| Alert LED | D3 / GPIO 0 |
| Green LED | D4 / GPIO 2 |
| Passive buzzer | Positive to D5 / GPIO 14; negative to common GND |

Use a series resistor for each external LED. GPIO 0 and GPIO 2 are ESP8266 boot-strapping pins: LED wiring must not force either pin low during reset. Check the GSM module RX logic level and power the modem from a supply rated for its current peaks, never from the NodeMCU 3.3 V output.

## Upload And Configure

1. In Arduino IDE, open `firmware/uno_radar_1/uno_radar_1.ino`; choose **Arduino Uno**. Upload this revised sketch even if D7 triggers already work; D8 will otherwise have no target data.
2. Disconnect Radar 1 TX from Uno D0/RX while uploading. Reconnect it after the upload. The Uno USB connection and Radar 1 share this UART.
3. Open `firmware/nodemcu_master/secrets.example.h`, duplicate it as `secrets.h` in the same folder, and set Wi-Fi, dashboard IP, device key, and eventually the alert phone number.
4. Open `firmware/nodemcu_master/nodemcu_master.ino`; choose **NodeMCU 1.0 (ESP-12E Module)**. Upload this revised sketch too.
5. Disconnect Radar 2 TX from NodeMCU GPIO 3 while uploading. Reconnect it after the upload.
6. Install ArduinoJson 7.x and EspSoftwareSerial for the NodeMCU. Restart the dashboard backend after the firmware/backend update, refresh the browser, then power both boards.

Existing Wi-Fi, API key, and recipient settings in `nodemcu_master/secrets.h` are preserved. Use a digits-only local recipient or international `+countrycode...` format, without spaces. International format is recommended when supported by the SIM/network. Calls now default to enabled; add `#define ENABLE_GSM_CALL false` in `secrets.h` to turn them off.

A stock 16 MHz Uno cannot generate exactly 256000 baud: its AVR UART divisor yields 250000 baud (2.34% slow) when `Serial.begin(256000)` is requested. Confirm that Radar 1 frames actually decode and D7 triggers before relying on its alerts. If they do not, use a controller with a UART clock that can reliably match the radar; software changes on the standard Uno cannot make this baud rate exact.

The NodeMCU's USB Serial Monitor uses `256000` baud after setup because UART0 RX is dedicated to Radar 2. The first boot-ROM text can still appear at 74880 baud. Diagnostics use GPIO 1/TX only; keep Radar 2 RX disconnected as specified. Diagnostics report state changes and a five-second health summary; recipient numbers and device credentials are not printed.

## Alarm Behaviour

- Uno: negative radial speed within 3000 mm renews D7 HIGH for one second. Distance comparisons use squared integers; no floating-point or serial printing delays are needed.
- NodeMCU: Radar 2 movement of at least 5 cm/s in either direction, or a qualified D6 trigger, renews a five-second local alarm.
- D6 edges are latched by an interrupt; pulses shorter than 3 ms are rejected. An entire valid pulse between loop reads is retained. A HIGH input at boot also qualifies.
- Red LED flashes 250 ms ON / 250 ms OFF. During alarms, the buzzer stays on and alternates `tone(GPIO14, 3600)` and `tone(GPIO14, 4600)` every 150 ms; `noTone` silences it when the alarm ends. Green remains ON. The two-second startup self-test stays at 4000 Hz; disable it with `ENABLE_BUZZER_SELF_TEST false`.
- Every 500 ms during a beep, the firmware samples GPIO14 for at most 400 microseconds with interrupts enabled. No observed edge causes a tone restart. `GPIO TOGGLING` is electrical readback only, not proof of audible sound. `DRIVE UNCONFIRMED` means the drive has not yet been observed or the waveform is being restarted.
- New notification cycles wait 30 seconds after SMS completion/failure (including timeouts). A queued alert expires after 60 seconds without a fresh detection; the local alarm continues independently of modem readiness.
- Calls are enabled by default and run before SMS, so an SMS timeout cannot postpone the call. CLCC tracks dialing/ringing/active status when supported; an unsupported query does not terminate the call. ATH requests hang-up at 20 seconds, with AT+CHUP as a fallback. If both release commands fail, SMS is skipped for that cycle and release remains unconfirmed. The original dial error is preserved separately from release errors. CEER requests the modem's release cause after unsuccessful calls. Dial acknowledgement alone is not proof of ringing or answering.
- SMS waits 2 seconds after call release. Text parameters are explicitly set with CMGF=1, CSCS="GSM", and CSMP=17,167,0,0 (GSM 7-bit encoding). A terminal CMS error does not send an unnecessary ESC; a timeout or serial overflow triggers ESC and resynchronization.
- SMS submission waits up to 65 seconds for both a `+CMGS:` reference and final `OK`. SENT means the modem accepted submission, not confirmed delivery to the recipient.
- GSM RX is parsed continuously; TX sends one byte per main-loop pass with ordinary interrupts protected for roughly 1 ms to limit software-UART timing jitter. The ESP8266 tone NMI remains active. There are no multi-second GSM wait loops or alarm delays.
- Telemetry advances incrementally every 500 ms, sooner for alarm/status changes. The only TCP connection wait is bounded to 80 ms; unreachable servers retry every 2 seconds. The dashboard polls every 500 ms. These are scheduling targets, not measured end-to-end latency guarantees.
- Uno D8 streams CRC-checked Radar 1 coordinates and speed at 9600 baud roughly every 100 ms. Timer1 drives D8 so UART0 can keep receiving Radar 1 at 256000 baud. NodeMCU D7 receives this on a second software-serial instance. The dashboard plots only fresh, valid measurements and clears them when packets or radar frames stop. D7/D6 remains an independent alarm path; if an alarm arrives without fresh coordinates, the dashboard shows an unlocated approach indicator rather than inventing a position.
- During heavy GSM software-serial transmission some Uno packets may be dropped. CRC rejects damaged data and the repeated stream resynchronizes; the independent alarm remains active. The sensor page shows link status, packet count, rejected packets and RX overflows. Coordinates are local to each radar; physical mapping of both sensors into one shared space requires measured alignment/calibration.
- `radar_protocol.h` and `uno_link_protocol.h` are identical in both sketch folders so each is independently uploadable. Keep both pairs identical when changing the wire format or radar decoder.

## WIS800C Commissioning

The code uses standard AT SMS/voice commands and reads `ATI` to display the actual firmware identity. Hardware revisions can differ. It checks SIM readiness, network registration, signal and the configured SMS service centre. It does not overwrite the SIM's SMS service-centre number.

The GSM dashboard now displays the current command stage and separate SMS/call/modem errors. For example, `CMGS result: +CMS ERROR: ...` preserves the modem's diagnostic; `CMGS prompt: TIMEOUT` identifies the stage where no response arrived. Use this evidence to distinguish a software command failure from a SIM/service/network issue. CONNECTED and REGISTERED alone do not prove outbound SMS or voice service.

1. Upload both sketches with their radar TX lines disconnected from board RX during upload; reconnect after flashing.
2. Start the dashboard and open the NodeMCU Serial Monitor at 256000 baud.
3. Approach Radar 1 within 3 m. Expect D7/D6 trigger, immediate local flash/siren, and a moving red S1 target marker from the D8/D7 data link. Other measured movement should appear blue. If the alarm works but no marker appears, check the new data wire and the sensor page's link/packet diagnostics.
4. Test Radar 2 independently. Expect full target measurements and alerts for motion in either direction.
5. Check GSM progress from DIALING/RINGING (ACTIVE only if reported by the modem) to call release, then SMS SENDING to SENT. Check the recipient phone directly.
6. While an SMS is pending, verify the red flash/beep and dashboard continue updating. Wait at least 30 seconds between fresh alert notification attempts.

## Current Update: Live Radar 1 Tracking

Flash **both** revised sketches. Confirm NodeMCU firmware `2026-09-27.1` in System Status, restart the dashboard backend, and refresh the browser. Existing secrets, alert policy, buzzer behavior and GSM behavior are unchanged.

Radar 1 measured targets now show moving S1-T1/S1-T2/S1-T3 markers. Square markers identify Radar 1; round markers identify Radar 2. Both use blue for ordinary movement and red for approaching movement. The D6 trigger remains independent and appears as an unlocated alarm only when no fresh approaching Radar 1 coordinate exists. A sensor heartbeat without fresh radar frames is not treated as an online radar.

If Radar 1 still alarms without coordinates, look at Radar 1 in Sensors: `Uno data link` should say `Receiving packets`, and `Packets received` should increase. If not, verify Uno D8 idle measures near 5 V, NodeMCU D7 after the divider measures near 3.3 V, and grounds are shared. If packet count rises but radar says WAITING, the Uno is not decoding fresh RD-03D frames. This is separate from the 256000-baud limitation of a stock 16 MHz Uno.

## Standalone GSM Diagnosis

The separate `gsm_diagnostic/gsm_diagnostic.ino` sketch tests the existing NodeMCU D1/D2 GSM connection without radar, Wi-Fi, or dashboard posts. It sends **one test SMS on every boot** to the recipient in its gitignored `gsm_diagnostic/secrets.h`, then remains available for incoming-call observation and manual AT commands. It does not dial automatically or change the main firmware credentials.

1. Power the GSM module from its own correctly regulated supply with common ground. Disconnect Radar 2 TX from NodeMCU RX/GPIO3 while uploading and while using the USB Serial Monitor. Leave GSM TX on D1/GPIO5 and GSM RX on D2/GPIO4. Do not join the two buck converters' positive outputs.
2. Confirm the test recipient in `gsm_diagnostic/secrets.h` before power-up; if absent, copy `secrets.example.h` to `secrets.h` and set the number. Upload the diagnostic sketch to **NodeMCU 1.0**, open Serial Monitor at **115200 baud**, and select **Newline**. After the startup checks it attempts one SMS. Resetting the ESP repeats that SMS and may incur charges. If `AT` never replies, check modem power, common ground, TX/RX, and 9600 baud.
3. In the printed checks, look for `+CPIN: READY`, `+CREG: 0,1` or `0,5`, usable `+CSQ`, `+CCALR: 1`, SMS service centre, and `+CBC` voltage. `AT+CCALR?` reports voice-call readiness; registration alone does not prove calls work. Type `AT+CNUM` manually if needed; it may be blank even when the SIM works, so verify the number with the operator or in a handset.
4. Call the SIM number from another phone while watching the Monitor. A call reaching the module should yield `RING` and possibly `+CLIP`. If the caller hears “number unavailable” and **no** `RING` appears, compare the same SIM in a handset and check number, voice service, 2G coverage/compatibility, and carrier routing. No software AT command can fix a call the network never delivers to the modem.
5. For an outgoing call, manually type `ATD+countrycode_number;` with the real digits and trailing semicolon; query `AT+CLCC` while it is trying; type `AT+CEER` immediately after failure and `ATH` to release any live call. Nothing in the diagnostic sketch dials automatically.
6. The sketch automatically sends `AT+CMGF=1`, `AT+CSCS="GSM"`, `AT+CSMP=17,167,0,0`, then `AT+CMGS` and the message. It waits up to 65 seconds for `+CMGS` plus final `OK`; `SMS SUBMITTED TO MODEM` does not prove delivery. Capture any `+CMS ERROR` or timeout. To repeat, verify the recipient and reset the board; the modem is not sent a second SMS during the same run.
7. The uploaded SIM800C hardware guide specifies 3.4-4.4 V operation, recommends 4.0 V, and warns of 2 A transmit bursts and shutdown if VBAT drops below 3.0 V. Measure **at the modem pins during a call/SMS attempt**; a slow multimeter may miss bursts. The guide also shows UART matching circuits for 3.3 V hosts. Check the actual breakout's level shifting before assuming direct 3.3 V ESP TX is suitable for a bare SIM800C module.

After diagnosis, re-upload `nodemcu_master/nodemcu_master.ino` and reconnect Radar 2 TX to GPIO3. Redact phone numbers and SIM identifiers from logs before sharing them. References: [SIM800C hardware design](https://en.simcom.com/product/SIM800C.html) and [SIM800-series AT command manual](https://simcom.ee/documents/SIM800C/SIM800%20Series_AT%20Command%20Manual_V1.10.pdf).


## September 26 Follow-Up

Upload only `nodemcu_master/nodemcu_master.ino` for this update. Confirm firmware `2026-09-26.1` in the Serial Monitor (256000 baud) or the dashboard System Status. Restart the dashboard backend after installing its changes and refresh the browser. Credentials in the existing `secrets.h` are unchanged.

At reset, expect a 2-second beep. During an alarm, check System Status for GPIO14 drive and restart count. A startup beep followed by silence during alarms, or recurring restarts, should be reported with the `[Buzzer GPIO14]` and `[Boot]` lines. If GPIO14 reports toggling but remains inaudible, measure the waveform at the buzzer terminals under the complete system load. The firmware cannot measure acoustic output.

The observed modem reports were `CMGS result: TIMEOUT`, `+CMS ERROR: PS busy`, `NO CARRIER`, and `ATH: ERROR`. These do not prove a single code-only cause. If they recur, test the same SIM in a phone for an outgoing SMS and call to the exact alert recipient; confirm credit/outgoing service and the operator-provided SMS centre. Do not guess or overwrite the SMSC. Use international format for the recipient if the local format fails. Read the new Call diagnostic and Release error fields alongside the original error. A modem reset during transmission also warrants measuring its supply during that event.

Reference: [OpenLuat SMS text parameters](https://docs.openluat.com/air780e/at/app/Command_List/SMS/CSMP/) describes the standard CSMP encoding fields; this newer-module documentation does not establish every feature of the older WIS800C firmware. Unsupported commands are reported by stage. [EspSoftwareSerial](https://github.com/plerup/espsoftwareserial) documents the interrupt-versus-transmit-timing tradeoff. Physical sound, SMS delivery and call connection still require the above live tests.

## Verification

Both revised sketches compile with the installed Uno and ESP8266 toolchains. Native tests exercise radar decoding, Uno link framing/CRC/resynchronization, alarm timing, and GSM behavior; backend tests cover linked and stale targets. Browser smoke tests cover trigger-only fallback and the measured Radar 1 marker at mobile width. No firmware was flashed and no live hardware measurements, SMS or calls were made here; bench confirmation remains.

```sh
g++ -std=c++11 -Wall -Wextra -Werror tests/firmware_logic_test.cpp -o /tmp/doppler-firmware-tests
/tmp/doppler-firmware-tests
g++ -std=c++11 -Wall -Wextra -Werror tests/uno_link_test.cpp -o /tmp/doppler-uno-link-test
/tmp/doppler-uno-link-test
g++ -std=c++11 -Wall -Wextra -Werror -Itests/fakes tests/buzzer_output_test.cpp -o /tmp/doppler-buzzer-tests
/tmp/doppler-buzzer-tests
node --test tests/telemetry.test.js tests/distributed.test.js tests/uno_tracking.test.js
```

## Important Uno Baud-Rate Constraint

The RD-03D uses a 256000-baud UART. `Serial.begin(256000)` is the correct requested setting, but a classic 16 MHz ATmega328P Uno cannot synthesize exactly 256000 in asynchronous UART mode; its nearest practical setting is 250000 baud, about 2.34% low. Bench-test Radar 1 by observing D7 with an LED or multimeter before relying on the system. If it does not detect valid frames consistently, this specific Uno architecture cannot satisfy a truly strict 256000-baud radar; use a controller with an exact-rate UART or reconfigure the radar at a supported rate using proper 3.3 V-level hardware.

The Uno and NodeMCU decoders expect the RD-03D's 30-byte target frame (`AA FF 03 00 ... 55 CC`).
