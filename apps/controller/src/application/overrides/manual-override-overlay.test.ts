import { describe, expect, it } from "vitest";

import { applyManualOverrideOverlays } from "./manual-override-overlay.js";

describe("manual override scheduler overlay", () => {
  it("keys by device and mapping, replaces scheduled rows, and appends unscheduled rows", () => {
    expect(
      applyManualOverrideOverlays(
        [
          {
            deviceId: "device-a",
            mappingId: "mapping-shared",
            pin: 4,
            value: 20,
            overwrite: false,
          },
          {
            deviceId: "device-b",
            mappingId: "mapping-shared",
            pin: 4,
            value: 30,
            overwrite: false,
          },
        ],
        [
          {
            overrideId: "override-scheduled",
            deviceId: "device-a",
            mappingId: "mapping-shared",
            pin: 4,
            value: 200,
            overwrite: true,
            expiresAtMs: 120_000,
          },
          {
            overrideId: "override-unscheduled",
            deviceId: "device-a",
            mappingId: "mapping-output",
            pin: 5,
            value: 180,
            overwrite: true,
            expiresAtMs: 120_000,
          },
        ],
      ),
    ).toEqual([
      {
        deviceId: "device-a",
        mappingId: "mapping-shared",
        pin: 4,
        value: 200,
        overwrite: true,
        overrideId: "override-scheduled",
      },
      {
        deviceId: "device-b",
        mappingId: "mapping-shared",
        pin: 4,
        value: 30,
        overwrite: false,
        overrideId: null,
      },
      {
        deviceId: "device-a",
        mappingId: "mapping-output",
        pin: 5,
        value: 180,
        overwrite: true,
        overrideId: "override-unscheduled",
      },
    ]);
  });

  it("fails loudly if effective commands would write one device pin twice", () => {
    expect(() =>
      applyManualOverrideOverlays(
        [
          {
            deviceId: "device-a",
            mappingId: "mapping-scheduled",
            pin: 4,
            value: 20,
            overwrite: false,
          },
        ],
        [
          {
            overrideId: "override-output",
            deviceId: "device-a",
            mappingId: "mapping-output",
            pin: 4,
            value: 180,
            overwrite: true,
            expiresAtMs: 120_000,
          },
        ],
      ),
    ).toThrow("overlap");
  });
});
