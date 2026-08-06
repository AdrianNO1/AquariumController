#pragma once

// Safe compile-only values. Copy this file to firmware-config.h and replace
// every value before flashing a physical controller.
const char* const ssid = "replace-with-wifi-ssid";
const char* const password = "replace-with-wifi-password";
const char* const mqtt_server = "192.0.2.1";
const int mqtt_port = 1883;
const char* const mqtt_username = "replace-with-mqtt-username";
const char* const mqtt_password = "replace-with-mqtt-password";
const char* const ntp_server = "pool.ntp.org";

// Set true only in a device-specific USB build when replacing network settings
// already persisted by older firmware. Generic OTA builds must leave this
// false so they never overwrite per-device NVS configuration.
#define AQUARIUM_REPROVISION_NETWORK_CONFIG false
