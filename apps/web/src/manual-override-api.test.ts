// @vitest-environment jsdom
// @vitest-environment-options {"url":"http://localhost/"}

import {
  manualOverrideCommandResponseSchema,
  manualOverrideStateResponseSchema,
  type ManualOverrideCommandResponse,
  type ManualOverrideStateResponse,
  type OperationSummary,
  type Override,
} from "@aquarium/contracts";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  cancelManualOverride,
  extendManualOverride,
  reconcileManualOverride,
  startManualOverride,
} from "./api.js";

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

describe("manual override API", () => {
  it("uses every typed command route and validates its response", async () => {
    const requests: { readonly path: string; readonly body: object }[] = [];
    const startResponse = commandResponse(
      "override-start",
      "operation-start",
      "manual_override_start",
      9,
    );
    const extendResponse = stateResponse(
      activeOverride("override-start", "operation-start"),
      10,
    );
    const cancelResponse = commandResponse(
      "override-start",
      "operation-cancel",
      "manual_override_cancel",
      11,
    );
    const reconcileResponse = stateResponse(
      {
        ...activeOverride("override-start", "operation-cancel"),
        status: "failed",
        completedAt: "2026-07-13T10:04:00.000Z",
      },
      12,
    );
    server.use(
      http.post("http://localhost/api/overrides", async ({ request }) => {
        requests.push({
          path: new URL(request.url).pathname,
          body: (await request.json()) as object,
        });
        return HttpResponse.json(startResponse);
      }),
      http.post(
        "http://localhost/api/overrides/override-start/extend",
        async ({ request }) => {
          requests.push({
            path: new URL(request.url).pathname,
            body: (await request.json()) as object,
          });
          return HttpResponse.json(extendResponse);
        },
      ),
      http.post(
        "http://localhost/api/overrides/override-start/cancel",
        async ({ request }) => {
          requests.push({
            path: new URL(request.url).pathname,
            body: (await request.json()) as object,
          });
          return HttpResponse.json(cancelResponse);
        },
      ),
      http.post(
        "http://localhost/api/overrides/override-start/reconcile",
        async ({ request }) => {
          requests.push({
            path: new URL(request.url).pathname,
            body: (await request.json()) as object,
          });
          return HttpResponse.json(reconcileResponse);
        },
      ),
    );

    await expect(
      startManualOverride({
        expectedRevision: 8,
        target: { targetType: "output", targetId: "moonlight" },
        valuePercentage: 42.5,
      }),
    ).resolves.toEqual(startResponse);
    await expect(
      extendManualOverride("override-start", { expectedRevision: 9 }),
    ).resolves.toEqual(extendResponse);
    await expect(
      cancelManualOverride("override-start", { expectedRevision: 10 }),
    ).resolves.toEqual(cancelResponse);
    await expect(
      reconcileManualOverride("override-start", { expectedRevision: 11 }),
    ).resolves.toEqual(reconcileResponse);

    expect(requests).toEqual([
      {
        path: "/api/overrides",
        body: {
          expectedRevision: 8,
          target: { targetType: "output", targetId: "moonlight" },
          valuePercentage: 42.5,
        },
      },
      {
        path: "/api/overrides/override-start/extend",
        body: { expectedRevision: 9 },
      },
      {
        path: "/api/overrides/override-start/cancel",
        body: { expectedRevision: 10 },
      },
      {
        path: "/api/overrides/override-start/reconcile",
        body: { expectedRevision: 11 },
      },
    ]);
  });

  it("preserves revision conflicts without retrying a command", async () => {
    let calls = 0;
    server.use(
      http.post("http://localhost/api/overrides", () => {
        calls += 1;
        return HttpResponse.json(
          {
            code: "revision_conflict",
            message: "State revision changed",
            expectedRevision: 8,
            currentRevision: 9,
          },
          { status: 409 },
        );
      }),
    );

    await expect(
      startManualOverride({
        expectedRevision: 8,
        target: { targetType: "channel", targetId: "light-main" },
        valuePercentage: 50,
      }),
    ).rejects.toMatchObject({
      status: 409,
      details: { code: "revision_conflict", currentRevision: 9 },
    });
    expect(calls).toBe(1);
  });
});

function commandResponse(
  overrideId: string,
  operationId: string,
  kind: OperationSummary["kind"],
  revision: number,
): ManualOverrideCommandResponse {
  const value = activeOverride(overrideId, operationId);
  return manualOverrideCommandResponseSchema.parse({
    override: {
      ...value,
      status: "pending",
      startsAt: kind === "manual_override_start" ? null : value.startsAt,
    },
    operation: operation(operationId, kind),
    mutation: mutation(overrideId, operationId, revision),
  });
}

function stateResponse(
  override: Override,
  revision: number,
): ManualOverrideStateResponse {
  return manualOverrideStateResponseSchema.parse({
    override,
    mutation: mutation(
      override.id,
      override.operationId ?? "operation-start",
      revision,
    ),
  });
}

function activeOverride(overrideId: string, operationId: string): Override {
  return {
    id: overrideId,
    targetType: "output",
    targetId: "moonlight",
    valuePercentage: 42.5,
    status: "active",
    requestedAt: "2026-07-13T10:00:00.000Z",
    startsAt: "2026-07-13T10:00:01.000Z",
    expiresAt: "2026-07-13T10:03:00.000Z",
    completedAt: null,
    operationId,
  };
}

function operation(
  operationId: string,
  kind: OperationSummary["kind"],
): OperationSummary {
  return {
    id: operationId,
    deviceId: null,
    kind,
    status: "pending",
    requestedAt: "2026-07-13T10:00:00.000Z",
    deadlineAt: "2026-07-13T10:00:30.000Z",
    completedAt: null,
  };
}

function mutation(overrideId: string, operationId: string, revision: number) {
  return {
    changed: true as const,
    revision,
    event: {
      revision,
      type: "override.pending",
      occurredAt: "2026-07-13T10:00:00.000Z",
      entity: { type: "override" as const, id: overrideId },
      schemaVersion: 1 as const,
      data: {
        invalidations: [
          { resource: "override" as const, id: overrideId },
          { resource: "operation" as const, id: operationId },
        ],
      },
      retentionClass: "audit" as const,
    },
  };
}
