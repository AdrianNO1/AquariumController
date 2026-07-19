// @vitest-environment jsdom
// @vitest-environment-options {"url":"http://localhost/"}

import {
  acknowledgeAlertRequestSchema,
  alertHistoryListResponseSchema,
  logsListResponseSchema,
  type AcknowledgeAlertRequest,
} from "@aquarium/contracts";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  acknowledgeAlert,
  AquariumApiError,
  buildLogExportUrl,
  fetchControllerSnapshot,
  fetchAlertHistory,
  fetchLogs,
} from "./api.js";
import {
  createTestAlertsSnapshot,
  createTestControllerSnapshot,
} from "./test-controller-snapshot.js";

const server = setupServer();
const nativeFetch = globalThis.fetch;

beforeAll(() => {
  globalThis.fetch = (input, init) => {
    const resolvedInput =
      typeof input === "string" ? new URL(input, window.location.href) : input;
    return nativeFetch(resolvedInput, init);
  };
  server.listen({ onUnhandledRequest: "error" });
});

afterEach(() => server.resetHandlers());

afterAll(() => {
  server.close();
  globalThis.fetch = nativeFetch;
});

describe("fetchControllerSnapshot", () => {
  it("requests and validates the authoritative snapshot", async () => {
    const snapshot = createTestControllerSnapshot(12);
    server.use(
      http.get("http://localhost/api/snapshot", () =>
        HttpResponse.json(snapshot),
      ),
    );

    await expect(fetchControllerSnapshot()).resolves.toEqual(snapshot);
  });

  it("rejects a successful response that violates the strict contract", async () => {
    server.use(
      http.get("http://localhost/api/snapshot", () =>
        HttpResponse.json({
          ...createTestControllerSnapshot(12),
          unexpected: true,
        }),
      ),
    );

    await expect(fetchControllerSnapshot()).rejects.toThrow();
  });

  it("reports a non-successful snapshot response", async () => {
    server.use(
      http.get(
        "http://localhost/api/snapshot",
        () => new HttpResponse(null, { status: 503 }),
      ),
    );

    await expect(fetchControllerSnapshot()).rejects.toThrow(
      "Snapshot request failed with HTTP 503",
    );
  });
});

describe("logs API", () => {
  it("serializes filters and validates a log page", async () => {
    const responseBody = logsListResponseSchema.parse({
      schemaVersion: 1,
      items: [
        {
          id: 3,
          occurredAtMs: 1_000,
          direction: "inbound",
          kind: "mqtt.response",
          severity: "info",
          topic: "test/aquarium/fromesp",
          deviceId: "device-1",
          correlationId: "correlation-1",
          operationId: "operation-1",
          outcome: "succeeded",
          durationMs: 4,
          byteCount: 24,
          retentionClass: "audit",
          payload: { response: "ok" },
          payloadSchemaVersion: 1,
          payloadSha256: "a".repeat(64),
        },
      ],
      nextCursor: null,
      hasMore: false,
      summary: {
        returnedCount: 1,
        totalByteCount: 24,
        firstOccurredAtMs: 1_000,
        lastOccurredAtMs: 1_000,
      },
    });
    const requestedUrls: URL[] = [];
    server.use(
      http.get("http://localhost/api/logs", ({ request }) => {
        requestedUrls.push(new URL(request.url));
        return HttpResponse.json(responseBody);
      }),
    );

    await expect(
      fetchLogs({
        filters: {
          direction: "inbound",
          severity: "info",
          deviceId: "device-1",
        },
        pageSize: 25,
      }),
    ).resolves.toEqual(responseBody);
    expect(requestedUrls[0]?.searchParams.get("direction")).toBe("inbound");
    expect(requestedUrls[0]?.searchParams.get("severity")).toBe("info");
    expect(requestedUrls[0]?.searchParams.get("deviceId")).toBe("device-1");
    expect(requestedUrls[0]?.searchParams.get("pageSize")).toBe("25");
  });

  it("builds a bounded same-origin export URL from validated input", () => {
    const url = new URL(
      buildLogExportUrl({
        filters: { retentionClass: "audit", outcome: "failed" },
        format: "ndjson",
        maxRows: 500,
      }),
      window.location.href,
    );

    expect(url.pathname).toBe("/api/logs/export");
    expect(url.searchParams.get("retentionClass")).toBe("audit");
    expect(url.searchParams.get("outcome")).toBe("failed");
    expect(url.searchParams.get("format")).toBe("ndjson");
    expect(url.searchParams.get("maxRows")).toBe("500");
  });
});

describe("alert acknowledgement API", () => {
  it("sends the expected revision and validates the mutation result", async () => {
    let received: AcknowledgeAlertRequest | null = null;
    server.use(
      http.post(
        "http://localhost/api/alerts/alert-open/acknowledge",
        async ({ request }) => {
          received = acknowledgeAlertRequestSchema.parse(await request.json());
          return HttpResponse.json({
            changed: false,
            revision: 4,
            event: null,
          });
        },
      ),
    );

    await expect(
      acknowledgeAlert("alert-open", {
        expectedRevision: 4,
        note: "Investigating",
      }),
    ).resolves.toEqual({ changed: false, revision: 4, event: null });
    expect(received).toEqual({
      expectedRevision: 4,
      note: "Investigating",
    });
  });

  it("preserves a typed revision conflict for conflict-safe UI handling", async () => {
    server.use(
      http.post("http://localhost/api/alerts/alert-open/acknowledge", () =>
        HttpResponse.json(
          {
            code: "revision_conflict",
            message: "State revision changed",
            expectedRevision: 4,
            currentRevision: 5,
          },
          { status: 409 },
        ),
      ),
    );

    const request = acknowledgeAlert("alert-open", {
      expectedRevision: 4,
      note: null,
    });
    await expect(request).rejects.toBeInstanceOf(AquariumApiError);
    await expect(request).rejects.toMatchObject({
      status: 409,
      details: {
        code: "revision_conflict",
        expectedRevision: 4,
        currentRevision: 5,
      },
    });
  });
});

describe("alert history API", () => {
  it("serializes the bounded lifecycle query and validates history", async () => {
    const recovered = createTestAlertsSnapshot().alerts.find(
      (alert) => alert.state === "recovered",
    );
    if (recovered === undefined) {
      throw new Error("Missing recovered alert fixture");
    }
    const responseBody = alertHistoryListResponseSchema.parse({
      schemaVersion: 1,
      items: [recovered],
      nextCursor: null,
      hasMore: false,
      deliveriesTruncatedAlertIds: [],
    });
    const requestedUrls: URL[] = [];
    server.use(
      http.get("http://localhost/api/alerts", ({ request }) => {
        requestedUrls.push(new URL(request.url));
        return HttpResponse.json(responseBody);
      }),
    );

    await expect(
      fetchAlertHistory({ state: "recovered", pageSize: 10 }),
    ).resolves.toEqual(responseBody);
    expect(requestedUrls[0]?.searchParams.get("state")).toBe("recovered");
    expect(requestedUrls[0]?.searchParams.get("pageSize")).toBe("10");
  });
});
