export const LEGACY_CHUNK_THRESHOLD_BYTES = 256;
export const LEGACY_CHUNK_DATA_BYTES = 200;
export const LEGACY_MAX_CHUNKS = 50;
export const LEGACY_SCHEDULE_BYTES = 4096;
export const LEGACY_COMMANDS_PER_DEVICE_PER_BATCH = 3;

const utf8Encoder = new TextEncoder();

export function utf8ByteLength(value: string): number {
  return utf8Encoder.encode(value).byteLength;
}

export function assertLegacyScheduleFits(scheduleJson: string): void {
  const size = utf8ByteLength(scheduleJson);
  if (size > LEGACY_SCHEDULE_BYTES) {
    throw new RangeError(
      `Schedule payload is ${size} bytes; deployed firmware supports at most ${LEGACY_SCHEDULE_BYTES}`,
    );
  }
}
