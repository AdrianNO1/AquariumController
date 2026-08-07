// Includes the request envelope and command batch. The firmware allocates a
// larger MQTT packet buffer so MQTT framing and the topic also fit.
export const ESP_MQTT_MAX_COMMAND_PAYLOAD_BYTES = 5_120;
export const LEGACY_MAX_SYNC_TIME = 2_147_483_647;
// currentSchedule is a 4096-byte C string buffer. One byte is required for the
// terminating NUL written by strlcpy, leaving 4095 safe payload bytes.
export const LEGACY_SCHEDULE_BYTES = 4095;
export const ESP_COMMANDS_PER_REQUEST = 3;
export const ESP32_LEDC_SOURCE_CLOCK_HZ = 80_000_000;
// The firmware keeps an overwrite active for this long before restoring the
// scheduled output. Server reconciliation must not assume an unknown overwrite
// command has expired before this window has elapsed.
export const ESP32_PWM_OVERWRITE_DURATION_MS = 120_000;

const utf8Encoder = new TextEncoder();

export function utf8ByteLength(value: string): number {
  return utf8Encoder.encode(value).byteLength;
}

export function isSupportedEsp32PwmConfiguration(
  pwmFrequencyHz: number,
  pwmResolutionBits: number,
): boolean {
  return (
    Number.isInteger(pwmFrequencyHz) &&
    pwmFrequencyHz >= 1 &&
    pwmFrequencyHz <= 40_000 &&
    Number.isInteger(pwmResolutionBits) &&
    pwmResolutionBits >= 1 &&
    pwmResolutionBits <= 16 &&
    pwmFrequencyHz * 2 ** pwmResolutionBits <= ESP32_LEDC_SOURCE_CLOCK_HZ
  );
}

export function assertLegacyScheduleFits(scheduleJson: string): void {
  const size = utf8ByteLength(scheduleJson);
  if (size > LEGACY_SCHEDULE_BYTES) {
    throw new RangeError(
      `Schedule payload is ${size} bytes; deployed firmware supports at most ${LEGACY_SCHEDULE_BYTES}`,
    );
  }
}
