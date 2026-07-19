import type { AlertHistoryListResponse } from "@aquarium/contracts";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  registerAlertHistoryRoutes,
  type AlertHistoryRouteReader,
} from "./alert-history-routes.js";
import { InvalidAlertHistoryCursorError } from "./infrastructure/database/index.js";

const openApps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
});

function emptyResponse(): AlertHistoryListResponse {
  return {
    schemaVersion: 1,
    items: [],
    nextCursor: null,
    hasMore: false,
    deliveriesTruncatedAlertIds: [],
  };
}

function createApp(reader?: AlertHistoryRouteReader): FastifyInstance {
  const app = Fastify({ logger: false });
  registerAlertHistoryRoutes(
    app,
    reader === undefined ? {} : { alertHistoryReader: reader },
  );
  openApps.push(app);
  return app;
}

describe("alert history HTTP route", () => {
  it("parses bounded query parameters and returns the shared response", async () => {
    const list = vi.fn(async () => emptyResponse());
    const app = createApp({ list });

    const response = await app.inject({
      method: "GET",
      url: "/api/alerts?state=recovered&pageSize=10",
    });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(emptyResponse());
    expect(list).toHaveBeenCalledWith({
      state: "recovered",
      pageSize: 10,
    });
  });

  it.each([
    "/api/alerts?state=invalid",
    "/api/alerts?pageSize=0",
    "/api/alerts?pageSize=51",
    "/api/alerts?extra=true",
  ])("rejects an invalid query before invoking the reader: %s", async (url) => {
    const list = vi.fn();
    const app = createApp({ list });

    const response = await app.inject({ method: "GET", url });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ code: "invalid_request" });
    expect(list).not.toHaveBeenCalled();
  });

  it("returns a typed unavailable response when history is not composed", async () => {
    const response = await createApp().inject({
      method: "GET",
      url: "/api/alerts",
    });

    expect(response.statusCode).toBe(503);
    expect(response.json()).toEqual({
      code: "service_unavailable",
      message: "alert history service is not configured",
      service: "alert history service",
    });
  });

  it("maps a filter-bound cursor failure to a safe validation response", async () => {
    const app = createApp({
      list: async () => {
        throw new InvalidAlertHistoryCursorError();
      },
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/alerts?cursor=bWFsZm9ybWVk",
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({
      code: "invalid_request",
      issues: [{ path: ["cursor"] }],
    });
  });

  it("does not expose persisted-data failures", async () => {
    const app = createApp({
      list: async () => {
        throw new Error("sensitive alert details");
      },
    });

    const response = await app.inject({
      method: "GET",
      url: "/api/alerts",
    });

    expect(response.statusCode).toBe(500);
    expect(response.body).not.toContain("sensitive alert details");
    expect(response.json()).toMatchObject({
      code: "internal_error",
      message: "Alert history query failed",
    });
  });
});
