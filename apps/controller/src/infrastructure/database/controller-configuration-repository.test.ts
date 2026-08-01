import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve, sep } from "node:path";

import type { Kysely } from "kysely";
import { afterEach, describe, expect, it } from "vitest";

import {
  ConfigurationNotFoundError,
  ConfigurationRelationalConflictError,
  ConfigurationRevisionConflictError,
  ConfigurationValidationError,
} from "../../application/configuration/index.js";
import { CONTROLLER_STORAGE_HEALTH_DEVICE_ID } from "../../application/maintenance/controller-storage-health-service.js";
import {
  ControllerConfigurationRepository,
  ControllerSnapshotRepository,
  commitStateChange,
  openStateDatabase,
  parseStoredStateOutboxEnvelope,
  readCurrentStateRevision,
  type StateDatabaseSchema,
} from "./index.js";

const openDatabases = new Set<Kysely<StateDatabaseSchema>>();
const temporaryDirectories = new Set<string>();

async function openDatabase(
  filename = ":memory:",
): Promise<Kysely<StateDatabaseSchema>> {
  const database = await openStateDatabase({ filename });
  openDatabases.add(database);
  return database;
}

async function closeDatabase(
  database: Kysely<StateDatabaseSchema>,
): Promise<void> {
  await database.destroy();
  openDatabases.delete(database);
}

afterEach(async () => {
  await Promise.all([...openDatabases].map(closeDatabase));
  const temporaryRoot = `${resolve(tmpdir())}${sep}`;
  for (const directory of temporaryDirectories) {
    const resolved = resolve(directory);
    if (
      !resolved.startsWith(temporaryRoot) ||
      !basename(resolved).startsWith("aquarium-configuration-")
    ) {
      throw new Error(`Refusing to remove unexpected directory ${resolved}`);
    }
    await rm(resolved, { recursive: true, force: true });
    temporaryDirectories.delete(directory);
  }
});

describe("ControllerConfigurationRepository", () => {
  it("creates, renames, and deletes areas with recoverable audit details", async () => {
    const database = await openDatabase();
    const repository = new ControllerConfigurationRepository(database, {
      nowMs: () => 100,
    });

    await expect(
      repository.createControlArea({
        expectedRevision: 0,
        label: "Anemone tank",
      }),
    ).resolves.toMatchObject({
      changed: true,
      revision: 1,
      event: {
        type: "control_area.created",
        entity: { type: "control_area", id: "anemone-tank" },
      },
    });
    await expect(
      repository.renameControlArea("anemone-tank", {
        expectedRevision: 1,
        label: "Anemones",
      }),
    ).resolves.toMatchObject({ changed: true, revision: 2 });
    await expect(
      repository.deleteControlArea("anemone-tank", 2),
    ).resolves.toMatchObject({ changed: true, revision: 3 });

    await expect(
      database
        .selectFrom("control_areas")
        .select("slug")
        .where("slug", "=", "anemone-tank")
        .executeTakeFirst(),
    ).resolves.toBeUndefined();
    await expect(
      database
        .selectFrom("throttles")
        .select("id")
        .where("id", "=", "throttle-anemone-tank")
        .executeTakeFirst(),
    ).resolves.toBeUndefined();

    const outboxRows = await database
      .selectFrom("state_outbox")
      .selectAll()
      .orderBy("revision")
      .execute();
    expect(
      outboxRows.map((row) => parseStoredStateOutboxEnvelope(row).details.data),
    ).toEqual([
      {
        schemaVersion: 1,
        action: "created",
        resource: "control_area",
        id: "anemone-tank",
        before: null,
        after: {
          slug: "anemone-tank",
          typeKey: "anemone-tank",
          label: "Anemone tank",
        },
        throttle: { id: "throttle-anemone-tank", percentage: 100 },
      },
      {
        schemaVersion: 1,
        action: "updated",
        resource: "control_area",
        id: "anemone-tank",
        before: {
          slug: "anemone-tank",
          typeKey: "anemone-tank",
          label: "Anemone tank",
        },
        after: {
          slug: "anemone-tank",
          typeKey: "anemone-tank",
          label: "Anemones",
        },
        throttle: { id: "throttle-anemone-tank", percentage: 100 },
      },
      {
        schemaVersion: 1,
        action: "deleted",
        resource: "control_area",
        id: "anemone-tank",
        before: {
          slug: "anemone-tank",
          typeKey: "anemone-tank",
          label: "Anemones",
        },
        after: null,
        throttle: { id: "throttle-anemone-tank", percentage: 100 },
      },
    ]);
  });

  it("does not delete an area while it owns live configuration", async () => {
    const database = await openDatabase();
    const repository = new ControllerConfigurationRepository(database, {
      nowMs: () => 100,
    });
    await repository.createControlArea({
      expectedRevision: 0,
      label: "Coral tank",
    });
    await repository.createChannel({
      expectedRevision: 1,
      id: "channel-coral",
      name: "Coral light",
      color: "#6f5bd5",
      typeKey: "coral-tank",
      throttleId: "throttle-coral-tank",
      displayOrder: 0,
      enabled: true,
    });

    await expect(
      repository.deleteControlArea("coral-tank", 2),
    ).rejects.toMatchObject({
      conflicts: [
        expect.objectContaining({
          resource: "channel",
          relation: "control_area",
        }),
      ],
    });
    expect(await readCurrentStateRevision(database)).toBe(2);
  });

  it("does not expose the internal storage-health owner as an operator device", async () => {
    const database = await openDatabase();
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
        created_at_ms: 1,
        updated_at_ms: 1,
      })
      .executeTakeFirstOrThrow();
    const repository = new ControllerConfigurationRepository(database);

    await expect(
      repository.setDeviceEnabled(CONTROLLER_STORAGE_HEALTH_DEVICE_ID, {
        expectedRevision: 0,
        enabled: true,
      }),
    ).rejects.toBeInstanceOf(ConfigurationNotFoundError);
    await expect(
      database
        .selectFrom("devices")
        .select("enabled")
        .where("id", "=", CONTROLLER_STORAGE_HEALTH_DEVICE_ID)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ enabled: 0 });
    expect(await readCurrentStateRevision(database)).toBe(0);
  });

  it("excludes devices reversibly and clears protocol quarantine only on include", async () => {
    const database = await openDatabase();
    await database
      .insertInto("devices")
      .values({
        id: "device-main",
        hardware_id: "hardware-main",
        name: "Main",
        desired_pwm_frequency_hz: 5_000,
        desired_pwm_resolution_bits: 8,
        status: "error",
        last_error_code: "protocol_invalid_response",
        last_error_message: "Invalid correlated response",
        enabled: 0,
        created_at_ms: 1,
        updated_at_ms: 1,
      })
      .executeTakeFirstOrThrow();
    const repository = new ControllerConfigurationRepository(database, {
      nowMs: () => 100,
    });

    await expect(
      repository.setDeviceEnabled("device-main", {
        expectedRevision: 0,
        enabled: true,
      }),
    ).resolves.toMatchObject({ changed: true, revision: 1 });
    await expect(
      database
        .selectFrom("devices")
        .select(["enabled", "status", "last_error_code", "last_error_message"])
        .where("id", "=", "device-main")
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({
      enabled: 1,
      status: "unknown",
      last_error_code: null,
      last_error_message: null,
    });
    await expect(
      repository.setDeviceEnabled("device-main", {
        expectedRevision: 1,
        enabled: true,
      }),
    ).resolves.toEqual({ changed: false, revision: 1, event: null });
    await expect(
      repository.setDeviceEnabled("device-main", {
        expectedRevision: 1,
        enabled: false,
      }),
    ).resolves.toMatchObject({ changed: true, revision: 2 });
    await expect(
      repository.setDeviceEnabled("device-main", {
        expectedRevision: 1,
        enabled: true,
      }),
    ).rejects.toBeInstanceOf(ConfigurationRevisionConflictError);
  });

  it("keeps revision checks, state writes, and outbox writes in one transaction", async () => {
    const database = await openDatabase();
    await database
      .insertInto("throttles")
      .values({
        id: "throttle-light",
        type_key: "light",
        percentage: 75,
        created_at_ms: 1,
        updated_at_ms: 1,
      })
      .executeTakeFirstOrThrow();
    const repository = new ControllerConfigurationRepository(database, {
      nowMs: () => 100,
    });

    await expect(
      repository.updateThrottle("light", {
        expectedRevision: 0,
        percentage: 75,
      }),
    ).resolves.toEqual({ changed: false, revision: 0, event: null });
    await expect(
      database.selectFrom("state_outbox").selectAll().execute(),
    ).resolves.toEqual([]);

    const changed = await repository.updateThrottle("light", {
      expectedRevision: 0,
      percentage: 80,
    });
    expect(changed).toMatchObject({
      changed: true,
      revision: 1,
      event: {
        revision: 1,
        entity: { type: "throttle", id: "throttle-light" },
      },
    });
    await expect(
      repository.updateThrottle("light", {
        expectedRevision: 0,
        percentage: 90,
      }),
    ).rejects.toBeInstanceOf(ConfigurationRevisionConflictError);
    await expect(
      database
        .selectFrom("throttles")
        .select(["percentage", "updated_at_ms"])
        .where("id", "=", "throttle-light")
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ percentage: 80, updated_at_ms: 100 });
    expect(await readCurrentStateRevision(database)).toBe(1);
    await expect(
      database
        .selectFrom("state_outbox")
        .select(({ fn }) => fn.countAll<number>().as("count"))
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ count: 1 });
  });

  it("accepts a snapshot revision after background state commits", async () => {
    const database = await openDatabase();
    await database
      .insertInto("throttles")
      .values({
        id: "throttle-light",
        type_key: "light",
        percentage: 75,
        created_at_ms: 1,
        updated_at_ms: 1,
      })
      .executeTakeFirstOrThrow();
    await commitStateChange(
      database,
      {
        actor: "background-test",
        mutationType: "operation.succeeded",
        summary: "Completed background operation",
        eventType: "operation.succeeded",
        entityType: "controller",
        entityId: null,
        occurredAtMs: 50,
        retentionClass: "audit",
        payloadJson: '{"operationId":"background-operation"}',
        payloadSchemaVersion: 1,
      },
      async () => undefined,
    );

    const repository = new ControllerConfigurationRepository(database, {
      nowMs: () => 100,
    });
    await expect(
      repository.updateThrottle("light", {
        expectedRevision: 0,
        percentage: 80,
      }),
    ).resolves.toMatchObject({ changed: true, revision: 2 });
    await expect(
      database
        .selectFrom("operator_concurrency")
        .select("last_operator_revision")
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ last_operator_revision: 2 });
  });

  it("reads valid manual-override aggregate operation documents and rejects corrupt ones", async () => {
    const database = await openDatabase();
    const base = {
      device_id: null,
      kind: "manual_override_start" as const,
      status: "outcome_unknown" as const,
      requested_at_ms: 100,
      deadline_at_ms: 200,
      completed_at_ms: 150,
      request_schema_version: 2,
      result_json: JSON.stringify({
        status: "outcome_unknown",
        childOperationIds: ["child-unknown"],
        reason: "child_outcome_not_succeeded",
        unknownChildOperationIds: ["child-unknown"],
        safetyReconcileAtMs: 120_150,
        reconciledAtMs: null,
      }),
      result_schema_version: 2,
    };
    const validRequest = {
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
    };
    await database
      .insertInto("control_operations")
      .values([
        {
          ...base,
          id: "manual-aggregate",
          request_json: JSON.stringify(validRequest),
        },
        {
          ...base,
          id: "corrupt-manual-aggregate",
          request_json: JSON.stringify({
            ...validRequest,
            kind: "manual_override_cancel",
          }),
        },
      ])
      .execute();
    const repository = new ControllerConfigurationRepository(database);

    await expect(
      repository.getOperation("manual-aggregate"),
    ).resolves.toMatchObject({
      operation: {
        id: "manual-aggregate",
        deviceId: null,
        kind: "manual_override_start",
        status: "outcome_unknown",
      },
      request: {
        schemaVersion: 2,
        data: {
          kind: "manual_override_start",
          overrideId: "override-main",
        },
      },
      result: {
        schemaVersion: 2,
        data: {
          status: "outcome_unknown",
          unknownChildOperationIds: ["child-unknown"],
        },
      },
    });
    await expect(
      repository.getOperation("corrupt-manual-aggregate"),
    ).rejects.toThrow();
  });

  it("creates and deletes each channel with its owned UTC schedule atomically", async () => {
    const database = await openDatabase();
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
    const pointIds = ["new-channel-start", "new-channel-end"];
    const repository = new ControllerConfigurationRepository(database, {
      nowMs: () => 100,
      schedulePointIdGenerator: () => {
        const id = pointIds.shift();
        if (id === undefined) {
          throw new Error("Unexpected schedule point ID request");
        }
        return id;
      },
    });

    await expect(
      repository.createChannel({
        expectedRevision: 0,
        id: "channel-new",
        name: "New channel",
        color: "#13a4c7",
        typeKey: "light",
        throttleId: "throttle-light",
        displayOrder: 0,
        enabled: true,
      }),
    ).resolves.toMatchObject({ changed: true, revision: 1 });
    await expect(
      database
        .selectFrom("schedules")
        .select([
          "id",
          "channel_id",
          "name",
          "timezone",
          "enabled",
          "graph_revision",
        ])
        .where("channel_id", "=", "channel-new")
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({
      id: "channel-new",
      channel_id: "channel-new",
      name: "New channel",
      timezone: "UTC",
      enabled: 1,
      graph_revision: 0,
    });
    await expect(
      database
        .selectFrom("schedule_points")
        .select([
          "id",
          "position",
          "minute_of_day",
          "percentage",
          "created_at_ms",
          "updated_at_ms",
        ])
        .where("schedule_id", "=", "channel-new")
        .orderBy("position", "asc")
        .execute(),
    ).resolves.toEqual([
      {
        id: "new-channel-start",
        position: 0,
        minute_of_day: 0,
        percentage: 0,
        created_at_ms: 100,
        updated_at_ms: 100,
      },
      {
        id: "new-channel-end",
        position: 1,
        minute_of_day: 1_439,
        percentage: 0,
        created_at_ms: 100,
        updated_at_ms: 100,
      },
    ]);

    await expect(
      repository.replaceSchedule("channel-new", {
        expectedRevision: 1,
        points: [
          {
            id: "point-start",
            position: 0,
            minuteOfDay: 0,
            percentage: 25,
            editorX: null,
            editorY: null,
          },
          {
            id: "point-end",
            position: 1,
            minuteOfDay: 1_439,
            percentage: 25,
            editorX: null,
            editorY: null,
          },
        ],
      }),
    ).resolves.toMatchObject({ changed: true, revision: 2 });
    await expect(
      repository.deleteChannel("channel-new", 2),
    ).resolves.toMatchObject({ changed: true, revision: 3 });
    await expect(
      database
        .selectFrom("channels")
        .select("id")
        .where("id", "=", "channel-new")
        .executeTakeFirst(),
    ).resolves.toBeUndefined();
    await expect(
      database
        .selectFrom("schedules")
        .select("id")
        .where("channel_id", "=", "channel-new")
        .executeTakeFirst(),
    ).resolves.toBeUndefined();
  });

  it("updates a channel name and color atomically with its schedule name", async () => {
    const database = await openDatabase();
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
    const repository = new ControllerConfigurationRepository(database, {
      nowMs: () => 100,
    });

    await repository.createChannel({
      expectedRevision: 0,
      id: "channel-blue",
      name: "Blue",
      color: "#13a4c7",
      typeKey: "light",
      throttleId: "throttle-light",
      displayOrder: 0,
      enabled: true,
    });
    await expect(
      repository.updateChannel("channel-blue", {
        expectedRevision: 1,
        name: "Ocean blue",
        color: "#3c66db",
      }),
    ).resolves.toMatchObject({ changed: true, revision: 2 });
    await expect(
      database
        .selectFrom("channels")
        .select(["name", "color", "updated_at_ms"])
        .where("id", "=", "channel-blue")
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({
      name: "Ocean blue",
      color: "#3c66db",
      updated_at_ms: 100,
    });
    await expect(
      database
        .selectFrom("schedules")
        .select(["name", "updated_at_ms"])
        .where("channel_id", "=", "channel-blue")
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ name: "Ocean blue", updated_at_ms: 100 });
    await expect(
      repository.updateChannel("channel-blue", {
        expectedRevision: 2,
        name: "Ocean blue",
        color: "#3c66db",
      }),
    ).resolves.toEqual({ changed: false, revision: 2, event: null });
  });

  it("reports every schedule graph problem before writing state", async () => {
    const database = await openDatabase();
    const repository = new ControllerConfigurationRepository(database, {
      nowMs: () => 100,
    });

    let failure: ConfigurationValidationError | undefined;
    try {
      await repository.replaceSchedule("channel-light", {
        expectedRevision: 0,
        points: [
          {
            id: "point-a",
            position: 1,
            minuteOfDay: 1,
            percentage: 0,
            editorX: null,
            editorY: null,
          },
          {
            id: "point-b",
            position: 3,
            minuteOfDay: 1,
            percentage: 100,
            editorX: null,
            editorY: null,
          },
        ],
      });
    } catch (error) {
      if (error instanceof ConfigurationValidationError) failure = error;
      else throw error;
    }

    expect(failure?.issues.map((issue) => issue.code)).toEqual([
      "non_contiguous_position",
      "non_contiguous_position",
      "zero-duration",
      "start-not-midnight",
      "end-not-final-minute",
      "wrap-discontinuity",
    ]);
    expect(await readCurrentStateRevision(database)).toBe(0);
  });

  it("enforces global prefix overlap case-sensitively and survives reopening", async () => {
    const directory = await mkdtemp(join(tmpdir(), "aquarium-configuration-"));
    temporaryDirectories.add(directory);
    const filename = join(directory, "state.sqlite");
    let database = await openDatabase(filename);
    let repository = new ControllerConfigurationRepository(database, {
      nowMs: () => 100,
    });

    await repository.replaceMappingProfile("profile-primary", {
      expectedRevision: 0,
      name: "Primary",
      deviceNamePrefix: "Tank",
      outputGain: 1,
      mappings: [],
    });
    await repository.replaceMappingProfile("profile-lowercase", {
      expectedRevision: 1,
      name: "primary",
      deviceNamePrefix: "tank",
      outputGain: 1,
      mappings: [],
    });
    await expect(
      repository.replaceMappingProfile("profile-overlap", {
        expectedRevision: 2,
        name: "Overlap",
        deviceNamePrefix: "Tank-A",
        outputGain: 1,
        mappings: [],
      }),
    ).rejects.toBeInstanceOf(ConfigurationRelationalConflictError);
    expect(await readCurrentStateRevision(database)).toBe(2);

    await closeDatabase(database);
    database = await openDatabase(filename);
    repository = new ControllerConfigurationRepository(database);
    await expect(
      database
        .selectFrom("mapping_profiles")
        .select(["id", "name", "device_name_prefix"])
        .orderBy("id")
        .execute(),
    ).resolves.toEqual([
      {
        id: "profile-lowercase",
        name: "primary",
        device_name_prefix: "tank",
      },
      {
        id: "profile-primary",
        name: "Primary",
        device_name_prefix: "Tank",
      },
    ]);
    await expect(repository.listAlertRules()).resolves.toEqual({ items: [] });
  });

  it("deletes a mapping profile and atomically detaches its devices", async () => {
    const database = await openDatabase();
    await database
      .insertInto("mapping_profiles")
      .values([
        {
          id: "profile-main",
          name: "Main",
          device_name_prefix: "Main",
          output_gain: 0.7,
          created_at_ms: 1,
          updated_at_ms: 1,
        },
        {
          id: "profile-other",
          name: "Other",
          device_name_prefix: "Other",
          output_gain: 1,
          created_at_ms: 1,
          updated_at_ms: 1,
        },
      ])
      .execute();
    await database
      .insertInto("outputs")
      .values({
        id: "output-main",
        name: "Main output",
        kind: "light",
        display_order: 0,
        output_gain: 1,
        created_at_ms: 1,
        updated_at_ms: 1,
      })
      .executeTakeFirstOrThrow();
    await database
      .insertInto("pin_mappings")
      .values({
        id: "mapping-main",
        mapping_profile_id: "profile-main",
        output_id: "output-main",
        channel_id: null,
        pin: 4,
        display_order: 0,
        enabled: 1,
        created_at_ms: 1,
        updated_at_ms: 1,
      })
      .executeTakeFirstOrThrow();
    await database
      .insertInto("devices")
      .values([
        {
          id: "device-main-a",
          hardware_id: "hardware-main-a",
          name: "MainA",
          mapping_profile_id: "profile-main",
          desired_pwm_frequency_hz: 5_000,
          desired_pwm_resolution_bits: 8,
          created_at_ms: 1,
          updated_at_ms: 1,
        },
        {
          id: "device-main-b",
          hardware_id: "hardware-main-b",
          name: "MainB",
          mapping_profile_id: "profile-main",
          desired_pwm_frequency_hz: 5_000,
          desired_pwm_resolution_bits: 8,
          created_at_ms: 1,
          updated_at_ms: 1,
        },
        {
          id: "device-other",
          hardware_id: "hardware-other",
          name: "Other",
          mapping_profile_id: "profile-other",
          desired_pwm_frequency_hz: 5_000,
          desired_pwm_resolution_bits: 8,
          created_at_ms: 1,
          updated_at_ms: 1,
        },
        {
          id: "device-unmapped",
          hardware_id: "hardware-unmapped",
          name: "Unmapped",
          mapping_profile_id: null,
          desired_pwm_frequency_hz: 5_000,
          desired_pwm_resolution_bits: 8,
          created_at_ms: 1,
          updated_at_ms: 1,
        },
      ])
      .execute();
    const repository = new ControllerConfigurationRepository(database, {
      nowMs: () => 100,
    });

    await expect(
      repository.deleteMappingProfile("profile-main", 1),
    ).rejects.toBeInstanceOf(ConfigurationRevisionConflictError);
    await expect(
      database
        .selectFrom("mapping_profiles")
        .select("id")
        .where("id", "=", "profile-main")
        .executeTakeFirst(),
    ).resolves.toEqual({ id: "profile-main" });
    await expect(
      database
        .selectFrom("devices")
        .select("mapping_profile_id")
        .where("id", "=", "device-main-a")
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ mapping_profile_id: "profile-main" });

    const deleted = await repository.deleteMappingProfile("profile-main", 0);
    expect(deleted).toMatchObject({
      changed: true,
      revision: 1,
      event: {
        type: "mapping_profile.deleted",
        entity: { type: "mapping_profile", id: "profile-main" },
        data: {
          invalidations: [{ resource: "mapping_profile", id: "profile-main" }],
        },
      },
    });
    await expect(
      database
        .selectFrom("mapping_profiles")
        .select("id")
        .orderBy("id")
        .execute(),
    ).resolves.toEqual([{ id: "profile-other" }]);
    await expect(
      database
        .selectFrom("pin_mappings")
        .select("id")
        .where("mapping_profile_id", "=", "profile-main")
        .execute(),
    ).resolves.toEqual([]);
    await expect(
      database
        .selectFrom("devices")
        .select(["id", "mapping_profile_id", "updated_at_ms"])
        .orderBy("id")
        .execute(),
    ).resolves.toEqual([
      {
        id: "device-main-a",
        mapping_profile_id: null,
        updated_at_ms: 100,
      },
      {
        id: "device-main-b",
        mapping_profile_id: null,
        updated_at_ms: 100,
      },
      {
        id: "device-other",
        mapping_profile_id: "profile-other",
        updated_at_ms: 1,
      },
      {
        id: "device-unmapped",
        mapping_profile_id: null,
        updated_at_ms: 1,
      },
    ]);
    const snapshot = await new ControllerSnapshotRepository(database, {
      now: () => new Date(100),
    }).read();
    expect(snapshot.mappingProfiles.map((profile) => profile.id)).toEqual([
      "profile-other",
    ]);
    expect(
      snapshot.devices
        .filter((device) => device.id.startsWith("device-main"))
        .map((device) => device.mappingProfileId),
    ).toEqual([null, null]);
    expect(await readCurrentStateRevision(database)).toBe(1);
  });

  it("blocks active-rule changes and preserves recovered alert history", async () => {
    const database = await openDatabase();
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
    const repository = new ControllerConfigurationRepository(database, {
      nowMs: () => 100,
    });
    await repository.createAlertRule({
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
    });
    await database
      .insertInto("active_alerts")
      .values({
        id: "alert-offline",
        alert_rule_id: "rule-offline",
        deduplication_key: "device-main",
        state: "open",
        opened_at_ms: 50,
        last_observed_at_ms: 50,
        acknowledged_at_ms: null,
        recovered_at_ms: null,
        details_json: null,
        details_schema_version: null,
      })
      .executeTakeFirstOrThrow();

    await expect(
      repository.patchAlertRule("rule-offline", {
        expectedRevision: 1,
        enabled: false,
      }),
    ).rejects.toBeInstanceOf(ConfigurationRelationalConflictError);
    await expect(
      repository.deleteAlertRule("rule-offline", 1),
    ).rejects.toBeInstanceOf(ConfigurationRelationalConflictError);
    expect(await readCurrentStateRevision(database)).toBe(1);

    await database
      .updateTable("active_alerts")
      .set({ state: "recovered", recovered_at_ms: 75 })
      .where("id", "=", "alert-offline")
      .executeTakeFirstOrThrow();
    await expect(
      repository.patchAlertRule("rule-offline", {
        expectedRevision: 1,
        enabled: false,
      }),
    ).resolves.toMatchObject({ changed: true, revision: 2 });
    await expect(
      repository.deleteAlertRule("rule-offline", 2),
    ).rejects.toBeInstanceOf(ConfigurationRelationalConflictError);
    expect(await readCurrentStateRevision(database)).toBe(2);
  });

  it("rejects a compiled mapping-profile schedule above the wire limit", async () => {
    const database = await openDatabase();
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
    await database
      .insertInto("mapping_profiles")
      .values({
        id: "profile-large",
        name: "Large",
        device_name_prefix: "Large",
        output_gain: 1,
        created_at_ms: 0,
        updated_at_ms: 0,
      })
      .executeTakeFirstOrThrow();
    const indexes = Array.from({ length: 64 }, (_, index) => index);
    await database
      .insertInto("channels")
      .values(
        indexes.map((index) => ({
          id: `channel-${index}`,
          name: `Channel ${index}`,
          kind: "light",
          throttle_id: "throttle-light",
          display_order: index,
          enabled: 1 as const,
          created_at_ms: 0,
          updated_at_ms: 0,
        })),
      )
      .execute();
    await database
      .insertInto("schedules")
      .values(
        indexes.map((index) => ({
          id: `schedule-${index}`,
          channel_id: `channel-${index}`,
          name: `Schedule ${index}`,
          timezone: "UTC" as const,
          enabled: 1 as const,
          graph_revision: 0,
          created_at_ms: 0,
          updated_at_ms: 0,
        })),
      )
      .execute();
    await database
      .insertInto("schedule_points")
      .values(
        indexes.flatMap((index) =>
          [0, 720, 1_439].map((minute, position) => ({
            id: `point-${index}-${position}`,
            schedule_id: `schedule-${index}`,
            position,
            minute_of_day: minute,
            percentage: position === 1 ? 100 : 0,
            editor_x: null,
            editor_y: null,
            created_at_ms: 0,
            updated_at_ms: 0,
          })),
        ),
      )
      .execute();
    await database
      .insertInto("pin_mappings")
      .values(
        indexes.map((index) => ({
          id: `mapping-${index}`,
          mapping_profile_id: "profile-large",
          output_id: null,
          channel_id: `channel-${index}`,
          pin: index,
          display_order: index,
          enabled: 1 as const,
          created_at_ms: 0,
          updated_at_ms: 0,
        })),
      )
      .execute();
    const repository = new ControllerConfigurationRepository(database, {
      nowMs: () => 100,
    });

    await expect(
      repository.replaceSchedule("channel-0", {
        expectedRevision: 0,
        points: [
          {
            id: "point-0-0",
            position: 0,
            minuteOfDay: 0,
            percentage: 0,
            editorX: null,
            editorY: null,
          },
          {
            id: "point-0-1",
            position: 1,
            minuteOfDay: 720,
            percentage: 99,
            editorX: null,
            editorY: null,
          },
          {
            id: "point-0-2",
            position: 2,
            minuteOfDay: 1_439,
            percentage: 0,
            editorX: null,
            editorY: null,
          },
        ],
      }),
    ).rejects.toMatchObject({
      issues: [{ path: ["points"], code: "schedule_capacity" }],
    });
    expect(await readCurrentStateRevision(database)).toBe(0);
  });
});
