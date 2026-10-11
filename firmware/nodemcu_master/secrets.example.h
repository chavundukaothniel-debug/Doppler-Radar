#pragma once

// Copy this file to secrets.h in this same nodemcu_master folder, then edit it.
// secrets.h is ignored by Git.
#define WIFI_SSID "YOUR_WIFI_NAME"
#define WIFI_PASSWORD "YOUR_WIFI_PASSWORD"

// Automatic discovery is enabled. Optional static LAN IPv4 fallback; never localhost.
#define DASHBOARD_HOST ""
#define ENABLE_DASHBOARD_DISCOVERY true
#define DASHBOARD_PORT 8080
#define DEVICE_API_KEY "replace-with-the-dashboard-DOPPLER_DEVICE_KEY"
#define ENABLE_DASHBOARD_TELEMETRY true

// Local digits or international +countrycode format, no spaces. Empty disables notifications.
#define ALERT_PHONE_NUMBER ""

// Calls run first; hang-up is requested at 20 seconds, then SMS runs.
#define ENABLE_GSM_CALL true

// Three rising startup notes; Wi-Fi connection beeps are enabled independently.
#define ENABLE_BUZZER_SELF_TEST true
