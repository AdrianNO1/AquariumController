import { healthResponseSchema } from "@aquarium/contracts";
import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "./app.js";
import {
  formatCommittedSseEvent,
  formatTransientSseEvent,
  resolveSseAfterRevision,
} from "./sse.js";

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

  it("formats transient SSE control messages without consuming a revision ID", () => {
    const formatted = formatTransientSseEvent({
      type: "system.stream-ready",
      occurredAt: "2026-07-10T12:00:00.000Z",
      data: { currentRevision: 42, replayedCount: 3 },
    });

    expect(formatted).not.toContain("id:");
    expect(formatted).toContain('"type":"system.stream-ready"');
    expect(formatted.endsWith("\n\n")).toBe(true);
  });

  it("formats committed events with their revision as the SSE identifier", () => {
    const formatted = formatCommittedSseEvent({
      revision: 12,
      type: "device.updated",
      occurredAt: "2026-07-10T12:00:00.000Z",
      entity: { type: "device", id: "esp-1" },
      schemaVersion: 1,
      data: { status: "online" },
    });

    expect(formatted.startsWith("id: 12\n")).toBe(true);
    expect(formatted).toContain('"revision":12');
  });

  it("gives a valid Last-Event-ID precedence over the snapshot query revision", () => {
    expect(resolveSseAfterRevision("4", "9")).toBe(9);
    expect(resolveSseAfterRevision("4", undefined)).toBe(4);
    expect(resolveSseAfterRevision(undefined, undefined)).toBe(0);
    expect(() => resolveSseAfterRevision("-1", undefined)).toThrow();
    expect(() => resolveSseAfterRevision("2", "not-a-revision")).toThrow();
  });
});
