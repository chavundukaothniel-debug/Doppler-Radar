#pragma once

// Copy this file to secrets.h and fill in local details. secrets.h is excluded from Git.
#define WIFI_SSID "YOUR_WIFI_NAME"
#define WIFI_PASSWORD "YOUR_WIFI_PASSWORD"

// Use your computer's LAN IPv4 address, not localhost. Example: 192.168.1.25
#define DASHBOARD_HOST "192.168.1.25"
#define DASHBOARD_PORT 8080
#define DEVICE_API_KEY "replace-with-the-same-DOPPLER_DEVICE_KEY-as-the-server"

// Leave empty to validate radar/LED/buzzer/dashboard behavior without placing SMS or calls.
#define ALERT_PHONE_NUMBER ""
#define ENABLE_GSM_CALL false
