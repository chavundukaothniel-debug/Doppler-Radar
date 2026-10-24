> Current cloud firmware: 2026-10-24.4. For HTTPS, select **Tools > MMU > 16KB cache + 48KB IRAM and 2nd Heap (shared)** before uploading the NodeMCU sketch. Current cloud settings and behavior are documented in the root README; historical local-only notes below are superseded.

# Active firmware: Uno + ESP8266 NodeMCU

Current NodeMCU version: **2026-10-11.8**. Upload both active sketches for the measurement-sequence and tracking update. See [TRACKING_UPDATE.md](../TRACKING_UPDATE.md) for behavior and physical tests.

## Existing connections (unchanged)

| Function | Connection |
| --- | --- |
| Radar 1 TX | Uno D0/RX, 256000 baud |
| Uno alarm output | D7 through its existing divider to NodeMCU D6/GPIO12 |
| Uno measured-data output | D8 through its existing divider to NodeMCU D7/GPIO13, 9600 baud |
| Radar 2 TX | NodeMCU RX/GPIO3, 256000 baud |
| GSM TX | NodeMCU D1/GPIO5 |
| GSM RX | NodeMCU D2/GPIO4 |
| Red LED | NodeMCU D3/GPIO0 |
| Green LED | NodeMCU D4/GPIO2 |
| Buzzer | NodeMCU D5/GPIO14; negative to common ground |

Preserve existing power supplies, common ground, LED resistors and level dividers. Radar RX connections are not added. Uno D1/TX is not used for radar configuration. NodeMCU red/green LEDs indicate Wi-Fi status; the buzzer siren follows qualified movement.

## Upload and configure

1. Upload `uno_radar_1/uno_radar_1.ino` with board Arduino Uno. Disconnect Radar 1 TX from Uno D0 while uploading; reconnect it afterward.
2. Keep your existing `nodemcu_master/secrets.h`. On a new checkout, copy `secrets.example.h` to `secrets.h` and configure Wi-Fi, matching dashboard device key and optional alert recipient.
3. Upload `nodemcu_master/nodemcu_master.ino` with board NodeMCU 1.0 (ESP-12E Module). Disconnect Radar 2 TX from GPIO3 while uploading; reconnect it afterward.
4. Restart the dashboard using the repository-root `start.bat`, refresh the browser, and confirm firmware 2026-10-11.8 in System Status.
5. Open the NodeMCU Serial Monitor at **256000 baud**. Inspect received-byte, valid-frame, rejected-frame and Uno link counters before relying on detection status.

NodeMCU dependencies: ESP8266 Arduino core, ArduinoJson 7.x and EspSoftwareSerial. Automatic dashboard discovery is enabled; the optional static address should be a computer LAN IPv4 address, never localhost.

The two copies of `radar_protocol.h`, `uno_link_protocol.h` and `target_tracking.h` must remain identical so both sketches are independently uploadable. Neither firmware invents human classification.

## Movement and communication

The master requires fresh measured targets, persistent radial movement and at least 800 mm filtered displacement from a retained baseline. Raw speed or the Uno trigger alone does not qualify the master's alarm. A notification latch prevents re-queueing the same continuous track after cooldown. GSM transactions remain cooperative; calls run first when enabled, followed by SMS. Modem submission is not proof of recipient delivery.

A classic 16 MHz Uno cannot synthesize exactly 256000 baud; its requested setting yields approximately 250000 baud. We preserve the existing setting. Valid Radar 1 frames must be checked physically. A dashboard filter cannot fix that hardware timing limitation.

GPIO0 and GPIO2 are boot-strapping pins. Existing LED wiring must not prevent boot. GSM requires its correctly rated external power supply and matching UART logic levels; do not power it from the NodeMCU regulator.

## Standalone GSM diagnostic

`gsm_diagnostic/gsm_diagnostic.ino` is a separate troubleshooting sketch for the same NodeMCU D1/D2 GSM wiring. Copy its `secrets.example.h` to `secrets.h` and configure the test recipient before use. It attempts **one test SMS on every boot**, so resetting repeats the attempt. It does not dial automatically.

For this diagnostic, disconnect Radar 2 TX from NodeMCU RX while uploading and using the USB Serial Monitor. Use **115200 baud** and Newline. Inspect AT response, SIM readiness, registration, CSQ, SMS service centre and any CMS errors. It does not overwrite the modem's SMS service-centre setting.

After diagnosis, re-upload the main NodeMCU sketch and reconnect Radar 2 TX to GPIO3. Keep recipient numbers and credentials out of shared logs.

## Verification limits

Software tests and compilation are documented in the root tracking update. No backup operation uploads firmware or validates physical power, serial waveforms, range accuracy, sound or SMS delivery. Keep commissioning records locally under `data/recordings`.
