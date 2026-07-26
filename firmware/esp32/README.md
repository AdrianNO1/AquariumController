# ESP32 firmware verification

The deployed firmware source remains at
`.old/slaveCode/ESP32Code/ESP32Code.ino` while the refactor is in progress. It
is now a supported part of the application and must compile before release.

The sketch reads its Wi-Fi and MQTT settings from the ignored
`.old/slaveCode/ESP32Code/firmware-config.h`. A local copy has been preserved on
this development machine without exposing its values in tracked source. On a
fresh checkout, copy `firmware-config.example.h` to `firmware-config.h`, replace
the Wi-Fi, MQTT, and NTP settings, and keep that file out of Git. The pinned verification build
uses only the safe example values because it compiles but never flashes or
connects the firmware.

Firmware 4.1.0 supports a username/password on its plaintext MQTT connection.
Set both values to non-empty strings for an authenticated broker, or leave both
empty only when the broker intentionally permits anonymous clients on an
isolated trusted LAN. The sketch does not support MQTT TLS; do not configure a
production broker that requires `mqtts://` for ESP clients without a future
firmware change and physical validation.

The `s <pin> <value> <overwrite>` command defines `value` as a normalized
8-bit duty from 0 through 255. Firmware scales that value to the configured
LEDC resolution before writing the pin, while its response echoes the original
normalized value. Changing PWM resolution rescales attached output state so an
active manual override preserves its duty until release or safety expiry.

NTP synchronization is asynchronous: DNS or NTP failure cannot hold MQTT or
manual control startup open. Attempts use a 15-second non-blocking deadline,
retry after 60 seconds until successful, and re-arm after six hours if periodic
SNTP updates stop. The MQTT `sync` command remains available as an immediate
controller-provided time source. If neither source is reachable after a reboot,
firmware intentionally trusts its last hourly EEPROM timestamp and runs the
local schedule from that boundedly stale estimate. Every accepted sync updates
the clock in RAM immediately. The first fresh checkpoint after boot is committed
immediately; later corrections, including backward corrections, are coalesced
to at most one EEPROM commit per hour. Failed commits remain pending and retry
no more than once per hour.

Schedule activation is best-effort per pin. A failed LEDC attachment leaves that
pin low while other scheduled pins continue, and the failed pin is retried once
per minute. Physical attachment and write failures use the same diagnostic codes
for scheduled and directly commanded outputs. Pins removed by a replacement
schedule are forced low and detached.
The first firmware diagnostic transition is written to SPIFFS immediately.
Later transitions are coalesced to at most one write per hour; a failed write
retries no more than once per hour. Repeated identical physical faults do not
change diagnostic state or write flash. Each transition queues a non-blocking
announcement after MQTT callback processing; failed publishes remain pending
and retry no more than once per minute.

Controller command batches may use
`request:<requestId>|<semicolon-separated commands>`. Responses echo the
request ID, preventing a delayed response from being mistaken for a newer
operation. Unwrapped command batches remain available for local diagnostics.

Build the pinned verification image from the repository root:

```sh
docker build --file firmware/esp32/Dockerfile.compile --tag aquarium-esp32-compile:4.1.0 .
```

The image build verifies Arduino CLI 1.5.0 against its official archive SHA-256
before extraction, installs ESP32 Arduino core 3.3.8, ArduinoJson 7.4.3, and
PubSubClient 2.8, then compiles the real sketch for the generic ESP32 target.
The final image contains only `ESP32Code.ino.bin`; it is a build artifact, not a
runtime dependency of the controller.
