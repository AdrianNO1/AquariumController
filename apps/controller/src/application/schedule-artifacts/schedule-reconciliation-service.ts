import {
  identifierSchema,
  nonnegativeSafeIntegerSchema,
} from "@aquarium/contracts";
import {
  CURRENT_ESP_FIRMWARE_VERSION,
  LEGACY_MAX_SYNC_TIME,
  isCurrentEspFirmwareVersion,
  serializeLegacyScheduleDocument,
} from "@aquarium/esp-protocol";

import {
  assertDeviceOperationResultMatchesRequest,
  deviceOperationResultSchema,
} from "../operations/device-operation-types.js";
import {
  ScheduleArtifactCompilationError,
  compileDeviceScheduleArtifact,
  type CompiledScheduleArtifactWithCore,
} from "./schedule-artifact-compiler.js";
import type {
  CompiledDeviceScheduleArtifact,
  DeviceScheduleArtifactStore,
  DeviceScheduleOperationPort,
  DeviceScheduleReconciliationResult,
  ScheduleArtifactDeliveryState,
  ScheduleReconciliationBatchResult,
  ScheduleReconciliationTrigger,
  StoredDeviceScheduleArtifact,
} from "./types.js";

export interface ScheduleReconciliationServiceOptions {
  readonly nowMs?: () => number;
}

export class ScheduleReconciliationService {
  readonly #nowMs: () => number;
  readonly #deviceTails = new Map<
    string,
    Promise<DeviceScheduleReconciliationResult>
  >();

  constructor(
    private readonly artifacts: DeviceScheduleArtifactStore,
    private readonly operations: DeviceScheduleOperationPort,
    options: ScheduleReconciliationServiceOptions = {},
  ) {
    this.#nowMs = options.nowMs ?? Date.now;
  }

  async reconcile(
    trigger: ScheduleReconciliationTrigger,
  ): Promise<ScheduleReconciliationBatchResult> {
    const deviceIds = await this.artifacts.selectAffectedDeviceIds(trigger);
    const devices = await Promise.all(
      deviceIds.map((deviceId) => this.reconcileDevice(deviceId, trigger)),
    );
    return { trigger, devices };
  }

  reconcileDevice(
    rawDeviceId: string,
    trigger: ScheduleReconciliationTrigger,
  ): Promise<DeviceScheduleReconciliationResult> {
    const deviceId = identifierSchema.parse(rawDeviceId);
    const prior = this.#deviceTails.get(deviceId);
    const queuedBehindActiveWork = prior !== undefined;
    const task =
      prior === undefined
        ? this.reconcileDeviceNow(deviceId, trigger, false)
        : prior.then(
            () =>
              this.reconcileDeviceNow(
                deviceId,
                trigger,
                queuedBehindActiveWork,
              ),
            () =>
              this.reconcileDeviceNow(
                deviceId,
                trigger,
                queuedBehindActiveWork,
              ),
          );
    this.#deviceTails.set(deviceId, task);
    void task.then(
      () => this.removeTail(deviceId, task),
      () => this.removeTail(deviceId, task),
    );
    return task;
  }

  private async reconcileDeviceNow(
    deviceId: string,
    trigger: ScheduleReconciliationTrigger,
    queuedBehindActiveWork: boolean,
  ): Promise<DeviceScheduleReconciliationResult> {
    const projection = await this.artifacts.loadProjection(deviceId);
    if (projection === null) {
      return {
        deviceId,
        outcome: "not_mapped",
        desiredScheduleHash: null,
        operationId: null,
      };
    }
    const nowMs = checkedNow(this.#nowMs());
    let compiled: CompiledScheduleArtifactWithCore;
    try {
      compiled = compileDeviceScheduleArtifact(projection);
    } catch (error) {
      const failure =
        error instanceof ScheduleArtifactCompilationError
          ? error
          : new ScheduleArtifactCompilationError(
              "invalid_projection",
              error instanceof Error ? error.message : String(error),
            );
      await this.artifacts.saveCompilationFailure({
        deviceId,
        sourceStateRevision: projection.sourceStateRevision,
        errorCode: failure.code,
        errorMessage: failure.message,
        nowMs,
      });
      return {
        deviceId,
        outcome: "compile_failed",
        desiredScheduleHash: null,
        operationId: null,
      };
    }

    const artifact = persistedArtifact(compiled);
    const [existing, unresolved] = await Promise.all([
      this.artifacts.getArtifact(deviceId),
      this.artifacts.findUnresolvedDelivery(deviceId),
    ]);
    if (unresolved !== null) {
      const delivery: ScheduleArtifactDeliveryState = {
        status: unresolved.status,
        operationId: unresolved.operationId,
        errorCode: unresolved.errorCode,
        errorMessage: unresolved.errorMessage,
      };
      await this.artifacts.saveCompiledArtifact({
        deviceId,
        sourceStateRevision: projection.sourceStateRevision,
        artifact,
        delivery,
        nowMs,
      });
      return {
        deviceId,
        outcome:
          unresolved.status === "outcome_unknown"
            ? "blocked_unknown"
            : "coalesced",
        desiredScheduleHash: compiled.desiredScheduleHash,
        operationId: unresolved.operationId,
      };
    }

    if (
      projection.firmwareVersion !== null &&
      !isCurrentEspFirmwareVersion(projection.firmwareVersion)
    ) {
      await this.artifacts.saveCompiledArtifact({
        deviceId,
        sourceStateRevision: projection.sourceStateRevision,
        artifact,
        delivery: {
          status: "unsupported",
          operationId: null,
          errorCode: "firmware_outdated",
          errorMessage: `Firmware ${projection.firmwareVersion} is outdated; install ${CURRENT_ESP_FIRMWARE_VERSION}`,
        },
        nowMs,
      });
      return {
        deviceId,
        outcome: "unsupported",
        desiredScheduleHash: compiled.desiredScheduleHash,
        operationId: null,
      };
    }

    if (projection.firmwareVersion === null) {
      await this.persistNoDelivery(
        projection.sourceStateRevision,
        artifact,
        deviceId,
        nowMs,
      );
      return {
        deviceId,
        outcome: "awaiting_announcement",
        desiredScheduleHash: compiled.desiredScheduleHash,
        operationId: null,
      };
    }

    if (projection.reportedScheduleHash === compiled.desiredScheduleHash) {
      await this.persistNoDelivery(
        projection.sourceStateRevision,
        artifact,
        deviceId,
        nowMs,
      );
      return {
        deviceId,
        outcome: "hash_match",
        desiredScheduleHash: compiled.desiredScheduleHash,
        operationId: null,
      };
    }

    if (
      existing?.compileStatus === "succeeded" &&
      existing.desiredScheduleHash === compiled.desiredScheduleHash &&
      (queuedBehindActiveWork || trigger.kind !== "announcement")
    ) {
      await this.artifacts.saveCompiledArtifact({
        deviceId,
        sourceStateRevision: projection.sourceStateRevision,
        artifact,
        delivery: existing.delivery,
        nowMs,
      });
      return {
        deviceId,
        outcome:
          existing.delivery.status === "outcome_unknown"
            ? "blocked_unknown"
            : "coalesced",
        desiredScheduleHash: compiled.desiredScheduleHash,
        operationId: existing.delivery.operationId,
      };
    }

    const scheduleRequest = {
      kind: "schedule" as const,
      scheduleJson: serializeLegacyScheduleDocument(
        compiled.core,
        currentEpochSeconds(nowMs),
      ),
    };
    const operation = await this.operations.executeDeviceOperation(
      deviceId,
      scheduleRequest,
    );
    const result = deviceOperationResultSchema.parse(operation.result);
    if (operation.status !== result.status) {
      throw new Error(
        `Schedule operation ${operation.id} status does not match its result`,
      );
    }
    assertDeviceOperationResultMatchesRequest(scheduleRequest, result);
    const delivery = deliveryFromOperation(operation.id, result);
    const saved = await this.artifacts.saveCompiledArtifact({
      deviceId,
      sourceStateRevision: projection.sourceStateRevision,
      artifact,
      delivery,
      nowMs: checkedNow(this.#nowMs()),
    });
    if (
      saved.compileStatus !== "succeeded" ||
      saved.desiredScheduleHash !== compiled.desiredScheduleHash
    ) {
      return {
        deviceId,
        outcome: "coalesced",
        desiredScheduleHash: compiled.desiredScheduleHash,
        operationId: operation.id,
      };
    }
    return {
      deviceId,
      outcome: reconciliationOutcome(result.status),
      desiredScheduleHash: compiled.desiredScheduleHash,
      operationId: operation.id,
    };
  }

  private persistNoDelivery(
    sourceStateRevision: number,
    artifact: CompiledDeviceScheduleArtifact,
    deviceId: string,
    nowMs: number,
  ): Promise<StoredDeviceScheduleArtifact> {
    return this.artifacts.saveCompiledArtifact({
      deviceId,
      sourceStateRevision,
      artifact,
      delivery: {
        status: "not_required",
        operationId: null,
        errorCode: null,
        errorMessage: null,
      },
      nowMs,
    });
  }

  private removeTail(
    deviceId: string,
    task: Promise<DeviceScheduleReconciliationResult>,
  ): void {
    if (this.#deviceTails.get(deviceId) === task) {
      this.#deviceTails.delete(deviceId);
    }
  }
}

function persistedArtifact(
  compiled: CompiledScheduleArtifactWithCore,
): CompiledDeviceScheduleArtifact {
  return {
    payloadJson: compiled.payloadJson,
    payloadSchemaVersion: compiled.payloadSchemaVersion,
    byteCount: compiled.byteCount,
    desiredScheduleHash: compiled.desiredScheduleHash,
  };
}

function checkedNow(nowMs: number): number {
  return nonnegativeSafeIntegerSchema.parse(nowMs);
}

function currentEpochSeconds(nowMs: number): number {
  const seconds = Math.floor(nowMs / 1_000);
  if (seconds < 1 || seconds > LEGACY_MAX_SYNC_TIME) {
    throw new RangeError(
      "Schedule syncTime must be a positive signed-32-bit epoch second",
    );
  }
  return seconds;
}

function deliveryFromOperation(
  operationId: string,
  result: ReturnType<typeof deviceOperationResultSchema.parse>,
): ScheduleArtifactDeliveryState {
  identifierSchema.parse(operationId);
  switch (result.status) {
    case "succeeded":
      return {
        status: "succeeded",
        operationId,
        errorCode: null,
        errorMessage: null,
      };
    case "failed":
      return {
        status: "failed",
        operationId,
        errorCode: result.code,
        errorMessage: result.message,
      };
    case "timed_out":
      return {
        status: "timed_out",
        operationId,
        errorCode: "schedule_delivery_timed_out",
        errorMessage: `Schedule delivery timed out: ${result.reason}`,
      };
    case "outcome_unknown":
      return {
        status: "outcome_unknown",
        operationId,
        errorCode: "schedule_delivery_outcome_unknown",
        errorMessage: `Schedule delivery outcome is unknown: ${result.reason}`,
      };
    case "cancelled":
      return {
        status: "failed",
        operationId,
        errorCode: "schedule_delivery_cancelled",
        errorMessage: `Schedule delivery was cancelled: ${result.reason}`,
      };
  }
}

function reconciliationOutcome(
  status: ReturnType<typeof deviceOperationResultSchema.parse>["status"],
): Extract<
  DeviceScheduleReconciliationResult,
  { readonly operationId: string }
>["outcome"] {
  switch (status) {
    case "succeeded":
      return "delivered";
    case "timed_out":
      return "delivery_timed_out";
    case "outcome_unknown":
      return "delivery_outcome_unknown";
    case "failed":
    case "cancelled":
      return "delivery_failed";
  }
}
