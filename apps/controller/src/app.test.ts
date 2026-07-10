import { healthResponseSchema } from "@aquarium/contracts";
import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "./app.js";
import { formatSseEvent } from "./sse.js";

const openApps: ReturnType<typeof buildApp>[] = [];

afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
});

describe("controller application", () => {
  it("returns a response validated by the shared health contract", async () => {
    const app = buildApp({
      now: () => new Date("2026-07-10T12:00:00.000Z"),
      version: "test-version",
    });
    openApps.push(app);

    const response = await app.inject({ method: "GET", url: "/api/health" });
    const body = healthResponseSchema.parse(response.json());

    expect(response.statusCode).toBe(200);
    expect(body).toEqual({
      service: "aquarium-controller",
      status: "ok",
      version: "test-version",
      now: "2026-07-10T12:00:00.000Z",
      capabilities: ["http", "sse"],
    });
  });

  it("formats replay-compatible SSE identifiers and JSON data", () => {
    const formatted = formatSseEvent({
      id: "42",
      type: "system.connected",
      occurredAt: "2026-07-10T12:00:00.000Z",
      data: { revision: 42 },
    });

    expect(formatted).toContain("id: 42\n");
    expect(formatted).toContain('"type":"system.connected"');
    expect(formatted.endsWith("\n\n")).toBe(true);
  });
});
