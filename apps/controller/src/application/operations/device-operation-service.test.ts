import type { Kysely } from "kysely";
import { afterEach, describe, expect, it, vi } from "vitest";

import { DeviceRegistry } from "../devices/index.js";
import { MqttInteractionLogger } from "../runtime/mqtt-interaction-logger.js";
import {
  ControlOperationRepository,
  openControllerDatabases,
  type ControllerDatabases,
  type StateDatabaseSchema,
} from "../../infrastructure/database/index.js";
import type { DeviceOperationRevisionConflictError } from "../../infrastructure/database/index.js";
import type {
  LegacyCommandOutcome,
  LegacyWireCommand,
  LegacyWireOperationResult,
} from "../../infrastructure/mqtt/index.js";
import {
  createEspTopicSet,
  CURRENT_ESP_FIRMWARE_VERSION,
  ESP32_PWM_OVERWRITE_DURATION_MS,
} from "@aquarium/esp-protocol";
import { InteractionRepository } from "../../infrastructure/storage/interaction-repository.js";
import { DeviceOperationService } from "./device-operation-service.js";
import type { DeviceOperationExecutionOptions } from "./device-operation-types.js";

const openDatabases: ControllerDatabases[] = [];

afterEach(async () => {
  await Promise.all(
    openDatabases.splice(0).map(async (databases) => {
      await Promise.all([
        databases.state.destroy(),
        databases.events.destroy(),
      ]);
    }),
  );
});

describe("persistent device operation service", () => {
  it("persists pending -> in_flight -> succeeded and confirms reported configuration", async () => {
    const onDeviceContact = vi.fn();
    const context = await setup({ onDeviceContact });
    context.executor.outcomes.push({
      index: 0,
      command: "A1 e Reef 6000 10",
      targetId: "A1",
      status: "succeeded",
      response: "Reef 6000 10",
      analogValue: null,
    });

    const completed = await context.service.executeDeviceOperation("A1", {
      kind: "edit_configuration",
      name: "Reef",
      pwmFrequencyHz: 6_000,
      pwmResolutionBits: 10,
    });

    expect(completed).toMatchObject({
      status: "succeeded",
      request: { kind: "edit_configuration", name: "Reef" },
      result: { status: "succeeded", analogValue: null },
    });
    expect(await readDevice(context.databases.state)).toMatchObject({
      name: "Reef",
      desired_pwm_frequency_hz: 6_000,
      desired_pwm_resolution_bits: 10,
      reported_name: "Reef",
      reported_pwm_frequency_hz: 6_000,
      reported_pwm_resolution_bits: 10,
      last_error_code: null,
    });
    expect(context.executor.calls).toHaveLength(1);
    expect(onDeviceContact).toHaveBeenCalledWith({
      deviceId: "A1",
      observedAtMs: expect.any(Number),
    });
    const eventTypes = await context.databases.state
      .selectFrom("state_outbox")
      .select("event_type")
      .orderBy("revision")
      .execute();
    expect(eventTypes.map(({ event_type }) => event_type)).toEqual([
      "device.announcement-processed",
      "operation.pending",
      "operation.in-flight",
      "operation.succeeded",
    ]);
    const logs = await context.databases.events
      .selectFrom("interactions")
      .selectAll()
      .execute();
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatchObject({
      topic: "test/aquarium/command",
      device_id: "A1",
      correlation_id: "wire-1",
      operation_id: "operation-1",
      outcome: "succeeded",
      byte_count: 17,
    });
    expect(logs[0]?.payload_json).not.toContain("Reef 6000 10");
  });

  it("forwards command priority to the MQTT executor", async () => {
    const context = await setup();
    context.executor.outcomes.push({
      index: 0,
      command: "A1 p",
      targetId: "A1",
      status: "succeeded",
      response: "o",
      analogValue: null,
    });

    await context.service.executeDeviceOperation(
      "A1",
      { kind: "ping" },
      { priority: "background" },
    );

    expect(context.executor.options).toEqual([{ priority: "background" }]);
  });

  it("cools only the timed-out device until availability is signalled", async () => {
    const context = await setup();
    context.executor.outcomes.push({
      index: 0,
      command: "A1 e Reef 6000 10",
      targetId: "A1",
      status: "outcome_unknown",
      reason: "timeout",
    });

    const unknown = await context.service.executeDeviceOperation("A1", {
      kind: "edit_configuration",
      name: "Reef",
      pwmFrequencyHz: 6_000,
      pwmResolutionBits: 10,
    });
    expect(unknown).toMatchObject({
      status: "outcome_unknown",
      result: {
        status: "outcome_unknown",
        reason: "timeout",
        reconciledAtMs: null,
      },
    });
    expect(await readDevice(context.databases.state)).toMatchObject({
      name: "Reef",
      desired_pwm_frequency_hz: 6_000,
      reported_name: "One",
      reported_pwm_frequency_hz: 5_000,
      last_error_code: "configuration_mismatch",
      status: "offline",
    });
    await expect(
      context.service.executeDeviceOperation("A1", { kind: "ping" }),
    ).resolves.toMatchObject({
      status: "cancelled",
      result: {
        status: "cancelled",
        reason: "device_command_cooldown",
      },
    });
    expect(context.executor.calls).toHaveLength(1);

    context.service.signalDeviceAvailable("A1");
    context.executor.outcomes.push({
      index: 0,
      command: "A1 p",
      targetId: "A1",
      status: "succeeded",
      response: "o",
      analogValue: null,
    });
    await expect(
      context.service.executeDeviceOperation("A1", { kind: "ping" }),
    ).resolves.toMatchObject({ status: "succeeded" });
    expect(context.executor.calls).toHaveLength(2);
  });

  it("allows one probe after cooldown while other devices continue", async () => {
    const context = await setup();
    await context.registry.handleAnnouncement({
      announcement: {
        id: "A2",
        name: "Two",
        freq: 5_000,
        res: 8,
        status: "online",
        version: CURRENT_ESP_FIRMWARE_VERSION,
        scheduleHash: "0",
      },
      receivedAtMs: 1_100,
    });
    context.executor.outcomes.push({
      index: 0,
      command: "A1 p",
      targetId: "A1",
      status: "outcome_unknown",
      reason: "timeout",
    });
    await context.service.executeDeviceOperation("A1", { kind: "ping" });

    context.executor.outcomes.push({
      index: 0,
      command: "A2 p",
      targetId: "A2",
      status: "succeeded",
      response: "o",
      analogValue: null,
    });
    await expect(
      context.service.executeDeviceOperation("A2", { kind: "ping" }),
    ).resolves.toMatchObject({ status: "succeeded" });
    await expect(
      context.service.executeDeviceOperation("A1", { kind: "ping" }),
    ).resolves.toMatchObject({
      status: "cancelled",
      result: { reason: "device_command_cooldown" },
    });

    context.setNowMs(100_000);
    let releaseProbe = (): void => undefined;
    context.executor.waits.push(
      new Promise<void>((resolve) => {
        releaseProbe = resolve;
      }),
    );
    context.executor.outcomes.push({
      index: 0,
      command: "A1 p",
      targetId: "A1",
      status: "succeeded",
      response: "o",
      analogValue: null,
    });
    const probe = context.service.executeDeviceOperation("A1", {
      kind: "ping",
    });
    await vi.waitFor(() => expect(context.executor.calls).toHaveLength(3));
    await expect(
      context.service.executeDeviceOperation("A1", { kind: "ping" }),
    ).resolves.toMatchObject({
      status: "cancelled",
      result: { reason: "device_command_in_flight" },
    });
    releaseProbe();
    await expect(probe).resolves.toMatchObject({ status: "succeeded" });
  });

  it("reconciles expired routine overwrite uncertainty so offline retries remain bounded", async () => {
    const context = await setup({ startService: false });
    await context.repository.createPending({
      id: "expired-routine-pwm",
      deviceId: "A1",
      requestedAtMs: 1_000,
      deadlineAtMs: 6_000,
      request: {
        kind: "set_pwm",
        pin: 4,
        value: 128,
        overwrite: true,
      },
    });
    await context.repository.markInFlight("expired-routine-pwm", 1_010);
    await context.repository.completeInFlight("expired-routine-pwm", 1_020, {
      status: "outcome_unknown",
      wireOperationId: "wire-expired-routine",
      reason: "timeout",
      reconciledAtMs: null,
    });
    await context.repository.createPending({
      id: "legacy-non-overwrite-pwm",
      deviceId: "A1",
      requestedAtMs: 1_001,
      deadlineAtMs: 6_001,
      request: {
        kind: "set_pwm",
        pin: 5,
        value: 64,
        overwrite: false,
      },
    });
    await context.repository.markInFlight("legacy-non-overwrite-pwm", 1_011);
    await context.repository.completeInFlight(
      "legacy-non-overwrite-pwm",
      1_019,
      {
        status: "outcome_unknown",
        wireOperationId: "wire-legacy-non-overwrite",
        reason: "timeout",
        reconciledAtMs: null,
      },
    );

    await expect(
      context.repository.reconcileExpiredRoutinePwmOutcomes("A1", 121_019),
    ).resolves.toEqual([]);
    await expect(
      context.repository.reconcileExpiredRoutinePwmOutcomes("A1", 121_020),
    ).resolves.toEqual(["expired-routine-pwm"]);
    await expect(
      context.repository.getById("expired-routine-pwm"),
    ).resolves.toMatchObject({
      result: {
        status: "outcome_unknown",
        reconciledAtMs: 121_020,
      },
    });
    await expect(
      context.repository.getById("legacy-non-overwrite-pwm"),
    ).resolves.toMatchObject({
      result: {
        status: "outcome_unknown",
        reconciledAtMs: null,
      },
    });
  });

  it("lets an explicit configuration patch bypass response cooldown", async () => {
    const context = await setup();
    context.executor.outcomes.push({
      index: 0,
      command: "A1 p",
      targetId: "A1",
      status: "outcome_unknown",
      reason: "timeout",
    });
    await context.service.executeDeviceOperation("A1", { kind: "ping" });
    context.executor.outcomes.push({
      index: 0,
      command: "A1 e Desired 5000 8",
      targetId: "A1",
      status: "succeeded",
      response: "Desired 5000 8",
      analogValue: null,
    });

    await expect(
      context.service.patchDeviceConfiguration("A1", {
        expectedRevision: await revisionCount(context.databases.state),
        name: "Desired",
      }),
    ).resolves.toMatchObject({ changed: true });
    await context.service.drain();
    context.executor.outcomes.push({
      index: 0,
      command: "A1 p",
      targetId: "A1",
      status: "succeeded",
      response: "o",
      analogValue: null,
    });
    await expect(
      context.service.executeDeviceOperation("A1", { kind: "ping" }),
    ).resolves.toMatchObject({ status: "succeeded" });
    expect(context.executor.calls).toHaveLength(3);
  });

  it("durably reconciles arbitrary unknown operations with revision guards", async () => {
    const context = await setup({ startService: false });
    for (const [id, requestedAtMs] of [
      ["unknown-one", 1_010],
      ["unknown-two", 1_020],
    ] as const) {
      await context.repository.createPending({
        id,
        deviceId: "A1",
        requestedAtMs,
        deadlineAtMs: 10_000,
        request: { kind: "ping" },
      });
      await context.repository.markInFlight(id, requestedAtMs + 1);
      await context.repository.completeInFlight(id, requestedAtMs + 2, {
        status: "outcome_unknown",
        wireOperationId: `wire-${id}`,
        reason: "timeout",
        reconciledAtMs: null,
      });
    }
    context.setNowMs(2_000);
    await context.service.start();

    const initialRevision = await revisionCount(context.databases.state);
    await expect(
      context.service.reconcileDeviceOperation("unknown-one", initialRevision),
    ).resolves.toMatchObject({
      changed: true,
      revision: initialRevision + 1,
      event: {
        type: "operation.outcome-reconciled",
        entity: { type: "operation", id: "unknown-one" },
      },
    });
    await expect(
      context.service.reconcileDeviceOperation("unknown-two", initialRevision),
    ).rejects.toMatchObject({
      name: "ConfigurationRevisionConflictError",
      expectedRevision: initialRevision,
      currentRevision: initialRevision + 1,
    });
    await expect(
      context.service.reconcileDeviceOperation(
        "unknown-two",
        initialRevision + 1,
      ),
    ).resolves.toMatchObject({
      changed: true,
      revision: initialRevision + 2,
    });
    expect(context.executor.calls).toHaveLength(0);

    await expect(
      context.service.reconcileDeviceOperation("unknown-one", initialRevision),
    ).resolves.toEqual({
      changed: false,
      revision: initialRevision + 2,
      event: null,
    });
    expect(
      (await context.repository.getById("unknown-one")).result,
    ).toMatchObject({
      status: "outcome_unknown",
      reconciledAtMs: expect.any(Number),
    });
    expect(
      (await context.repository.getById("unknown-two")).result,
    ).toMatchObject({
      status: "outcome_unknown",
      reconciledAtMs: expect.any(Number),
    });
  });

  it("holds unknown firmware overwrites through the complete 120-second safety window", async () => {
    const context = await setup({ startService: false });
    await context.repository.createPending({
      id: "unknown-overwrite",
      deviceId: "A1",
      requestedAtMs: 1_010,
      deadlineAtMs: 10_000,
      request: {
        kind: "set_pwm",
        pin: 4,
        value: 200,
        overwrite: true,
      },
    });
    await context.repository.markInFlight("unknown-overwrite", 1_020);
    const completedAtMs = 1_030;
    await context.repository.completeInFlight(
      "unknown-overwrite",
      completedAtMs,
      {
        status: "outcome_unknown",
        wireOperationId: "wire-overwrite",
        reason: "timeout",
        reconciledAtMs: null,
      },
    );
    await context.service.start();
    const expectedRevision = await revisionCount(context.databases.state);

    context.setNowMs(completedAtMs + ESP32_PWM_OVERWRITE_DURATION_MS - 1 - 10);
    await expect(
      context.service.reconcileDeviceOperation(
        "unknown-overwrite",
        expectedRevision,
      ),
    ).rejects.toMatchObject({
      name: "ConfigurationRelationalConflictError",
      conflicts: [
        {
          resource: "operation",
          id: "unknown-overwrite",
          relation: "firmware_safety_window",
          message:
            "Operation unknown-overwrite cannot be reconciled before the firmware safety window ends",
        },
      ],
    });
    expect(await revisionCount(context.databases.state)).toBe(expectedRevision);
    context.setNowMs(completedAtMs + ESP32_PWM_OVERWRITE_DURATION_MS - 10);
    await expect(
      context.service.reconcileDeviceOperation(
        "unknown-overwrite",
        expectedRevision,
      ),
    ).resolves.toMatchObject({
      changed: true,
      revision: expectedRevision + 1,
    });
  });

  it("reserves unresolved manual-override children for the safe internal reconciliation path", async () => {
    const context = await setup({ startService: false });
    await context.repository.createPending({
      id: "owned-unknown-child",
      deviceId: "A1",
      requestedAtMs: 1_010,
      deadlineAtMs: 10_000,
      request: {
        kind: "set_pwm",
        pin: 4,
        value: 200,
        overwrite: true,
      },
    });
    await context.repository.markInFlight("owned-unknown-child", 1_020);
    await context.repository.completeInFlight("owned-unknown-child", 1_030, {
      status: "outcome_unknown",
      wireOperationId: "wire-owned-child",
      reason: "timeout",
      reconciledAtMs: null,
    });
    await context.databases.state
      .insertInto("control_operations")
      .values({
        id: "manual-operation-owner",
        device_id: null,
        kind: "manual_override_start",
        status: "outcome_unknown",
        requested_at_ms: 1_000,
        deadline_at_ms: 2_000,
        completed_at_ms: 1_040,
        request_json: JSON.stringify({
          kind: "manual_override_start",
          overrideId: "override-main",
          target: { targetType: "channel", targetId: "channel-main" },
          commands: [
            {
              deviceId: "A1",
              mappingId: "mapping-main",
              pin: 4,
              value: 200,
              overwrite: true,
            },
          ],
          valuePercentage: 78,
          expiresAtMs: 121_000,
        }),
        request_schema_version: 2,
        result_json: JSON.stringify({
          status: "outcome_unknown",
          childOperationIds: ["owned-unknown-child"],
          reason: "child_outcome_not_succeeded",
          unknownChildOperationIds: ["owned-unknown-child"],
          safetyReconcileAtMs: 121_040,
          reconciledAtMs: null,
        }),
        result_schema_version: 2,
      })
      .executeTakeFirstOrThrow();
    context.setNowMs(121_040);
    await context.service.start();
    const expectedRevision = await revisionCount(context.databases.state);

    await expect(
      context.service.reconcileDeviceOperation(
        "owned-unknown-child",
        expectedRevision,
      ),
    ).rejects.toMatchObject({
      name: "ConfigurationRelationalConflictError",
      conflicts: [
        {
          resource: "operation",
          id: "owned-unknown-child",
          relation: "manual_override_owns_operation",
          message:
            "Operation owned-unknown-child must be reconciled through manual override operation manual-operation-owner",
        },
      ],
    });
    await expect(
      context.service.reconcileDeviceOperation(
        "manual-operation-owner",
        expectedRevision,
      ),
    ).rejects.toMatchObject({
      name: "ConfigurationRelationalConflictError",
      conflicts: [
        expect.objectContaining({
          resource: "operation",
          id: "manual-operation-owner",
          relation: "not_device_operation",
        }),
      ],
    });

    await context.service.acknowledgeReconciledOutcome("owned-unknown-child");
    expect(context.executor.calls).toHaveLength(0);
  });

  it("persists an analog read value without reparsing it in the service", async () => {
    const context = await setup();
    context.executor.outcomes.push({
      index: 0,
      command: "A1 r 4",
      targetId: "A1",
      status: "succeeded",
      response: "r 4 2048",
      analogValue: 2_048,
    });
    await expect(
      context.service.executeDeviceOperation("A1", {
        kind: "analog_read",
        pin: 4,
      }),
    ).resolves.toMatchObject({
      status: "succeeded",
      result: { analogValue: 2_048 },
    });
  });

  it("records a firmware-reported command error without quarantining the device", async () => {
    const context = await setup();
    context.executor.outcomes.push({
      index: 0,
      command: "A1 p",
      targetId: "A1",
      status: "failed",
      response: "E: Invalid command",
      expectedResponse: { kind: "exact", value: "o" },
    });
    await expect(
      context.service.executeDeviceOperation("A1", { kind: "ping" }),
    ).resolves.toMatchObject({
      status: "failed",
      result: {
        code: "device_reported_error",
        message: "Device reported: Invalid command",
      },
    });
    expect(context.executor.calls).toHaveLength(1);
    await expect(readDevice(context.databases.state)).resolves.toMatchObject({
      enabled: 1,
      status: "online",
      last_error_code: null,
    });
  });

  it("bounds invalid-response diagnostics before quarantining the device", async () => {
    const context = await setup();
    context.executor.outcomes.push({
      index: 0,
      command: "A1 p",
      targetId: "A1",
      status: "failed",
      response: "x".repeat(5_000),
      expectedResponse: { kind: "exact", value: "o" },
    });

    await expect(
      context.service.executeDeviceOperation("A1", { kind: "ping" }),
    ).resolves.toMatchObject({ status: "failed" });
    const device = await readDevice(context.databases.state);
    expect(device).toMatchObject({
      enabled: 0,
      status: "error",
      last_error_code: "protocol_invalid_response",
    });
    expect(device.last_error_message?.length).toBeLessThanOrEqual(256);
  });

  it("guards desired configuration against operator commits without conflicting on routine device operations", async () => {
    const context = await setup();
    const repository = new ControlOperationRepository(context.databases.state);
    await context.registry.handleAnnouncement({
      announcement: {
        id: "A1",
        name: "One",
        freq: 5_000,
        res: 8,
        status: "online",
        version: CURRENT_ESP_FIRMWARE_VERSION,
        scheduleHash: "0",
      },
      receivedAtMs: 2_000,
    });
    await repository.createPending({
      id: "background-operation",
      deviceId: "A1",
      requestedAtMs: 2_001,
      deadlineAtMs: 7_001,
      request: { kind: "ping" },
    });
    const created = await repository.createPendingUserConfiguration({
      id: "user-operation",
      deviceId: "A1",
      expectedRevision: 1,
      mappingProfileId: null,
      requestedAtMs: 2_002,
      deadlineAtMs: 7_002,
      request: {
        kind: "edit_configuration",
        name: "Desired",
        pwmFrequencyHz: 6_000,
        pwmResolutionBits: 10,
      },
    });
    expect(created.mutation).toMatchObject({
      changed: true,
      revision: 4,
      event: {
        entity: { type: "operation", id: "user-operation" },
        data: {
          invalidations: expect.arrayContaining([
            { resource: "operation", id: "user-operation" },
            { resource: "device", id: "A1" },
          ]),
        },
      },
    });
    if (!created.changed) {
      throw new Error("Expected configuration mutation to create an operation");
    }
    expect(created.operation.status).toBe("pending");
    expect(await readDevice(context.databases.state)).toMatchObject({
      name: "Desired",
      reported_name: "One",
    });
    await expect(
      repository.createPendingUserConfiguration({
        id: "stale-operation",
        deviceId: "A1",
        expectedRevision: 1,
        mappingProfileId: null,
        requestedAtMs: 2_003,
        deadlineAtMs: 7_003,
        request: {
          kind: "edit_configuration",
          name: "Stale",
          pwmFrequencyHz: 7_000,
          pwmResolutionBits: 8,
        },
      }),
    ).rejects.toMatchObject({
      name: "DeviceOperationRevisionConflictError",
      expectedRevision: 1,
      currentRevision: 4,
    } satisfies Partial<DeviceOperationRevisionConflictError>);
    const reapply = await repository.createPendingUserConfiguration({
      id: "same-value-operation",
      deviceId: "A1",
      expectedRevision: 4,
      mappingProfileId: null,
      requestedAtMs: 2_004,
      deadlineAtMs: 7_004,
      request: {
        kind: "edit_configuration",
        name: "Desired",
        pwmFrequencyHz: 6_000,
        pwmResolutionBits: 10,
      },
    });
    expect(reapply).toMatchObject({
      changed: true,
      operation: {
        id: "same-value-operation",
        status: "pending",
      },
      mutation: { changed: true, revision: 5 },
    });
    expect(await revisionCount(context.databases.state)).toBe(5);
    expect(
      await context.databases.state
        .selectFrom("control_operations")
        .select(({ fn }) => fn.countAll<number>().as("count"))
        .executeTakeFirstOrThrow(),
    ).toMatchObject({ count: 3 });
  });

  it("returns a same-value device configuration PATCH as a true no-op without publishing", async () => {
    const context = await setup();
    await expect(
      context.service.patchDeviceConfiguration("A1", {
        expectedRevision: 1,
        name: "One",
      }),
    ).resolves.toEqual({
      changed: false,
      revision: 1,
      event: null,
    });
    expect(context.executor.calls).toHaveLength(0);
    expect(await revisionCount(context.databases.state)).toBe(1);
    const operationCount = await context.databases.state
      .selectFrom("control_operations")
      .select(({ fn }) => fn.countAll<number>().as("count"))
      .executeTakeFirstOrThrow();
    expect(Number(operationCount.count)).toBe(0);
  });

  it("reapplies an actual configuration mismatch when another device error masks its error code", async () => {
    const context = await setup();
    await context.databases.state
      .updateTable("devices")
      .set({
        name: "Desired",
        last_error_code: "firmware_unsupported",
        last_error_message: "Firmware version is unsupported",
      })
      .where("id", "=", "A1")
      .executeTakeFirstOrThrow();
    context.executor.outcomes.push({
      index: 0,
      command: "A1 e Desired 5000 8",
      targetId: "A1",
      status: "succeeded",
      response: "Desired 5000 8",
      analogValue: null,
    });

    await expect(
      context.service.patchDeviceConfiguration("A1", {
        expectedRevision: 1,
        name: "Desired",
        pwmFrequencyHz: 5_000,
        pwmResolutionBits: 8,
      }),
    ).resolves.toMatchObject({ changed: true, revision: 2 });
    await context.service.drain();

    expect(context.executor.calls).toHaveLength(1);
    expect(context.executor.calls[0]?.[0]).toMatchObject({
      command: "A1 e Desired 5000 8",
    });
  });

  it("rejects a partial PATCH whose resolved PWM pair is unsupported", async () => {
    const context = await setup();

    await expect(
      context.service.patchDeviceConfiguration("A1", {
        expectedRevision: 1,
        pwmResolutionBits: 16,
      }),
    ).rejects.toMatchObject({
      name: "ConfigurationValidationError",
      issues: [
        expect.objectContaining({
          path: ["pwmResolutionBits"],
          message: expect.stringMatching(/source-clock/),
        }),
      ],
    });
    expect(context.executor.calls).toHaveLength(0);
    expect(await revisionCount(context.databases.state)).toBe(1);
    expect(await readDevice(context.databases.state)).toMatchObject({
      desired_pwm_frequency_hz: 5_000,
      desired_pwm_resolution_bits: 8,
    });
  });

  it("reports post-terminal side-effect failures without making a completed command retryable", async () => {
    const reportedErrors: Error[] = [];
    const context = await setup({
      onBackgroundError: (error) => {
        reportedErrors.push(error);
      },
    });
    context.executor.outcomes.push({
      index: 0,
      command: "A1 p",
      targetId: "A1",
      status: "succeeded",
      response: "o",
      analogValue: null,
    });
    vi.spyOn(context.registry, "recordResponseContact").mockRejectedValueOnce(
      new Error("response-contact database unavailable"),
    );

    await expect(
      context.service.executeDeviceOperation("A1", { kind: "ping" }),
    ).resolves.toMatchObject({ status: "succeeded" });
    expect(context.executor.calls).toHaveLength(1);
    expect(reportedErrors).toHaveLength(1);
    expect(reportedErrors[0]?.message).toMatch(/terminal state/i);
    expect(
      await context.databases.events
        .selectFrom("interactions")
        .select(({ fn }) => fn.countAll<number>().as("count"))
        .executeTakeFirstOrThrow(),
    ).toMatchObject({ count: 1 });
  });

  it("captures a throwing background error reporter as a fatal service state", async () => {
    const context = await setup();
    vi.spyOn(context.repository, "markInFlight").mockRejectedValueOnce(
      new Error("state database write failed"),
    );

    await expect(
      context.service.patchDeviceConfiguration("A1", {
        expectedRevision: 1,
        name: "Desired",
      }),
    ).resolves.toMatchObject({ changed: true, revision: 2 });
    await expect(context.service.drain()).rejects.toThrow(
      /background error reporter failed/i,
    );
    await expect(
      context.service.executeDeviceOperation("A1", { kind: "ping" }),
    ).rejects.toThrow(/background error reporter failed/i);
    expect(context.executor.calls).toHaveLength(0);
  });

  it("recovers pending and in-flight rows without globally blocking new work", async () => {
    const context = await setup({ startService: false });
    const repository = new ControlOperationRepository(context.databases.state);
    await repository.createPending({
      id: "pending-on-restart",
      deviceId: "A1",
      requestedAtMs: 1_000,
      deadlineAtMs: 10_000,
      request: { kind: "ping" },
    });
    await repository.createPending({
      id: "in-flight-on-restart",
      deviceId: "A1",
      requestedAtMs: 1_001,
      deadlineAtMs: 10_000,
      request: { kind: "ping" },
    });
    await repository.createPending({
      id: "expired-on-restart",
      deviceId: "A1",
      requestedAtMs: 1_000,
      deadlineAtMs: 1_005,
      request: { kind: "ping" },
    });
    await repository.markInFlight("in-flight-on-restart", 1_002);

    await context.service.start();
    await expect(
      repository.getById("pending-on-restart"),
    ).resolves.toMatchObject({
      status: "cancelled",
    });
    await expect(
      repository.getById("in-flight-on-restart"),
    ).resolves.toMatchObject({
      status: "outcome_unknown",
      result: { reason: "controller_restart" },
    });
    await expect(
      repository.getById("expired-on-restart"),
    ).resolves.toMatchObject({
      status: "timed_out",
      result: { reason: "deadline_before_attempt" },
    });
    context.executor.outcomes.push({
      index: 0,
      command: "A1 p",
      targetId: "A1",
      status: "succeeded",
      response: "o",
      analogValue: null,
    });
    await expect(
      context.service.executeDeviceOperation("A1", { kind: "ping" }),
    ).resolves.toMatchObject({ status: "succeeded" });
    expect(context.executor.calls).toHaveLength(1);
  });

  it("restores an unresolved in-flight operation after both databases are reopened", async () => {
    const directory = await mkdtemp(join(tmpdir(), "aquarium-operation-"));
    const stateFilename = join(directory, "state.db");
    const eventsFilename = join(directory, "events.db");
    try {
      const first = await openControllerDatabases({
        state: { filename: stateFilename },
        events: { filename: eventsFilename },
      });
      const firstRegistry = new DeviceRegistry(first.state, {
        announcementPersistIntervalMs: 1_000,
        staleAfterMs: 10_000,
        offlineAfterMs: 20_000,
      });
      await firstRegistry.handleAnnouncement({
        announcement: {
          id: "A1",
          name: "One",
          freq: 5_000,
          res: 8,
          status: "online",
          version: CURRENT_ESP_FIRMWARE_VERSION,
          scheduleHash: "0",
        },
        receivedAtMs: 1_000,
      });
      const firstRepository = new ControlOperationRepository(first.state);
      await firstRepository.createPending({
        id: "reopened-in-flight",
        deviceId: "A1",
        requestedAtMs: 1_100,
        deadlineAtMs: 10_000,
        request: { kind: "ping" },
      });
      await firstRepository.markInFlight("reopened-in-flight", 1_200);
      await Promise.all([first.state.destroy(), first.events.destroy()]);

      const reopened = await openControllerDatabases({
        state: { filename: stateFilename },
        events: { filename: eventsFilename },
      });
      openDatabases.push(reopened);
      const executor = new FakeCommandExecutor(() => 2_000);
      const service = new DeviceOperationService(
        new ControlOperationRepository(reopened.state),
        executor,
        new DeviceRegistry(reopened.state, {
          announcementPersistIntervalMs: 1_000,
          staleAfterMs: 10_000,
          offlineAfterMs: 20_000,
        }),
        new MqttInteractionLogger(
          new InteractionRepository(reopened.events),
          createEspTopicSet(true),
        ),
        {
          now: () => 2_000,
          idGenerator: () => "unused-operation",
          onBackgroundError: (error) => {
            throw error;
          },
        },
      );
      await service.start();
      await expect(
        new ControlOperationRepository(reopened.state).getById(
          "reopened-in-flight",
        ),
      ).resolves.toMatchObject({
        status: "outcome_unknown",
        result: { reason: "controller_restart", reconciledAtMs: null },
      });
      executor.outcomes.push({
        index: 0,
        command: "A1 p",
        targetId: "A1",
        status: "succeeded",
        response: "o",
        analogValue: null,
      });
      await expect(
        service.executeDeviceOperation("A1", { kind: "ping" }),
      ).resolves.toMatchObject({ status: "succeeded" });
      expect(executor.calls).toHaveLength(1);
    } finally {
      await Promise.all(
        openDatabases.splice(0).map(async (databases) => {
          await Promise.all([
            databases.state.destroy(),
            databases.events.destroy(),
          ]);
        }),
      );
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("rejects corrupt request/result coupling at the persisted boundary", async () => {
    const context = await setup();
    await context.databases.state
      .insertInto("control_operations")
      .values({
        id: "corrupt-analog",
        device_id: "A1",
        kind: "analog_read",
        status: "succeeded",
        requested_at_ms: 2_000,
        deadline_at_ms: 3_000,
        completed_at_ms: 2_500,
        request_json: JSON.stringify({ kind: "analog_read", pin: 4 }),
        request_schema_version: 1,
        result_json: JSON.stringify({
          status: "succeeded",
          wireOperationId: "wire-corrupt",
          analogValue: null,
        }),
        result_schema_version: 1,
      })
      .executeTakeFirstOrThrow();
    await expect(
      new ControlOperationRepository(context.databases.state).getById(
        "corrupt-analog",
      ),
    ).rejects.toThrow(/requires an analog value/i);

    await context.databases.state
      .insertInto("control_operations")
      .values({
        id: "corrupt-ping",
        device_id: "A1",
        kind: "ping",
        status: "succeeded",
        requested_at_ms: 2_000,
        deadline_at_ms: 3_000,
        completed_at_ms: 2_500,
        request_json: JSON.stringify({ kind: "ping" }),
        request_schema_version: 1,
        result_json: JSON.stringify({
          status: "succeeded",
          wireOperationId: "wire-corrupt-ping",
          analogValue: 1,
        }),
        result_schema_version: 1,
      })
      .executeTakeFirstOrThrow();
    await expect(
      new ControlOperationRepository(context.databases.state).getById(
        "corrupt-ping",
      ),
    ).rejects.toThrow(/only a successful analog_read/i);
  });
});

interface TestContext {
  readonly databases: ControllerDatabases;
  readonly executor: FakeCommandExecutor;
  readonly interactionLogger: MqttInteractionLogger;
  readonly registry: DeviceRegistry;
  readonly repository: ControlOperationRepository;
  readonly service: DeviceOperationService;
  readonly setNowMs: (value: number) => void;
}

async function setup(
  options: {
    readonly startService?: boolean;
    readonly onBackgroundError?: (error: Error) => void;
    readonly onDeviceContact?: (contact: {
      readonly deviceId: string;
      readonly observedAtMs: number;
    }) => void;
  } = {},
): Promise<TestContext> {
  const databases = await openControllerDatabases({
    state: { filename: ":memory:" },
    events: { filename: ":memory:" },
  });
  openDatabases.push(databases);
  let nowMs = 1_000;
  const registry = new DeviceRegistry(databases.state, {
    announcementPersistIntervalMs: 1_000,
    staleAfterMs: 10_000,
    offlineAfterMs: 20_000,
  });
  await registry.handleAnnouncement({
    announcement: {
      id: "A1",
      name: "One",
      freq: 5_000,
      res: 8,
      status: "online",
      version: CURRENT_ESP_FIRMWARE_VERSION,
      scheduleHash: "0",
    },
    receivedAtMs: nowMs,
  });
  const executor = new FakeCommandExecutor(() => {
    nowMs += 50;
    return nowMs;
  });
  let id = 0;
  const repository = new ControlOperationRepository(databases.state);
  const interactionLogger = new MqttInteractionLogger(
    new InteractionRepository(databases.events),
    createEspTopicSet(true),
  );
  const service = new DeviceOperationService(
    repository,
    executor,
    registry,
    interactionLogger,
    {
      now: () => {
        nowMs += 10;
        return nowMs;
      },
      operationTimeoutMs: 5_000,
      idGenerator: () => `operation-${++id}`,
      onBackgroundError:
        options.onBackgroundError ??
        ((error) => {
          throw error;
        }),
      ...(options.onDeviceContact === undefined
        ? {}
        : { onDeviceContact: options.onDeviceContact }),
    },
  );
  if (options.startService !== false) {
    await service.start();
  }
  return {
    databases,
    executor,
    interactionLogger,
    registry,
    repository,
    service,
    setNowMs: (value) => {
      nowMs = value;
    },
  };
}

class FakeCommandExecutor {
  readonly outcomes: LegacyCommandOutcome[] = [];
  readonly calls: LegacyWireCommand[][] = [];
  readonly options: DeviceOperationExecutionOptions[] = [];
  readonly waits: Promise<void>[] = [];

  constructor(readonly now: () => number) {}

  async executeCommands(
    commands: readonly LegacyWireCommand[],
    options: DeviceOperationExecutionOptions = {},
  ): Promise<LegacyWireOperationResult> {
    this.calls.push([...commands]);
    this.options.push(options);
    const outcome = this.outcomes.shift();
    if (outcome === undefined) {
      throw new Error("Fake command executor requires an explicit outcome");
    }
    const wait = this.waits.shift();
    if (wait !== undefined) {
      await wait;
    }
    const startedAtMs = this.now();
    return {
      operationId: `wire-${this.calls.length}`,
      startedAtMs,
      completedAtMs: this.now(),
      outcomes: [outcome],
    };
  }
}

async function readDevice(database: Kysely<StateDatabaseSchema>) {
  return database
    .selectFrom("devices")
    .selectAll()
    .where("id", "=", "A1")
    .executeTakeFirstOrThrow();
}

async function revisionCount(
  database: Kysely<StateDatabaseSchema>,
): Promise<number> {
  const row = await database
    .selectFrom("state_revisions")
    .select(({ fn }) => fn.countAll<number>().as("count"))
    .executeTakeFirstOrThrow();
  return Number(row.count);
}
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
