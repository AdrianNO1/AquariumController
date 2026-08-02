import {
  boundedTextSchema,
  canonicalUint32HashSchema,
  hardwareProfileIdSchema,
  identifierSchema,
  nonnegativeSafeIntegerSchema,
} from "@aquarium/contracts";
import {
  calculateLegacyScheduleHash,
  LEGACY_MAX_SYNC_TIME,
  legacyScheduleCoreSchema,
  serializeLegacyScheduleCore,
  serializeLegacyScheduleDocument,
  utf8ByteLength,
} from "@aquarium/esp-protocol";
import { sql, type Kysely, type Selectable, type Transaction } from "kysely";

import {
  DEVICE_OPERATION_REQUEST_SCHEMA_VERSION,
  DEVICE_OPERATION_RESULT_SCHEMA_VERSION,
  deviceOperationRequestSchema,
  deviceOperationResultSchema,
} from "../../application/operations/device-operation-types.js";
import {
  DEVICE_SCHEDULE_ARTIFACT_SCHEMA_VERSION,
  type DeviceScheduleArtifactStore,
  type DeviceScheduleProjection,
  type PersistCompiledScheduleArtifact,
  type PersistFailedScheduleArtifact,
  type ScheduleArtifactDeliveryState,
  type ScheduleReconciliationTrigger,
  type StoredDeviceScheduleArtifact,
  type UnresolvedScheduleDelivery,
} from "../../application/schedule-artifacts/types.js";
import { parseJsonDocument } from "../import/strict-json.js";
import type {
  DeviceScheduleArtifactsTable,
  StateDatabaseSchema,
} from "./types.js";

type StoredArtifactRow = Selectable<DeviceScheduleArtifactsTable>;
type StateTransaction = Transaction<StateDatabaseSchema>;

export class DeviceScheduleArtifactRepository implements DeviceScheduleArtifactStore {
  constructor(private readonly database: Kysely<StateDatabaseSchema>) {}

  async selectAffectedDeviceIds(
    trigger: ScheduleReconciliationTrigger,
  ): Promise<readonly string[]> {
    switch (trigger.kind) {
      case "startup":
        return this.selectMappedDevices();
      case "device_configuration":
        return this.selectOneMappedDevice(trigger.deviceId);
      case "announcement":
        return this.selectOneMappedDevice(trigger.deviceId);
      case "mapping_profile": {
        const mappingProfileId = identifierSchema.parse(
          trigger.mappingProfileId,
        );
        const rows = await this.database
          .selectFrom("devices")
          .select("id")
          .where("enabled", "=", 1)
          .where("mapping_profile_id", "=", mappingProfileId)
          .orderBy("id")
          .execute();
        return rows.map((row) => row.id);
      }
      case "channel": {
        const channelId = identifierSchema.parse(trigger.channelId);
        const rows = await this.database
          .selectFrom("devices")
          .innerJoin(
            "pin_mappings",
            "pin_mappings.mapping_profile_id",
            "devices.mapping_profile_id",
          )
          .select("devices.id")
          .distinct()
          .where("devices.enabled", "=", 1)
          .where("pin_mappings.enabled", "=", 1)
          .where("pin_mappings.channel_id", "=", channelId)
          .orderBy("devices.id")
          .execute();
        return rows.map((row) => row.id);
      }
      case "schedule": {
        const scheduleId = identifierSchema.parse(trigger.scheduleId);
        const rows = await this.database
          .selectFrom("devices")
          .innerJoin(
            "pin_mappings",
            "pin_mappings.mapping_profile_id",
            "devices.mapping_profile_id",
          )
          .innerJoin(
            "schedules",
            "schedules.channel_id",
            "pin_mappings.channel_id",
          )
          .select("devices.id")
          .distinct()
          .where("devices.enabled", "=", 1)
          .where("pin_mappings.enabled", "=", 1)
          .where("schedules.id", "=", scheduleId)
          .orderBy("devices.id")
          .execute();
        return rows.map((row) => row.id);
      }
      case "schedule_point": {
        const schedulePointId = identifierSchema.parse(trigger.schedulePointId);
        const rows = await this.database
          .selectFrom("devices")
          .innerJoin(
            "pin_mappings",
            "pin_mappings.mapping_profile_id",
            "devices.mapping_profile_id",
          )
          .innerJoin(
            "schedules",
            "schedules.channel_id",
            "pin_mappings.channel_id",
          )
          .innerJoin(
            "schedule_points",
            "schedule_points.schedule_id",
            "schedules.id",
          )
          .select("devices.id")
          .distinct()
          .where("devices.enabled", "=", 1)
          .where("pin_mappings.enabled", "=", 1)
          .where("schedule_points.id", "=", schedulePointId)
          .orderBy("devices.id")
          .execute();
        return rows.map((row) => row.id);
      }
      case "throttle": {
        const throttleId = identifierSchema.parse(trigger.throttleId);
        const rows = await this.database
          .selectFrom("devices")
          .innerJoin(
            "pin_mappings",
            "pin_mappings.mapping_profile_id",
            "devices.mapping_profile_id",
          )
          .innerJoin("channels", "channels.id", "pin_mappings.channel_id")
          .select("devices.id")
          .distinct()
          .where("devices.enabled", "=", 1)
          .where("pin_mappings.enabled", "=", 1)
          .where("channels.throttle_id", "=", throttleId)
          .orderBy("devices.id")
          .execute();
        return rows.map((row) => row.id);
      }
    }
  }

  async loadProjection(
    rawDeviceId: string,
  ): Promise<DeviceScheduleProjection | null> {
    const deviceId = identifierSchema.parse(rawDeviceId);
    return this.database.transaction().execute(async (transaction) => {
      const device = await transaction
        .selectFrom("devices")
        .selectAll()
        .where("id", "=", deviceId)
        .executeTakeFirst();
      if (
        device === undefined ||
        device.enabled !== 1 ||
        !["online", "stale", "offline"].includes(device.status) ||
        device.mapping_profile_id === null
      ) {
        return null;
      }
      if (device.firmware_version !== null) {
        boundedTextSchema.parse(device.firmware_version);
      }
      if (device.reported_schedule_hash !== null) {
        canonicalUint32HashSchema.parse(device.reported_schedule_hash);
      }
      const revisionRow = await transaction
        .selectFrom("state_revisions")
        .select("revision")
        .orderBy("revision", "desc")
        .limit(1)
        .executeTakeFirst();
      const mappingProfile = await transaction
        .selectFrom("mapping_profiles")
        .select(["hardware_profile_id", "output_gain"])
        .where("id", "=", device.mapping_profile_id)
        .executeTakeFirstOrThrow();
      const mappings = await transaction
        .selectFrom("pin_mappings")
        .selectAll()
        .where("mapping_profile_id", "=", device.mapping_profile_id)
        .where("enabled", "=", 1)
        .where("channel_id", "is not", null)
        .orderBy("display_order")
        .orderBy("id")
        .execute();
      const channels: DeviceScheduleProjection["channels"][number][] = [];
      for (const mapping of mappings) {
        if (mapping.channel_id === null) {
          throw new Error(`Persisted mapping ${mapping.id} has no channel`);
        }
        const channel = await transaction
          .selectFrom("channels")
          .selectAll()
          .where("id", "=", mapping.channel_id)
          .executeTakeFirstOrThrow();
        if (channel.enabled !== 1) continue;
        const schedule = await transaction
          .selectFrom("schedules")
          .selectAll()
          .where("channel_id", "=", channel.id)
          .executeTakeFirst();
        if (schedule === undefined || schedule.enabled !== 1) continue;
        const [throttle, points] = await Promise.all([
          transaction
            .selectFrom("throttles")
            .selectAll()
            .where("id", "=", channel.throttle_id)
            .executeTakeFirstOrThrow(),
          transaction
            .selectFrom("schedule_points")
            .selectAll()
            .where("schedule_id", "=", schedule.id)
            .orderBy("position")
            .orderBy("id")
            .execute(),
        ]);
        channels.push({
          mappingId: mapping.id,
          displayOrder: mapping.display_order,
          pin: mapping.pin,
          channelId: channel.id,
          channelKind: channel.kind,
          throttlePercentage: throttle.percentage,
          points: points.map((point) => ({
            id: point.id,
            position: point.position,
            minuteOfDay: point.minute_of_day,
            percentage: point.percentage,
          })),
        });
      }
      return {
        sourceStateRevision: revisionRow?.revision ?? 0,
        deviceId: device.id,
        firmwareVersion: device.firmware_version,
        reportedScheduleHash: device.reported_schedule_hash,
        hardwareProfileId: hardwareProfileIdSchema.parse(
          mappingProfile.hardware_profile_id,
        ),
        outputGain: mappingProfile.output_gain,
        channels,
      };
    });
  }

  async getArtifact(
    rawDeviceId: string,
  ): Promise<StoredDeviceScheduleArtifact | null> {
    const deviceId = identifierSchema.parse(rawDeviceId);
    const row = await this.database
      .selectFrom("device_schedule_artifacts")
      .selectAll()
      .where("device_id", "=", deviceId)
      .executeTakeFirst();
    return row === undefined ? null : parseStoredArtifact(row);
  }

  saveCompiledArtifact(
    input: PersistCompiledScheduleArtifact,
  ): Promise<StoredDeviceScheduleArtifact> {
    validateCompiledArtifactInput(input);
    return this.database.transaction().execute(async (transaction) => {
      const existing = await this.readExisting(transaction, input.deviceId);
      if (
        existing !== undefined &&
        existing.source_state_revision > input.sourceStateRevision
      ) {
        return parseStoredArtifact(existing);
      }
      const createdAtMs = existing?.created_at_ms ?? input.nowMs;
      if (input.nowMs < createdAtMs) {
        throw new RangeError("Schedule artifact clock moved backwards");
      }
      await transaction
        .insertInto("device_schedule_artifacts")
        .values({
          device_id: input.deviceId,
          source_state_revision: input.sourceStateRevision,
          compile_status: "succeeded",
          desired_schedule_hash: input.artifact.desiredScheduleHash,
          compiled_payload_json: input.artifact.payloadJson,
          compiled_payload_schema_version: input.artifact.payloadSchemaVersion,
          byte_count: input.artifact.byteCount,
          delivery_status: input.delivery.status,
          last_delivery_operation_id: input.delivery.operationId,
          compile_error_code: null,
          compile_error_message: null,
          delivery_error_code: input.delivery.errorCode,
          delivery_error_message: input.delivery.errorMessage,
          compiled_at_ms: input.nowMs,
          delivery_updated_at_ms: input.nowMs,
          created_at_ms: createdAtMs,
          updated_at_ms: input.nowMs,
        })
        .onConflict((conflict) =>
          conflict.column("device_id").doUpdateSet({
            source_state_revision: input.sourceStateRevision,
            compile_status: "succeeded",
            desired_schedule_hash: input.artifact.desiredScheduleHash,
            compiled_payload_json: input.artifact.payloadJson,
            compiled_payload_schema_version:
              input.artifact.payloadSchemaVersion,
            byte_count: input.artifact.byteCount,
            delivery_status: input.delivery.status,
            last_delivery_operation_id: input.delivery.operationId,
            compile_error_code: null,
            compile_error_message: null,
            delivery_error_code: input.delivery.errorCode,
            delivery_error_message: input.delivery.errorMessage,
            compiled_at_ms: input.nowMs,
            delivery_updated_at_ms: input.nowMs,
            updated_at_ms: input.nowMs,
          }),
        )
        .executeTakeFirstOrThrow();
      const row = await this.readExisting(transaction, input.deviceId);
      if (row === undefined)
        throw new Error("Schedule artifact write was lost");
      return parseStoredArtifact(row);
    });
  }

  saveCompilationFailure(
    input: PersistFailedScheduleArtifact,
  ): Promise<StoredDeviceScheduleArtifact> {
    identifierSchema.parse(input.deviceId);
    nonnegativeSafeIntegerSchema.parse(input.sourceStateRevision);
    nonnegativeSafeIntegerSchema.parse(input.nowMs);
    boundedTextSchema.parse(input.errorCode);
    boundedTextSchema.parse(input.errorMessage);
    return this.database.transaction().execute(async (transaction) => {
      const existing = await this.readExisting(transaction, input.deviceId);
      if (
        existing !== undefined &&
        existing.source_state_revision > input.sourceStateRevision
      ) {
        return parseStoredArtifact(existing);
      }
      const createdAtMs = existing?.created_at_ms ?? input.nowMs;
      if (input.nowMs < createdAtMs) {
        throw new RangeError("Schedule artifact clock moved backwards");
      }
      await transaction
        .insertInto("device_schedule_artifacts")
        .values({
          device_id: input.deviceId,
          source_state_revision: input.sourceStateRevision,
          compile_status: "failed",
          desired_schedule_hash: null,
          compiled_payload_json: null,
          compiled_payload_schema_version: null,
          byte_count: null,
          delivery_status: "not_required",
          last_delivery_operation_id: null,
          compile_error_code: input.errorCode,
          compile_error_message: input.errorMessage,
          delivery_error_code: null,
          delivery_error_message: null,
          compiled_at_ms: input.nowMs,
          delivery_updated_at_ms: input.nowMs,
          created_at_ms: createdAtMs,
          updated_at_ms: input.nowMs,
        })
        .onConflict((conflict) =>
          conflict.column("device_id").doUpdateSet({
            source_state_revision: input.sourceStateRevision,
            compile_status: "failed",
            desired_schedule_hash: null,
            compiled_payload_json: null,
            compiled_payload_schema_version: null,
            byte_count: null,
            delivery_status: "not_required",
            last_delivery_operation_id: null,
            compile_error_code: input.errorCode,
            compile_error_message: input.errorMessage,
            delivery_error_code: null,
            delivery_error_message: null,
            compiled_at_ms: input.nowMs,
            delivery_updated_at_ms: input.nowMs,
            updated_at_ms: input.nowMs,
          }),
        )
        .executeTakeFirstOrThrow();
      const row = await this.readExisting(transaction, input.deviceId);
      if (row === undefined)
        throw new Error("Schedule artifact write was lost");
      return parseStoredArtifact(row);
    });
  }

  async findUnresolvedDelivery(
    rawDeviceId: string,
  ): Promise<UnresolvedScheduleDelivery | null> {
    const deviceId = identifierSchema.parse(rawDeviceId);
    const rows = await this.database
      .selectFrom("control_operations")
      .selectAll()
      .where("device_id", "=", deviceId)
      .where("kind", "=", "schedule")
      .where("status", "in", ["pending", "in_flight", "outcome_unknown"])
      .orderBy("requested_at_ms", "desc")
      .orderBy("id", "desc")
      .execute();
    for (const row of rows) {
      const request = parseVersionedDocument(
        row.request_json,
        row.request_schema_version,
        DEVICE_OPERATION_REQUEST_SCHEMA_VERSION,
        deviceOperationRequestSchema,
        `schedule operation ${row.id} request`,
      );
      if (request.kind !== "schedule") {
        throw new Error(`Operation ${row.id} kind does not match its request`);
      }
      if (row.status === "pending" || row.status === "in_flight") {
        if (row.result_json !== null || row.result_schema_version !== null) {
          throw new Error(`Incomplete operation ${row.id} has a result`);
        }
        return {
          operationId: row.id,
          status: row.status,
          errorCode: null,
          errorMessage: null,
        };
      }
      if (row.result_json === null || row.result_schema_version === null) {
        throw new Error(`Outcome-unknown operation ${row.id} has no result`);
      }
      const result = parseVersionedDocument(
        row.result_json,
        row.result_schema_version,
        DEVICE_OPERATION_RESULT_SCHEMA_VERSION,
        deviceOperationResultSchema,
        `schedule operation ${row.id} result`,
      );
      if (result.status !== "outcome_unknown") {
        throw new Error(`Operation ${row.id} status does not match its result`);
      }
      if (result.reconciledAtMs !== null) continue;
      return {
        operationId: row.id,
        status: "outcome_unknown",
        errorCode: "operation_outcome_unknown",
        errorMessage: `Schedule operation outcome is unknown: ${result.reason}`,
      };
    }
    return null;
  }

  private async selectMappedDevices(): Promise<readonly string[]> {
    const rows = await this.database
      .selectFrom("devices")
      .select("id")
      .where("enabled", "=", 1)
      .where("status", "in", ["online", "stale", "offline"])
      .where("mapping_profile_id", "is not", null)
      .orderBy(
        sql<number>`CASE ${sql.ref("status")}
          WHEN 'online' THEN 0
          WHEN 'stale' THEN 1
          ELSE 2
        END`,
        "asc",
      )
      .orderBy("id")
      .execute();
    return rows.map((row) => row.id);
  }

  private async selectOneMappedDevice(
    rawDeviceId: string,
  ): Promise<readonly string[]> {
    const deviceId = identifierSchema.parse(rawDeviceId);
    const row = await this.database
      .selectFrom("devices")
      .leftJoin(
        "device_schedule_artifacts",
        "device_schedule_artifacts.device_id",
        "devices.id",
      )
      .select([
        "devices.id",
        "devices.enabled",
        "devices.status",
        "devices.mapping_profile_id",
        "devices.reported_schedule_hash",
        "device_schedule_artifacts.compile_status",
        "device_schedule_artifacts.desired_schedule_hash",
      ])
      .where("devices.id", "=", deviceId)
      .executeTakeFirst();
    if (
      row === undefined ||
      row.enabled !== 1 ||
      !["online", "stale", "offline"].includes(row.status) ||
      row.mapping_profile_id === null
    ) {
      return [];
    }
    return [row.id];
  }

  private readExisting(
    transaction: StateTransaction,
    deviceId: string,
  ): Promise<StoredArtifactRow | undefined> {
    return transaction
      .selectFrom("device_schedule_artifacts")
      .selectAll()
      .where("device_id", "=", deviceId)
      .executeTakeFirst();
  }
}

function validateCompiledArtifactInput(
  input: PersistCompiledScheduleArtifact,
): void {
  identifierSchema.parse(input.deviceId);
  nonnegativeSafeIntegerSchema.parse(input.sourceStateRevision);
  nonnegativeSafeIntegerSchema.parse(input.nowMs);
  if (
    input.artifact.payloadSchemaVersion !==
    DEVICE_SCHEDULE_ARTIFACT_SCHEMA_VERSION
  ) {
    throw new Error("Unsupported compiled schedule artifact schema version");
  }
  const parsed = parseJsonDocument(
    input.artifact.payloadJson,
    `schedule artifact for ${input.deviceId}`,
  );
  if (parsed.duplicateKeys.length > 0) {
    throw new Error("Compiled schedule artifact contains duplicate JSON keys");
  }
  const core = legacyScheduleCoreSchema.parse(parsed.value);
  if (serializeLegacyScheduleCore(core) !== input.artifact.payloadJson) {
    throw new Error("Compiled schedule artifact is not canonical");
  }
  serializeLegacyScheduleDocument(core, LEGACY_MAX_SYNC_TIME);
  if (utf8ByteLength(input.artifact.payloadJson) !== input.artifact.byteCount) {
    throw new Error("Compiled schedule artifact byte count is incorrect");
  }
  if (
    calculateLegacyScheduleHash(core) !== input.artifact.desiredScheduleHash
  ) {
    throw new Error("Compiled schedule artifact hash is incorrect");
  }
  canonicalUint32HashSchema.parse(input.artifact.desiredScheduleHash);
  validateDelivery(input.delivery);
}

function parseStoredArtifact(
  row: StoredArtifactRow,
): StoredDeviceScheduleArtifact {
  identifierSchema.parse(row.device_id);
  nonnegativeSafeIntegerSchema.parse(row.source_state_revision);
  for (const timestamp of [
    row.compiled_at_ms,
    row.delivery_updated_at_ms,
    row.created_at_ms,
    row.updated_at_ms,
  ]) {
    nonnegativeSafeIntegerSchema.parse(timestamp);
  }
  if (row.compile_status === "failed") {
    if (
      row.compile_error_code === null ||
      row.compile_error_message === null ||
      row.delivery_status !== "not_required"
    ) {
      throw new Error(
        `Persisted schedule artifact ${row.device_id} is invalid`,
      );
    }
    return {
      deviceId: row.device_id,
      sourceStateRevision: row.source_state_revision,
      compileStatus: "failed",
      payloadJson: null,
      payloadSchemaVersion: null,
      byteCount: null,
      desiredScheduleHash: null,
      delivery: {
        status: "not_required",
        operationId: null,
        errorCode: null,
        errorMessage: null,
      },
      compileErrorCode: boundedTextSchema.parse(row.compile_error_code),
      compileErrorMessage: boundedTextSchema.parse(row.compile_error_message),
      compiledAtMs: row.compiled_at_ms,
      deliveryUpdatedAtMs: row.delivery_updated_at_ms,
      createdAtMs: row.created_at_ms,
      updatedAtMs: row.updated_at_ms,
    };
  }
  if (
    row.compiled_payload_json === null ||
    row.compiled_payload_schema_version !==
      DEVICE_SCHEDULE_ARTIFACT_SCHEMA_VERSION ||
    row.byte_count === null ||
    row.desired_schedule_hash === null
  ) {
    throw new Error(`Persisted schedule artifact ${row.device_id} is invalid`);
  }
  const delivery: ScheduleArtifactDeliveryState = {
    status: row.delivery_status,
    operationId: row.last_delivery_operation_id,
    errorCode: row.delivery_error_code,
    errorMessage: row.delivery_error_message,
  };
  validateCompiledArtifactInput({
    deviceId: row.device_id,
    sourceStateRevision: row.source_state_revision,
    artifact: {
      payloadJson: row.compiled_payload_json,
      payloadSchemaVersion: row.compiled_payload_schema_version,
      byteCount: row.byte_count,
      desiredScheduleHash: row.desired_schedule_hash,
    },
    delivery,
    nowMs: row.compiled_at_ms,
  });
  return {
    deviceId: row.device_id,
    sourceStateRevision: row.source_state_revision,
    compileStatus: "succeeded",
    payloadJson: row.compiled_payload_json,
    payloadSchemaVersion: row.compiled_payload_schema_version,
    byteCount: row.byte_count,
    desiredScheduleHash: row.desired_schedule_hash,
    delivery,
    compileErrorCode: null,
    compileErrorMessage: null,
    compiledAtMs: row.compiled_at_ms,
    deliveryUpdatedAtMs: row.delivery_updated_at_ms,
    createdAtMs: row.created_at_ms,
    updatedAtMs: row.updated_at_ms,
  };
}

function validateDelivery(delivery: ScheduleArtifactDeliveryState): void {
  const hasOperation = delivery.operationId !== null;
  const hasError =
    delivery.errorCode !== null && delivery.errorMessage !== null;
  if (
    (delivery.status === "not_required" ||
      delivery.status === "unsupported") !== !hasOperation
  ) {
    throw new Error("Schedule delivery operation relationship is invalid");
  }
  if (
    ["failed", "timed_out", "outcome_unknown", "unsupported"].includes(
      delivery.status,
    ) !== hasError
  ) {
    throw new Error("Schedule delivery error relationship is invalid");
  }
  if (delivery.operationId !== null)
    identifierSchema.parse(delivery.operationId);
  if (delivery.errorCode !== null) boundedTextSchema.parse(delivery.errorCode);
  if (delivery.errorMessage !== null)
    boundedTextSchema.parse(delivery.errorMessage);
}

function parseVersionedDocument<Output>(
  json: string,
  actualVersion: number,
  expectedVersion: number,
  schema: { readonly parse: (value: object) => Output },
  subject: string,
): Output {
  if (actualVersion !== expectedVersion) {
    throw new Error(`Persisted ${subject} has an unsupported schema version`);
  }
  const parsed = parseJsonDocument(json, subject);
  if (parsed.duplicateKeys.length > 0) {
    throw new Error(`Persisted ${subject} contains duplicate JSON keys`);
  }
  if (parsed.value === null || typeof parsed.value !== "object") {
    throw new Error(`Persisted ${subject} is not a JSON object`);
  }
  return schema.parse(parsed.value);
}
