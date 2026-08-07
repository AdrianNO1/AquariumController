import { healthResponseSchema } from "@aquarium/contracts";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "./app.js";
import {
  formatCommittedSseEvent,
  formatTransientSseEvent,
  resolveSseAfterRevision,
} from "./sse.js";

const openApps: ReturnType<typeof buildApp>[] = [];
const temporaryDirectories: string[] = [];

afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
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

  it("distinguishes process liveness from dependency readiness", async () => {
    let ready = false;
    const app = buildApp({
      now: () => new Date("2026-07-10T12:00:00.000Z"),
      readinessProbe: async () => {
        if (!ready) {
          throw new Error("not ready");
        }
      },
    });
    openApps.push(app);

    const liveResponse = await app.inject({
      method: "GET",
      url: "/api/health/live",
    });
    const unavailableResponse = await app.inject({
      method: "GET",
      url: "/api/health/ready",
    });
    ready = true;
    const readyResponse = await app.inject({
      method: "GET",
      url: "/api/health/ready",
    });

    expect(liveResponse.statusCode).toBe(200);
    expect(unavailableResponse.statusCode).toBe(503);
    expect(unavailableResponse.json()).toMatchObject({ status: "not_ready" });
    expect(readyResponse.statusCode).toBe(200);
    expect(healthResponseSchema.parse(readyResponse.json()).status).toBe("ok");
  });

  it("serves immutable production assets and SPA routes from one origin", async () => {
    const webRoot = await mkdtemp(join(tmpdir(), "aquarium-web-"));
    temporaryDirectories.push(webRoot);
    await mkdir(join(webRoot, "assets"));
    await Promise.all([
      writeFile(
        join(webRoot, "index.html"),
        '<!doctype html><div id="root">Aquarium UI</div>',
        "utf8",
      ),
      writeFile(join(webRoot, "assets", "app-123.js"), "export {};\n", "utf8"),
    ]);
    const app = buildApp({ webRoot });
    openApps.push(app);

    const indexResponse = await app.inject({ method: "GET", url: "/" });
    const spaResponse = await app.inject({
      method: "GET",
      url: "/control/lights",
    });
    const assetResponse = await app.inject({
      method: "GET",
      url: "/assets/app-123.js",
    });
    const unknownApiResponse = await app.inject({
      method: "GET",
      url: "/api/not-a-route",
    });

    expect(indexResponse.statusCode).toBe(200);
    expect(indexResponse.headers["cache-control"]).toBe("no-cache");
    expect(indexResponse.headers["content-security-policy"]).toContain(
      "default-src 'self'",
    );
    expect(indexResponse.headers["content-security-policy"]).not.toContain(
      "upgrade-insecure-requests",
    );
    expect(indexResponse.headers["strict-transport-security"]).toBeUndefined();
    expect(spaResponse.statusCode).toBe(200);
    expect(spaResponse.body).toContain("Aquarium UI");
    expect(assetResponse.statusCode).toBe(200);
    expect(assetResponse.headers["cache-control"]).toBe(
      "public, max-age=31536000, immutable",
    );
    expect(unknownApiResponse.statusCode).toBe(404);
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
      data: {
        invalidations: [{ resource: "device", id: "esp-1" }],
      },
      retentionClass: "operational",
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

  it("does not expose the long-lived event stream through implicit HEAD", async () => {
    const app = buildApp();
    openApps.push(app);

    const response = await app.inject({ method: "HEAD", url: "/api/events" });

    expect(response.statusCode).toBe(404);
  });

  it("routes identifiers through the shared 128-character contract limit", async () => {
    const app = buildApp();
    openApps.push(app);
    const maximumLengthId = `a${":".repeat(127)}`;

    const response = await app.inject({
      method: "GET",
      url: `/api/operations/${encodeURIComponent(maximumLengthId)}`,
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toMatchObject({
      code: "service_unavailable",
      service: "controller configuration service",
    });
  });
});
