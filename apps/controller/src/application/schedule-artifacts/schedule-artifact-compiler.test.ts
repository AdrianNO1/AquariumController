import { describe, expect, it } from "vitest";

import { compileDeviceScheduleArtifact } from "./schedule-artifact-compiler.js";
import type { ScheduleArtifactCompilationError } from "./schedule-artifact-compiler.js";
import type { DeviceScheduleProjection } from "./types.js";

describe("device schedule artifact compilation", () => {
  it("sorts normalized mappings and emits the canonical legacy golden payload", () => {
    const compiled = compileDeviceScheduleArtifact({
      sourceStateRevision: 7,
      deviceId: "device-main",
      firmwareVersion: "4.0.0",
      reportedScheduleHash: "0",
      channels: [
        {
          mappingId: "mapping-pump",
          displayOrder: 1,
          pin: 12,
          channelId: "channel-pump",
          channelKind: "pump",
          throttlePercentage: 100,
          points: [
            { id: "pump-end", position: 1, minuteOfDay: 1_439, percentage: 25 },
            { id: "pump-start", position: 0, minuteOfDay: 0, percentage: 25 },
          ],
        },
        {
          mappingId: "mapping-light",
          displayOrder: 0,
          pin: 4,
          channelId: "channel-light",
          channelKind: "testlight",
          throttlePercentage: 100,
          points: [
            { id: "light-end", position: 2, minuteOfDay: 1_439, percentage: 0 },
            { id: "light-start", position: 0, minuteOfDay: 0, percentage: 0 },
            { id: "light-mid", position: 1, minuteOfDay: 360, percentage: 50 },
          ],
        },
      ],
    });

    expect(compiled.payloadJson).toBe(
      '{"c":[{"o":4,"t":108,"l":[{"s":{"t":0,"p":0},"d":{"t":360,"p":50}},{"s":{"t":360,"p":50},"d":{"t":1439,"p":0}}]},{"o":12,"t":112,"l":[{"s":{"t":0,"p":25},"d":{"t":1439,"p":25}}]}]}',
    );
    expect(compiled.desiredScheduleHash).toBe("3007624189");
    expect(compiled.byteCount).toBe(
      new TextEncoder().encode(compiled.payloadJson).byteLength,
    );
    expect(compiled.payloadSchemaVersion).toBe(1);
    expect(compiled.payloadJson).not.toContain("syncTime");
  });

  it("accepts a 4095-byte worst-case document and rejects 4096 bytes", () => {
    const boundary = compileDeviceScheduleArtifact(
      largeProjectionWithExpandedZeroes(0),
    );
    expect(boundary.byteCount).toBe(4_072);

    expect(() =>
      compileDeviceScheduleArtifact(largeProjectionWithExpandedZeroes(1)),
    ).toThrowError(
      expect.objectContaining<Partial<ScheduleArtifactCompilationError>>({
        code: "schedule_capacity",
      }),
    );
  });

  it("rejects malformed normalized graph and mapping invariants", () => {
    const projection = largeProjectionWithExpandedZeroes(0);
    const firstChannel = projection.channels.at(0);
    if (!firstChannel) {
      throw new Error("Expected the test projection to contain a channel.");
    }
    expect(() =>
      compileDeviceScheduleArtifact({
        ...projection,
        channels: [
          firstChannel,
          { ...firstChannel, mappingId: "mapping-duplicate" },
        ],
      }),
    ).toThrowError(
      expect.objectContaining<Partial<ScheduleArtifactCompilationError>>({
        code: "invalid_mapping",
      }),
    );
  });
});

function largeProjectionWithExpandedZeroes(
  expandedZeroCount: number,
): DeviceScheduleProjection {
  const points = Array.from({ length: 92 }, (_, index) => ({
    id: `point-${index}`,
    position: index,
    minuteOfDay: index === 91 ? 1_439 : Math.floor((index * 1_439) / 91),
    percentage:
      index > 0 && index <= expandedZeroCount * 2 && index % 2 === 0
        ? 99
        : index === 91
          ? 0
          : index % 2 === 0
            ? 0
            : 100,
  }));
  return {
    sourceStateRevision: 1,
    deviceId: "device-large",
    firmwareVersion: "4.0.0",
    reportedScheduleHash: "0",
    channels: [
      {
        mappingId: "mapping-large",
        displayOrder: 0,
        pin: 1,
        channelId: "channel-large",
        channelKind: "light",
        throttlePercentage: 100,
        points,
      },
    ],
  };
}
