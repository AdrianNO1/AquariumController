import { describe, expect, it } from "vitest";

import {
  calculateLegacyScheduleHash,
  legacyScheduleCoreSchema,
  serializeLegacyScheduleCore,
  serializeLegacyScheduleDocument,
  unsignedDjb2,
  type LegacyScheduleCore,
} from "./schedule.js";

const goldenSchedule: LegacyScheduleCore = {
  c: [
    {
      o: 4,
      t: 108,
      l: [
        { s: { t: 0, p: 0 }, d: { t: 360, p: 50 } },
        { s: { t: 360, p: 50 }, d: { t: 1_439, p: 0 } },
      ],
    },
    {
      o: 12,
      t: 112,
      l: [{ s: { t: 0, p: 25 }, d: { t: 1_439, p: 25 } }],
    },
  ],
};

describe("legacy compact schedule wire format", () => {
  it("serializes with the legacy key order and no whitespace", () => {
    expect(serializeLegacyScheduleCore(goldenSchedule)).toBe(
      '{"c":[{"o":4,"t":108,"l":[{"s":{"t":0,"p":0},"d":{"t":360,"p":50}},{"s":{"t":360,"p":50},"d":{"t":1439,"p":0}}]},{"o":12,"t":112,"l":[{"s":{"t":0,"p":25},"d":{"t":1439,"p":25}}]}]}',
    );
  });

  it("appends syncTime exactly as the active host does", () => {
    expect(serializeLegacyScheduleDocument(goldenSchedule, 1_752_192_000)).toBe(
      '{"c":[{"o":4,"t":108,"l":[{"s":{"t":0,"p":0},"d":{"t":360,"p":50}},{"s":{"t":360,"p":50},"d":{"t":1439,"p":0}}]},{"o":12,"t":112,"l":[{"s":{"t":0,"p":25},"d":{"t":1439,"p":25}}]}],"syncTime":1752192000}',
    );
  });

  it("matches firmware/Python unsigned 32-bit DJB2 golden values", () => {
    expect(unsignedDjb2("")).toBe(5_381);
    expect(unsignedDjb2("hello")).toBe(261_238_937);
    expect(calculateLegacyScheduleHash(goldenSchedule)).toBe("3007624189");
  });

  it("rejects non-wire fields and invalid channel values", () => {
    expect(
      legacyScheduleCoreSchema.safeParse({
        c: [{ o: 64, t: 108, l: [], channelName: "not-on-wire" }],
      }).success,
    ).toBe(false);
  });

  it("enforces the active firmware document capacity after syncTime", () => {
    const schedule: LegacyScheduleCore = {
      c: Array.from({ length: 50 }, (_, channelIndex) => ({
        o: channelIndex,
        t: 108 as const,
        l: Array.from({ length: 10 }, () => ({
          s: { t: 0, p: 0 },
          d: { t: 1_439, p: 100 },
        })),
      })),
    };

    expect(() => serializeLegacyScheduleDocument(schedule, 1)).toThrow(/4096/);
  });
});
