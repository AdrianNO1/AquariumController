import { controllerSnapshotSchema } from "@aquarium/contracts";
import { ESP_FIRMWARE_ARTIFACT } from "@aquarium/esp-protocol";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
import { sql, type Kysely } from "kysely";
import { afterEach, describe, expect, it } from "vitest";

import {
  StateEventStreamHub,
  type StateEventStreamSink,
} from "../../realtime/state-event-stream.js";
import { CONTROLLER_STORAGE_HEALTH_DEVICE_ID } from "../../application/maintenance/controller-storage-health-service.js";
import {
  commitStateChange,
  openStateDatabase,
  type StateDatabaseSchema,
} from "./index.js";
import {
  CONTROL_AREA_DEFINITIONS,
  ControllerSnapshotRepository,
  InvalidPersistedSnapshotDataError,
  RECENT_OPERATION_LIMIT,
  UNRESOLVED_DEVICE_OPERATION_LIMIT,
} from "./controller-snapshot-repository.js";

const BASE_TIME_MS = Date.parse("2026-07-13T08:00:00.000Z");
const SNAPSHOT_TIME = new Date("2026-07-13T09:00:00.000Z");
const openDatabases = new Set<Kysely<StateDatabaseSchema>>();
const temporaryDirectories = new Set<string>();

afterEach(async () => {
  await Promise.all(
    [...openDatabases].map(async (database) => {
      await database.destroy();
      openDatabases.delete(database);
    }),
  );

  const temporaryRoot = `${resolve(tmpdir())}${sep}`;
  for (const directory of temporaryDirectories) {
    const resolvedDirectory = resolve(directory);
    if (
      !resolvedDirectory.startsWith(temporaryRoot) ||
      !basename(resolvedDirectory).startsWith("aquarium-snapshot-")
    ) {
      throw new Error(
        `Refusing to remove unexpected test directory: ${resolvedDirectory}`,
      );
    }
    await rm(resolvedDirectory, { recursive: true, force: true });
    temporaryDirectories.delete(directory);
  }
});

describe("controller snapshot repository", () => {
  it("returns empty and current snapshots without mutating or materializing defaults", async () => {
    const database = await openDatabase(":memory:");
    const repository = createRepository(database);
    const changesBefore = await totalChanges(database);

    const empty = await repository.read();

    expect(controllerSnapshotSchema.parse(empty)).toEqual(empty);
    expect(empty).toMatchObject({
      schemaVersion: 1,
      revision: 0,
      committedAt: null,
      generatedAt: SNAPSHOT_TIME.toISOString(),
      controlAreas: CONTROL_AREA_DEFINITIONS,
      channels: [],
      schedules: [],
      operations: {
        items: [],
        limit: RECENT_OPERATION_LIMIT,
        truncated: false,
      },
      unresolvedDeviceOperations: {
        items: [],
        limit: UNRESOLVED_DEVICE_OPERATION_LIMIT,
        truncated: false,
      },
    });
    expect(await totalChanges(database)).toBe(changesBefore);

    await database
      .insertInto("state_revisions")
      .values({
        revision: 7,
        committed_at_ms: BASE_TIME_MS,
        actor: "test",
        mutation_type: "test.seed",
        summary: "Seed current revision",
      })
      .executeTakeFirstOrThrow();

    const current = await repository.read();
    expect(current.revision).toBe(7);
    expect(current.committedAt).toBe(new Date(BASE_TIME_MS).toISOString());
    expect(current.controlAreas).toHaveLength(11);
    await expect(
      database.selectFrom("throttles").selectAll().execute(),
    ).resolves.toEqual([]);
  });

  it("keeps the internal storage-health owner out of ESP-facing projections", async () => {
    const database = await openDatabase(":memory:");
    await database
      .insertInto("devices")
      .values({
        id: CONTROLLER_STORAGE_HEALTH_DEVICE_ID,
        hardware_id: CONTROLLER_STORAGE_HEALTH_DEVICE_ID,
        name: "Controller storage health",
        desired_pwm_frequency_hz: 1_000,
        desired_pwm_resolution_bits: 8,
        status: "unknown",
        enabled: 0,
        created_at_ms: BASE_TIME_MS,
        updated_at_ms: BASE_TIME_MS,
      })
      .executeTakeFirstOrThrow();
    await database
      .insertInto("alert_rules")
      .values({
        id: "rule-internal-device-health",
        name: "Internal storage owner health",
        source_type: "device",
        device_id: CONTROLLER_STORAGE_HEALTH_DEVICE_ID,
        condition: "not_online",
        threshold: null,
        delay_ms: 0,
        severity: "error",
        created_at_ms: BASE_TIME_MS,
        updated_at_ms: BASE_TIME_MS,
      })
      .executeTakeFirstOrThrow();
    await database
      .insertInto("active_alerts")
      .values({
        id: "alert-internal-device-health",
        alert_rule_id: "rule-internal-device-health",
        deduplication_key: "device:virtual-controller-storage",
        state: "open",
        opened_at_ms: BASE_TIME_MS,
        last_observed_at_ms: BASE_TIME_MS,
      })
      .executeTakeFirstOrThrow();

    const snapshot = await createRepository(database).read();

    expect(snapshot.devices).toEqual([]);
    expect(snapshot.alertRules).toEqual([]);
    expect(snapshot.alerts).toEqual([]);
  });

  it("hides a rollout policy targeting an obsolete firmware artifact", async () => {
    const database = await openDatabase(":memory:");
    await database
      .updateTable("firmware_rollout_policy")
      .set({
        enabled: 1,
        target_version: "5.0.0",
        mode: "when_off",
        requested_at_ms: BASE_TIME_MS,
        updated_at_ms: BASE_TIME_MS,
      })
      .where("singleton_key", "=", 1)
      .executeTakeFirstOrThrow();

    const repository = createRepository(database);
    await expect(repository.read()).resolves.toMatchObject({
      firmware: { fleetPolicy: null },
    });

    await database
      .updateTable("firmware_rollout_policy")
      .set({ target_version: ESP_FIRMWARE_ARTIFACT.version })
      .where("singleton_key", "=", 1)
      .executeTakeFirstOrThrow();
    await expect(repository.read()).resolves.toMatchObject({
      firmware: {
        fleetPolicy: {
          targetVersion: ESP_FIRMWARE_ARTIFACT.version,
          mode: "when_off",
        },
      },
    });
  });

  it("projects populated normalized state, nested JSON, and current lifecycle records", async () => {
    const database = await openDatabase(":memory:");
    await seedPopulatedState(database);

    const snapshot = await createRepository(database).read();

    expect(controllerSnapshotSchema.parse(snapshot)).toEqual(snapshot);
    expect(snapshot.revision).toBe(1);
    expect(snapshot.channels).toEqual([
      expect.objectContaining({
        id: "channel-blue",
        color: "#6f5bd5",
        typeKey: "light",
        throttleId: "throttle-light",
      }),
    ]);
    expect(snapshot.schedules[0]?.points.map((point) => point.id)).toEqual([
      "point-midnight",
      "point-noon",
    ]);
    expect(snapshot.mappingProfiles[0]?.mappings).toEqual([
      {
        id: "mapping-blue",
        pin: 12,
        displayOrder: 0,
        enabled: true,
        target: { kind: "channel", id: "channel-blue" },
      },
    ]);
    expect(snapshot.devices[0]).toMatchObject({
      id: "device-main",
      desired: { name: "reef-main" },
      reported: {
        scheduleHash: "42",
        outputsOff: false,
        outputs: [{ pin: 12, valuePercentage: 75 }],
        ota: {
          status: "idle",
          targetVersion: "",
          progress: 0,
          error: null,
        },
      },
      firmwareUpdate: {
        targetVersion: "5.0.0",
        mode: "when_off",
        status: "usb_required",
      },
      status: "online",
    });
    expect(snapshot.firmware).toMatchObject({
      currentVersion: "5.0.4",
      sizeBytes: 1_172_144,
      fleetPolicy: null,
    });
    expect(snapshot.operations.items.map((operation) => operation.id)).toEqual([
      "operation-apply",
    ]);
    expect(snapshot.operations.items[0]?.outcomeUnresolved).toBe(false);
    expect(snapshot.importRuns.map((run) => run.id)).toEqual(["import-legacy"]);
    expect(snapshot.overrides).toEqual([
      expect.objectContaining({
        id: "override-blue",
        targetType: "channel",
        targetId: "channel-blue",
        status: "active",
      }),
    ]);
    expect(snapshot.alertRules).toEqual([
      expect.objectContaining({
        id: "rule-offline",
        source: { type: "device", id: "device-main" },
        condition: { kind: "offline" },
      }),
    ]);
    expect(snapshot.alerts[0]).toMatchObject({
      id: "alert-offline",
      details: {
        schemaVersion: 1,
        observation: {
          sourceType: "device",
          sourceId: "device-main",
          status: "offline",
        },
      },
      notificationDeliveries: [
        {
          id: 1,
          alertTransitionRevision: 1,
          transition: "opened",
          destinationKind: "webhook",
          destinationKey: "primary",
          status: "delivered",
          attemptCount: 1,
          createdAt: new Date(BASE_TIME_MS + 7_000).toISOString(),
          attemptedAt: new Date(BASE_TIME_MS + 8_000).toISOString(),
          completedAt: new Date(BASE_TIME_MS + 9_000).toISOString(),
          lastError: null,
        },
      ],
    });
  });

  it("uses deterministic ordering at every nested projection boundary", async () => {
    const database = await openDatabase(":memory:");
    await database
      .insertInto("throttles")
      .values([
        {
          id: "throttle-pump",
          type_key: "pump",
          percentage: 80,
          created_at_ms: BASE_TIME_MS,
          updated_at_ms: BASE_TIME_MS,
        },
        {
          id: "throttle-light",
          type_key: "light",
          percentage: 90,
          created_at_ms: BASE_TIME_MS,
          updated_at_ms: BASE_TIME_MS,
        },
      ])
      .execute();
    await database
      .insertInto("channels")
      .values([
        {
          id: "channel-second",
          name: "Second",
          kind: "light",
          throttle_id: "throttle-light",
          display_order: 2,
          created_at_ms: BASE_TIME_MS,
          updated_at_ms: BASE_TIME_MS,
        },
        {
          id: "channel-first-b",
          name: "First B",
          kind: "light",
          throttle_id: "throttle-light",
          display_order: 1,
          created_at_ms: BASE_TIME_MS,
          updated_at_ms: BASE_TIME_MS,
        },
        {
          id: "channel-first-a",
          name: "First A",
          kind: "light",
          throttle_id: "throttle-light",
          display_order: 1,
          created_at_ms: BASE_TIME_MS,
          updated_at_ms: BASE_TIME_MS,
        },
      ])
      .execute();

    const first = await createRepository(database).read();
    const second = await createRepository(database).read();

    expect(first).toEqual(second);
    expect(first.throttles.map((throttle) => throttle.id)).toEqual([
      "throttle-light",
      "throttle-pump",
    ]);
    expect(first.channels.map((channel) => channel.id)).toEqual([
      "channel-first-a",
      "channel-first-b",
      "channel-second",
    ]);
  });

  it("bounds recent operations and reports when the result is truncated", async () => {
    const database = await openDatabase(":memory:");
    await database
      .insertInto("control_operations")
      .values(
        Array.from({ length: RECENT_OPERATION_LIMIT + 1 }, (_, index) => ({
          id: `operation-${String(index).padStart(3, "0")}`,
          device_id: null,
          kind: "test.operation",
          status: "succeeded" as const,
          requested_at_ms: BASE_TIME_MS + index,
          deadline_at_ms: BASE_TIME_MS + index + 10_000,
          completed_at_ms: BASE_TIME_MS + index + 1,
          request_json: '{"schemaVersion":1}',
          request_schema_version: 1,
          result_json: '{"ok":true}',
          result_schema_version: 1,
        })),
      )
      .execute();

    const snapshot = await createRepository(database).read();

    expect(snapshot.operations).toMatchObject({
      limit: RECENT_OPERATION_LIMIT,
      truncated: true,
    });
    expect(snapshot.operations.items).toHaveLength(RECENT_OPERATION_LIMIT);
    expect(snapshot.operations.items[0]?.id).toBe("operation-100");
    expect(snapshot.operations.items.at(-1)?.id).toBe("operation-001");
  });

  it("pins unresolved device outcomes outside recent history and current mappings", async () => {
    const database = await openDatabase(":memory:");
    await database
      .insertInto("devices")
      .values({
        id: "device-unmapped",
        hardware_id: "UNMAPPED",
        name: "Unmapped device",
        mapping_profile_id: null,
        desired_pwm_frequency_hz: 5_000,
        desired_pwm_resolution_bits: 8,
        created_at_ms: BASE_TIME_MS,
        updated_at_ms: BASE_TIME_MS,
      })
      .executeTakeFirstOrThrow();
    await database
      .insertInto("control_operations")
      .values([
        {
          id: "operation-unresolved-old",
          device_id: "device-unmapped",
          kind: "ping",
          status: "outcome_unknown",
          requested_at_ms: BASE_TIME_MS,
          deadline_at_ms: BASE_TIME_MS + 5_000,
          completed_at_ms: BASE_TIME_MS + 5_001,
          request_json: '{"kind":"ping"}',
          request_schema_version: 1,
          result_json:
            '{"status":"outcome_unknown","wireOperationId":"wire-old","reason":"timeout","reconciledAtMs":null}',
          result_schema_version: 1,
        },
        {
          id: "operation-reconciled-old",
          device_id: "device-unmapped",
          kind: "ping",
          status: "outcome_unknown",
          requested_at_ms: BASE_TIME_MS + 1,
          deadline_at_ms: BASE_TIME_MS + 5_001,
          completed_at_ms: BASE_TIME_MS + 5_002,
          request_json: '{"kind":"ping"}',
          request_schema_version: 1,
          result_json: `{"status":"outcome_unknown","wireOperationId":"wire-reconciled","reason":"timeout","reconciledAtMs":${BASE_TIME_MS + 10_000}}`,
          result_schema_version: 1,
        },
      ])
      .execute();
    await database
      .insertInto("control_operations")
      .values(
        Array.from({ length: RECENT_OPERATION_LIMIT + 1 }, (_, index) => ({
          id: `operation-newer-${String(index).padStart(3, "0")}`,
          device_id: null,
          kind: "test.operation",
          status: "succeeded" as const,
          requested_at_ms: BASE_TIME_MS + 20_000 + index,
          deadline_at_ms: BASE_TIME_MS + 30_000 + index,
          completed_at_ms: BASE_TIME_MS + 20_001 + index,
          request_json: '{"schemaVersion":1}',
          request_schema_version: 1,
          result_json: '{"ok":true}',
          result_schema_version: 1,
        })),
      )
      .execute();

    const snapshot = await createRepository(database).read();

    expect(snapshot.operations.truncated).toBe(true);
    expect(
      snapshot.operations.items.some(
        ({ id }) => id === "operation-unresolved-old",
      ),
    ).toBe(false);
    expect(snapshot.unresolvedDeviceOperations).toEqual({
      items: [
        expect.objectContaining({
          id: "operation-unresolved-old",
          deviceId: "device-unmapped",
          status: "outcome_unknown",
          outcomeUnresolved: true,
        }),
      ],
      limit: UNRESOLVED_DEVICE_OPERATION_LIMIT,
      truncated: false,
    });
  });

  it("rejects duplicate-key persisted JSON without exposing the document", async () => {
    const database = await openDatabase(":memory:");
    await seedPopulatedState(database);
    const malformed =
      '{"schemaVersion":1,"schemaVersion":1,"observation":null,"note":"private-value"}';
    await database
      .updateTable("active_alerts")
      .set({ details_json: malformed })
      .where("id", "=", "alert-offline")
      .executeTakeFirstOrThrow();

    const result = createRepository(database).read();

    await expect(result).rejects.toBeInstanceOf(
      InvalidPersistedSnapshotDataError,
    );
    await expect(result).rejects.not.toThrow(/private-value/u);
  });

  it("persists the same projection across a database reopen", async () => {
    const directory = await mkdtemp(join(tmpdir(), "aquarium-snapshot-"));
    temporaryDirectories.add(directory);
    const filename = join(directory, "state.db");
    const firstDatabase = await openDatabase(filename);
    await seedPopulatedState(firstDatabase);
    const before = await createRepository(firstDatabase).read();
    await firstDatabase.destroy();
    openDatabases.delete(firstDatabase);

    const reopenedDatabase = await openDatabase(filename, false);
    const after = await createRepository(reopenedDatabase).read();

    expect(after).toEqual(before);
  });

  it("replays a commit made after the snapshot revision through SSE", async () => {
    const database = await openDatabase(":memory:");
    await commitStateChange(
      database,
      {
        actor: "test",
        mutationType: "throttle.create",
        summary: "Create light throttle",
        eventType: "configuration.throttle-created",
        entityType: "throttle",
        entityId: "throttle-light",
        occurredAtMs: BASE_TIME_MS,
        retentionClass: "audit",
        payloadJson: '{"percentage":90}',
        payloadSchemaVersion: 1,
      },
      async (transaction) => {
        await transaction
          .insertInto("throttles")
          .values({
            id: "throttle-light",
            type_key: "light",
            percentage: 90,
            created_at_ms: BASE_TIME_MS,
            updated_at_ms: BASE_TIME_MS,
          })
          .executeTakeFirstOrThrow();
      },
    );
    const snapshot = await createRepository(database).read();
    expect(snapshot.revision).toBe(1);

    await commitStateChange(
      database,
      {
        actor: "test",
        mutationType: "throttle.update",
        summary: "Update light throttle",
        eventType: "configuration.throttle-updated",
        entityType: "throttle",
        entityId: "throttle-light",
        occurredAtMs: BASE_TIME_MS + 1,
        retentionClass: "audit",
        payloadJson: '{"percentage":80}',
        payloadSchemaVersion: 1,
      },
      async (transaction) => {
        await transaction
          .updateTable("throttles")
          .set({ percentage: 80, updated_at_ms: BASE_TIME_MS + 1 })
          .where("id", "=", "throttle-light")
          .executeTakeFirstOrThrow();
      },
    );

    const sink = new RecordingSink();
    const connection = await new StateEventStreamHub(database).open(sink, {
      afterRevision: snapshot.revision,
      now: () => SNAPSHOT_TIME,
    });

    expect(sink.frames).toHaveLength(2);
    expect(sink.frames[0]).toContain("id: 2");
    expect(sink.frames[0]).toContain(
      '"resource":"throttle","id":"throttle-light"',
    );
    expect(sink.frames[1]).toContain("system.stream-ready");
    connection.close();
  });
});

class RecordingSink implements StateEventStreamSink {
  readonly frames: string[] = [];

  write(frame: string): boolean {
    this.frames.push(frame);
    return true;
  }

  close(): void {}
}

async function openDatabase(
  filename: string,
  clearThrottles = true,
): Promise<Kysely<StateDatabaseSchema>> {
  const database = await openStateDatabase({ filename });
  if (clearThrottles) {
    await database.deleteFrom("throttles").execute();
  }
  openDatabases.add(database);
  return database;
}

function createRepository(
  database: Kysely<StateDatabaseSchema>,
): ControllerSnapshotRepository {
  return new ControllerSnapshotRepository(database, {
    now: () => SNAPSHOT_TIME,
  });
}

async function totalChanges(
  database: Kysely<StateDatabaseSchema>,
): Promise<number> {
  const result = await sql<{ changes: number }>`
    SELECT total_changes() AS changes
  `.execute(database);
  const row = result.rows[0];
  if (row === undefined) throw new Error("SQLite did not return total_changes");
  return row.changes;
}

async function seedPopulatedState(
  database: Kysely<StateDatabaseSchema>,
): Promise<void> {
  await database
    .insertInto("state_revisions")
    .values({
      revision: 1,
      committed_at_ms: BASE_TIME_MS,
      actor: "test",
      mutation_type: "test.seed",
      summary: "Seed populated snapshot",
    })
    .executeTakeFirstOrThrow();
  await database
    .insertInto("throttles")
    .values({
      id: "throttle-light",
      type_key: "light",
      percentage: 90,
      created_at_ms: BASE_TIME_MS,
      updated_at_ms: BASE_TIME_MS,
    })
    .executeTakeFirstOrThrow();
  await database
    .insertInto("channels")
    .values({
      id: "channel-blue",
      name: "Blue",
      kind: "light",
      throttle_id: "throttle-light",
      display_order: 0,
      created_at_ms: BASE_TIME_MS,
      updated_at_ms: BASE_TIME_MS,
    })
    .executeTakeFirstOrThrow();
  await database
    .insertInto("schedules")
    .values({
      id: "schedule-blue",
      channel_id: "channel-blue",
      name: "Blue schedule",
      timezone: "UTC",
      graph_revision: 3,
      created_at_ms: BASE_TIME_MS,
      updated_at_ms: BASE_TIME_MS,
    })
    .executeTakeFirstOrThrow();
  await database
    .insertInto("schedule_points")
    .values([
      {
        id: "point-noon",
        schedule_id: "schedule-blue",
        position: 1,
        minute_of_day: 720,
        percentage: 80,
        editor_x: 12,
        editor_y: 24,
        created_at_ms: BASE_TIME_MS,
        updated_at_ms: BASE_TIME_MS,
      },
      {
        id: "point-midnight",
        schedule_id: "schedule-blue",
        position: 0,
        minute_of_day: 0,
        percentage: 0,
        created_at_ms: BASE_TIME_MS,
        updated_at_ms: BASE_TIME_MS,
      },
    ])
    .execute();
  await database
    .insertInto("outputs")
    .values({
      id: "output-return",
      name: "Return pump",
      kind: "pump",
      display_order: 0,
      output_gain: 0.75,
      created_at_ms: BASE_TIME_MS,
      updated_at_ms: BASE_TIME_MS,
    })
    .executeTakeFirstOrThrow();
  await database
    .insertInto("mapping_profiles")
    .values({
      id: "profile-main",
      name: "Main profile",
      device_name_prefix: "reef-",
      output_gain: 0.9,
      created_at_ms: BASE_TIME_MS,
      updated_at_ms: BASE_TIME_MS,
    })
    .executeTakeFirstOrThrow();
  await database
    .insertInto("pin_mappings")
    .values({
      id: "mapping-blue",
      mapping_profile_id: "profile-main",
      channel_id: "channel-blue",
      pin: 12,
      display_order: 0,
      created_at_ms: BASE_TIME_MS,
      updated_at_ms: BASE_TIME_MS,
    })
    .executeTakeFirstOrThrow();
  await database
    .insertInto("devices")
    .values({
      id: "device-main",
      hardware_id: "A1B2C3",
      name: "reef-main",
      mapping_profile_id: "profile-main",
      reported_name: "reef-main",
      desired_pwm_frequency_hz: 5_000,
      desired_pwm_resolution_bits: 8,
      reported_pwm_frequency_hz: 5_000,
      reported_pwm_resolution_bits: 8,
      firmware_version: "1.2.3",
      reported_schedule_hash: "42",
      output_state_json: '{"outputsOff":false,"outputs":[[12,75]]}',
      ota_status_json: '{"status":"idle","targetVersion":"","progress":0}',
      status: "online",
      last_seen_at_ms: BASE_TIME_MS + 1_000,
      created_at_ms: BASE_TIME_MS,
      updated_at_ms: BASE_TIME_MS + 1_000,
      metadata_json: '{"schemaVersion":1,"rack":"main"}',
      metadata_schema_version: 1,
    })
    .executeTakeFirstOrThrow();
  await database
    .insertInto("firmware_update_requests")
    .values({
      device_id: "device-main",
      target_version: "5.0.0",
      mode: "when_off",
      status: "usb_required",
      progress: 0,
      operation_id: null,
      error_message: "Install firmware 5.0.0 once over USB",
      requested_at_ms: BASE_TIME_MS,
      updated_at_ms: BASE_TIME_MS,
    })
    .executeTakeFirstOrThrow();
  await database
    .insertInto("control_operations")
    .values({
      id: "operation-apply",
      device_id: "device-main",
      kind: "schedule.apply",
      status: "succeeded",
      requested_at_ms: BASE_TIME_MS + 2_000,
      deadline_at_ms: BASE_TIME_MS + 12_000,
      completed_at_ms: BASE_TIME_MS + 3_000,
      request_json: '{"schemaVersion":1,"deviceId":"device-main"}',
      request_schema_version: 1,
      result_json: '{"schemaVersion":1,"accepted":true}',
      result_schema_version: 1,
    })
    .executeTakeFirstOrThrow();
  await database
    .insertInto("import_runs")
    .values({
      id: "import-legacy",
      source_kind: "legacy-json",
      source_fingerprint: "sha256:fixture",
      dry_run: 0,
      status: "succeeded",
      started_at_ms: BASE_TIME_MS + 1_000,
      completed_at_ms: BASE_TIME_MS + 2_000,
      report_json: '{"schemaVersion":1,"issues":[]}',
      report_schema_version: 1,
    })
    .executeTakeFirstOrThrow();
  await database
    .insertInto("overrides")
    .values({
      id: "override-blue",
      channel_id: "channel-blue",
      value_percentage: 45,
      status: "active",
      requested_at_ms: BASE_TIME_MS + 3_000,
      starts_at_ms: BASE_TIME_MS + 3_000,
      expires_at_ms: BASE_TIME_MS + 120_000,
      operation_id: "operation-apply",
    })
    .executeTakeFirstOrThrow();
  await database
    .insertInto("alert_rules")
    .values({
      id: "rule-offline",
      name: "Main controller offline",
      source_type: "device",
      device_id: "device-main",
      condition: "offline",
      threshold: null,
      delay_ms: 5_000,
      severity: "critical",
      created_at_ms: BASE_TIME_MS,
      updated_at_ms: BASE_TIME_MS,
      configuration_json: '{"schemaVersion":1}',
      configuration_schema_version: 1,
    })
    .executeTakeFirstOrThrow();
  const alertSnapshot = {
    id: "alert-offline",
    ruleId: "rule-offline",
    deduplicationKey: "device:device-main",
    state: "open",
    openedAtMs: BASE_TIME_MS + 4_000,
    lastObservedAtMs: BASE_TIME_MS + 6_000,
    acknowledgedAtMs: null,
    recoveredAtMs: null,
  } as const;
  const ruleSnapshot = {
    id: "rule-offline",
    name: "Main controller offline",
    sourceType: "device",
    sourceId: "device-main",
    condition: "offline",
    threshold: null,
    delayMs: 5_000,
    severity: "critical",
  } as const;
  const observation = {
    sourceType: "device",
    sourceId: "device-main",
    status: "offline",
  } as const;
  await database
    .insertInto("active_alerts")
    .values({
      id: "alert-offline",
      alert_rule_id: "rule-offline",
      deduplication_key: "device:device-main",
      state: "open",
      opened_at_ms: BASE_TIME_MS + 4_000,
      last_observed_at_ms: BASE_TIME_MS + 6_000,
      details_json: JSON.stringify({
        schemaVersion: 1,
        observation,
        note: null,
      }),
      details_schema_version: 1,
    })
    .executeTakeFirstOrThrow();
  await database
    .insertInto("notification_deliveries")
    .values({
      id: 1,
      alert_transition_revision: 1,
      alert_id: "alert-offline",
      transition: "opened",
      destination_kind: "webhook",
      destination_key: "primary",
      deduplication_key: "alert-offline:opened:primary",
      status: "delivered",
      attempt_count: 1,
      notification_json: JSON.stringify({
        schemaVersion: 1,
        kind: "aquarium.alert",
        eventRevision: 1,
        occurredAt: new Date(BASE_TIME_MS + 4_000).toISOString(),
        transition: "opened",
        alert: alertSnapshot,
        rule: ruleSnapshot,
        observation,
        note: null,
      }),
      notification_schema_version: 1,
      created_at_ms: BASE_TIME_MS + 7_000,
      attempt_started_at_ms: BASE_TIME_MS + 8_000,
      completed_at_ms: BASE_TIME_MS + 9_000,
      updated_at_ms: BASE_TIME_MS + 9_000,
    })
    .executeTakeFirstOrThrow();
}
