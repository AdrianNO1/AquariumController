# ESP32 firmware

The supported source is `firmware/esp32/ESP32Code/ESP32Code.ino`. Firmware
5.0.0 adds controller-managed pull OTA, output-state telemetry, and automatic
rollback without depending on the legacy `.old` tree.

## Initial USB bootstrap

Copy `firmware-config.example.h` to the ignored `firmware-config.h`, enter the
device's Wi-Fi, MQTT, and NTP settings, and flash firmware 5.0.0 once over USB.
On its first 5.x boot the sketch stores those settings in the ESP32's NVS. Later
generic OTA images reuse the persisted settings, so each release does not need
device-specific credentials compiled into it.

Firmware older than 5.0.0 cannot pull an update and therefore needs this one
USB bootstrap. The web UI identifies those devices as `USB required`.

## Controller-managed OTA

The controller bundles one approved binary and exposes it on the trusted LAN at
`/api/firmware/esp32/current.bin`. An operator can request an update for one ESP
or start an update-all rollout with either of these modes:

- `Update now` starts the download immediately. LEDC hardware keeps the current
  duty while the image downloads, but activating the image requires a brief
  restart.
- `Update when outputs are off` waits until the ESP reports every attached pin
  at 0%, avoiding a visible restart while lights are on.

The controller sends the target version, exact byte count, SHA-256, and local
HTTP URL over the existing correlated MQTT command channel. There is no
per-device OTA password or separate discovery mechanism. MQTT identifies the
device, and the ESP downloads from the configured controller URL. This design
assumes the controller, broker, and ESPs are confined to the trusted aquarium
LAN; the current firmware supports neither HTTPS nor MQTT TLS.

The ESP writes only to the inactive OTA partition. It rejects an unexpected
HTTP status, content length, image size, or SHA-256 before selecting the image
for boot. The old partition remains available during probation:

- MQTT reconnect is attempted every five seconds while the local schedule
  continues running.
- A successful presence announcement confirms the new image.
- If MQTT cannot be confirmed within five minutes, or the probation image boots
  three times, the ESP selects the previous partition and restarts.
- A reported download, verification, or rollback failure is not retried
  automatically. An operator must explicitly retry it. Controller-side command
  contention that occurs before an OTA command is accepted remains pending and
  can be attempted after the next device announcement.

An active update-all policy is persisted with its chosen mode. An outdated ESP
that is powered later is enrolled when it announces itself. Devices already on
the target version are left alone.

## Runtime behavior

The `s <pin> <value> <overwrite>` command defines `value` as a normalized 8-bit
duty from 0 through 255. Firmware scales that value to the configured LEDC
resolution and reports attached output pins as percentages. Output changes
queue an announcement used by the controller's `when outputs are off` gate.

NTP synchronization is asynchronous. DNS or NTP failure cannot hold MQTT or
manual-control startup open. If neither source is reachable after a reboot, the
firmware uses its last hourly EEPROM timestamp and continues the persisted local
schedule. Schedule activation remains best-effort per pin, and physical output
fault diagnostics remain wear-limited in SPIFFS.

Controller command batches use
`request:<requestId>|<semicolon-separated commands>`. Responses echo the
request ID so a delayed response cannot settle a newer operation.

## Reproducible build

Build the pinned generic image from the repository root:

```sh
docker build --file firmware/esp32/Dockerfile.compile --tag aquarium-esp32-compile:5.0.2 .
```

The build verifies Arduino CLI 1.5.0, installs ESP32 Arduino core 3.0.7,
ArduinoJson 7.4.3, and PubSubClient 2.8, then compiles for the generic ESP32
target using only the safe example configuration. The resulting application
binary is `firmware/esp32/artifacts/ESP32Code-5.0.2.bin`; its exact size and
SHA-256 are pinned in `@aquarium/esp-protocol` and revalidated by the controller
at startup.
