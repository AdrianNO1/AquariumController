export const UTC_MINUTE_MIN = 0;
export const UTC_MINUTE_MAX = 1_439;
export const HOST_PWM_MIN = 0;
export const HOST_PWM_MAX = 255;

export interface SchedulePoint {
  readonly minute: number;
  readonly percent: number;
}

export interface ScheduleSegment {
  readonly source: SchedulePoint;
  readonly target: SchedulePoint;
}

export interface ScheduleGraph {
  readonly segments: readonly ScheduleSegment[];
}

export type ScheduleEndpoint = "source" | "target";

export type ScheduleValidationIssue =
  | {
      readonly code: "empty-schedule";
    }
  | {
      readonly code: "invalid-minute";
      readonly segmentIndex: number;
      readonly endpoint: ScheduleEndpoint;
      readonly value: number;
      readonly reason: "not-finite" | "not-integer" | "out-of-range";
    }
  | {
      readonly code: "invalid-percent";
      readonly segmentIndex: number;
      readonly endpoint: ScheduleEndpoint;
      readonly value: number;
      readonly reason: "not-finite" | "out-of-range";
    }
  | {
      readonly code: "zero-duration";
      readonly segmentIndex: number;
      readonly minute: number;
    }
  | {
      readonly code: "reversed-segment";
      readonly segmentIndex: number;
      readonly sourceMinute: number;
      readonly targetMinute: number;
    }
  | {
      readonly code: "gap";
      readonly previousSegmentIndex: number;
      readonly segmentIndex: number;
      readonly previousEndMinute: number;
      readonly nextStartMinute: number;
    }
  | {
      readonly code: "overlap";
      readonly previousSegmentIndex: number;
      readonly segmentIndex: number;
      readonly previousEndMinute: number;
      readonly nextStartMinute: number;
    }
  | {
      readonly code: "discontinuity";
      readonly previousSegmentIndex: number;
      readonly segmentIndex: number;
      readonly minute: number;
      readonly previousPercent: number;
      readonly nextPercent: number;
    }
  | {
      readonly code: "start-not-midnight";
      readonly minute: number;
    }
  | {
      readonly code: "end-not-final-minute";
      readonly minute: number;
    }
  | {
      readonly code: "wrap-discontinuity";
      readonly startPercent: number;
      readonly endPercent: number;
    };

const validatedScheduleGraph = Symbol("validated-schedule-graph");

export interface ValidatedScheduleGraph extends ScheduleGraph {
  readonly [validatedScheduleGraph]: true;
}

export type ScheduleValidationResult =
  | {
      readonly ok: true;
      readonly graph: ValidatedScheduleGraph;
      readonly issues: readonly [];
    }
  | {
      readonly ok: false;
      readonly issues: readonly ScheduleValidationIssue[];
    };

/**
 * Builds legacy-style adjacent segments from canonical schedule points.
 * Validation remains explicit so callers can report every problem together.
 */
export function scheduleGraphFromPoints(
  points: readonly SchedulePoint[],
): ScheduleGraph {
  const segments: ScheduleSegment[] = [];

  for (let index = 0; index < points.length - 1; index += 1) {
    const source = points[index];
    const target = points[index + 1];
    if (source !== undefined && target !== undefined) {
      segments.push({ source, target });
    }
  }

  return { segments };
}

/**
 * Validates the complete periodic UTC graph and returns an immutable graph on
 * success. The copy prevents callers from invalidating it after validation.
 */
export function validateScheduleGraph(
  input: ScheduleGraph,
): ScheduleValidationResult {
  const issues: ScheduleValidationIssue[] = [];

  if (input.segments.length === 0) {
    return {
      ok: false,
      issues: Object.freeze([{ code: "empty-schedule" }]),
    };
  }

  input.segments.forEach((segment, segmentIndex) => {
    validatePoint(segment.source, segmentIndex, "source", issues);
    validatePoint(segment.target, segmentIndex, "target", issues);

    if (
      isValidUtcMinute(segment.source.minute) &&
      isValidUtcMinute(segment.target.minute)
    ) {
      if (segment.source.minute === segment.target.minute) {
        issues.push({
          code: "zero-duration",
          segmentIndex,
          minute: segment.source.minute,
        });
      } else if (segment.source.minute > segment.target.minute) {
        issues.push({
          code: "reversed-segment",
          segmentIndex,
          sourceMinute: segment.source.minute,
          targetMinute: segment.target.minute,
        });
      }
    }
  });

  const firstSegment = input.segments[0];
  const lastSegment = input.segments[input.segments.length - 1];

  if (
    firstSegment !== undefined &&
    isValidUtcMinute(firstSegment.source.minute) &&
    firstSegment.source.minute !== UTC_MINUTE_MIN
  ) {
    issues.push({
      code: "start-not-midnight",
      minute: firstSegment.source.minute,
    });
  }

  if (
    lastSegment !== undefined &&
    isValidUtcMinute(lastSegment.target.minute) &&
    lastSegment.target.minute !== UTC_MINUTE_MAX
  ) {
    issues.push({
      code: "end-not-final-minute",
      minute: lastSegment.target.minute,
    });
  }

  for (
    let segmentIndex = 1;
    segmentIndex < input.segments.length;
    segmentIndex += 1
  ) {
    const previous = input.segments[segmentIndex - 1];
    const current = input.segments[segmentIndex];
    if (previous === undefined || current === undefined) {
      continue;
    }

    const previousEndMinute = previous.target.minute;
    const nextStartMinute = current.source.minute;
    if (
      !isValidUtcMinute(previousEndMinute) ||
      !isValidUtcMinute(nextStartMinute)
    ) {
      continue;
    }

    if (previousEndMinute < nextStartMinute) {
      issues.push({
        code: "gap",
        previousSegmentIndex: segmentIndex - 1,
        segmentIndex,
        previousEndMinute,
        nextStartMinute,
      });
    } else if (previousEndMinute > nextStartMinute) {
      issues.push({
        code: "overlap",
        previousSegmentIndex: segmentIndex - 1,
        segmentIndex,
        previousEndMinute,
        nextStartMinute,
      });
    } else if (
      isValidPercent(previous.target.percent) &&
      isValidPercent(current.source.percent) &&
      previous.target.percent !== current.source.percent
    ) {
      issues.push({
        code: "discontinuity",
        previousSegmentIndex: segmentIndex - 1,
        segmentIndex,
        minute: previousEndMinute,
        previousPercent: previous.target.percent,
        nextPercent: current.source.percent,
      });
    }
  }

  if (
    firstSegment !== undefined &&
    lastSegment !== undefined &&
    isValidPercent(firstSegment.source.percent) &&
    isValidPercent(lastSegment.target.percent) &&
    firstSegment.source.percent !== lastSegment.target.percent
  ) {
    issues.push({
      code: "wrap-discontinuity",
      startPercent: firstSegment.source.percent,
      endPercent: lastSegment.target.percent,
    });
  }

  if (issues.length > 0) {
    return { ok: false, issues: Object.freeze(issues) };
  }

  const segments = input.segments.map((segment) =>
    Object.freeze({
      source: Object.freeze({ ...segment.source }),
      target: Object.freeze({ ...segment.target }),
    }),
  );
  const graph: ValidatedScheduleGraph = Object.freeze({
    segments: Object.freeze(segments),
    [validatedScheduleGraph]: true as const,
  });

  return { ok: true, graph, issues: [] };
}

/** Evaluates a validated graph at an integer UTC minute. */
export function evaluateSchedulePercent(
  graph: ValidatedScheduleGraph,
  minute: number,
): number {
  assertUtcMinute(minute);

  for (const segment of graph.segments) {
    if (segment.source.minute <= minute && segment.target.minute >= minute) {
      return interpolateSegment(segment, minute);
    }
  }

  throw new Error(
    `Validated schedule invariant violated: minute ${minute} is uncovered`,
  );
}

/** Evaluates by UTC clock fields, intentionally ignoring local time and seconds. */
export function evaluateSchedulePercentAtUtc(
  graph: ValidatedScheduleGraph,
  at: Date,
): number {
  return evaluateSchedulePercent(graph, utcMinuteOfDay(at));
}

/**
 * Mirrors deployed ESP32 getScheduledValue behavior for compatibility checks:
 * the first inclusive covering link wins, a zero-duration link returns its
 * source value, interpolation is truncated by the firmware's int return type,
 * and an uncovered minute returns 0. Canonical controller code must validate
 * and use evaluateSchedulePercent instead.
 */
export function evaluateLegacySchedulePercentOrZero(
  segments: readonly ScheduleSegment[],
  minute: number,
): number {
  assertUtcMinute(minute);

  for (const segment of segments) {
    if (segment.source.minute <= minute && segment.target.minute >= minute) {
      if (segment.source.minute === segment.target.minute) {
        return Math.trunc(segment.source.percent);
      }

      const progress = Math.fround(
        (minute - segment.source.minute) /
          (segment.target.minute - segment.source.minute),
      );
      const delta = Math.fround(
        (segment.target.percent - segment.source.percent) * progress,
      );
      return Math.trunc(Math.fround(segment.source.percent + delta));
    }
  }

  return 0;
}

export function utcMinuteOfDay(at: Date): number {
  if (!Number.isFinite(at.getTime())) {
    throw new RangeError("UTC schedule evaluation requires a valid Date");
  }

  return at.getUTCHours() * 60 + at.getUTCMinutes();
}

/** Matches Python round(number) for finite values: ties go to the even integer. */
export function roundHalfEven(value: number): number {
  if (!Number.isFinite(value)) {
    throw new RangeError("Half-even rounding requires a finite number");
  }

  if (Number.isInteger(value)) {
    return Object.is(value, -0) ? 0 : value;
  }

  const lower = Math.floor(value);
  const fraction = value - lower;
  let rounded: number;

  if (fraction < 0.5) {
    rounded = lower;
  } else if (fraction > 0.5) {
    rounded = lower + 1;
  } else {
    rounded = lower % 2 === 0 ? lower : lower + 1;
  }

  return Object.is(rounded, -0) ? 0 : rounded;
}

/**
 * Converts scheduled percent to the legacy host's 8-bit PWM value. Throttle is
 * a percent and gain is a non-negative multiplier (for example, 0.7).
 */
export function toHostPwm(
  percent: number,
  throttlePercent = 100,
  gain = 1,
): number {
  assertPercent(percent, "Schedule percent");
  assertPercent(throttlePercent, "Throttle percent");
  if (!Number.isFinite(gain) || gain < 0) {
    throw new RangeError("Gain must be a finite non-negative number");
  }

  const throttleGain = (throttlePercent / 100) * gain;
  const scaled = (percent / 100) * HOST_PWM_MAX * throttleGain;
  return clamp(roundHalfEven(scaled), HOST_PWM_MIN, HOST_PWM_MAX);
}

function validatePoint(
  point: SchedulePoint,
  segmentIndex: number,
  endpoint: ScheduleEndpoint,
  issues: ScheduleValidationIssue[],
): void {
  if (!Number.isFinite(point.minute)) {
    issues.push({
      code: "invalid-minute",
      segmentIndex,
      endpoint,
      value: point.minute,
      reason: "not-finite",
    });
  } else if (!Number.isInteger(point.minute)) {
    issues.push({
      code: "invalid-minute",
      segmentIndex,
      endpoint,
      value: point.minute,
      reason: "not-integer",
    });
  } else if (point.minute < UTC_MINUTE_MIN || point.minute > UTC_MINUTE_MAX) {
    issues.push({
      code: "invalid-minute",
      segmentIndex,
      endpoint,
      value: point.minute,
      reason: "out-of-range",
    });
  }

  if (!Number.isFinite(point.percent)) {
    issues.push({
      code: "invalid-percent",
      segmentIndex,
      endpoint,
      value: point.percent,
      reason: "not-finite",
    });
  } else if (point.percent < 0 || point.percent > 100) {
    issues.push({
      code: "invalid-percent",
      segmentIndex,
      endpoint,
      value: point.percent,
      reason: "out-of-range",
    });
  }
}

function interpolateSegment(segment: ScheduleSegment, minute: number): number {
  const duration = segment.target.minute - segment.source.minute;
  const progress = (minute - segment.source.minute) / duration;
  return (
    segment.source.percent +
    progress * (segment.target.percent - segment.source.percent)
  );
}

function isValidUtcMinute(minute: number): boolean {
  return (
    Number.isFinite(minute) &&
    Number.isInteger(minute) &&
    minute >= UTC_MINUTE_MIN &&
    minute <= UTC_MINUTE_MAX
  );
}

function isValidPercent(percent: number): boolean {
  return Number.isFinite(percent) && percent >= 0 && percent <= 100;
}

function assertUtcMinute(minute: number): void {
  if (!isValidUtcMinute(minute)) {
    throw new RangeError(
      `UTC minute must be an integer from ${UTC_MINUTE_MIN} through ${UTC_MINUTE_MAX}`,
    );
  }
}

function assertPercent(percent: number, label: string): void {
  if (!isValidPercent(percent)) {
    throw new RangeError(`${label} must be between 0 and 100`);
  }
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(Math.max(value, minimum), maximum);
}
