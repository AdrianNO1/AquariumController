import type { Kysely } from "kysely";
import { afterEach, describe, expect, it } from "vitest";

import { ManualOverrideConflictError } from "../../application/overrides/manual-override-errors.js";
import type { ManualOverrideRevisionConflictError } from "../../application/overrides/manual-override-errors.js";
import { MANUAL_OVERRIDE_DURATION_MS } from "../../application/overrides/manual-override-types.js";
import { openStateDatabase } from "./connection.js";
import { ManualOverrideRepository } from "./manual-override-repository.js";
import { commitStateChange } from "./state-outbox.js";
import type { StateDatabaseSchema } from "./types.js";

let database: Kysely<StateDatabaseSchema> | undefined;

afterEach(async () => {
  await database?.destroy();
  database = undefined;
});

describe("manual override repository", () => {
  it("guards operator overrides without conflicting on unrelated background revisions", async () => {
    const repository = await createRepository();
    await recordBackgroundDeviceContact(requireDatabase(), 2_000);

    await expect(
      repository.createStart({
        overrideId: "override-output",
        operationId: "operation-output-start",
        expectedRevision: 0,
        target: { targetType: "output", targetId: "output-standalone" },
        valuePercentage: 50,
        requestedAtMs: 3_000,
        expiresAtMs: 3_000 + MANUAL_OVERRIDE_DURATION_MS,
        deadlineAtMs: 33_000,
      }),
    ).resolves.toMatchObject({
      mutation: { changed: true, revision: 2 },
    });
    await recordBackgroundDeviceContact(requireDatabase(), 4_000);

    await expect(
      repository.createStart({
        overrideId: "override-channel",
        operationId: "operation-channel-start",
        expectedRevision: 0,
        target: { targetType: "channel", targetId: "channel-blue" },
        valuePercentage: 50,
        requestedAtMs: 3_001,
        expiresAtMs: 3_001 + MANUAL_OVERRIDE_DURATION_MS,
        deadlineAtMs: 33_001,
      }),
    ).rejects.toMatchObject({
      name: "ManualOverrideRevisionConflictError",
      expectedRevision: 0,
      currentRevision: 3,
    } satisfies Partial<ManualOverrideRevisionConflictError>);
  });

  it("atomically persists a coordinator operation and exposes the exact active boundary", async () => {
    const repository = await createRepository();
    const prepared = await repository.createStart({
      overrideId: "override-channel",
      operationId: "operation-start",
      expectedRevision: 0,
      target: { targetType: "channel", targetId: "channel-blue" },
      valuePercentage: 50,
      requestedAtMs: 10_000,
      expiresAtMs: 10_000 + MANUAL_OVERRIDE_DURATION_MS,
      deadlineAtMs: 40_000,
    });

    expect(prepared.override).toMatchObject({
      status: "pending",
      operationId: "operation-start",
      requestedAtMs: 10_000,
      expiresAtMs: 130_000,
    });
    expect(prepared.operation.request).toMatchObject({
      kind: "manual_override_start",
      commands: [
        {
          deviceId: "device-a",
          mappingId: "mapping-channel",
          pin: 4,
          value: 89,
          overwrite: true,
        },
      ],
    });
    expect(prepared.mutation).toMatchObject({ changed: true, revision: 1 });
    await expect(
      database
        ?.selectFrom("control_operations")
        .select("id")
        .where("id", "=", "operation-start")
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ id: "operation-start" });
    await expect(
      database?.selectFrom("state_outbox").select("revision").execute(),
    ).resolves.toEqual([{ revision: 1 }]);

    await repository.markInFlight("operation-start", 10_001);
    await repository.completeSucceeded("operation-start", 10_002, [
      "child-start",
    ]);

    await expect(
      repository.readActiveManualOverrideOutputs(129_999),
    ).resolves.toEqual([
      {
        overrideId: "override-channel",
        deviceId: "device-a",
        mappingId: "mapping-channel",
        pin: 4,
        value: 89,
        overwrite: true,
        expiresAtMs: 130_000,
      },
    ]);
    await expect(
      repository.readActiveManualOverrideOutputs(130_000),
    ).resolves.toEqual([]);
  });

  it("extends from authoritative server time and releases scheduled and unscheduled pins", async () => {
    const repository = await createRepository();
    await activate(repository, {
      overrideId: "override-channel",
      operationId: "operation-channel-start",
      target: { targetType: "channel", targetId: "channel-blue" },
      valuePercentage: 80,
    });
    await recordBackgroundDeviceContact(requireDatabase(), 10_003);
    const extended = await repository.extend({
      overrideId: "override-channel",
      expectedRevision: 3,
      atMs: 60_000,
      expiresAtMs: 60_000 + MANUAL_OVERRIDE_DURATION_MS,
    });
    expect(extended.override.expiresAtMs).toBe(180_000);
    await recordBackgroundDeviceContact(requireDatabase(), 60_001);

    const cancellation = await repository.createRelease({
      overrideId: "override-channel",
      operationId: "operation-channel-cancel",
      action: "cancel",
      expectedRevision: 5,
      requestedAtMs: 70_000,
      deadlineAtMs: 100_000,
      utcMinuteOfDay: 600,
    });
    expect(cancellation?.operation.request).toMatchObject({
      kind: "manual_override_cancel",
      originStartOperationId: "operation-channel-start",
      commands: [
        {
          deviceId: "device-a",
          mappingId: "mapping-channel",
          pin: 4,
          value: 89,
          overwrite: true,
        },
      ],
    });
    await repository.markInFlight("operation-channel-cancel", 70_001);
    await repository.completeSucceeded("operation-channel-cancel", 70_002, [
      "child-cancel",
    ]);
    await expect(
      repository.readActiveManualOverrideOutputs(70_003),
    ).resolves.toEqual([]);

    await activate(repository, {
      overrideId: "override-output",
      operationId: "operation-output-start",
      target: { targetType: "output", targetId: "output-standalone" },
      valuePercentage: 100,
      expectedRevision: 7,
      requestedAtMs: 200_000,
    });
    const outputCancellation = await repository.createRelease({
      overrideId: "override-output",
      operationId: "operation-output-cancel",
      action: "cancel",
      expectedRevision: 10,
      requestedAtMs: 210_000,
      deadlineAtMs: 240_000,
      utcMinuteOfDay: 600,
    });
    expect(outputCancellation?.operation.request).toMatchObject({
      commands: [
        {
          mappingId: "mapping-output",
          pin: 5,
          value: 0,
          overwrite: true,
        },
      ],
    });
  });

  it("keeps unknown starts conservatively active and reconciles only after the safety window", async () => {
    const repository = await createRepository();
    await repository.createStart({
      overrideId: "override-unknown",
      operationId: "operation-unknown",
      expectedRevision: 0,
      target: { targetType: "channel", targetId: "channel-blue" },
      valuePercentage: 75,
      requestedAtMs: 10_000,
      expiresAtMs: 130_000,
      deadlineAtMs: 40_000,
    });
    await repository.markInFlight("operation-unknown", 10_001);
    await repository.completeOutcomeUnknown({
      operationId: "operation-unknown",
      completedAtMs: 10_002,
      childOperationIds: ["child-unknown"],
      reason: "child_outcome_not_succeeded",
      unknownChildOperationIds: ["child-unknown"],
      safetyReconcileAtMs: 130_002,
    });
    await recordBackgroundDeviceContact(requireDatabase(), 20_000);

    await expect(
      repository.readActiveManualOverrideOutputs(20_000),
    ).resolves.toMatchObject([
      {
        overrideId: "override-unknown",
        deviceId: "device-a",
        pin: 4,
        overwrite: true,
      },
    ]);
    await expect(
      repository.finalizeReconciledOutcome({
        operationId: "operation-unknown",
        expectedRevision: null,
        reconciledAtMs: 130_001,
      }),
    ).rejects.toBeInstanceOf(ManualOverrideConflictError);

    const reconciled = await repository.finalizeReconciledOutcome({
      operationId: "operation-unknown",
      expectedRevision: 3,
      reconciledAtMs: 130_002,
    });
    expect(reconciled.override).toMatchObject({
      status: "active",
      startsAtMs: 10_002,
      completedAtMs: null,
    });
    await expect(
      repository.getManualOperation("operation-unknown"),
    ).resolves.toMatchObject({
      status: "outcome_unknown",
      result: { reconciledAtMs: 130_002 },
    });
  });

  it("can release an unknown start and reconcile its historical outcome after cancellation", async () => {
    const repository = await createRepository();
    await repository.createStart({
      overrideId: "override-unknown",
      operationId: "operation-unknown",
      expectedRevision: 0,
      target: { targetType: "channel", targetId: "channel-blue" },
      valuePercentage: 75,
      requestedAtMs: 10_000,
      expiresAtMs: 130_000,
      deadlineAtMs: 40_000,
    });
    await repository.markInFlight("operation-unknown", 10_001);
    await repository.completeOutcomeUnknown({
      operationId: "operation-unknown",
      completedAtMs: 10_002,
      childOperationIds: ["child-unknown"],
      reason: "child_outcome_not_succeeded",
      unknownChildOperationIds: ["child-unknown"],
      safetyReconcileAtMs: 130_002,
    });

    const cancellation = await repository.createRelease({
      overrideId: "override-unknown",
      operationId: "operation-cancel",
      action: "cancel",
      expectedRevision: 2,
      requestedAtMs: 20_000,
      deadlineAtMs: 50_000,
      utcMinuteOfDay: 600,
    });
    expect(cancellation?.operation.request).toMatchObject({
      kind: "manual_override_cancel",
      originStartOperationId: "operation-unknown",
      commands: [{ overwrite: true }],
    });
    await repository.markInFlight("operation-cancel", 20_001);
    await repository.completeSucceeded("operation-cancel", 20_002, [
      "child-cancel",
    ]);

    const reconciled = await repository.finalizeReconciledOutcome({
      operationId: "operation-unknown",
      expectedRevision: null,
      reconciledAtMs: 130_002,
    });
    expect(reconciled.override).toMatchObject({
      status: "cancelled",
      operationId: "operation-cancel",
      completedAtMs: 20_002,
    });
    await expect(
      repository.getManualOperation("operation-unknown"),
    ).resolves.toMatchObject({
      status: "outcome_unknown",
      result: { reconciledAtMs: 130_002 },
    });
  });

  it("recovers active overrides across restart and converts interrupted work without retrying", async () => {
    const repository = await createRepository();
    await activate(repository, {
      overrideId: "override-active",
      operationId: "operation-active",
      target: { targetType: "channel", targetId: "channel-blue" },
      valuePercentage: 40,
    });
    const restarted = new ManualOverrideRepository(requireDatabase());
    await restarted.recoverInterrupted(20_000);
    await expect(
      restarted.readActiveManualOverrideOutputs(20_000),
    ).resolves.toHaveLength(1);

    await restarted.createRelease({
      overrideId: "override-active",
      operationId: "operation-release-interrupted",
      action: "cancel",
      expectedRevision: 3,
      requestedAtMs: 21_000,
      deadlineAtMs: 51_000,
      utcMinuteOfDay: 600,
    });
    const afterSecondRestart = new ManualOverrideRepository(requireDatabase());
    await afterSecondRestart.recoverInterrupted(22_000);
    await expect(
      afterSecondRestart.getManualOperation("operation-release-interrupted"),
    ).resolves.toMatchObject({
      status: "outcome_unknown",
      result: {
        reason: "controller_restart_before_release",
        unknownChildOperationIds: [],
        safetyReconcileAtMs: 142_000,
      },
    });
    await expect(
      afterSecondRestart.readActiveManualOverrideOutputs(22_000),
    ).resolves.toEqual([]);
  });

  it("recovers the unresolved child identifier after a crash between child and coordinator persistence", async () => {
    const repository = await createRepository();
    const device = await requireDatabase()
      .selectFrom("devices")
      .selectAll()
      .where("id", "=", "device-a")
      .executeTakeFirstOrThrow();
    await requireDatabase()
      .insertInto("devices")
      .values({
        ...device,
        id: "device-b",
        hardware_id: "hardware-b",
        name: "Beta",
        reported_name: "Beta",
      })
      .execute();
    await repository.createStart({
      overrideId: "override-crash-gap",
      operationId: "operation-crash-gap",
      expectedRevision: 0,
      target: { targetType: "channel", targetId: "channel-blue" },
      valuePercentage: 50,
      requestedAtMs: 10_000,
      expiresAtMs: 130_000,
      deadlineAtMs: 40_000,
    });
    await repository.markInFlight("operation-crash-gap", 10_001);
    await requireDatabase()
      .insertInto("control_operations")
      .values(
        ["a", "b"].map((suffix, index) => ({
          id: `child-crash-gap-${suffix}`,
          device_id: `device-${suffix}`,
          kind: "set_pwm",
          status: "outcome_unknown" as const,
          requested_at_ms: 10_002 + index,
          deadline_at_ms: 15_002 + index,
          completed_at_ms: 15_002 + index,
          request_json: JSON.stringify({
            kind: "set_pwm",
            pin: 4,
            value: 89,
            overwrite: true,
          }),
          request_schema_version: 1,
          result_json: JSON.stringify({
            status: "outcome_unknown",
            wireOperationId: `wire-${suffix}`,
            reason: "timeout",
            reconciledAtMs: null,
          }),
          result_schema_version: 1,
        })),
      )
      .execute();

    const restarted = new ManualOverrideRepository(requireDatabase());
    await restarted.recoverInterrupted(20_000);
    await expect(
      restarted.getManualOperation("operation-crash-gap"),
    ).resolves.toMatchObject({
      status: "outcome_unknown",
      result: {
        childOperationIds: ["child-crash-gap-a", "child-crash-gap-b"],
        unknownChildOperationIds: ["child-crash-gap-a", "child-crash-gap-b"],
        reason: "controller_restart",
      },
    });
    await expect(
      restarted.readActiveManualOverrideOutputs(20_000),
    ).resolves.toHaveLength(2);
  });

  it("recovers an in-flight start as expired when its lease already elapsed", async () => {
    const repository = await createRepository();
    await repository.createStart({
      overrideId: "override-expired",
      operationId: "operation-expired",
      expectedRevision: 0,
      target: { targetType: "channel", targetId: "channel-blue" },
      valuePercentage: 50,
      requestedAtMs: 10_000,
      expiresAtMs: 130_000,
      deadlineAtMs: 40_000,
    });
    await repository.markInFlight("operation-expired", 10_001);

    const restarted = new ManualOverrideRepository(requireDatabase());
    await restarted.recoverInterrupted(140_000);

    await expect(
      requireDatabase()
        .selectFrom("overrides")
        .select(["status", "starts_at_ms", "completed_at_ms"])
        .where("id", "=", "override-expired")
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({
      status: "expired",
      starts_at_ms: 140_000,
      completed_at_ms: 140_000,
    });
    await expect(
      restarted.readActiveManualOverrideOutputs(140_000),
    ).resolves.toEqual([]);
  });
});

async function createRepository(): Promise<ManualOverrideRepository> {
  database = await openStateDatabase({ filename: ":memory:" });
  await seed(database);
  return new ManualOverrideRepository(database);
}

async function recordBackgroundDeviceContact(
  state: Kysely<StateDatabaseSchema>,
  atMs: number,
): Promise<void> {
  await commitStateChange(
    state,
    {
      actor: "runtime.device-health",
      mutationType: "device.contact-recorded",
      summary: "Recorded background device contact",
      eventType: "device.contact-recorded",
      entityType: "device",
      entityId: "device-a",
      occurredAtMs: atMs,
      retentionClass: "operational",
      payloadJson: JSON.stringify({ schemaVersion: 1 }),
      payloadSchemaVersion: 1,
    },
    async (transaction) => {
      await transaction
        .updateTable("devices")
        .set({ last_seen_at_ms: atMs, updated_at_ms: atMs })
        .where("id", "=", "device-a")
        .executeTakeFirstOrThrow();
    },
  );
}

function requireDatabase(): Kysely<StateDatabaseSchema> {
  if (database === undefined) {
    throw new Error("Test database has not been initialized");
  }
  return database;
}

async function activate(
  repository: ManualOverrideRepository,
  input: {
    readonly overrideId: string;
    readonly operationId: string;
    readonly target:
      | { readonly targetType: "channel"; readonly targetId: string }
      | { readonly targetType: "output"; readonly targetId: string };
    readonly valuePercentage: number;
    readonly expectedRevision?: number;
    readonly requestedAtMs?: number;
  },
): Promise<void> {
  const requestedAtMs = input.requestedAtMs ?? 10_000;
  await repository.createStart({
    overrideId: input.overrideId,
    operationId: input.operationId,
    expectedRevision: input.expectedRevision ?? 0,
    target: input.target,
    valuePercentage: input.valuePercentage,
    requestedAtMs,
    expiresAtMs: requestedAtMs + MANUAL_OVERRIDE_DURATION_MS,
    deadlineAtMs: requestedAtMs + 30_000,
  });
  await repository.markInFlight(input.operationId, requestedAtMs + 1);
  await repository.completeSucceeded(input.operationId, requestedAtMs + 2, [
    `${input.operationId}-child`,
  ]);
}

async function seed(state: Kysely<StateDatabaseSchema>): Promise<void> {
  const now = 1_000;
  await state
    .insertInto("throttles")
    .values({
      id: "throttle-half",
      type_key: "light",
      percentage: 50,
      created_at_ms: now,
      updated_at_ms: now,
    })
    .execute();
  await state
    .insertInto("channels")
    .values({
      id: "channel-blue",
      name: "Blue",
      kind: "light",
      throttle_id: "throttle-half",
      display_order: 0,
      enabled: 1,
      created_at_ms: now,
      updated_at_ms: now,
    })
    .execute();
  await state
    .insertInto("outputs")
    .values({
      id: "output-standalone",
      name: "Standalone",
      kind: "pump",
      display_order: 0,
      enabled: 1,
      output_gain: 0.5,
      created_at_ms: now,
      updated_at_ms: now,
    })
    .execute();
  await state
    .insertInto("schedules")
    .values({
      id: "schedule-blue",
      channel_id: "channel-blue",
      name: "Blue schedule",
      timezone: "UTC",
      enabled: 1,
      graph_revision: 1,
      created_at_ms: now,
      updated_at_ms: now,
    })
    .execute();
  await state
    .insertInto("schedule_points")
    .values([
      {
        id: "point-blue-0",
        schedule_id: "schedule-blue",
        position: 0,
        minute_of_day: 0,
        percentage: 100,
        editor_x: null,
        editor_y: null,
        created_at_ms: now,
        updated_at_ms: now,
      },
      {
        id: "point-blue-1",
        schedule_id: "schedule-blue",
        position: 1,
        minute_of_day: 1_439,
        percentage: 100,
        editor_x: null,
        editor_y: null,
        created_at_ms: now,
        updated_at_ms: now,
      },
    ])
    .execute();
  await state
    .insertInto("mapping_profiles")
    .values({
      id: "profile-a",
      name: "Profile A",
      device_name_prefix: "A",
      output_gain: 0.7,
      created_at_ms: now,
      updated_at_ms: now,
    })
    .execute();
  await state
    .insertInto("pin_mappings")
    .values([
      {
        id: "mapping-channel",
        mapping_profile_id: "profile-a",
        output_id: null,
        channel_id: "channel-blue",
        pin: 4,
        display_order: 0,
        enabled: 1,
        created_at_ms: now,
        updated_at_ms: now,
      },
      {
        id: "mapping-output",
        mapping_profile_id: "profile-a",
        output_id: "output-standalone",
        channel_id: null,
        pin: 5,
        display_order: 1,
        enabled: 1,
        created_at_ms: now,
        updated_at_ms: now,
      },
    ])
    .execute();
  await state
    .insertInto("devices")
    .values({
      id: "device-a",
      hardware_id: "hardware-a",
      name: "Alpha",
      mapping_profile_id: "profile-a",
      reported_name: "Alpha",
      desired_pwm_frequency_hz: 5_000,
      desired_pwm_resolution_bits: 8,
      reported_pwm_frequency_hz: 5_000,
      reported_pwm_resolution_bits: 8,
      firmware_version: "4.0.0",
      reported_schedule_hash: "0",
      status: "online",
      last_seen_at_ms: now,
      last_error_code: null,
      last_error_message: null,
      enabled: 1,
      created_at_ms: now,
      updated_at_ms: now,
      metadata_json: null,
      metadata_schema_version: null,
    })
    .execute();
}
