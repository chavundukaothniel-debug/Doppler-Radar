#include <Arduino.h>
#include <SoftwareSerial.h>
#include <string.h>
#include "secrets.h"

// ---------------------------------------------------------
// ESP8266 NodeMCU <-> SIM800C / WIS800C
//
// GSM TX -> NodeMCU D1 / GPIO5
// GSM RX <- NodeMCU D2 / GPIO4
// GND    -> GND
//
// GSM baud: 9600
// Serial Monitor: 115200
// ---------------------------------------------------------

constexpr uint8_t GSM_RX_PIN = 5;   // D1 / GPIO5, receives from GSM TX
constexpr uint8_t GSM_TX_PIN = 4;   // D2 / GPIO4, sends to GSM RX
constexpr uint32_t GSM_BAUD = 9600;

// Test recipient is configured in the gitignored secrets.h.
const char PHONE_NUMBER[] = GSM_TEST_PHONE_NUMBER;

// ---------------------------------------------------------
// ENTER YOUR SMS MESSAGE HERE
// ---------------------------------------------------------
const char SMS_TEXT[] = "Hello. This is a test SMS from my ESP8266 GSM system.";

SoftwareSerial gsm;

// ---------------------------------------------------------
// Print everything received from GSM modem
// ---------------------------------------------------------
void readGsmResponse(uint32_t timeoutMs) {

  const uint32_t startTime = millis();

  while (millis() - startTime < timeoutMs) {

    while (gsm.available()) {
      Serial.write(gsm.read());
    }

    yield();
  }
}

// ---------------------------------------------------------
// Send a normal AT command
// ---------------------------------------------------------
void sendAT(const char *command, uint32_t waitMs = 1500) {

  Serial.print("\nESP8266 -> GSM: ");
  Serial.println(command);

  gsm.print(command);
  gsm.write('\r');

  Serial.println("GSM response:");

  readGsmResponse(waitMs);
}

// Wait for the modem's SMS reference and final acknowledgement, not just a delay.
bool waitSmsResult(uint32_t timeoutMs) {
  const uint32_t startedAt = millis();
  char line[160]{};
  size_t used = 0;
  bool reference = false;
  while (uint32_t(millis() - startedAt) < timeoutMs) {
    while (gsm.available()) {
      const char ch = char(gsm.read());
      Serial.write(ch);
      if (ch == '\n') {
        line[used] = 0;
        if (strstr(line, "+CMGS:")) reference = true;
        if (!strcmp(line, "OK")) return reference;
        if (!strcmp(line, "ERROR") || strstr(line, "+CMS ERROR:")) return false;
        used = 0;
      } else if (ch != '\r' && used < sizeof(line) - 1) {
        line[used++] = ch;
      }
    }
    yield();
  }
  Serial.println("\nSMS result timed out");
  return false;
}

// ---------------------------------------------------------
// Send SMS
// ---------------------------------------------------------
void sendSMS() {

  Serial.println();
  Serial.println("======================================");
  Serial.println("        STARTING SMS TEST");
  Serial.println("======================================");

  // Check modem communication
  sendAT("AT", 2000);

  // Disable command echo
  sendAT("ATE0", 1000);

  sendAT("AT+CMEE=2");
  sendAT("ATI");
  sendAT("AT+CPIN?");
  sendAT("AT+CREG?");
  sendAT("AT+CSQ");
  sendAT("AT+CCALR?");
  sendAT("AT+CBC");
  sendAT("AT+CSCA?");
  sendAT("AT+CLIP=1");

  // Put modem into SMS text mode
  sendAT("AT+CMGF=1", 1500);
  sendAT("AT+CSCS=\"GSM\"");
  sendAT("AT+CSMP=17,167,0,0");

  // -------------------------------------------------------
  // Tell modem which number should receive the SMS
  // -------------------------------------------------------

  Serial.println();
  Serial.print("Sending SMS to: ");
  Serial.println(PHONE_NUMBER);

  gsm.print("AT+CMGS=\"");
  gsm.print(PHONE_NUMBER);
  gsm.write('\r');

  // Wait for the > prompt
  uint32_t startTime = millis();
  bool promptReceived = false;

  while (millis() - startTime < 5000) {

    while (gsm.available()) {

      char c = gsm.read();

      Serial.write(c);

      if (c == '>') {
        promptReceived = true;
      }
    }

    if (promptReceived) {
      break;
    }

    yield();
  }

  if (!promptReceived) {

    Serial.println();
    Serial.println("ERROR: GSM modem did not give the > SMS prompt.");
    Serial.println("SMS was not sent.");

    return;
  }

  Serial.println();
  Serial.println("SMS prompt received.");

  // -------------------------------------------------------
  // Send actual SMS text
  // -------------------------------------------------------

  Serial.print("SMS message: ");
  Serial.println(SMS_TEXT);

  gsm.print(SMS_TEXT);

  delay(300);

  // CTRL+Z tells SIM800C to send the SMS
  gsm.write(uint8_t(26));

  Serial.println();
  Serial.println("CTRL+Z sent.");
  Serial.println("Waiting for GSM confirmation...");

  // SMS sending can take several seconds
  const bool submitted = waitSmsResult(65000);

  Serial.println();
  Serial.println("======================================");
  Serial.println(submitted ? "SMS SUBMITTED TO MODEM" : "SMS FAILED OR UNCONFIRMED");
  Serial.println("======================================");
}

// ---------------------------------------------------------
// SETUP
// ---------------------------------------------------------
void setup() {

  Serial.begin(115200);

  delay(1000);

  Serial.println();
  Serial.println("ESP8266 + SIM800C Simple SMS Test");

  // Start GSM SoftwareSerial
  gsm.begin(
    GSM_BAUD,
    SWSERIAL_8N1,
    GSM_RX_PIN,
    GSM_TX_PIN,
    false,
    256,
    1024
  );

  gsm.enableIntTx(false);

  Serial.println("GSM serial started at 9600 baud.");
  Serial.println("Waiting for GSM modem to initialise...");

  // Give SIM800C time to boot/register
  delay(5000);

  // Send one SMS
  sendSMS();
  Serial.println("Incoming call monitor active: call the SIM and watch for RING/+CLIP.");
  Serial.println("Serial Monitor: 115200 baud, Newline. Type AT+CLCC, AT+CEER, ATD+number;, or ATH.");
}

// ---------------------------------------------------------
// LOOP
// ---------------------------------------------------------
void loop() {
  while (gsm.available()) Serial.write(gsm.read());

  static char command[128]{};
  static size_t used = 0;
  while (Serial.available()) {
    const char ch = char(Serial.read());
    if (ch == '\r' || ch == '\n') {
      if (!used) continue;
      command[used] = 0;
      if (!strncmp(command, "AT", 2)) {
        Serial.print("[AT] ");
        Serial.println(command);
        gsm.print(command);
        gsm.write('\r');
      } else {
        Serial.println("Enter a raw AT command, such as AT+CLCC or AT+CEER.");
      }
      used = 0;
    } else if (used < sizeof(command) - 1) {
      command[used++] = ch;
    } else {
      used = 0;
      Serial.println("AT command too long");
    }
  }
  yield();
}
