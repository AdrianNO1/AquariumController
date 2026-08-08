import {
  CURRENT_ESP_FIRMWARE_VERSION,
  ESP_FIRMWARE_ARTIFACT,
} from "@aquarium/esp-protocol";
import type { Kysely } from "kysely";
import { afterEach, describe, expect, it } from "vitest";

import {
  openStateDatabase,
  readCurrentStateRevision,
  type StateDatabaseSchema,
} from "../../infrastructure/database/index.js";
import type { StoredDeviceOperation } from "../../infrastructure/database/control-operation-repository.js";
import type {
  DeviceOperationExecutionOptions,
  DeviceOperationRequest,
} from "../operations/index.js";
import {
  FirmwareUpdateService,
  type FirmwareUpdateOperationPort,
} from "./firmware-update-service.js";

const openDatabases = new Set<Kysely<StateDatabaseSchema>>();

afterEach(async () => {
  await Promise.all(
    [...openDatabases].map(async (database) => {
      await database.destroy();
      openDatabases.delete(database);
    }),
  );
});

describe("FirmwareUpdateService", () => {
  it("waits for outputs to turn off, dispatches the approved artifact, and follows OTA telemetry", async () => {
    const database = await createDatabase();
    await seedDevice(database, {
      id: "device-a",
      firmwareVersion: "6.0.0-beta.1",
      outputsOff: false,
    });
    const operations = new RecordingFirmwareOperations(database);
    const service = createService(database, operations);

    await service.requestDeviceUpdate("device-a", {
      expectedRevision: 0,
      mode: "when_off",
    });
    await service.drain();

    await expect(readUpdate(database, "device-a")).resolves.toMatchObject({
      mode: "when_off",
      status: "waiting_for_off",
      operation_id: null,
    });
    expect(operations.requests).toEqual([]);

    await setOutputState(database, "device-a", true);
    await service.signalDeviceAnnouncement("device-a");

    expect(operations.requests).toEqual([
      {
        deviceId: "device-a",
        request: {
          kind: "firmware_update",
          version: CURRENT_ESP_FIRMWARE_VERSION,
          url: "http://controller.local:3000/api/firmware/esp32/current.bin",
          size: ESP_FIRMWARE_ARTIFACT.sizeBytes,
          sha256: ESP_FIRMWARE_ARTIFACT.sha256,
        },
        options: { priority: "interactive" },
      },
    ]);
    await expect(readUpdate(database, "device-a")).resolves.toMatchObject({
      status: "accepted",
      operation_id: "firmware-operation-1",
    });

    await setOtaState(database, "device-a", {
      status: "downloading",
      targetVersion: CURRENT_ESP_FIRMWARE_VERSION,
      progress: 60,
    });
    await service.signalDeviceAnnouncement("device-a");
    await expect(readUpdate(database, "device-a")).resolves.toMatchObject({
      status: "downloading",
      progress: 60,
    });

    await database
      .updateTable("devices")
      .set({ firmware_version: CURRENT_ESP_FIRMWARE_VERSION })
      .where("id", "=", "device-a")
      .executeTakeFirstOrThrow();
    await service.signalDeviceAnnouncement("device-a");
    await expect(readUpdate(database, "device-a")).resolves.toMatchObject({
      status: "succeeded",
      progress: 100,
    });
  });

  it("requires one USB bootstrap for legacy firmware without dispatching OTA", async () => {
    const database = await createDatabase();
    await seedDevice(database, {
      id: "legacy-device",
      firmwareVersion: "4.2.1",
      outputsOff: true,
    });
    const operations = new RecordingFirmwareOperations(database);
    const service = createService(database, operations);

    await service.requestDeviceUpdate("legacy-device", {
      expectedRevision: 0,
      mode: "immediate",
    });
    await service.drain();

    await expect(readUpdate(database, "legacy-device")).resolves.toMatchObject({
      status: "usb_required",
      operation_id: null,
    });
    expect(operations.requests).toEqual([]);
  });

  it("does not retry a reported OTA failure until an operator explicitly requests it", async () => {
    const database = await createDatabase();
    await seedDevice(database, {
      id: "device-a",
      firmwareVersion: "6.0.0-beta.1",
      outputsOff: true,
    });
    const operations = new RecordingFirmwareOperations(database);
    const service = createService(database, operations);

    await service.requestDeviceUpdate("device-a", {
      expectedRevision: 0,
      mode: "immediate",
    });
    await service.drain();
    await setOtaState(database, "device-a", {
      status: "failed",
      targetVersion: CURRENT_ESP_FIRMWARE_VERSION,
      progress: 0,
      error: "sha256_mismatch",
    });
    await service.signalDeviceAnnouncement("device-a");

    await expect(readUpdate(database, "device-a")).resolves.toMatchObject({
      status: "failed",
      error_message: "sha256_mismatch",
    });
    await service.signalDeviceAnnouncement("device-a");
    expect(operations.requests).toHaveLength(1);

    await service.requestDeviceUpdate("device-a", {
      expectedRevision: await readCurrentStateRevision(database),
      mode: "immediate",
    });
    await service.drain();

    expect(operations.requests).toHaveLength(2);
    await expect(readUpdate(database, "device-a")).resolves.toMatchObject({
      status: "accepted",
      operation_id: "firmware-operation-2",
      error_message: null,
    });
  });

  it("keeps update-all active for an outdated ESP discovered later", async () => {
    const database = await createDatabase();
    await seedDevice(database, {
      id: "current-device",
      firmwareVersion: CURRENT_ESP_FIRMWARE_VERSION,
      outputsOff: true,
    });
    const operations = new RecordingFirmwareOperations(database);
    const service = createService(database, operations);

    await service.requestFleetUpdate({
      expectedRevision: 0,
      mode: "when_off",
    });
    await service.drain();
    await seedDevice(database, {
      id: "late-device",
      firmwareVersion: "6.0.0-beta.1",
      outputsOff: true,
    });
    await service.signalDeviceAnnouncement("late-device");

    await expect(
      database
        .selectFrom("firmware_rollout_policy")
        .selectAll()
        .executeTakeFirstOrThrow(),
    ).resolves.toMatchObject({
      enabled: 1,
      mode: "when_off",
      target_version: CURRENT_ESP_FIRMWARE_VERSION,
    });
    expect(operations.requests.map(({ deviceId }) => deviceId)).toEqual([
      "late-device",
    ]);
    await expect(readUpdate(database, "late-device")).resolves.toMatchObject({
      status: "accepted",
      mode: "when_off",
    });
  });

  it("defers devices discovered after an immediate fleet request until their outputs are off", async () => {
    const database = await createDatabase();
    const operations = new RecordingFirmwareOperations(database);
    const service = createService(database, operations);

    await service.requestFleetUpdate({
      expectedRevision: 0,
      mode: "immediate",
      transitionSeconds: 7,
    });
    await service.drain();
    await seedDevice(database, {
      id: "late-running-device",
      firmwareVersion: "6.0.1",
      outputsOff: false,
    });
    await service.signalDeviceAnnouncement("late-running-device");

    await expect(
      readUpdate(database, "late-running-device"),
    ).resolves.toMatchObject({
      mode: "when_off",
      transition_seconds: 7,
      status: "waiting_for_off",
    });
    expect(operations.requests).toEqual([]);

  });

  it("requires USB for firmware 5 in both fleet and per-device requests", async () => {
    const database = await createDatabase();
    await seedDevice(database, {
      id: "legacy-ota-device",
      firmwareVersion: "5.0.6",
      outputsOff: true,
    });
    const operations = new RecordingFirmwareOperations(database);
    const service = createService(database, operations);

    await service.requestFleetUpdate({
      expectedRevision: 0,
      mode: "immediate",
    });
    await service.drain();
    await expect(
      readUpdate(database, "legacy-ota-device"),
    ).resolves.toMatchObject({ status: "usb_required" });
    expect(operations.requests).toHaveLength(0);

    await service.requestDeviceUpdate("legacy-ota-device", {
      expectedRevision: await readCurrentStateRevision(database),
      mode: "immediate",
    });
    await service.drain();
    expect(operations.requests).toHaveLength(0);
    await expect(
      readUpdate(database, "legacy-ota-device"),
    ).resolves.toMatchObject({ status: "usb_required" });
  });
});

class RecordingFirmwareOperations implements FirmwareUpdateOperationPort {
  readonly #database: Kysely<StateDatabaseSchema>;
  readonly requests: Array<{
    readonly deviceId: string;
    readonly request: Extract<
      DeviceOperationRequest,
      { kind: "firmware_update" }
    >;
    readonly options: DeviceOperationExecutionOptions | undefined;
  }> = [];

  constructor(database: Kysely<StateDatabaseSchema>) {
    this.#database = database;
  }

  async executeDeviceOperation(
    deviceId: string,
    request: Extract<DeviceOperationRequest, { kind: "firmware_update" }>,
    options?: DeviceOperationExecutionOptions,
  ): Promise<StoredDeviceOperation> {
    this.requests.push({ deviceId, request, options });
    const operationId = `firmware-operation-${this.requests.length}`;
    const result = {
      status: "succeeded" as const,
      wireOperationId: operationId,
      analogValue: null,
    };
    await this.#database
      .insertInto("control_operations")
      .values({
        id: operationId,
        device_id: deviceId,
        kind: "firmware_update",
        status: "succeeded",
        requested_at_ms: 1,
        deadline_at_ms: 2,
        completed_at_ms: 2,
        request_json: JSON.stringify(request),
        request_schema_version: 1,
        result_json: JSON.stringify(result),
        result_schema_version: 1,
      })
      .executeTakeFirstOrThrow();
    return {
      id: operationId,
      deviceId,
      kind: "firmware_update",
      status: "succeeded",
      requestedAtMs: 1,
      deadlineAtMs: 2,
      completedAtMs: 2,
      request,
      result,
    };
  }
}

async function createDatabase(): Promise<Kysely<StateDatabaseSchema>> {
  const database = await openStateDatabase({ filename: ":memory:" });
  openDatabases.add(database);
  return database;
}

function createService(
  database: Kysely<StateDatabaseSchema>,
  operations: FirmwareUpdateOperationPort,
): FirmwareUpdateService {
  let nowMs = 1_752_192_000_000;
  const service = new FirmwareUpdateService(database, operations, {
    artifact: {
      version: ESP_FIRMWARE_ARTIFACT.version,
      sizeBytes: ESP_FIRMWARE_ARTIFACT.sizeBytes,
      sha256: ESP_FIRMWARE_ARTIFACT.sha256,
      url: "http://controller.local:3000/api/firmware/esp32/current.bin",
    },
    now: () => nowMs++,
    onBackgroundError: (error) => {
      throw error;
    },
  });
  service.start();
  return service;
}

async function seedDevice(
  database: Kysely<StateDatabaseSchema>,
  input: {
    readonly id: string;
    readonly firmwareVersion: string;
    readonly outputsOff: boolean;
  },
): Promise<void> {
  await database
    .insertInto("devices")
    .values({
      id: input.id,
      hardware_id: input.id.toUpperCase(),
      name: input.id,
      mapping_profile_id: null,
      reported_name: input.id,
      desired_pwm_frequency_hz: 5_000,
      desired_pwm_resolution_bits: 8,
      reported_pwm_frequency_hz: 5_000,
      reported_pwm_resolution_bits: 8,
      firmware_version: input.firmwareVersion,
      reported_schedule_hash: "0",
      output_state_json: JSON.stringify({
        outputsOff: input.outputsOff,
        outputs: [],
      }),
      ota_status_json: null,
      status: "online",
      last_seen_at_ms: 1,
      last_error_code: null,
      last_error_message: null,
      enabled: 1,
      created_at_ms: 1,
      updated_at_ms: 1,
      metadata_json: null,
      metadata_schema_version: null,
    })
    .executeTakeFirstOrThrow();
}

async function setOutputState(
  database: Kysely<StateDatabaseSchema>,
  deviceId: string,
  outputsOff: boolean,
): Promise<void> {
  await database
    .updateTable("devices")
    .set({
      output_state_json: JSON.stringify({ outputsOff, outputs: [] }),
    })
    .where("id", "=", deviceId)
    .executeTakeFirstOrThrow();
}

async function setOtaState(
  database: Kysely<StateDatabaseSchema>,
  deviceId: string,
  state: {
    readonly status: "downloading" | "failed";
    readonly targetVersion: string;
    readonly progress: number;
    readonly error?: string;
  },
): Promise<void> {
  await database
    .updateTable("devices")
    .set({ ota_status_json: JSON.stringify(state) })
    .where("id", "=", deviceId)
    .executeTakeFirstOrThrow();
}

async function readUpdate(
  database: Kysely<StateDatabaseSchema>,
  deviceId: string,
) {
  return database
    .selectFrom("firmware_update_requests")
    .selectAll()
    .where("device_id", "=", deviceId)
    .executeTakeFirstOrThrow();
}
