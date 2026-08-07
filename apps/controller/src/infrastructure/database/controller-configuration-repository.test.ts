import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve, sep } from "node:path";

import { NODEMCU_ESP32S_V1_1_HARDWARE_PROFILE_ID } from "@aquarium/contracts";
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
  await database.deleteFrom("throttles").execute();
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

  it("atomically deletes an area with unreferenced channels and schedules", async () => {
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

    await database
      .insertInto("outputs")
      .values({
        id: "output-coral",
        name: "Coral output",
        kind: "coral-tank",
        display_order: 0,
        enabled: 1,
        output_gain: 1,
        created_at_ms: 100,
        updated_at_ms: 100,
      })
      .executeTakeFirstOrThrow();

    await expect(
      repository.deleteControlArea("coral-tank", 2),
    ).resolves.toMatchObject({ changed: true, revision: 3 });
    await expect(
      database
        .selectFrom("channels")
        .select("id")
        .where("id", "=", "channel-coral")
        .executeTakeFirst(),
    ).resolves.toBeUndefined();
    await expect(
      database
        .selectFrom("schedules")
        .select("id")
        .where("channel_id", "=", "channel-coral")
        .executeTakeFirst(),
    ).resolves.toBeUndefined();
    await expect(
      database
        .selectFrom("outputs")
        .select("id")
        .where("id", "=", "output-coral")
        .executeTakeFirst(),
    ).resolves.toBeUndefined();
    expect(await readCurrentStateRevision(database)).toBe(3);
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

  it("allows the same channel name in different control areas only", async () => {
    const database = await openDatabase();
    await database
      .insertInto("throttles")
      .values([
        {
          id: "throttle-light",
          type_key: "light",
          percentage: 100,
          created_at_ms: 0,
          updated_at_ms: 0,
        },
        {
          id: "throttle-qt3",
          type_key: "qt3",
          percentage: 100,
          created_at_ms: 0,
          updated_at_ms: 0,
        },
      ])
      .execute();
    const repository = new ControllerConfigurationRepository(database, {
      nowMs: () => 100,
    });

    await repository.createChannel({
      expectedRevision: 0,
      id: "channel-lights-uv",
      name: "Uv",
      color: "#6f5bd5",
      typeKey: "light",
      throttleId: "throttle-light",
      displayOrder: 0,
      enabled: true,
    });
    await expect(
      repository.createChannel({
        expectedRevision: 1,
        id: "channel-qt3-uv",
        name: "Uv",
        color: "#a747a9",
        typeKey: "qt3",
        throttleId: "throttle-qt3",
        displayOrder: 0,
        enabled: true,
      }),
    ).resolves.toMatchObject({ changed: true, revision: 2 });

    await expect(
      repository.createChannel({
        expectedRevision: 2,
        id: "channel-qt3-uv-duplicate",
        name: "Uv",
        color: "#3c66db",
        typeKey: "qt3",
        throttleId: "throttle-qt3",
        displayOrder: 1,
        enabled: true,
      }),
    ).rejects.toMatchObject({
      conflicts: [
        expect.objectContaining({
          resource: "channel",
          relation: "name",
          message: "Channel name is already in use in this control area",
        }),
      ],
    });
  });

  it("validates a complete channel edit before atomically applying it", async () => {
    const database = await openDatabase();
    await database.deleteFrom("control_areas").execute();
    const repository = new ControllerConfigurationRepository(database, {
      nowMs: () => 100,
    });
    await repository.createControlArea({
      expectedRevision: 0,
      label: "Lights",
    });
    await repository.createChannel({
      expectedRevision: 1,
      id: "channel-blue",
      name: "Blue",
      color: "#13a4c7",
      typeKey: "lights",
      throttleId: "throttle-lights",
      displayOrder: 0,
      enabled: true,
    });
    await repository.createChannel({
      expectedRevision: 2,
      id: "channel-white",
      name: "White",
      color: "#87959e",
      typeKey: "lights",
      throttleId: "throttle-lights",
      displayOrder: 1,
      enabled: true,
    });
    await database
      .insertInto("mapping_profiles")
      .values({
        id: "profile-main",
        name: "Main",
        device_name_prefix: "Main",
        output_gain: 1,
        created_at_ms: 0,
        updated_at_ms: 0,
      })
      .executeTakeFirstOrThrow();
    await database
      .insertInto("pin_mappings")
      .values({
        id: "mapping-white",
        mapping_profile_id: "profile-main",
        output_id: null,
        channel_id: "channel-white",
        pin: 4,
        display_order: 0,
        enabled: 1,
        created_at_ms: 0,
        updated_at_ms: 0,
      })
      .executeTakeFirstOrThrow();

    await expect(
      repository.replaceControlAreaChannels("lights", {
        expectedRevision: 3,
        channels: [
          { id: "channel-blue", name: "Ocean", color: "#3c66db" },
        ],
      }),
    ).rejects.toMatchObject({
      conflicts: [
        expect.objectContaining({
          resource: "pin_mapping",
          relation: "channel",
        }),
      ],
    });
    expect(await readCurrentStateRevision(database)).toBe(3);
    await expect(
      database
        .selectFrom("channels")
        .select(["id", "name"])
        .where("kind", "=", "lights")
        .orderBy("display_order")
        .execute(),
    ).resolves.toEqual([
      { id: "channel-blue", name: "Blue" },
      { id: "channel-white", name: "White" },
    ]);

    await expect(
      repository.replaceControlAreaChannels("lights", {
        expectedRevision: 3,
        channels: [
          { id: "channel-blue", name: "White", color: "#3c66db" },
          { id: "channel-white", name: "Blue", color: "#87959e" },
          { id: "channel-uv", name: "UV", color: "#6f5bd5" },
        ],
      }),
    ).resolves.toMatchObject({ changed: true, revision: 4 });
    expect(await readCurrentStateRevision(database)).toBe(4);
    await expect(
      database
        .selectFrom("channels")
        .select(["id", "name", "display_order"])
        .where("kind", "=", "lights")
        .orderBy("display_order")
        .execute(),
    ).resolves.toEqual([
      { id: "channel-blue", name: "White", display_order: 0 },
      { id: "channel-white", name: "Blue", display_order: 1 },
      { id: "channel-uv", name: "UV", display_order: 2 },
    ]);
  });

  it("saves every changed schedule and its multiplier in one revision", async () => {
    const database = await openDatabase();
    await database.deleteFrom("control_areas").execute();
    const repository = new ControllerConfigurationRepository(database, {
      nowMs: () => 100,
    });
    await repository.createControlArea({
      expectedRevision: 0,
      label: "Lights",
    });
    for (const [index, id] of ["channel-blue", "channel-white"].entries()) {
      await repository.createChannel({
        expectedRevision: index + 1,
        id,
        name: id === "channel-blue" ? "Blue" : "White",
        color: id === "channel-blue" ? "#13a4c7" : "#87959e",
        typeKey: "lights",
        throttleId: "throttle-lights",
        displayOrder: index,
        enabled: true,
      });
    }
    await repository.createControlArea({
      expectedRevision: 3,
      label: "Pumps",
    });
    await repository.createChannel({
      expectedRevision: 4,
      id: "channel-return",
      name: "Return",
      color: "#db5451",
      typeKey: "pumps",
      throttleId: "throttle-pumps",
      displayOrder: 0,
      enabled: true,
    });
    const bluePoints = [
      schedulePoint("blue-start", 0, 0, 25),
      schedulePoint("blue-end", 1, 1_439, 25),
    ];
    await expect(
      repository.replaceControlAreaScheduleConfiguration("lights", {
        expectedRevision: 5,
        schedules: [
          { channelId: "channel-blue", points: bluePoints },
          {
            channelId: "channel-return",
            points: [
              schedulePoint("return-start", 0, 0, 50),
              schedulePoint("return-end", 1, 1_439, 50),
            ],
          },
        ],
        throttlePercentage: 70,
      }),
    ).rejects.toBeInstanceOf(ConfigurationRelationalConflictError);
    expect(await readCurrentStateRevision(database)).toBe(5);
    await expect(
      database
        .selectFrom("throttles")
        .select("percentage")
        .where("id", "=", "throttle-lights")
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ percentage: 100 });
    await expect(
      database
        .selectFrom("schedules")
        .select("graph_revision")
        .where("id", "=", "channel-blue")
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ graph_revision: 0 });

    await expect(
      repository.replaceControlAreaScheduleConfiguration("lights", {
        expectedRevision: 5,
        schedules: [
          { channelId: "channel-blue", points: bluePoints },
          {
            channelId: "channel-white",
            points: [
              schedulePoint("white-start", 0, 0, 40),
              schedulePoint("white-end", 1, 1_439, 40),
            ],
          },
        ],
        throttlePercentage: 70,
      }),
    ).resolves.toMatchObject({ changed: true, revision: 6 });
    await expect(
      database
        .selectFrom("schedules")
        .select(["id", "graph_revision"])
        .where("id", "in", ["channel-blue", "channel-white"])
        .orderBy("id")
        .execute(),
    ).resolves.toEqual([
      { id: "channel-blue", graph_revision: 1 },
      { id: "channel-white", graph_revision: 1 },
    ]);
    await expect(
      database
        .selectFrom("throttles")
        .select("percentage")
        .where("id", "=", "throttle-lights")
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ percentage: 70 });
  });

  it("rolls back the whole area collection when one deletion is invalid", async () => {
    const database = await openDatabase();
    await database.deleteFrom("control_areas").execute();
    const repository = new ControllerConfigurationRepository(database, {
      nowMs: () => 100,
    });
    await repository.createControlArea({
      expectedRevision: 0,
      label: "Lights",
    });
    await repository.createControlArea({
      expectedRevision: 1,
      label: "Pumps",
    });
    await repository.createChannel({
      expectedRevision: 2,
      id: "channel-return",
      name: "Return",
      color: "#13a4c7",
      typeKey: "pumps",
      throttleId: "throttle-pumps",
      displayOrder: 0,
      enabled: true,
    });
    await database
      .insertInto("overrides")
      .values({
        id: "override-return-history",
        channel_id: "channel-return",
        output_id: null,
        value_percentage: 50,
        status: "expired",
        requested_at_ms: 10,
        starts_at_ms: 10,
        expires_at_ms: 20,
        completed_at_ms: 20,
        operation_id: null,
      })
      .executeTakeFirstOrThrow();

    await expect(
      repository.replaceControlAreas({
        expectedRevision: 3,
        areas: [{ slug: "lights", label: "Main lights" }],
      }),
    ).rejects.toBeInstanceOf(ConfigurationRelationalConflictError);
    expect(await readCurrentStateRevision(database)).toBe(3);
    await expect(
      database
        .selectFrom("control_areas")
        .select(["slug", "label"])
        .orderBy("display_order")
        .execute(),
    ).resolves.toEqual([
      { slug: "lights", label: "Lights" },
      { slug: "pumps", label: "Pumps" },
    ]);
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

  it("persists explicitly named hardware mapping profiles across reopening", async () => {
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
      hardwareProfileId: NODEMCU_ESP32S_V1_1_HARDWARE_PROFILE_ID,
      outputGain: 1,
      mappings: [],
    });
    await repository.replaceMappingProfile("profile-lowercase", {
      expectedRevision: 1,
      name: "primary",
      hardwareProfileId: NODEMCU_ESP32S_V1_1_HARDWARE_PROFILE_ID,
      outputGain: 1,
      mappings: [],
    });
    expect(await readCurrentStateRevision(database)).toBe(2);

    await closeDatabase(database);
    database = await openDatabase(filename);
    repository = new ControllerConfigurationRepository(database);
    await expect(
      database
        .selectFrom("mapping_profiles")
        .select(["id", "name", "hardware_profile_id"])
        .orderBy("id")
        .execute(),
    ).resolves.toEqual([
      {
        id: "profile-lowercase",
        name: "primary",
        hardware_profile_id: NODEMCU_ESP32S_V1_1_HARDWARE_PROFILE_ID,
      },
      {
        id: "profile-primary",
        name: "Primary",
        hardware_profile_id: NODEMCU_ESP32S_V1_1_HARDWARE_PROFILE_ID,
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

function schedulePoint(
  id: string,
  position: number,
  minuteOfDay: number,
  percentage: number,
) {
  return {
    id,
    position,
    minuteOfDay,
    percentage,
    editorX: null,
    editorY: null,
  };
}
