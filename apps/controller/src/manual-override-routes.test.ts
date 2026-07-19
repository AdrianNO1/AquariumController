import {
  manualOverrideCommandResponseSchema,
  manualOverrideStateResponseSchema,
  type ManualOverrideCommandResponse,
  type ManualOverrideStateResponse,
} from "@aquarium/contracts";
import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ManualOverrideRevisionConflictError,
  type ManualOverrideCommandService,
} from "./application/overrides/index.js";
import { registerManualOverrideRoutes } from "./manual-override-routes.js";

const openApps = new Set<FastifyInstance>();

afterEach(async () => {
  await Promise.all([...openApps].map((app) => app.close()));
  openApps.clear();
});

describe("manual override HTTP routes", () => {
  it("validates untrusted input before returning typed service availability", async () => {
    const app = track(Fastify());
    registerManualOverrideRoutes(app, {});

    const invalid = await app.inject({
      method: "POST",
      url: "/api/overrides",
      payload: {
        expectedRevision: 0,
        target: { targetType: "channel", targetId: "channel-blue" },
        valuePercentage: 101,
      },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toMatchObject({ code: "invalid_request" });

    const unavailable = await app.inject({
      method: "POST",
      url: "/api/overrides",
      payload: {
        expectedRevision: 0,
        target: { targetType: "channel", targetId: "channel-blue" },
        valuePercentage: 50,
      },
    });
    expect(unavailable.statusCode).toBe(503);
    expect(unavailable.json()).toEqual({
      code: "service_unavailable",
      message: "manual override service is not configured",
      service: "manual override service",
    });
  });

  it("routes start, extend, cancel, and reconcile through strict contracts", async () => {
    const commands = stubCommands();
    const app = track(Fastify());
    registerManualOverrideRoutes(app, { manualOverrideCommands: commands });

    const start = await app.inject({
      method: "POST",
      url: "/api/overrides",
      payload: {
        expectedRevision: 4,
        target: { targetType: "channel", targetId: "channel-blue" },
        valuePercentage: 50,
      },
    });
    expect(start.statusCode).toBe(200);
    expect(commands.startOverride).toHaveBeenCalledWith({
      expectedRevision: 4,
      target: { targetType: "channel", targetId: "channel-blue" },
      valuePercentage: 50,
    });

    for (const action of ["extend", "cancel", "reconcile"] as const) {
      const response = await app.inject({
        method: "POST",
        url: `/api/overrides/override-blue/${action}`,
        payload: { expectedRevision: 5 },
      });
      expect(response.statusCode).toBe(200);
    }
    expect(commands.extendOverride).toHaveBeenCalledWith("override-blue", {
      expectedRevision: 5,
    });
    expect(commands.cancelOverride).toHaveBeenCalledWith("override-blue", {
      expectedRevision: 5,
    });
    expect(commands.reconcileOverride).toHaveBeenCalledWith("override-blue", {
      expectedRevision: 5,
    });
  });

  it("returns a typed revision conflict without exposing implementation details", async () => {
    const commands = stubCommands();
    commands.extendOverride = vi.fn(async () => {
      throw new ManualOverrideRevisionConflictError(3, 4);
    });
    const app = track(Fastify());
    registerManualOverrideRoutes(app, { manualOverrideCommands: commands });

    const response = await app.inject({
      method: "POST",
      url: "/api/overrides/override-blue/extend",
      payload: { expectedRevision: 3 },
    });
    expect(response.statusCode).toBe(409);
    expect(response.json()).toEqual({
      code: "revision_conflict",
      message: "Expected state revision 3, but current revision is 4",
      expectedRevision: 3,
      currentRevision: 4,
    });
  });
});

function track(app: FastifyInstance): FastifyInstance {
  openApps.add(app);
  return app;
}

function stubCommands(): ManualOverrideCommandService & {
  startOverride: ReturnType<
    typeof vi.fn<ManualOverrideCommandService["startOverride"]>
  >;
  extendOverride: ReturnType<
    typeof vi.fn<ManualOverrideCommandService["extendOverride"]>
  >;
  cancelOverride: ReturnType<
    typeof vi.fn<ManualOverrideCommandService["cancelOverride"]>
  >;
  reconcileOverride: ReturnType<
    typeof vi.fn<ManualOverrideCommandService["reconcileOverride"]>
  >;
} {
  const command = commandResponse();
  const state = stateResponse();
  return {
    startOverride: vi.fn(async () => command),
    extendOverride: vi.fn(async () => state),
    cancelOverride: vi.fn(async () => command),
    reconcileOverride: vi.fn(async () => state),
  };
}

function commandResponse(): ManualOverrideCommandResponse {
  return manualOverrideCommandResponseSchema.parse({
    override: override("pending", "operation-start"),
    operation: {
      id: "operation-start",
      deviceId: null,
      kind: "manual_override_start",
      status: "pending",
      requestedAt: "2026-07-13T10:00:00.000Z",
      deadlineAt: "2026-07-13T10:00:30.000Z",
      completedAt: null,
    },
    mutation: mutation(5),
  });
}

function stateResponse(): ManualOverrideStateResponse {
  return manualOverrideStateResponseSchema.parse({
    override: override("active", "operation-start"),
    mutation: mutation(5),
  });
}

function override(status: "pending" | "active", operationId: string) {
  return {
    id: "override-blue",
    targetType: "channel" as const,
    targetId: "channel-blue",
    valuePercentage: 50,
    status,
    requestedAt: "2026-07-13T10:00:00.000Z",
    startsAt: status === "active" ? "2026-07-13T10:00:01.000Z" : null,
    expiresAt: "2026-07-13T10:02:00.000Z",
    completedAt: null,
    operationId,
  };
}

function mutation(revision: number) {
  return {
    changed: true as const,
    revision,
    event: {
      revision,
      type: "override.pending",
      occurredAt: "2026-07-13T10:00:00.000Z",
      entity: { type: "override" as const, id: "override-blue" },
      schemaVersion: 1 as const,
      data: {
        invalidations: [
          { resource: "override" as const, id: "override-blue" },
          { resource: "operation" as const, id: "operation-start" },
        ],
      },
      retentionClass: "audit" as const,
    },
  };
}
