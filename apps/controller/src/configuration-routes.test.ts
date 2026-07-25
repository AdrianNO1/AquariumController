import {
  alertRulesResponseSchema,
  type MutationResult,
} from "@aquarium/contracts";
import type { FastifyInstance } from "fastify";
import type { Kysely } from "kysely";
import { afterEach, describe, expect, it, vi } from "vitest";

import { buildApp } from "./app.js";
import { ConfigurationRelationalConflictError } from "./application/configuration/index.js";
import {
  ControllerConfigurationRepository,
  openStateDatabase,
  type StateDatabaseSchema,
} from "./infrastructure/database/index.js";

const openApps = new Set<FastifyInstance>();
const openDatabases = new Set<Kysely<StateDatabaseSchema>>();

async function createRepository(): Promise<{
  readonly database: Kysely<StateDatabaseSchema>;
  readonly repository: ControllerConfigurationRepository;
}> {
  const database = await openStateDatabase({ filename: ":memory:" });
  openDatabases.add(database);
  return {
    database,
    repository: new ControllerConfigurationRepository(database, {
      nowMs: () => 100,
    }),
  };
}

function trackApp(app: FastifyInstance): FastifyInstance {
  openApps.add(app);
  return app;
}

afterEach(async () => {
  await Promise.all(
    [...openApps].map(async (app) => {
      await app.close();
      openApps.delete(app);
    }),
  );
  await Promise.all(
    [...openDatabases].map(async (database) => {
      await database.destroy();
      openDatabases.delete(database);
    }),
  );
});

describe("configuration HTTP routes", () => {
  it("validates requests before returning typed unavailable-service errors", async () => {
    const app = trackApp(buildApp());
    const invalid = await app.inject({
      method: "POST",
      url: "/api/channels",
      payload: {
        expectedRevision: 0,
        id: "channel-blue",
        name: "Blue",
        typeKey: "light",
        throttleId: "throttle-light",
        displayOrder: 0,
        enabled: true,
        extra: true,
      },
    });
    expect(invalid.statusCode).toBe(400);
    expect(invalid.json()).toMatchObject({ code: "invalid_request" });

    const rules = await app.inject({ method: "GET", url: "/api/alert-rules" });
    expect(rules.statusCode).toBe(503);
    expect(rules.json()).toEqual({
      code: "service_unavailable",
      message: "controller configuration service is not configured",
      service: "controller configuration service",
    });

    const device = await app.inject({
      method: "PATCH",
      url: "/api/devices/device-main/configuration",
      payload: { expectedRevision: 0, name: "Main" },
    });
    expect(device.statusCode).toBe(503);
    expect(device.json()).toMatchObject({
      code: "service_unavailable",
      service: "device configuration command service",
    });

    const reconciliation = await app.inject({
      method: "POST",
      url: "/api/operations/operation-main/reconcile",
      payload: { expectedRevision: 0 },
    });
    expect(reconciliation.statusCode).toBe(503);
    expect(reconciliation.json()).toMatchObject({
      code: "service_unavailable",
      service: "device configuration command service",
    });

    const alert = await app.inject({
      method: "POST",
      url: "/api/alerts/alert-main/acknowledge",
      payload: { expectedRevision: 0, note: null },
    });
    expect(alert.statusCode).toBe(503);
    expect(alert.json()).toMatchObject({
      code: "service_unavailable",
      service: "alert acknowledgement service",
    });
  });

  it("returns changed and no-op results and maps not-found and revision conflicts", async () => {
    const { database, repository } = await createRepository();
    await database
      .insertInto("throttles")
      .values({
        id: "throttle-light",
        type_key: "light",
        percentage: 100,
        created_at_ms: 0,
        updated_at_ms: 0,
      })
      .executeTakeFirstOrThrow();
    const app = trackApp(buildApp({ configurationService: repository }));
    const request = {
      expectedRevision: 0,
      id: "channel-blue",
      name: "Blue",
      typeKey: "light",
      throttleId: "throttle-light",
      displayOrder: 0,
      enabled: true,
    } as const;

    const created = await app.inject({
      method: "POST",
      url: "/api/channels",
      payload: request,
    });
    expect(created.statusCode).toBe(200);
    expect(created.json()).toMatchObject({ changed: true, revision: 1 });

    const noOp = await app.inject({
      method: "POST",
      url: "/api/channels",
      payload: { ...request, expectedRevision: 1 },
    });
    expect(noOp.statusCode).toBe(200);
    expect(noOp.json()).toEqual({ changed: false, revision: 1, event: null });

    const missing = await app.inject({
      method: "PATCH",
      url: "/api/channels/channel-missing",
      payload: { expectedRevision: 1, name: "Missing" },
    });
    expect(missing.statusCode).toBe(404);
    expect(missing.json()).toMatchObject({
      code: "not_found",
      resource: "channel",
      id: "channel-missing",
    });

    const stale = await app.inject({
      method: "PATCH",
      url: "/api/channels/channel-blue",
      payload: { expectedRevision: 0, name: "Azure" },
    });
    expect(stale.statusCode).toBe(409);
    expect(stale.json()).toMatchObject({
      code: "revision_conflict",
      expectedRevision: 0,
      currentRevision: 1,
    });
  });

  it("delegates device configuration and alert acknowledgement commands", async () => {
    const unchanged: MutationResult = {
      changed: false,
      revision: 4,
      event: null,
    };
    const patchDeviceConfiguration = vi.fn(
      async (): Promise<MutationResult> => unchanged,
    );
    const reconcileDeviceOperation = vi.fn(
      async (): Promise<MutationResult> => unchanged,
    );
    const acknowledgeAlert = vi.fn(
      async (): Promise<MutationResult> => unchanged,
    );
    const app = trackApp(
      buildApp({
        deviceConfigurationCommands: {
          patchDeviceConfiguration,
          reconcileDeviceOperation,
        },
        alertAcknowledgementCommands: { acknowledgeAlert },
      }),
    );

    const invalidName = await app.inject({
      method: "PATCH",
      url: "/api/devices/device-main/configuration",
      payload: { expectedRevision: 4, name: "Main;Tank" },
    });
    expect(invalidName.statusCode).toBe(400);
    expect(patchDeviceConfiguration).not.toHaveBeenCalled();

    const invalidPwmPair = await app.inject({
      method: "PATCH",
      url: "/api/devices/device-main/configuration",
      payload: {
        expectedRevision: 4,
        pwmFrequencyHz: 40_000,
        pwmResolutionBits: 11,
      },
    });
    expect(invalidPwmPair.statusCode).toBe(400);
    expect(invalidPwmPair.json()).toMatchObject({
      code: "invalid_request",
      issues: [
        expect.objectContaining({
          path: ["pwmResolutionBits"],
          message: expect.stringMatching(/source-clock/),
        }),
      ],
    });
    expect(patchDeviceConfiguration).not.toHaveBeenCalled();

    const device = await app.inject({
      method: "PATCH",
      url: "/api/devices/device-main/configuration",
      payload: { expectedRevision: 4, name: "Main-Tank" },
    });
    expect(device.statusCode).toBe(200);
    expect(device.json()).toEqual(unchanged);
    expect(patchDeviceConfiguration).toHaveBeenCalledWith("device-main", {
      expectedRevision: 4,
      name: "Main-Tank",
    });

    const reconciled = await app.inject({
      method: "POST",
      url: "/api/operations/operation-main/reconcile",
      payload: { expectedRevision: 4 },
    });
    expect(reconciled.statusCode).toBe(200);
    expect(reconciled.json()).toEqual(unchanged);
    expect(reconcileDeviceOperation).toHaveBeenCalledWith("operation-main", 4);

    const invalidReconciliation = await app.inject({
      method: "POST",
      url: "/api/operations/operation-main/reconcile",
      payload: { expectedRevision: 4, retry: true },
    });
    expect(invalidReconciliation.statusCode).toBe(400);
    expect(reconcileDeviceOperation).toHaveBeenCalledTimes(1);

    reconcileDeviceOperation.mockRejectedValueOnce(
      new ConfigurationRelationalConflictError([
        {
          resource: "operation",
          id: "operation-main",
          relation: "firmware_safety_window",
          message:
            "Operation operation-main cannot be reconciled before the firmware safety window ends",
        },
      ]),
    );
    const safetyBlocked = await app.inject({
      method: "POST",
      url: "/api/operations/operation-main/reconcile",
      payload: { expectedRevision: 4 },
    });
    expect(safetyBlocked.statusCode).toBe(409);
    expect(safetyBlocked.json()).toEqual({
      code: "relational_conflict",
      message: "Configuration mutation conflicts with related state",
      conflicts: [
        {
          resource: "operation",
          id: "operation-main",
          relation: "firmware_safety_window",
          message:
            "Operation operation-main cannot be reconciled before the firmware safety window ends",
        },
      ],
    });

    const alert = await app.inject({
      method: "POST",
      url: "/api/alerts/alert-main/acknowledge",
      payload: { expectedRevision: 4, note: "Investigating" },
    });
    expect(alert.statusCode).toBe(200);
    expect(alert.json()).toEqual(unchanged);
    expect(acknowledgeAlert).toHaveBeenCalledWith("alert-main", {
      expectedRevision: 4,
      note: "Investigating",
    });
  });

  it("exposes alert-rule CRUD through the shared contracts", async () => {
    const { database, repository } = await createRepository();
    await database
      .insertInto("devices")
      .values({
        id: "device-main",
        hardware_id: "hardware-main",
        name: "Main",
        desired_pwm_frequency_hz: 1_000,
        desired_pwm_resolution_bits: 8,
        created_at_ms: 0,
        updated_at_ms: 0,
      })
      .executeTakeFirstOrThrow();
    const app = trackApp(buildApp({ configurationService: repository }));
    const created = await app.inject({
      method: "POST",
      url: "/api/alert-rules",
      payload: {
        expectedRevision: 0,
        id: "rule-offline",
        rule: {
          name: "Device offline",
          source: { type: "device", id: "device-main" },
          condition: { kind: "offline" },
          delayMs: 0,
          severity: "critical",
          enabled: true,
        },
      },
    });
    expect(created.statusCode).toBe(200);
    expect(created.json()).toMatchObject({ changed: true, revision: 1 });

    const listed = await app.inject({ method: "GET", url: "/api/alert-rules" });
    expect(listed.statusCode).toBe(200);
    expect(listed.json()).toMatchObject({
      items: [{ id: "rule-offline", enabled: true }],
    });

    const disabled = await app.inject({
      method: "PATCH",
      url: "/api/alert-rules/rule-offline",
      payload: { expectedRevision: 1, enabled: false },
    });
    expect(disabled.statusCode).toBe(200);
    expect(disabled.json()).toMatchObject({ changed: true, revision: 2 });

    const deleted = await app.inject({
      method: "DELETE",
      url: "/api/alert-rules/rule-offline",
      payload: { expectedRevision: 2 },
    });
    expect(deleted.statusCode).toBe(200);
    expect(deleted.json()).toMatchObject({ changed: true, revision: 3 });
  });

  it("inspects a valid manual-override aggregate operation", async () => {
    const { database, repository } = await createRepository();
    await database
      .insertInto("control_operations")
      .values({
        id: "manual-aggregate",
        device_id: null,
        kind: "manual_override_start",
        status: "outcome_unknown",
        requested_at_ms: 100,
        deadline_at_ms: 200,
        completed_at_ms: 150,
        request_json: JSON.stringify({
          kind: "manual_override_start",
          overrideId: "override-main",
          target: { targetType: "channel", targetId: "channel-main" },
          commands: [
            {
              deviceId: "device-main",
              mappingId: "mapping-main",
              pin: 4,
              value: 200,
              overwrite: true,
            },
          ],
          valuePercentage: 78,
          expiresAtMs: 120_100,
        }),
        request_schema_version: 1,
        result_json: JSON.stringify({
          status: "outcome_unknown",
          childOperationIds: ["child-unknown"],
          reason: "child_outcome_not_succeeded",
          unknownChildOperationId: "child-unknown",
          safetyReconcileAtMs: 120_150,
          reconciledAtMs: null,
        }),
        result_schema_version: 1,
      })
      .executeTakeFirstOrThrow();
    const app = trackApp(buildApp({ configurationService: repository }));

    const response = await app.inject({
      method: "GET",
      url: "/api/operations/manual-aggregate",
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({
      operation: {
        id: "manual-aggregate",
        deviceId: null,
        kind: "manual_override_start",
      },
      request: { data: { overrideId: "override-main" } },
      result: { data: { unknownChildOperationId: "child-unknown" } },
    });
  });

  it("does not expose unexpected repository failures", async () => {
    const { repository } = await createRepository();
    repository.getOperation = async () => {
      throw new Error("sensitive persisted operation payload");
    };
    repository.listAlertRules = async () =>
      alertRulesResponseSchema.parse({ items: "corrupt persisted rules" });
    const app = trackApp(buildApp({ configurationService: repository }));

    const operationResponse = await app.inject({
      method: "GET",
      url: "/api/operations/operation-main",
    });
    expect(operationResponse.statusCode).toBe(500);
    expect(operationResponse.body).not.toContain(
      "sensitive persisted operation payload",
    );
    expect(operationResponse.json()).toMatchObject({
      code: "internal_error",
      message: "Controller configuration request failed",
    });

    const persistedValidationResponse = await app.inject({
      method: "GET",
      url: "/api/alert-rules",
    });
    expect(persistedValidationResponse.statusCode).toBe(500);
    expect(persistedValidationResponse.body).not.toContain(
      "corrupt persisted rules",
    );
  });
});
