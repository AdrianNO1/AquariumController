import type {
  DeviceOperationResult,
  DeviceOperationTerminalStatus,
} from "../operations/device-operation-types.js";

export const DEVICE_SCHEDULE_ARTIFACT_SCHEMA_VERSION = 1;

export type ScheduleReconciliationTrigger =
  | { readonly kind: "startup" }
  | { readonly kind: "channel"; readonly channelId: string }
  | { readonly kind: "schedule"; readonly scheduleId: string }
  | { readonly kind: "schedule_point"; readonly schedulePointId: string }
  | { readonly kind: "throttle"; readonly throttleId: string }
  | { readonly kind: "mapping_profile"; readonly mappingProfileId: string }
  | { readonly kind: "device_configuration"; readonly deviceId: string }
  | { readonly kind: "announcement"; readonly deviceId: string };

export interface NormalizedSchedulePointProjection {
  readonly id: string;
  readonly position: number;
  readonly minuteOfDay: number;
  readonly percentage: number;
}

export interface NormalizedScheduleChannelProjection {
  readonly mappingId: string;
  readonly displayOrder: number;
  readonly pin: number;
  readonly channelId: string;
  readonly channelKind: string;
  readonly throttlePercentage: number;
  readonly points: readonly NormalizedSchedulePointProjection[];
}

export interface DeviceScheduleProjection {
  readonly sourceStateRevision: number;
  readonly deviceId: string;
  readonly firmwareVersion: string | null;
  readonly reportedScheduleHash: string | null;
  readonly channels: readonly NormalizedScheduleChannelProjection[];
}

export interface CompiledDeviceScheduleArtifact {
  readonly payloadJson: string;
  readonly payloadSchemaVersion: typeof DEVICE_SCHEDULE_ARTIFACT_SCHEMA_VERSION;
  readonly byteCount: number;
  readonly desiredScheduleHash: string;
}

export type ScheduleArtifactDeliveryStatus =
  | "not_required"
  | "pending"
  | "in_flight"
  | "succeeded"
  | "failed"
  | "timed_out"
  | "outcome_unknown"
  | "unsupported";

export interface ScheduleArtifactDeliveryState {
  readonly status: ScheduleArtifactDeliveryStatus;
  readonly operationId: string | null;
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
}

export type StoredDeviceScheduleArtifact =
  | {
      readonly deviceId: string;
      readonly sourceStateRevision: number;
      readonly compileStatus: "failed";
      readonly payloadJson: null;
      readonly payloadSchemaVersion: null;
      readonly byteCount: null;
      readonly desiredScheduleHash: null;
      readonly delivery: {
        readonly status: "not_required";
        readonly operationId: null;
        readonly errorCode: null;
        readonly errorMessage: null;
      };
      readonly compileErrorCode: string;
      readonly compileErrorMessage: string;
      readonly compiledAtMs: number;
      readonly deliveryUpdatedAtMs: number;
      readonly createdAtMs: number;
      readonly updatedAtMs: number;
    }
  | {
      readonly deviceId: string;
      readonly sourceStateRevision: number;
      readonly compileStatus: "succeeded";
      readonly payloadJson: string;
      readonly payloadSchemaVersion: number;
      readonly byteCount: number;
      readonly desiredScheduleHash: string;
      readonly delivery: ScheduleArtifactDeliveryState;
      readonly compileErrorCode: null;
      readonly compileErrorMessage: null;
      readonly compiledAtMs: number;
      readonly deliveryUpdatedAtMs: number;
      readonly createdAtMs: number;
      readonly updatedAtMs: number;
    };

export interface PersistCompiledScheduleArtifact {
  readonly deviceId: string;
  readonly sourceStateRevision: number;
  readonly artifact: CompiledDeviceScheduleArtifact;
  readonly delivery: ScheduleArtifactDeliveryState;
  readonly nowMs: number;
}

export interface PersistFailedScheduleArtifact {
  readonly deviceId: string;
  readonly sourceStateRevision: number;
  readonly errorCode: string;
  readonly errorMessage: string;
  readonly nowMs: number;
}

export interface UnresolvedScheduleDelivery {
  readonly operationId: string;
  readonly status: "pending" | "in_flight" | "outcome_unknown";
  readonly errorCode: string | null;
  readonly errorMessage: string | null;
}

export interface DeviceScheduleArtifactStore {
  selectAffectedDeviceIds(
    trigger: ScheduleReconciliationTrigger,
  ): Promise<readonly string[]>;
  loadProjection(deviceId: string): Promise<DeviceScheduleProjection | null>;
  getArtifact(deviceId: string): Promise<StoredDeviceScheduleArtifact | null>;
  saveCompiledArtifact(
    input: PersistCompiledScheduleArtifact,
  ): Promise<StoredDeviceScheduleArtifact>;
  saveCompilationFailure(
    input: PersistFailedScheduleArtifact,
  ): Promise<StoredDeviceScheduleArtifact>;
  findUnresolvedDelivery(
    deviceId: string,
  ): Promise<UnresolvedScheduleDelivery | null>;
}

export type ScheduleOperationStatus =
  DeviceOperationTerminalStatus | "pending" | "in_flight";

export interface ScheduleDeliveryOperation {
  readonly id: string;
  readonly status: ScheduleOperationStatus;
  readonly result: DeviceOperationResult | null;
}

export interface DeviceScheduleOperationPort {
  executeDeviceOperation(
    deviceId: string,
    request: { readonly kind: "schedule"; readonly scheduleJson: string },
  ): Promise<ScheduleDeliveryOperation>;
}

export type DeviceScheduleReconciliationResult =
  | {
      readonly deviceId: string;
      readonly outcome: "not_mapped" | "awaiting_announcement" | "hash_match";
      readonly desiredScheduleHash: string | null;
      readonly operationId: null;
    }
  | {
      readonly deviceId: string;
      readonly outcome: "compile_failed" | "unsupported" | "blocked_unknown";
      readonly desiredScheduleHash: string | null;
      readonly operationId: string | null;
    }
  | {
      readonly deviceId: string;
      readonly outcome: "coalesced";
      readonly desiredScheduleHash: string;
      readonly operationId: string | null;
    }
  | {
      readonly deviceId: string;
      readonly outcome:
        | "delivered"
        | "delivery_failed"
        | "delivery_timed_out"
        | "delivery_outcome_unknown";
      readonly desiredScheduleHash: string;
      readonly operationId: string;
    };

export interface ScheduleReconciliationBatchResult {
  readonly trigger: ScheduleReconciliationTrigger;
  readonly devices: readonly DeviceScheduleReconciliationResult[];
}
