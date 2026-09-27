# Doppler Radar System

A two-sensor RD-03D Doppler radar security prototype with a distributed Arduino Uno and ESP8266 NodeMCU controller, local LED/buzzer alerts, GSM SMS support, and a secured real-time engineering dashboard.

```text
Radar 1 --256000 UART--> Arduino Uno --D7 / divider (alarm)--> NodeMCU D6
                                  \--D8 / divider (data)-----> NodeMCU D7
Radar 2 --256000 UART--------------------------------------> NodeMCU RX / GPIO 3
                                                                    |
                                                LED + passive buzzer + GSM SMS
                                                                    |
                                           authenticated HTTP telemetry over Wi-Fi
                                                                    |
                                                   Node dashboard server
```

Radar 1 is processed by the Uno and reported to the NodeMCU through an independent alarm trigger and a checksummed target-data link. Both radars provide measured local position, distance, radial speed, and direction on the dashboard. When the Radar 1 data link is stale, only the unlocated alarm trigger is shown.

## Start The Dashboard

Open a terminal in this directory:

```sh
cd "/home/thewizard/Doppler-Radar"
export DOPPLER_DEVICE_KEY='replace-this-with-a-long-random-secret'
node server.js
```

Then open [http://localhost:8080](http://localhost:8080).

On the first launch, the server creates `data/users.json`. The initial accounts are `admin`, `operator`, and `viewer`, each using `ChangeMe!2026` unless `DOPPLER_INITIAL_PASSWORD` was set before the first launch. Sign in as `admin` and replace or reset those initial accounts before using the system outside a controlled demonstration.

The server accepts dashboard access on `localhost` and NodeMCU traffic on the computer network. If your firewall asks, allow inbound TCP port `8080` only on your trusted local network.

## Flash The Two-Board Firmware

The active replacement firmware is documented in [`firmware/README.md`](firmware/README.md). In short:

1. Upload [`uno_radar_1.ino`](firmware/uno_radar_1/uno_radar_1.ino) to the Arduino Uno with Radar 1 TX disconnected from Uno D0 during upload.
2. Keep your existing `firmware/nodemcu_master/secrets.h`. For a new installation only, copy the example there and configure Wi-Fi, dashboard LAN IP, device key, and a recipient in international +countrycode format.
3. Upload [`nodemcu_master.ino`](firmware/nodemcu_master/nodemcu_master.ino) to the NodeMCU with Radar 2 TX disconnected from GPIO 3 during upload.
4. Keep the Uno D7-to-NodeMCU D6 alarm divider and add Uno D8-to-NodeMCU D7 with its own 10 kOhm upper / 20 kOhm lower divider and common ground. Reconnect both radar TX lines and power the system. Use the NodeMCU Serial Monitor at `256000` baud for commissioning diagnostics.
5. Restart the dashboard backend and refresh the browser. Confirm firmware `2026-09-27.1` in System Status.

`firmware/**/secrets.h`, runtime account data, event history, Wi-Fi credentials, device keys, and GSM recipient numbers are excluded from Git.

## Behaviour

- Radar 1 triggers Uno D7 for one second when an approaching target is within 3 m. Uno D8 streams real target measurements to NodeMCU D7 at 9600 baud; each 5 V Uno output needs its own 10 kOhm / 20 kOhm divider.
- Radar 2 is parsed at 256000 baud by the NodeMCU. Any motion at 5 cm/s or above, or a HIGH Uno trigger, activates the alert response.
- Green stays ON as a running indicator. During an alarm, the red LED flashes 250 ms ON / 250 ms OFF while the buzzer plays a separate rapid two-tone siren.
- The grounded passive buzzer on NodeMCU D5 / GPIO14 alternates 3600 and 4600 Hz every 150 ms during an alarm; `noTone` silences it afterward. The startup self-test remains 4000 Hz.
- Alert cycles start with a voice-call attempt, then an SMS after call release. New cycles wait 30 seconds after SMS completion/failure; calls hang up after at most 20 seconds. Set `ENABLE_GSM_CALL false` in `secrets.h` to disable calls.
- Telemetry and browser polling target 500 ms intervals, with prompt alarm updates. Both radars plot measured targets; Radar 1 has square markers and Radar 2 round markers. Blue indicates ordinary movement and red approaching movement. An Uno alarm without fresh position data appears as an unlocated detection. The GSM view includes actual SMS/call errors.

## Verify Dashboard Code

```sh
node --check server.js
node --check light-ui.js
node --test tests/telemetry.test.js tests/distributed.test.js tests/uno_tracking.test.js
```

## Engineering Safety Notes

- Power the GSM module from its properly rated external supply, never a microcontroller 3.3 V regulator. Tie all grounds together.
- Check the GSM module's RX logic level. SIM800L-class devices commonly need a level shifter or resistor divider from a 3.3 V NodeMCU TX signal.
- GPIO 0 and GPIO 2 are ESP8266 boot-strapping pins. Make sure external LED wiring cannot pull either low during reset.
- A standard 16 MHz Uno cannot generate an exact 256000-baud asynchronous UART. The Radar 1 trigger must be bench-tested; if it is unreliable, use a controller capable of the exact baud rate or reconfigure the radar through level-safe hardware.
- Validate SMS alerts with a controlled target before field use. This is a prototype monitoring system, not a certified life-safety or security system.
