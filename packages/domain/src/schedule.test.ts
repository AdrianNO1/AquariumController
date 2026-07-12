import { describe, expect, it } from "vitest";

import {
  evaluateLegacySchedulePercentOrZero,
  evaluateSchedulePercent,
  evaluateSchedulePercentAtUtc,
  roundHalfEven,
  scheduleGraphFromPoints,
  toHostPwm,
  utcMinuteOfDay,
  validateScheduleGraph,
  type ScheduleGraph,
  type SchedulePoint,
  type ScheduleValidationIssue,
  type ValidatedScheduleGraph,
} from "./schedule.js";

const dailyPoints = [
  { minute: 0, percent: 0 },
  { minute: 360, percent: 100 },
  { minute: 720, percent: 100 },
  { minute: 1_080, percent: 0 },
  { minute: 1_439, percent: 0 },
] as const;

function requireValidGraph(
  points: readonly SchedulePoint[],
): ValidatedScheduleGraph {
  const result = validateScheduleGraph(scheduleGraphFromPoints(points));
  expect(result.ok, JSON.stringify(result.issues)).toBe(true);
  if (!result.ok) {
    throw new Error("Expected a valid schedule graph");
  }
  return result.graph;
}

function issueCodes(graph: ScheduleGraph): ScheduleValidationIssue["code"][] {
  const result = validateScheduleGraph(graph);
  return result.ok ? [] : result.issues.map((issue) => issue.code);
}

describe("schedule graph validation", () => {
  it("accepts an ordered, contiguous, midnight-wrapped graph", () => {
    const result = validateScheduleGraph(scheduleGraphFromPoints(dailyPoints));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.graph.segments).toHaveLength(4);
      expect(Object.isFrozen(result.graph)).toBe(true);
      expect(Object.isFrozen(result.graph.segments)).toBe(true);
    }
  });

  it("reports gaps, overlaps, zero durations, and discontinuities explicitly", () => {
    const gap: ScheduleGraph = {
      segments: [
        {
          source: { minute: 0, percent: 0 },
          target: { minute: 600, percent: 50 },
        },
        {
          source: { minute: 601, percent: 50 },
          target: { minute: 1_439, percent: 0 },
        },
      ],
    };
    const overlap: ScheduleGraph = {
      segments: [
        {
          source: { minute: 0, percent: 0 },
          target: { minute: 800, percent: 50 },
        },
        {
          source: { minute: 700, percent: 50 },
          target: { minute: 1_439, percent: 0 },
        },
      ],
    };
    const zeroAndDiscontinuous: ScheduleGraph = {
      segments: [
        {
          source: { minute: 0, percent: 0 },
          target: { minute: 0, percent: 0 },
        },
        {
          source: { minute: 0, percent: 10 },
          target: { minute: 1_439, percent: 0 },
        },
      ],
    };

    expect(issueCodes(gap)).toContain("gap");
    expect(issueCodes(overlap)).toContain("overlap");
    expect(issueCodes(zeroAndDiscontinuous)).toEqual(
      expect.arrayContaining(["zero-duration", "discontinuity"]),
    );
  });

  it("reports malformed boundaries, point values, ordering, and wrap continuity", () => {
    const graph: ScheduleGraph = {
      segments: [
        {
          source: { minute: 1.5, percent: -1 },
          target: { minute: 800, percent: 25 },
        },
        {
          source: { minute: 800, percent: 25 },
          target: { minute: 700, percent: 101 },
        },
      ],
    };

    expect(issueCodes(graph)).toEqual(
      expect.arrayContaining([
        "invalid-minute",
        "invalid-percent",
        "reversed-segment",
        "end-not-final-minute",
      ]),
    );

    const wrapMismatch = scheduleGraphFromPoints([
      { minute: 0, percent: 10 },
      { minute: 1_439, percent: 20 },
    ]);
    expect(issueCodes(wrapMismatch)).toContain("wrap-discontinuity");
  });

  it("does not allow the validated graph to change with its source objects", () => {
    const points: { minute: number; percent: number }[] = dailyPoints.map(
      (point) => ({ ...point }),
    );
    const graph = scheduleGraphFromPoints(points);
    const result = validateScheduleGraph(graph);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }

    const originalPoint = points[1];
    if (originalPoint === undefined) {
      throw new Error("Expected the test schedule point");
    }
    originalPoint.percent = 0;
    expect(evaluateSchedulePercent(result.graph, 360)).toBe(100);
  });
});

describe("UTC piecewise-linear schedule evaluation", () => {
  const graph = requireValidGraph(dailyPoints);

  it("interpolates rising, flat, and falling segments", () => {
    expect(evaluateSchedulePercent(graph, 0)).toBe(0);
    expect(evaluateSchedulePercent(graph, 180)).toBe(50);
    expect(evaluateSchedulePercent(graph, 540)).toBe(100);
    expect(evaluateSchedulePercent(graph, 900)).toBe(50);
    expect(evaluateSchedulePercent(graph, 1_439)).toBe(0);
  });

  it("stays within endpoint bounds at every UTC minute", () => {
    for (let minute = 0; minute <= 1_439; minute += 1) {
      const value = evaluateSchedulePercent(graph, minute);
      expect(Number.isFinite(value)).toBe(true);
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThanOrEqual(100);
    }
  });

  it("derives minutes from UTC rather than local clock fields", () => {
    expect(utcMinuteOfDay(new Date("2026-07-10T23:59:59.999Z"))).toBe(1_439);
    expect(utcMinuteOfDay(new Date("2026-07-11T00:00:00.000Z"))).toBe(0);
    expect(
      evaluateSchedulePercentAtUtc(graph, new Date("2026-07-10T06:00:30.000Z")),
    ).toBe(100);
  });

  it("rejects non-integer and out-of-day evaluation minutes", () => {
    expect(() => evaluateSchedulePercent(graph, -1)).toThrow(/integer/);
    expect(() => evaluateSchedulePercent(graph, 1_440)).toThrow(/integer/);
    expect(() => evaluateSchedulePercent(graph, 1.5)).toThrow(/integer/);
    expect(() => utcMinuteOfDay(new Date(Number.NaN))).toThrow(/valid Date/);
  });

  it("returns zero for uncovered time only through the named legacy fallback", () => {
    const malformed = [
      {
        source: { minute: 0, percent: 20 },
        target: { minute: 300, percent: 40 },
      },
      {
        source: { minute: 600, percent: 40 },
        target: { minute: 1_439, percent: 20 },
      },
    ] as const;

    expect(validateScheduleGraph({ segments: malformed }).ok).toBe(false);
    expect(evaluateLegacySchedulePercentOrZero(malformed, 450)).toBe(0);
    expect(evaluateLegacySchedulePercentOrZero(malformed, 150)).toBe(30);
  });

  it("matches deployed firmware ordering, zero-duration, and int conversion", () => {
    const firmwareLinks = [
      {
        source: { minute: 120, percent: 37 },
        target: { minute: 120, percent: 99 },
      },
      {
        source: { minute: 0, percent: 0 },
        target: { minute: 240, percent: 100 },
      },
      {
        source: { minute: 120, percent: 80 },
        target: { minute: 1_439, percent: 80 },
      },
    ] as const;

    // The first inclusive covering link wins, including a zero-duration link.
    expect(evaluateLegacySchedulePercentOrZero(firmwareLinks, 120)).toBe(37);
    // C++ converts the interpolated float to int by truncating toward zero.
    expect(evaluateLegacySchedulePercentOrZero(firmwareLinks, 119)).toBe(49);
    // At an overlapping endpoint, array order still decides the value.
    expect(evaluateLegacySchedulePercentOrZero(firmwareLinks, 240)).toBe(100);
  });
});

describe("Python-compatible rounding and host PWM", () => {
  it.each([
    [0.5, 0],
    [1.5, 2],
    [2.5, 2],
    [3.5, 4],
    [-0.5, 0],
    [-1.5, -2],
    [-2.5, -2],
    [2.500_000_000_000_000_4, 3],
  ])("rounds %s to the even integer %s", (value, expected) => {
    expect(roundHalfEven(value)).toBe(expected);
  });

  it("matches half-even parity across every 10-percent PWM midpoint", () => {
    expect([10, 30, 50, 70, 90].map((percent) => toHostPwm(percent))).toEqual([
      26, 76, 128, 178, 230,
    ]);
  });

  it("applies throttle and gain before rounding, then clamps to 8-bit PWM", () => {
    expect(toHostPwm(100)).toBe(255);
    expect(toHostPwm(100, 50)).toBe(128);
    expect(toHostPwm(80, 50, 0.5)).toBe(51);
    expect(toHostPwm(100, 100, 2)).toBe(255);
    expect(toHostPwm(100, 0, 10)).toBe(0);
  });

  it("rejects invalid scaling inputs instead of silently clamping them", () => {
    expect(() => toHostPwm(-1)).toThrow(/between 0 and 100/);
    expect(() => toHostPwm(50, 101)).toThrow(/between 0 and 100/);
    expect(() => toHostPwm(50, 100, -0.1)).toThrow(/non-negative/);
    expect(() => roundHalfEven(Number.POSITIVE_INFINITY)).toThrow(/finite/);
  });
});
