import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve, sep } from "node:path";

import {
  CURRENT_ESP_FIRMWARE_VERSION,
  legacyScheduleDocumentSchema,
  serializeLegacyScheduleCore,
} from "@aquarium/esp-protocol";
import type { Kysely } from "kysely";
import { afterEach, describe, expect, it } from "vitest";

import {
  DEVICE_OPERATION_REQUEST_SCHEMA_VERSION,
  DEVICE_OPERATION_RESULT_SCHEMA_VERSION,
  deviceOperationRequestSchema,
  deviceOperationResultSchema,
  type DeviceOperationResult,
} from "../operations/device-operation-types.js";
import { compileDeviceScheduleArtifact } from "./schedule-artifact-compiler.js";
import { ScheduleReconciliationService } from "./schedule-reconciliation-service.js";
import type {
  DeviceScheduleOperationPort,
  ScheduleDeliveryOperation,
} from "./types.js";
import { openStateDatabase } from "../../infrastructure/database/connection.js";
import { DeviceScheduleArtifactRepository } from "../../infrastructure/database/device-schedule-artifact-repository.js";
import type { StateDatabaseSchema } from "../../infrastructure/database/types.js";

const NOW_MS = 1_752_192_000_000;
const openDatabases = new Set<Kysely<StateDatabaseSchema>>();
const temporaryDirectories = new Set<string>();

afterEach(async () => {
  await Promise.all(
    [...openDatabases].map(async (database) => {
      await database.destroy();
      openDatabases.delete(database);
    }),
  );
  const safeRoot = `${resolve(tmpdir())}${sep}`;
  for (const directory of temporaryDirectories) {
    const resolved = resolve(directory);
    if (
      !resolved.startsWith(safeRoot) ||
      !basename(resolved).startsWith("aquarium-schedule-artifact-")
    ) {
      throw new Error(`Refusing to remove unexpected directory ${resolved}`);
    }
    await rm(resolved, { recursive: true, force: true });
    temporaryDirectories.delete(directory);
  }
});

describe("schedule artifact affected-device projection", () => {
  it("selects every independent normalized-state trigger deterministically", async () => {
    const database = await createDatabase();
    await seedNormalizedState(database);
    const repository = new DeviceScheduleArtifactRepository(database);

    await expect(
      repository.selectAffectedDeviceIds({ kind: "startup" }),
    ).resolves.toEqual(["device-a", "device-b", "device-c"]);
    await expect(
      repository.selectAffectedDeviceIds({
        kind: "mapping_profile",
        mappingProfileId: "profile-main",
      }),
    ).resolves.toEqual(["device-a", "device-b"]);
    for (const trigger of [
      { kind: "channel", channelId: "channel-light" } as const,
      { kind: "schedule", scheduleId: "schedule-light" } as const,
      { kind: "schedule_point", schedulePointId: "light-mid" } as const,
      { kind: "throttle", throttleId: "throttle-light" } as const,
    ]) {
      await expect(
        repository.selectAffectedDeviceIds(trigger),
      ).resolves.toEqual(["device-a", "device-b", "device-c"]);
    }
    await expect(
      repository.selectAffectedDeviceIds({
        kind: "device_configuration",
        deviceId: "device-a",
      }),
    ).resolves.toEqual(["device-a"]);
    await expect(
      repository.selectAffectedDeviceIds({
        kind: "announcement",
        deviceId: "device-a",
      }),
    ).resolves.toEqual(["device-a"]);

    const projection = await repository.loadProjection("device-a");
    if (projection === null) throw new Error("Missing device projection");
    const compiled = compileDeviceScheduleArtifact(projection);
    await repository.saveCompiledArtifact({
      deviceId: "device-a",
      sourceStateRevision: projection.sourceStateRevision,
      artifact: compiled,
      delivery: noDelivery(),
      nowMs: NOW_MS,
    });
    await database
      .updateTable("devices")
      .set({ reported_schedule_hash: compiled.desiredScheduleHash })
      .where("id", "=", "device-a")
      .executeTakeFirstOrThrow();
    await expect(
      repository.selectAffectedDeviceIds({
        kind: "announcement",
        deviceId: "device-a",
      }),
    ).resolves.toEqual(["device-a"]);
  });
});

describe("ScheduleReconciliationService", () => {
  it("dispatches current syncTime, stores the core hash, and persists across restart", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "aquarium-schedule-artifact-"),
    );
    temporaryDirectories.add(directory);
    const filename = join(directory, "state.sqlite");
    let database = await createDatabase(filename);
    await seedNormalizedState(database);
    let repository = new DeviceScheduleArtifactRepository(database);
    const operations = new RecordingScheduleOperations(database);
    const service = new ScheduleReconciliationService(repository, operations, {
      nowMs: () => NOW_MS,
    });

    await expect(
      service.reconcileDevice("device-a", {
        kind: "schedule",
        scheduleId: "schedule-light",
      }),
    ).resolves.toMatchObject({
      outcome: "delivered",
      operationId: "schedule-op-1",
    });
    const request = operations.requests[0];
    if (request === undefined) throw new Error("Schedule was not dispatched");
    const document = legacyScheduleDocumentSchema.parse(
      JSON.parse(request.scheduleJson),
    );
    expect(document.syncTime).toBe(1_752_192_000);
    expect(request.scheduleJson.endsWith(',"syncTime":1752192000}')).toBe(true);

    const storedBeforeRestart = await repository.getArtifact("device-a");
    expect(storedBeforeRestart).toMatchObject({
      sourceStateRevision: 1,
      compileStatus: "succeeded",
      delivery: { status: "succeeded", operationId: "schedule-op-1" },
    });
    if (storedBeforeRestart?.compileStatus !== "succeeded") {
      throw new Error("Expected compiled schedule artifact");
    }
    expect(storedBeforeRestart.payloadJson).toBe(
      serializeLegacyScheduleCore({ c: document.c }),
    );
    expect(storedBeforeRestart.payloadJson).not.toContain("syncTime");
    expect(storedBeforeRestart.byteCount).toBe(
      new TextEncoder().encode(storedBeforeRestart.payloadJson).byteLength,
    );

    await closeDatabase(database);
    database = await createDatabase(filename);
    repository = new DeviceScheduleArtifactRepository(database);
    expect(await repository.getArtifact("device-a")).toEqual(
      storedBeforeRestart,
    );
    const operationsAfterRestart = new RecordingScheduleOperations(database);
    const restarted = new ScheduleReconciliationService(
      repository,
      operationsAfterRestart,
      { nowMs: () => NOW_MS + 1_000 },
    );
    await expect(
      restarted.reconcileDevice("device-a", { kind: "startup" }),
    ).resolves.toMatchObject({ outcome: "coalesced" });
    expect(operationsAfterRestart.requests).toEqual([]);
  });

  it("rejects a schedule timestamp beyond the firmware signed-long range", async () => {
    const database = await createDatabase();
    await seedNormalizedState(database);
    const repository = new DeviceScheduleArtifactRepository(database);
    const operations = new RecordingScheduleOperations(database);
    const service = new ScheduleReconciliationService(repository, operations, {
      nowMs: () => 2_147_483_648_000,
    });

    await expect(
      service.reconcileDevice("device-a", { kind: "startup" }),
    ).rejects.toThrow(/signed-32-bit/);
    expect(operations.requests).toEqual([]);
  });

  it("treats reported hash equality as a delivery no-op", async () => {
    const database = await createDatabase();
    await seedNormalizedState(database);
    const repository = new DeviceScheduleArtifactRepository(database);
    const projection = await repository.loadProjection("device-a");
    if (projection === null) throw new Error("Missing device projection");
    const desired = compileDeviceScheduleArtifact(projection);
    await database
      .updateTable("devices")
      .set({ reported_schedule_hash: desired.desiredScheduleHash })
      .where("id", "=", "device-a")
      .executeTakeFirstOrThrow();
    const operations = new RecordingScheduleOperations(database);
    const service = new ScheduleReconciliationService(repository, operations, {
      nowMs: () => NOW_MS,
    });

    await expect(
      service.reconcileDevice("device-a", {
        kind: "announcement",
        deviceId: "device-a",
      }),
    ).resolves.toMatchObject({
      outcome: "hash_match",
      desiredScheduleHash: desired.desiredScheduleHash,
      operationId: null,
    });
    expect(operations.requests).toEqual([]);
    await expect(repository.getArtifact("device-a")).resolves.toMatchObject({
      delivery: { status: "not_required", operationId: null },
    });
  });

  it.each(["0", "1", "2w", "3.2w", "5.0.0"])(
    "marks non-current firmware %s explicitly unsupported",
    async (firmwareVersion) => {
      const database = await createDatabase();
      await seedNormalizedState(database);
      await database
        .updateTable("devices")
        .set({ firmware_version: firmwareVersion })
        .where("id", "=", "device-a")
        .executeTakeFirstOrThrow();
      const repository = new DeviceScheduleArtifactRepository(database);
      const operations = new RecordingScheduleOperations(database);
      const service = new ScheduleReconciliationService(
        repository,
        operations,
        {
          nowMs: () => NOW_MS,
        },
      );

      await expect(
        service.reconcileDevice("device-a", {
          kind: "announcement",
          deviceId: "device-a",
        }),
      ).resolves.toMatchObject({ outcome: "unsupported", operationId: null });
      expect(operations.requests).toEqual([]);
      await expect(repository.getArtifact("device-a")).resolves.toMatchObject({
        compileStatus: "succeeded",
        delivery: {
          status: "unsupported",
          operationId: null,
          errorCode: "firmware_outdated",
        },
      });
    },
  );

  it("records response mismatch without converting it into a blind retry", async () => {
    const database = await createDatabase();
    await seedNormalizedState(database);
    const repository = new DeviceScheduleArtifactRepository(database);
    const operations = new RecordingScheduleOperations(database, [
      {
        status: "failed",
        wireOperationId: "wire-mismatch",
        code: "response_mismatch",
        message: "Schedule response was partial or mismatched",
      },
    ]);
    const service = new ScheduleReconciliationService(repository, operations, {
      nowMs: () => NOW_MS,
    });

    await expect(
      service.reconcileDevice("device-a", {
        kind: "schedule",
        scheduleId: "schedule-light",
      }),
    ).resolves.toMatchObject({ outcome: "delivery_failed" });
    await expect(repository.getArtifact("device-a")).resolves.toMatchObject({
      delivery: {
        status: "failed",
        errorCode: "response_mismatch",
        errorMessage: "Schedule response was partial or mismatched",
      },
    });
    await expect(
      service.reconcileDevice("device-a", {
        kind: "device_configuration",
        deviceId: "device-a",
      }),
    ).resolves.toMatchObject({ outcome: "coalesced" });
    expect(operations.requests).toHaveLength(1);
  });

  it("preserves outcome-unknown across a superseding configuration", async () => {
    const database = await createDatabase();
    await seedNormalizedState(database);
    const repository = new DeviceScheduleArtifactRepository(database);
    const operations = new RecordingScheduleOperations(database, [
      {
        status: "outcome_unknown",
        wireOperationId: "wire-unknown",
        reason: "timeout",
        reconciledAtMs: null,
      },
    ]);
    const service = new ScheduleReconciliationService(repository, operations, {
      nowMs: () => NOW_MS,
    });

    await expect(
      service.reconcileDevice("device-a", {
        kind: "schedule",
        scheduleId: "schedule-light",
      }),
    ).resolves.toMatchObject({ outcome: "delivery_outcome_unknown" });
    await database
      .updateTable("schedule_points")
      .set({ percentage: 40, updated_at_ms: NOW_MS })
      .where("id", "=", "light-mid")
      .executeTakeFirstOrThrow();
    await insertRevision(database, 2, "Superseding schedule");

    await expect(
      service.reconcileDevice("device-a", {
        kind: "schedule",
        scheduleId: "schedule-light",
      }),
    ).resolves.toMatchObject({
      outcome: "blocked_unknown",
      operationId: "schedule-op-1",
    });
    expect(operations.requests).toHaveLength(1);
    await expect(repository.getArtifact("device-a")).resolves.toMatchObject({
      sourceStateRevision: 2,
      delivery: {
        status: "outcome_unknown",
        operationId: "schedule-op-1",
      },
    });
  });

  it("serializes per-device work and coalesces queued superseded requests", async () => {
    const database = await createDatabase();
    await seedNormalizedState(database);
    const repository = new DeviceScheduleArtifactRepository(database);
    const operations = new RecordingScheduleOperations(database);
    operations.blockFirstOperation();
    const service = new ScheduleReconciliationService(repository, operations, {
      nowMs: () => NOW_MS,
    });
    const first = service.reconcileDevice("device-a", {
      kind: "schedule",
      scheduleId: "schedule-light",
    });
    await operations.firstOperationStarted;

    await database
      .updateTable("schedule_points")
      .set({ percentage: 40, updated_at_ms: NOW_MS })
      .where("id", "=", "light-mid")
      .executeTakeFirstOrThrow();
    await insertRevision(database, 2, "Newer schedule");
    const second = service.reconcileDevice("device-a", {
      kind: "schedule",
      scheduleId: "schedule-light",
    });
    const third = service.reconcileDevice("device-a", {
      kind: "schedule",
      scheduleId: "schedule-light",
    });
    operations.releaseFirstOperation();

    await expect(Promise.all([first, second, third])).resolves.toMatchObject([
      { outcome: "delivered" },
      { outcome: "delivered" },
      { outcome: "coalesced" },
    ]);
    expect(operations.requests).toHaveLength(2);
    expect(operations.requests[0]?.scheduleJson).not.toBe(
      operations.requests[1]?.scheduleJson,
    );
    await expect(repository.getArtifact("device-a")).resolves.toMatchObject({
      sourceStateRevision: 2,
      delivery: { status: "succeeded", operationId: "schedule-op-2" },
    });
  });
});

class RecordingScheduleOperations implements DeviceScheduleOperationPort {
  readonly requests: {
    readonly deviceId: string;
    readonly scheduleJson: string;
  }[] = [];
  readonly reconciledOperationIds: string[] = [];
  readonly firstOperationStarted: Promise<void>;
  readonly #results: DeviceOperationResult[];
  readonly #firstStarted: () => void;
  #firstGate: Promise<void> | null = null;
  #releaseFirst: (() => void) | null = null;

  constructor(
    private readonly database: Kysely<StateDatabaseSchema>,
    results: readonly DeviceOperationResult[] = [],
  ) {
    this.#results = [...results];
    let firstStarted: (() => void) | undefined;
    this.firstOperationStarted = new Promise((resolveStarted) => {
      firstStarted = resolveStarted;
    });
    if (firstStarted === undefined) {
      throw new Error("Failed to initialize operation start signal");
    }
    this.#firstStarted = firstStarted;
  }

  blockFirstOperation(): void {
    this.#firstGate = new Promise((resolveGate) => {
      this.#releaseFirst = resolveGate;
    });
  }

  releaseFirstOperation(): void {
    if (this.#releaseFirst === null) {
      throw new Error("First operation is not blocked");
    }
    this.#releaseFirst();
    this.#releaseFirst = null;
  }

  async executeDeviceOperation(
    deviceId: string,
    request: { readonly kind: "schedule"; readonly scheduleJson: string },
  ): Promise<ScheduleDeliveryOperation> {
    const parsedRequest = deviceOperationRequestSchema.parse(request);
    if (parsedRequest.kind !== "schedule") {
      throw new Error("Expected a schedule operation request");
    }
    const callNumber = this.requests.length + 1;
    this.requests.push({ deviceId, scheduleJson: parsedRequest.scheduleJson });
    if (callNumber === 1) {
      this.#firstStarted();
      await this.#firstGate;
    }
    const result = deviceOperationResultSchema.parse(
      this.#results.shift() ?? {
        status: "succeeded",
        wireOperationId: `wire-${callNumber}`,
        analogValue: null,
      },
    );
    const operationId = `schedule-op-${callNumber}`;
    const requestedAtMs = NOW_MS + callNumber;
    await this.database
      .insertInto("control_operations")
      .values({
        id: operationId,
        device_id: deviceId,
        kind: "schedule",
        status: result.status,
        requested_at_ms: requestedAtMs,
        deadline_at_ms: requestedAtMs + 1_000,
        completed_at_ms: requestedAtMs + 1,
        request_json: JSON.stringify(parsedRequest),
        request_schema_version: DEVICE_OPERATION_REQUEST_SCHEMA_VERSION,
        result_json: JSON.stringify(result),
        result_schema_version: DEVICE_OPERATION_RESULT_SCHEMA_VERSION,
      })
      .executeTakeFirstOrThrow();
    return { id: operationId, status: result.status, result };
  }

  async acknowledgeScheduleReconciledOutcome(
    operationId: string,
  ): Promise<void> {
    this.reconciledOperationIds.push(operationId);
  }
}

async function createDatabase(
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

async function seedNormalizedState(
  database: Kysely<StateDatabaseSchema>,
): Promise<void> {
  await database
    .insertInto("mapping_profiles")
    .values([
      {
        id: "profile-main",
        name: "Main",
        device_name_prefix: "Main",
        output_gain: 1,
        created_at_ms: 0,
        updated_at_ms: 0,
      },
      {
        id: "profile-secondary",
        name: "Secondary",
        device_name_prefix: "Secondary",
        output_gain: 1,
        created_at_ms: 0,
        updated_at_ms: 0,
      },
    ])
    .execute();
  await database
    .insertInto("devices")
    .values([
      deviceRow("device-a", "profile-main"),
      deviceRow("device-b", "profile-main"),
      deviceRow("device-c", "profile-secondary"),
      { ...deviceRow("device-disabled", "profile-main"), enabled: 0 as const },
      deviceRow("device-unmapped", null),
    ])
    .execute();
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
        id: "throttle-pump",
        type_key: "pump",
        percentage: 100,
        created_at_ms: 0,
        updated_at_ms: 0,
      },
    ])
    .execute();
  await database
    .insertInto("channels")
    .values([
      {
        id: "channel-light",
        name: "Light",
        kind: "light",
        throttle_id: "throttle-light",
        display_order: 0,
        enabled: 1,
        created_at_ms: 0,
        updated_at_ms: 0,
      },
      {
        id: "channel-pump",
        name: "Pump",
        kind: "pump",
        throttle_id: "throttle-pump",
        display_order: 1,
        enabled: 1,
        created_at_ms: 0,
        updated_at_ms: 0,
      },
    ])
    .execute();
  await database
    .insertInto("schedules")
    .values([
      {
        id: "schedule-light",
        channel_id: "channel-light",
        name: "Light",
        timezone: "UTC",
        enabled: 1,
        graph_revision: 1,
        created_at_ms: 0,
        updated_at_ms: 0,
      },
      {
        id: "schedule-pump",
        channel_id: "channel-pump",
        name: "Pump",
        timezone: "UTC",
        enabled: 1,
        graph_revision: 1,
        created_at_ms: 0,
        updated_at_ms: 0,
      },
    ])
    .execute();
  await database
    .insertInto("schedule_points")
    .values([
      pointRow("light-start", "schedule-light", 0, 0, 0),
      pointRow("light-mid", "schedule-light", 1, 360, 50),
      pointRow("light-end", "schedule-light", 2, 1_439, 0),
      pointRow("pump-start", "schedule-pump", 0, 0, 25),
      pointRow("pump-end", "schedule-pump", 1, 1_439, 25),
    ])
    .execute();
  await database
    .insertInto("pin_mappings")
    .values([
      mappingRow("mapping-main-light", "profile-main", "channel-light", 4, 0),
      mappingRow("mapping-main-pump", "profile-main", "channel-pump", 12, 1),
      mappingRow(
        "mapping-secondary-light",
        "profile-secondary",
        "channel-light",
        8,
        0,
      ),
    ])
    .execute();
  await insertRevision(database, 1, "Seed normalized schedule state");
}

function deviceRow(deviceId: string, mappingProfileId: string | null) {
  return {
    id: deviceId,
    hardware_id: `${deviceId}-hardware`,
    name: deviceId,
    mapping_profile_id: mappingProfileId,
    reported_name: deviceId,
    desired_pwm_frequency_hz: 1_000,
    desired_pwm_resolution_bits: 8,
    reported_pwm_frequency_hz: 1_000,
    reported_pwm_resolution_bits: 8,
    firmware_version: CURRENT_ESP_FIRMWARE_VERSION,
    reported_schedule_hash: "0",
    status: "online" as const,
    last_seen_at_ms: 0,
    enabled: 1 as const,
    created_at_ms: 0,
    updated_at_ms: 0,
  };
}

function pointRow(
  id: string,
  scheduleId: string,
  position: number,
  minuteOfDay: number,
  percentage: number,
) {
  return {
    id,
    schedule_id: scheduleId,
    position,
    minute_of_day: minuteOfDay,
    percentage,
    editor_x: null,
    editor_y: null,
    created_at_ms: 0,
    updated_at_ms: 0,
  };
}

function mappingRow(
  id: string,
  profileId: string,
  channelId: string,
  pin: number,
  displayOrder: number,
) {
  return {
    id,
    mapping_profile_id: profileId,
    output_id: null,
    channel_id: channelId,
    pin,
    display_order: displayOrder,
    enabled: 1 as const,
    created_at_ms: 0,
    updated_at_ms: 0,
  };
}

async function insertRevision(
  database: Kysely<StateDatabaseSchema>,
  expectedRevision: number,
  summary: string,
): Promise<void> {
  const inserted = await database
    .insertInto("state_revisions")
    .values({
      committed_at_ms: NOW_MS + expectedRevision,
      actor: "test",
      mutation_type: "test.schedule",
      summary,
    })
    .returning("revision")
    .executeTakeFirstOrThrow();
  expect(inserted.revision).toBe(expectedRevision);
}

function noDelivery() {
  return {
    status: "not_required" as const,
    operationId: null,
    errorCode: null,
    errorMessage: null,
  };
}
