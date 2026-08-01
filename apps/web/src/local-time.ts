const MINUTES_PER_DAY = 24 * 60;

/** JavaScript timezone offsets are local-to-UTC minutes. */
export function utcMinuteToLocalMinute(
  utcMinuteOfDay: number,
  timezoneOffsetMinutes: number,
): number {
  return normalizeMinuteOfDay(
    validateMinute(utcMinuteOfDay) - validateOffset(timezoneOffsetMinutes),
  );
}

export function localMinuteToUtcMinute(
  localMinuteOfDay: number,
  timezoneOffsetMinutes: number,
): number {
  return normalizeMinuteOfDay(
    validateMinute(localMinuteOfDay) + validateOffset(timezoneOffsetMinutes),
  );
}

export function utcMinuteOfDay(date: Date): number {
  assertValidDate(date);
  return date.getUTCHours() * 60 + date.getUTCMinutes();
}

export function localMinuteOfDay(date: Date): number {
  assertValidDate(date);
  return date.getHours() * 60 + date.getMinutes();
}

function normalizeMinuteOfDay(minute: number): number {
  return ((minute % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
}

function validateMinute(minute: number): number {
  if (!Number.isInteger(minute) || minute < 0 || minute >= MINUTES_PER_DAY) {
    throw new RangeError(
      "Minute of day must be an integer from 0 through 1439",
    );
  }
  return minute;
}

function validateOffset(offset: number): number {
  if (!Number.isInteger(offset) || Math.abs(offset) >= MINUTES_PER_DAY) {
    throw new RangeError("Timezone offset must be a whole number of minutes");
  }
  return offset;
}

function assertValidDate(date: Date): void {
  if (!Number.isFinite(date.getTime())) {
    throw new RangeError("Date must be valid");
  }
}
