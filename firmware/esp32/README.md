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

Firmware 5.0.6 also keeps the persisted local schedule running when network
configuration is missing, verifies command-topic subscription and OTA probation
confirmation before reporting success, and reports recoverable Wi-Fi, MQTT,
NTP, EEPROM, schedule-restore, and response-publication failures to the Pi.

The firmware reports hardware profile `nodemcu-esp32s-v1.1` and model
`Ai-Thinker NodeMCU-32S V1.1`. PWM output is limited to GPIO 4, 12-14, 16-19,
21-23, 25-27, 32, and 33; analog reads use ADC1 GPIO 32-36 and 39. GPIO12 is
allowed because the deployed driver wiring boots reliably, but it is a reset
strapping pin and replacement circuitry must not pull it high while the ESP32
starts.

SPIFFS mounts without automatic formatting. If mounting fails, firmware uses a
persisted two-attempt repair budget, explicitly formats, reports the recovery to
the controller, and waits for schedule reconciliation to restore the erased
schedule. It will not format if the attempt counter cannot be persisted. The
legacy bare MQTT `clear` broadcast is ignored and cannot erase EEPROM.

Controller command batches use
`request:<requestId>|<semicolon-separated commands>`. Responses echo the
request ID so a delayed response cannot settle a newer operation.

Firmware 5.0.6 carries each command batch in one MQTT publication. The command
payload limit is 5,120 UTF-8 bytes, which covers the 4,095-byte schedule limit
plus target and request-correlation metadata. PubSubClient uses a 6,144-byte
packet buffer for MQTT framing and topic overhead. The earlier custom
`chunk:index:total:isLast:data` protocol and its 50-slot reassembly buffer are
no longer used.

## Preparing a firmware release

The CI firmware job is a compile and resource-usage validation. The controller
serves the separately reviewed binary committed under
`firmware/esp32/artifacts`, so prepare that binary with the repository release
command rather than copying an Arduino IDE build by hand.

Before releasing a new version:

1. Make and review the sketch changes.
2. Choose a new numeric SemVer version and set the same value in:
   - `VERSION` in `ESP32Code.ino`;
   - `CURRENT_ESP_FIRMWARE_VERSION` in `packages/esp-protocol/src/index.ts`;
   - `FAKE_ESP_FIRMWARE_VERSION` in `packages/fake-esp/src/fake-esp.ts`.
3. Update exact-version test fixtures that intentionally represent the current
   firmware. Do not rewrite historical version references merely because a new
   release exists.
4. Prepare the generic OTA artifact from the repository root:

   ```sh
   npm run firmware:release -- 5.0.7
   ```

The command builds with `firmware-config.example.h`, extracts the application
binary from the pinned Docker build, rejects test MQTT topics or missing safe
configuration sentinels, writes `ESP32Code-<version>.bin`, and updates its exact
size and SHA-256 in `@aquarium/esp-protocol`. It refuses to replace an existing
version. `--replace` is reserved for correcting an artifact that has not been
released or installed anywhere. Use `--check` to compile and validate without
writing the artifact or metadata.

Review the resulting source, binary, and metadata diff. Update documentation
that describes the current release, then run the unit, critical, and firmware
CI lanes before merging. Compiler output is not byte-reproducible across clean
builds, so the trusted release evidence is the reviewed source commit plus the
exact committed binary hash; CI independently proves that the source compiles.

The current release can be rebuilt for investigation with:

```sh
docker build --file firmware/esp32/Dockerfile.compile --tag aquarium-esp32-compile:5.0.6 .
```

The build verifies Arduino CLI 1.5.0, installs ESP32 Arduino core 3.0.7,
ArduinoJson 7.4.3, and PubSubClient 2.8, then compiles for the generic ESP32
target using only the safe example configuration. This validation build does
not replace the approved OTA artifact. The current application binary is
`firmware/esp32/artifacts/ESP32Code-5.0.6.bin`; its exact size and SHA-256 are
pinned in `@aquarium/esp-protocol` and revalidated by the controller at startup.
