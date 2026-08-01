import { describe, expect, it } from "vitest";

import {
  committedStateEventSchema,
  controllerStreamEventSchema,
  deviceContactEventSchema,
  healthResponseSchema,
  legacyControlAreaSchema,
  streamReadyEventSchema,
  systemStreamEventSchema,
} from "./index.js";

describe("shared contracts", () => {
  it("accepts the controller health response", () => {
    const parsed = healthResponseSchema.parse({
      service: "aquarium-controller",
      status: "ok",
      version: "0.1.0",
      now: "2026-07-10T12:00:00.000Z",
      capabilities: ["http", "sse"],
    });

    expect(parsed.status).toBe("ok");
  });

  it("rejects unrecognized control areas", () => {
    expect(legacyControlAreaSchema.safeParse("unknown").success).toBe(false);
  });

  it("does not assign a state revision identifier to stream readiness", () => {
    const parsed = streamReadyEventSchema.parse({
      type: "system.stream-ready",
      occurredAt: "2026-07-10T12:00:00.000Z",
      data: { currentRevision: 42, replayedCount: 3 },
    });

    expect("id" in parsed).toBe(false);
  });

  it("rejects incomplete resynchronization control messages", () => {
    const result = systemStreamEventSchema.safeParse({
      type: "system.resync-required",
      occurredAt: "2026-07-10T12:00:00.000Z",
      data: { earliestAvailableRevision: 10 },
    });

    expect(result.success).toBe(false);
  });

  it("validates versioned committed state events separately from transient controls", () => {
    const event = committedStateEventSchema.parse({
      revision: 7,
      type: "configuration.throttle-updated",
      occurredAt: "2026-07-10T12:00:00.000Z",
      entity: { type: "throttle", id: "blue" },
      schemaVersion: 1,
      data: {
        invalidations: [{ resource: "throttle", id: "blue" }],
      },
      retentionClass: "audit",
    });

    expect(controllerStreamEventSchema.parse(event)).toEqual(event);
    expect(
      committedStateEventSchema.safeParse({ ...event, revision: 0 }).success,
    ).toBe(false);
    expect(
      committedStateEventSchema.safeParse({
        ...event,
        data: {
          invalidations: [
            { resource: "throttle", id: "blue", invalid: Number.NaN },
          ],
        },
      }).success,
    ).toBe(false);
  });

  it("rejects excess fields at transient event boundaries", () => {
    expect(
      streamReadyEventSchema.safeParse({
        type: "system.stream-ready",
        occurredAt: "2026-07-10T12:00:00.000Z",
        data: { currentRevision: 0, replayedCount: 0, unexpected: true },
      }).success,
    ).toBe(false);
  });

  it("validates transient device contact without assigning a revision", () => {
    const event = deviceContactEventSchema.parse({
      type: "device.contact",
      occurredAt: "2026-07-10T12:00:00.000Z",
      data: { deviceId: "device-main" },
    });

    expect(controllerStreamEventSchema.parse(event)).toEqual(event);
    expect("revision" in event).toBe(false);
  });
});
