import { describe, expect, it } from "vitest";

import { compileFirmwareSchedule } from "./schedule-compiler.js";
import {
  scheduleGraphFromPoints,
  validateScheduleGraph,
  type SchedulePoint,
  type ValidatedScheduleGraph,
} from "./schedule.js";

describe("firmware schedule compilation", () => {
  it("preserves channel order and applies throttle and profile multipliers", () => {
    const schedule = compileFirmwareSchedule([
      {
        pin: 12,
        kind: "light",
        throttlePercent: 50,
        outputGain: 0.5,
        graph: validGraph([
          { minute: 0, percent: 1 },
          { minute: 720, percent: 3 },
          { minute: 1_439, percent: 1 },
        ]),
      },
      {
        pin: 4,
        kind: "pump",
        throttlePercent: 75,
        outputGain: 1,
        graph: validGraph([
          { minute: 0, percent: 20 },
          { minute: 1_439, percent: 20 },
        ]),
      },
    ]);

    expect(schedule).toEqual({
      channels: [
        {
          pin: 12,
          kind: "light",
          links: [
            {
              source: { minute: 0, percent: 0 },
              target: { minute: 720, percent: 1 },
            },
            {
              source: { minute: 720, percent: 1 },
              target: { minute: 1_439, percent: 0 },
            },
          ],
        },
        {
          pin: 4,
          kind: "pump",
          links: [
            {
              source: { minute: 0, percent: 15 },
              target: { minute: 1_439, percent: 15 },
            },
          ],
        },
      ],
    });
    expect(Object.isFrozen(schedule)).toBe(true);
    expect(Object.isFrozen(schedule.channels[0]?.links)).toBe(true);
  });

  it("rejects unsafe pins, duplicate pins, and invalid throttles", () => {
    const graph = validGraph([
      { minute: 0, percent: 0 },
      { minute: 1_439, percent: 0 },
    ]);
    expect(() =>
      compileFirmwareSchedule([
        {
          pin: 64,
          kind: "light",
          graph,
          throttlePercent: 100,
          outputGain: 1,
        },
      ]),
    ).toThrow(/0 to 63/);
    expect(() =>
      compileFirmwareSchedule([
        {
          pin: 1,
          kind: "light",
          graph,
          throttlePercent: 100,
          outputGain: 1,
        },
        {
          pin: 1,
          kind: "pump",
          graph,
          throttlePercent: 100,
          outputGain: 1,
        },
      ]),
    ).toThrow(/duplicated/);
    expect(() =>
      compileFirmwareSchedule([
        {
          pin: 1,
          kind: "light",
          graph,
          throttlePercent: 101,
          outputGain: 1,
        },
      ]),
    ).toThrow(/between 0 and 100/);
    expect(() =>
      compileFirmwareSchedule([
        {
          pin: 1,
          kind: "light",
          graph,
          throttlePercent: 100,
          outputGain: 1.01,
        },
      ]),
    ).toThrow(/between 0 and 1/);
  });
});

function validGraph(points: readonly SchedulePoint[]): ValidatedScheduleGraph {
  const result = validateScheduleGraph(scheduleGraphFromPoints(points));
  if (!result.ok) {
    throw new Error(`Invalid test graph: ${JSON.stringify(result.issues)}`);
  }
  return result.graph;
}
