import { describe, expect, it } from "vitest";

import {
  healthResponseSchema,
  legacyControlAreaSchema,
  systemEventSchema,
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

  it("requires numeric SSE event identifiers", () => {
    const result = systemEventSchema.safeParse({
      id: "event-one",
      type: "system.connected",
      occurredAt: "2026-07-10T12:00:00.000Z",
      data: { revision: 1 },
    });

    expect(result.success).toBe(false);
  });
});
