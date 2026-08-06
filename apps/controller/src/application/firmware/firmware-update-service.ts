import {
  mutationResultSchema,
  requestFirmwareUpdateSchema,
  type MutationResult,
  type RequestFirmwareUpdate,
} from "@aquarium/contracts";
import {
  CURRENT_ESP_FIRMWARE_VERSION,
  MINIMUM_PULL_OTA_FIRMWARE_VERSION,
  requiresLegacyOtaBridge,
  supportsPullOta,
} from "@aquarium/esp-protocol";
import { sql, type Kysely, type Selectable } from "kysely";

import {
  commitConditionalStateChange,
  toCommittedStateEvent,
  type FirmwareUpdateStatus,
  type StateDatabaseSchema,
} from "../../infrastructure/database/index.js";
import {
  ConfigurationNotFoundError,
  ConfigurationRevisionConflictError,
} from "../configuration/index.js";
import type {
  DeviceOperationExecutionOptions,
  DeviceOperationRequest,
} from "../operations/index.js";
import type { StoredDeviceOperation } from "../../infrastructure/database/control-operation-repository.js";

export interface FirmwareArtifact {
  readonly version: string;
  readonly url: string;
  readonly sizeBytes: number;
  readonly sha256: string;
}

export interface FirmwareUpdateOperationPort {
  executeDeviceOperation(
    deviceId: string,
    request: Extract<DeviceOperationRequest, { kind: "firmware_update" }>,
    options?: DeviceOperationExecutionOptions,
  ): Promise<StoredDeviceOperation>;
}

export interface FirmwareUpdateCommandService {
  requestDeviceUpdate(
    deviceId: string,
    request: RequestFirmwareUpdate,
  ): Promise<MutationResult>;
  requestFleetUpdate(request: RequestFirmwareUpdate): Promise<MutationResult>;
}

export interface FirmwareUpdateServiceOptions {
  readonly artifact: FirmwareArtifact;
  readonly now?: () => number;
  readonly onBackgroundError: (error: Error) => void;
}

type DeviceRow = Selectable<StateDatabaseSchema["devices"]>;
type UpdateRow = Selectable<StateDatabaseSchema["firmware_update_requests"]>;
const USB_BOOTSTRAP_MESSAGE =
  `Install firmware ${MINIMUM_PULL_OTA_FIRMWARE_VERSION} or newer once over USB ` +
  "to enable wireless updates";

export class FirmwareUpdateService implements FirmwareUpdateCommandService {
  readonly #database: Kysely<StateDatabaseSchema>;
  readonly #operations: FirmwareUpdateOperationPort;
  readonly #artifact: FirmwareArtifact;
  readonly #now: () => number;
  readonly #onBackgroundError: (error: Error) => void;
  #tail: Promise<void> = Promise.resolve();
  #accepting = false;

  constructor(
    database: Kysely<StateDatabaseSchema>,
    operations: FirmwareUpdateOperationPort,
    options: FirmwareUpdateServiceOptions,
  ) {
    if (options.artifact.version !== CURRENT_ESP_FIRMWARE_VERSION) {
      throw new Error("Firmware artifact version does not match the protocol");
    }
    this.#database = database;
    this.#operations = operations;
    this.#artifact = options.artifact;
    this.#now = options.now ?? Date.now;
    this.#onBackgroundError = options.onBackgroundError;
  }

  start(): void {
    this.#accepting = true;
  }

  stop(): void {
    this.#accepting = false;
  }

  async drain(): Promise<void> {
    await this.#tail;
  }

  async requestDeviceUpdate(
    deviceId: string,
    request: RequestFirmwareUpdate,
  ): Promise<MutationResult> {
    this.#assertAccepting();
    const parsed = requestFirmwareUpdateSchema.parse(request);
    const nowMs = this.#now();
    const committed = await commitConditionalStateChange(
      this.#database,
      {
        actor: "operator.firmware-update",
        mutationType: "firmware.update-requested",
        summary: `Requested firmware ${this.#artifact.version} for device ${deviceId}`,
        eventType: "firmware.update-requested",
        entityType: "device",
        entityId: deviceId,
        occurredAtMs: nowMs,
        retentionClass: "audit",
        payloadJson: JSON.stringify({
          schemaVersion: 1,
          targetVersion: this.#artifact.version,
          mode: parsed.mode,
        }),
        payloadSchemaVersion: 1,
      },
      async (transaction) => {
        const device = await transaction
          .selectFrom("devices")
          .selectAll()
          .where("id", "=", deviceId)
          .executeTakeFirst();
        if (device === undefined) {
          throw new ConfigurationNotFoundError("device", deviceId);
        }
        const status = initialStatus(
          device,
          parsed.mode,
          this.#artifact.version,
          true,
        );
        await transaction
          .insertInto("firmware_update_requests")
          .values({
            device_id: device.id,
            target_version: this.#artifact.version,
            mode: parsed.mode,
            status,
            progress: 0,
            operation_id: null,
            error_message:
              status === "usb_required"
                ? USB_BOOTSTRAP_MESSAGE
                : null,
            requested_at_ms: nowMs,
            updated_at_ms: nowMs,
          })
          .onConflict((conflict) =>
            conflict.column("device_id").doUpdateSet({
              target_version: this.#artifact.version,
              mode: parsed.mode,
              status,
              progress: 0,
              operation_id: null,
              error_message:
                status === "usb_required"
                  ? USB_BOOTSTRAP_MESSAGE
                  : null,
              requested_at_ms: nowMs,
              updated_at_ms: nowMs,
            }),
          )
          .executeTakeFirstOrThrow();
        return { changed: true, result: { deviceId: device.id } };
      },
      undefined,
      {
        expectedRevision: parsed.expectedRevision,
        conflictError: (expectedRevision, currentRevision) =>
          new ConfigurationRevisionConflictError(
            expectedRevision,
            currentRevision,
          ),
      },
    );
    if (!committed.changed) {
      throw new Error(
        "Firmware update request unexpectedly produced no change",
      );
    }
    void this.#schedule(() => this.#reconcileDevice(deviceId));
    return mutationResultSchema.parse({
      changed: true,
      revision: committed.revision,
      event: toCommittedStateEvent(committed.outboxEvent),
    });
  }

  async requestFleetUpdate(
    request: RequestFirmwareUpdate,
  ): Promise<MutationResult> {
    this.#assertAccepting();
    const parsed = requestFirmwareUpdateSchema.parse(request);
    const nowMs = this.#now();
    const committed = await commitConditionalStateChange(
      this.#database,
      {
        actor: "operator.firmware-update",
        mutationType: "firmware.fleet-rollout-requested",
        summary: `Requested firmware ${this.#artifact.version} for every ESP32`,
        eventType: "firmware.fleet-rollout-requested",
        entityType: "controller",
        entityId: null,
        occurredAtMs: nowMs,
        retentionClass: "audit",
        payloadJson: JSON.stringify({
          schemaVersion: 1,
          targetVersion: this.#artifact.version,
          mode: parsed.mode,
        }),
        payloadSchemaVersion: 1,
      },
      async (transaction) => {
        await transaction
          .updateTable("firmware_rollout_policy")
          .set({
            target_version: this.#artifact.version,
            mode: parsed.mode,
            enabled: 1,
            requested_at_ms: nowMs,
            updated_at_ms: nowMs,
          })
          .where("singleton_key", "=", 1)
          .executeTakeFirstOrThrow();
        const devices = await transaction
          .selectFrom("devices")
          .selectAll()
          .where("enabled", "=", 1)
          .execute();
        for (const device of devices) {
          if (device.firmware_version === this.#artifact.version) continue;
          const status = initialStatus(
            device,
            parsed.mode,
            this.#artifact.version,
            false,
          );
          await transaction
            .insertInto("firmware_update_requests")
            .values({
              device_id: device.id,
              target_version: this.#artifact.version,
              mode: parsed.mode,
              status,
              progress: 0,
              operation_id: null,
              error_message:
                status === "usb_required"
                  ? USB_BOOTSTRAP_MESSAGE
                  : null,
              requested_at_ms: nowMs,
              updated_at_ms: nowMs,
            })
            .onConflict((conflict) =>
              conflict.column("device_id").doUpdateSet({
                target_version: this.#artifact.version,
                mode: parsed.mode,
                status,
                progress: 0,
                operation_id: null,
                error_message:
                  status === "usb_required"
                    ? USB_BOOTSTRAP_MESSAGE
                    : null,
                requested_at_ms: nowMs,
                updated_at_ms: nowMs,
              }),
            )
            .executeTakeFirstOrThrow();
        }
        return { changed: true, result: { deviceCount: devices.length } };
      },
      undefined,
      {
        expectedRevision: parsed.expectedRevision,
        conflictError: (expectedRevision, currentRevision) =>
          new ConfigurationRevisionConflictError(
            expectedRevision,
            currentRevision,
          ),
      },
    );
    if (!committed.changed) {
      throw new Error("Fleet firmware request unexpectedly produced no change");
    }
    void this.#schedule(() => this.#reconcileAll());
    return mutationResultSchema.parse({
      changed: true,
      revision: committed.revision,
      event: toCommittedStateEvent(committed.outboxEvent),
    });
  }

  signalDeviceAnnouncement(deviceId: string): Promise<void> {
    if (!this.#accepting) return Promise.resolve();
    return this.#schedule(async () => {
      await this.#ensureFleetRequest(deviceId);
      await this.#reconcileDevice(deviceId);
    });
  }

  #schedule(task: () => Promise<void>): Promise<void> {
    const run = this.#tail.then(task, task);
    this.#tail = run.catch((error) => {
      this.#onBackgroundError(toError(error));
    });
    return this.#tail;
  }

  async #reconcileAll(): Promise<void> {
    const requests = await this.#database
      .selectFrom("firmware_update_requests")
      .select("device_id")
      .where("target_version", "=", this.#artifact.version)
      .execute();
    for (const request of requests) {
      await this.#reconcileDevice(request.device_id);
    }
  }

  async #ensureFleetRequest(deviceId: string): Promise<void> {
    const policy = await this.#database
      .selectFrom("firmware_rollout_policy")
      .selectAll()
      .where("singleton_key", "=", 1)
      .executeTakeFirstOrThrow();
    if (
      policy.enabled !== 1 ||
      policy.target_version !== this.#artifact.version
    ) {
      return;
    }
    const device = await this.#database
      .selectFrom("devices")
      .selectAll()
      .where("id", "=", deviceId)
      .executeTakeFirst();
    if (
      device === undefined ||
      device.enabled !== 1 ||
      device.firmware_version === this.#artifact.version
    ) {
      return;
    }
    const existing = await this.#database
      .selectFrom("firmware_update_requests")
      .selectAll()
      .where("device_id", "=", device.id)
      .executeTakeFirst();
    if (
      existing?.target_version === this.#artifact.version &&
      ["failed", "usb_required"].includes(existing.status)
    ) {
      return;
    }
    if (existing?.target_version === this.#artifact.version) return;

    const nowMs = this.#now();
    const status = initialStatus(
      device,
      policy.mode,
      this.#artifact.version,
      false,
    );
    await commitConditionalStateChange(
      this.#database,
      {
        actor: "runtime.firmware-update",
        mutationType: "firmware.fleet-device-enrolled",
        summary: `Enrolled device ${device.id} in the active firmware rollout`,
        eventType: "firmware.fleet-device-enrolled",
        entityType: "device",
        entityId: device.id,
        occurredAtMs: nowMs,
        retentionClass: "operational",
        payloadJson: JSON.stringify({
          schemaVersion: 1,
          targetVersion: this.#artifact.version,
          mode: policy.mode,
        }),
        payloadSchemaVersion: 1,
      },
      async (transaction) => {
        await transaction
          .insertInto("firmware_update_requests")
          .values({
            device_id: device.id,
            target_version: this.#artifact.version,
            mode: policy.mode,
            status,
            progress: 0,
            operation_id: null,
            error_message:
              status === "usb_required"
                ? USB_BOOTSTRAP_MESSAGE
                : null,
            requested_at_ms: nowMs,
            updated_at_ms: nowMs,
          })
          .onConflict((conflict) => conflict.column("device_id").doNothing())
          .executeTakeFirstOrThrow();
        return { changed: true, result: { deviceId: device.id } };
      },
    );
  }

  async #reconcileDevice(deviceId: string): Promise<void> {
    const record = await this.#readDeviceUpdate(deviceId);
    if (record === null) return;
    const { device, update } = record;
    if (device.firmware_version === update.target_version) {
      await this.#transition(
        update,
        "succeeded",
        100,
        null,
        update.operation_id,
      );
      return;
    }
    if (
      device.firmware_version === null ||
      !supportsPullOta(device.firmware_version)
    ) {
      await this.#transition(
        update,
        "usb_required",
        0,
        USB_BOOTSTRAP_MESSAGE,
        null,
      );
      return;
    }

    const reportedOta = parseReportedOta(device.ota_status_json);
    if (
      update.operation_id !== null &&
      reportedOta !== null &&
      reportedOta.targetVersion === update.target_version &&
      reportedOta.status !== "idle"
    ) {
      if (
        reportedOta.status === "failed" ||
        reportedOta.status === "rolling_back"
      ) {
        await this.#transition(
          update,
          "failed",
          reportedOta.progress,
          reportedOta.error ?? "Firmware rolled back after probation",
          update.operation_id,
        );
        return;
      }
      const status = reportedStatus(reportedOta.status);
      if (status !== null) {
        await this.#transition(
          update,
          status,
          reportedOta.progress,
          null,
          update.operation_id,
        );
        return;
      }
    }
    if (["failed", "usb_required", "succeeded"].includes(update.status)) {
      return;
    }
    if (
      [
        "accepted",
        "downloading",
        "verifying",
        "rebooting",
        "probation",
      ].includes(update.status)
    ) {
      return;
    }
    if (!["online", "error"].includes(device.status)) {
      await this.#transition(
        update,
        "waiting_for_device",
        update.progress,
        null,
        update.operation_id,
      );
      return;
    }
    if (
      update.mode === "when_off" &&
      !reportedOutputsOff(device.output_state_json)
    ) {
      await this.#transition(
        update,
        "waiting_for_off",
        update.progress,
        null,
        update.operation_id,
      );
      return;
    }

    const operation = await this.#operations.executeDeviceOperation(
      device.id,
      {
        kind: "firmware_update",
        version: this.#artifact.version,
        url: this.#artifact.url,
        size: this.#artifact.sizeBytes,
        sha256: this.#artifact.sha256,
      },
      { priority: "interactive" },
    );
    if (operation.status === "succeeded") {
      await this.#transition(update, "accepted", 0, null, operation.id);
      return;
    }
    if (operation.status === "outcome_unknown") {
      await this.#transition(update, "accepted", 0, null, operation.id);
      return;
    }
    if (
      operation.status === "cancelled" ||
      operation.status === "timed_out" ||
      (operation.result?.status === "failed" &&
        ["not_attempted", "transport_unavailable"].includes(
          operation.result.code,
        ))
    ) {
      await this.#transition(update, "pending", 0, null, operation.id);
      return;
    }
    await this.#transition(
      update,
      "failed",
      0,
      `Firmware command ${operation.status.replaceAll("_", " ")}`,
      operation.id,
    );
  }

  async #readDeviceUpdate(deviceId: string): Promise<{
    readonly device: DeviceRow;
    readonly update: UpdateRow;
  } | null> {
    const [device, update] = await Promise.all([
      this.#database
        .selectFrom("devices")
        .selectAll()
        .where("id", "=", deviceId)
        .executeTakeFirst(),
      this.#database
        .selectFrom("firmware_update_requests")
        .selectAll()
        .where("device_id", "=", deviceId)
        .executeTakeFirst(),
    ]);
    return device === undefined || update === undefined
      ? null
      : { device, update };
  }

  async #transition(
    update: UpdateRow,
    status: FirmwareUpdateStatus,
    progress: number,
    errorMessage: string | null,
    operationId: string | null,
  ): Promise<void> {
    if (
      update.status === status &&
      update.progress === progress &&
      update.error_message === errorMessage &&
      update.operation_id === operationId
    ) {
      return;
    }
    const nowMs = this.#now();
    await commitConditionalStateChange(
      this.#database,
      {
        actor: "runtime.firmware-update",
        mutationType: "firmware.update-status",
        summary: `Firmware update for device ${update.device_id} is ${status.replaceAll("_", " ")}`,
        eventType: "firmware.update-status-changed",
        entityType: "device",
        entityId: update.device_id,
        occurredAtMs: nowMs,
        retentionClass: status === "failed" ? "critical" : "operational",
        payloadJson: JSON.stringify({
          schemaVersion: 1,
          targetVersion: update.target_version,
          status,
          progress,
          error: errorMessage,
        }),
        payloadSchemaVersion: 1,
      },
      async (transaction) => {
        const result = await transaction
          .updateTable("firmware_update_requests")
          .set({
            status,
            progress,
            operation_id: operationId,
            error_message: errorMessage,
            updated_at_ms: sql<number>`MAX(updated_at_ms, ${nowMs})`,
          })
          .where("device_id", "=", update.device_id)
          .where("target_version", "=", update.target_version)
          .where("updated_at_ms", "=", update.updated_at_ms)
          .executeTakeFirst();
        return {
          changed: result.numUpdatedRows === 1n,
          result: { deviceId: update.device_id },
        };
      },
    );
  }

  #assertAccepting(): void {
    if (!this.#accepting) {
      throw new Error("Firmware update service is not accepting requests");
    }
  }
}

function initialStatus(
  device: DeviceRow,
  mode: RequestFirmwareUpdate["mode"],
  targetVersion: string,
  allowLegacyOtaBridge: boolean,
): FirmwareUpdateStatus {
  if (device.firmware_version === targetVersion) return "succeeded";
  if (
    device.firmware_version === null ||
    !supportsPullOta(device.firmware_version) ||
    (!allowLegacyOtaBridge &&
      requiresLegacyOtaBridge(device.firmware_version))
  ) {
    return "usb_required";
  }
  if (!["online", "error"].includes(device.status)) {
    return "waiting_for_device";
  }
  if (mode === "when_off" && !reportedOutputsOff(device.output_state_json)) {
    return "waiting_for_off";
  }
  return "pending";
}

function parseReportedOta(source: string | null): {
  readonly status: string;
  readonly targetVersion: string;
  readonly progress: number;
  readonly error?: string;
} | null {
  if (source === null) return null;
  const parsed = JSON.parse(source) as {
    readonly status: string;
    readonly targetVersion: string;
    readonly progress: number;
    readonly error?: string;
  };
  return parsed;
}

function reportedOutputsOff(source: string | null): boolean {
  if (source === null) return false;
  const parsed = JSON.parse(source) as { readonly outputsOff?: boolean };
  return parsed.outputsOff === true;
}

function reportedStatus(status: string): FirmwareUpdateStatus | null {
  switch (status) {
    case "accepted":
    case "downloading":
    case "verifying":
    case "rebooting":
    case "probation":
    case "succeeded":
      return status;
    default:
      return null;
  }
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
