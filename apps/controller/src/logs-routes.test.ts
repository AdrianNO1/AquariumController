import {
  logsListResponseSchema,
  type LogExportMetadata,
  type LogExportRequest,
  type LogsListResponse,
} from "@aquarium/contracts";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { LogExportSink } from "./application/logs/index.js";
import { registerLogsRoutes, type LogsRouteService } from "./logs-routes.js";

const openApps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
});

function emptyLogsResponse(): LogsListResponse {
  return {
    schemaVersion: 1,
    items: [],
    nextCursor: null,
    hasMore: false,
    summary: {
      returnedCount: 0,
      totalByteCount: 0,
      firstOccurredAtMs: null,
      lastOccurredAtMs: null,
    },
  };
}

function createApp(logsService?: LogsRouteService): FastifyInstance {
  const app = Fastify({ logger: false });
  registerLogsRoutes(app, logsService === undefined ? {} : { logsService });
  openApps.push(app);
  return app;
}

describe("logs HTTP routes", () => {
  it("parses flat, bounded query parameters into the typed list request", async () => {
    const list = vi.fn(async (): Promise<LogsListResponse> =>
      emptyLogsResponse(),
    );
    const app = createApp({
      list,
      export: vi.fn(),
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/logs?startAtMs=10&endAtMs=20&direction=inbound&kind=mqtt.command&severity=warning&deviceId=esp-1&operationId=op-1&correlationId=cor-1&outcome=succeeded&retentionClass=audit&pageSize=25",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(emptyLogsResponse());
    expect(list).toHaveBeenCalledWith({
      filters: {
        startAtMs: 10,
        endAtMs: 20,
        direction: "inbound",
        kind: "mqtt.command",
        severity: "warning",
        deviceId: "esp-1",
        operationId: "op-1",
        correlationId: "cor-1",
        outcome: "succeeded",
        retentionClass: "audit",
      },
      pageSize: 25,
    });
  });

  it.each([
    "/api/logs?pageSize=0",
    "/api/logs?pageSize=101",
    "/api/logs?startAtMs=-1",
    "/api/logs?startAtMs=20&endAtMs=10",
    "/api/logs?severity=verbose",
    "/api/logs?extra=true",
  ])("rejects an invalid list query: %s", async (url) => {
    const list = vi.fn();
    const app = createApp({ list, export: vi.fn() });

    const response = await app.inject({ method: "GET", url });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      code: "invalid_request",
      message: "Request validation failed",
    });
    expect(list).not.toHaveBeenCalled();
  });

  it("returns a typed service-unavailable response when logs are not composed", async () => {
    const app = createApp();

    const listResponse = await app.inject({
      method: "GET",
      url: "/api/logs",
    });
    const exportResponse = await app.inject({
      method: "GET",
      url: "/api/logs/export?format=csv",
    });

    expect(listResponse.statusCode).toBe(503);
    expect(exportResponse.statusCode).toBe(503);
    expect(listResponse.json()).toEqual({
      code: "service_unavailable",
      message: "logs service is not configured",
      service: "logs service",
    });
  });

  it("does not expose repository failures in list responses", async () => {
    const app = createApp({
      list: async () => {
        throw new Error("sensitive persisted payload");
      },
      export: vi.fn(),
    });

    const response = await app.inject({ method: "GET", url: "/api/logs" });

    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain("sensitive persisted payload");
    expect(response.json()).toMatchObject({
      code: "internal_error",
      message: "Log query failed",
    });
  });

  it("reports an invalid internal response as a server error", async () => {
    const app = createApp({
      list: async () =>
        logsListResponseSchema.parse({
          ...emptyLogsResponse(),
          summary: {
            ...emptyLogsResponse().summary,
            returnedCount: 1,
          },
        }),
      export: vi.fn(),
    });

    const response = await app.inject({ method: "GET", url: "/api/logs" });

    expect(response.statusCode).toBe(500);
    expect(response.json()).toMatchObject({
      code: "internal_error",
      message: "Log query failed",
    });
  });

  it("streams CSV with bounded request parsing, attachment headers, and trailers", async () => {
    const exportLogs = vi.fn(
      async (
        request: LogExportRequest,
        sink: LogExportSink,
      ): Promise<LogExportMetadata> => {
        await sink.write("id,kind\r\n");
        await sink.write("1,mqtt.command\r\n");
        return {
          schemaVersion: 1,
          format: "csv",
          generatedAt: "2026-07-13T12:00:00.000Z",
          requestedFilters: request.filters,
          requestedMaxRows: request.maxRows,
          rowCount: 1,
          truncated: false,
          contentType: "text/csv",
          filename: "aquarium-logs-20260713T120000000Z.csv",
        };
      },
    );
    const app = createApp({
      list: vi.fn(),
      export: exportLogs,
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/logs/export?format=csv&deviceId=esp-1&maxRows=500",
    });

    expect(response.statusCode).toBe(200);
    expect(response.headers["content-type"]).toBe("text/csv; charset=utf-8");
    expect(response.headers["content-disposition"]).toBe(
      'attachment; filename="aquarium-logs.csv"',
    );
    expect(response.body).toBe("id,kind\r\n1,mqtt.command\r\n");
    expect(response.trailers).toMatchObject({
      "x-aquarium-log-row-count": "1",
      "x-aquarium-log-truncated": "false",
    });
    expect(exportLogs).toHaveBeenCalledWith(
      {
        filters: { deviceId: "esp-1" },
        format: "csv",
        maxRows: 500,
      },
      expect.objectContaining({ write: expect.any(Function) }),
    );
  });

  it("does not run a streaming export through implicit HEAD", async () => {
    const exportLogs = vi.fn();
    const app = createApp({ list: vi.fn(), export: exportLogs });

    const response = await app.inject({
      method: "HEAD",
      url: "/api/logs/export?format=csv",
    });

    expect(response.statusCode).toBe(404);
    expect(exportLogs).not.toHaveBeenCalled();
  });

  it.each([
    "/api/logs/export",
    "/api/logs/export?format=json",
    "/api/logs/export?format=ndjson&maxRows=100001",
    "/api/logs/export?format=ndjson&unexpected=true",
  ])("rejects an invalid export query before streaming: %s", async (url) => {
    const exportLogs = vi.fn();
    const app = createApp({ list: vi.fn(), export: exportLogs });

    const response = await app.inject({ method: "GET", url });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: "invalid_request" });
    expect(exportLogs).not.toHaveBeenCalled();
  });
});
