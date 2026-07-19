import { randomUUID } from "node:crypto";

import {
  alertRuleInputSchema,
  alertRuleSchema,
  alertRulesResponseSchema,
  configurationMutationEventV1Schema,
  createAlertRuleRequestSchema,
  createChannelRequestSchema,
  expectedRevisionSchema,
  identifierSchema,
  mappingProfileParamsSchema,
  mutationResultSchema,
  operationDetailsResponseSchema,
  patchAlertRuleRequestSchema,
  renameChannelRequestSchema,
  replaceMappingProfileRequestSchema,
  replaceScheduleRequestSchema,
  updateThrottleRequestSchema,
  controlTypeKeySchema,
  type AlertRule,
  type AlertRuleInput,
  type AlertRulesResponse,
  type CreateAlertRuleRequest,
  type CreateChannelRequest,
  type MutationResult,
  type OperationDetailsResponse,
  type PatchAlertRuleRequest,
  type RenameChannelRequest,
  type ReplaceMappingProfileRequest,
  type ReplaceScheduleRequest,
  type SchedulePoint,
  type UpdateThrottleRequest,
} from "@aquarium/contracts";
import {
  compileFirmwareSchedule,
  scheduleGraphFromPoints,
  validateScheduleGraph,
  type ScheduleValidationIssue,
  type ValidatedScheduleGraph,
} from "@aquarium/domain";
import {
  LEGACY_LIGHT_CHANNEL_TYPE,
  LEGACY_MAX_SYNC_TIME,
  LEGACY_PUMP_CHANNEL_TYPE,
  serializeLegacyScheduleDocument,
  type LegacyScheduleCore,
} from "@aquarium/esp-protocol";
import type { Kysely, Selectable } from "kysely";
import { z, type ZodType } from "zod";

import {
  ConfigurationNotFoundError,
  ConfigurationRelationalConflictError,
  ConfigurationRevisionConflictError,
  ConfigurationValidationError,
  type ControllerConfigurationService,
  type RelationConflict,
  type ValidationIssue,
} from "../../application/configuration/configuration-service.js";
import {
  DEVICE_OPERATION_REQUEST_SCHEMA_VERSION,
  DEVICE_OPERATION_RESULT_SCHEMA_VERSION,
  assertDeviceOperationResultMatchesRequest,
  deviceOperationRequestSchema,
  deviceOperationResultSchema,
} from "../../application/operations/device-operation-types.js";
import { parseJsonDocument } from "../import/strict-json.js";
import {
  commitConditionalStateChange,
  toCommittedStateEvent,
} from "./state-outbox.js";
import type {
  AlertRulesTable,
  PinMappingsTable,
  StateDatabaseSchema,
} from "./types.js";
import type { StateDatabaseTransaction } from "./state-outbox.js";

type StoredAlertRule = Selectable<AlertRulesTable>;
type StoredPinMapping = Selectable<PinMappingsTable>;

export interface ControllerConfigurationRepositoryOptions {
  readonly nowMs?: () => number;
  readonly actor?: string;
  readonly schedulePointIdGenerator?: () => string;
}

function assertTime(value: number): number {
  if (
    !Number.isSafeInteger(value) ||
    value < 0 ||
    !Number.isFinite(new Date(value).getTime())
  ) {
    throw new RangeError("Configuration clock must return a valid timestamp");
  }
  return value;
}

function toIsoTimestamp(value: number, subject: string): string {
  if (
    !Number.isSafeInteger(value) ||
    value < 0 ||
    !Number.isFinite(new Date(value).getTime())
  ) {
    throw new Error(`Persisted ${subject} timestamp is invalid`);
  }
  return new Date(value).toISOString();
}

function relationalConflict(conflict: RelationConflict): never {
  throw new ConfigurationRelationalConflictError([conflict]);
}

function unchangedResult(revision: number): MutationResult {
  return mutationResultSchema.parse({ changed: false, revision, event: null });
}

function zodIssues(error: z.ZodError): readonly ValidationIssue[] {
  return error.issues.map((issue) => ({
    path: issue.path.map((part) =>
      typeof part === "number" ? part : String(part),
    ),
    code: issue.code,
    message: issue.message,
  }));
}

function scheduleIssuePath(
  issue: ScheduleValidationIssue,
): (string | number)[] {
  switch (issue.code) {
    case "empty-schedule":
    case "start-not-midnight":
    case "end-not-final-minute":
    case "wrap-discontinuity":
      return ["points"];
    case "gap":
    case "overlap":
    case "discontinuity":
      return ["points", issue.segmentIndex];
    case "invalid-minute":
    case "invalid-percent":
    case "zero-duration":
    case "reversed-segment":
      return ["points", issue.segmentIndex];
  }
}

function validateSchedulePoints(
  points: readonly SchedulePoint[],
): ValidatedScheduleGraph {
  const positionIssues: ValidationIssue[] = [];
  for (const [index, point] of points.entries()) {
    if (point.position !== index) {
      positionIssues.push({
        path: ["points", index, "position"],
        code: "non_contiguous_position",
        message: "Schedule point positions must be contiguous from zero",
      });
    }
  }
  const result = validateScheduleGraph(
    scheduleGraphFromPoints(
      points.map((point) => ({
        minute: point.minuteOfDay,
        percent: point.percentage,
      })),
    ),
  );
  if (!result.ok || positionIssues.length > 0) {
    const graphIssues: ValidationIssue[] = result.ok
      ? []
      : result.issues.map((issue) => ({
          path: scheduleIssuePath(issue),
          code: issue.code,
          message: `Invalid periodic UTC schedule: ${issue.code}`,
        }));
    throw new ConfigurationValidationError([...positionIssues, ...graphIssues]);
  }
  return result.graph;
}

function parseStoredDocument<Output>(
  json: string,
  schemaVersion: number,
  expectedVersion: number,
  schema: ZodType<Output>,
  subject: string,
): Output {
  if (schemaVersion !== expectedVersion) {
    throw new Error(`Persisted ${subject} has an unsupported schema version`);
  }
  const document = parseJsonDocument(json, subject);
  if (document.duplicateKeys.length > 0) {
    throw new Error(`Persisted ${subject} contains duplicate keys`);
  }
  return schema.parse(document.value);
}

function alertRuleSourceId(rule: StoredAlertRule): string {
  const sourceId =
    rule.source_type === "device"
      ? rule.device_id
      : rule.source_type === "output"
        ? rule.output_id
        : rule.source_type === "sensor"
          ? rule.sensor_id
          : rule.switch_id;
  if (sourceId === null) {
    throw new Error(`Persisted alert rule ${rule.id} has no source`);
  }
  return sourceId;
}

function toAlertRuleInput(rule: StoredAlertRule): AlertRuleInput {
  const common = {
    name: rule.name,
    delayMs: rule.delay_ms,
    severity: rule.severity,
    enabled: rule.enabled === 1,
  } as const;
  const sourceId = alertRuleSourceId(rule);
  switch (rule.source_type) {
    case "device":
      return alertRuleInputSchema.parse({
        ...common,
        source: { type: "device", id: sourceId },
        condition: { kind: rule.condition },
      });
    case "output":
      return alertRuleInputSchema.parse({
        ...common,
        source: { type: "output", id: sourceId },
        condition: { kind: rule.condition, threshold: rule.threshold },
      });
    case "sensor":
      return alertRuleInputSchema.parse({
        ...common,
        source: { type: "sensor", id: sourceId },
        condition: { kind: rule.condition, threshold: rule.threshold },
      });
    case "switch":
      return alertRuleInputSchema.parse({
        ...common,
        source: { type: "switch", id: sourceId },
        condition: { kind: rule.condition },
      });
  }
}

function toAlertRule(rule: StoredAlertRule): AlertRule {
  const input = toAlertRuleInput(rule);
  return alertRuleSchema.parse({
    id: rule.id,
    ...input,
    createdAt: toIsoTimestamp(rule.created_at_ms, `alert rule ${rule.id}`),
    updatedAt: toIsoTimestamp(rule.updated_at_ms, `alert rule ${rule.id}`),
  });
}

function alertRuleValues(input: AlertRuleInput): {
  readonly source_type: AlertRuleInput["source"]["type"];
  readonly device_id: string | null;
  readonly output_id: string | null;
  readonly sensor_id: string | null;
  readonly switch_id: string | null;
  readonly condition: string;
  readonly threshold: number | null;
} {
  return {
    source_type: input.source.type,
    device_id: input.source.type === "device" ? input.source.id : null,
    output_id: input.source.type === "output" ? input.source.id : null,
    sensor_id: input.source.type === "sensor" ? input.source.id : null,
    switch_id: input.source.type === "switch" ? input.source.id : null,
    condition: input.condition.kind,
    threshold:
      "threshold" in input.condition ? input.condition.threshold : null,
  };
}

function mappingsEqual(
  stored: readonly StoredPinMapping[],
  requested: ReplaceMappingProfileRequest["mappings"],
): boolean {
  if (stored.length !== requested.length) return false;
  const requestedById = new Map(
    requested.map((mapping) => [mapping.id, mapping]),
  );
  return stored.every((mapping) => {
    const expected = requestedById.get(mapping.id);
    if (expected === undefined) return false;
    return (
      mapping.pin === expected.pin &&
      mapping.display_order === expected.displayOrder &&
      mapping.enabled === (expected.enabled ? 1 : 0) &&
      mapping.channel_id ===
        (expected.target.kind === "channel" ? expected.target.id : null) &&
      mapping.output_id ===
        (expected.target.kind === "output" ? expected.target.id : null)
    );
  });
}

export class ControllerConfigurationRepository implements ControllerConfigurationService {
  readonly #nowMs: () => number;
  readonly #actor: string;
  readonly #schedulePointIdGenerator: () => string;

  constructor(
    private readonly database: Kysely<StateDatabaseSchema>,
    options: ControllerConfigurationRepositoryOptions = {},
  ) {
    this.#nowMs = options.nowMs ?? (() => Date.now());
    this.#actor = options.actor ?? "controller-api";
    this.#schedulePointIdGenerator =
      options.schedulePointIdGenerator ??
      (() => `schedule-point-${randomUUID()}`);
  }

  async createChannel(
    rawRequest: CreateChannelRequest,
  ): Promise<MutationResult> {
    const request = createChannelRequestSchema.parse(rawRequest);
    return this.commitMutation(
      "channel",
      request.id,
      "created",
      request.expectedRevision,
      `Create channel ${request.id}`,
      async (transaction) => {
        const existing = await transaction
          .selectFrom("channels")
          .selectAll()
          .where("id", "=", request.id)
          .executeTakeFirst();
        if (existing !== undefined) {
          if (
            existing.name === request.name &&
            existing.kind === request.typeKey &&
            existing.throttle_id === request.throttleId &&
            existing.display_order === request.displayOrder &&
            existing.enabled === (request.enabled ? 1 : 0)
          ) {
            return false;
          }
          return relationalConflict({
            resource: "channel",
            id: request.id,
            relation: "identifier",
            message: "Channel identifier is already used by different state",
          });
        }
        await this.assertChannelNameAvailable(transaction, request.name, null);
        const throttle = await transaction
          .selectFrom("throttles")
          .select(["id", "type_key"])
          .where("id", "=", request.throttleId)
          .executeTakeFirst();
        if (throttle === undefined) {
          throw new ConfigurationNotFoundError("throttle", request.throttleId);
        }
        if (throttle.type_key !== request.typeKey) {
          return relationalConflict({
            resource: "throttle",
            id: throttle.id,
            relation: "type_key",
            message: "Channel and throttle type keys must match",
          });
        }
        const nowMs = assertTime(this.#nowMs());
        await transaction
          .insertInto("channels")
          .values({
            id: request.id,
            name: request.name,
            kind: request.typeKey,
            throttle_id: request.throttleId,
            display_order: request.displayOrder,
            enabled: request.enabled ? 1 : 0,
            created_at_ms: nowMs,
            updated_at_ms: nowMs,
          })
          .executeTakeFirstOrThrow();
        const conflictingSchedule = await transaction
          .selectFrom("schedules")
          .select("channel_id")
          .where("id", "=", request.id)
          .executeTakeFirst();
        if (conflictingSchedule !== undefined) {
          return relationalConflict({
            resource: "schedule",
            id: request.id,
            relation: "identifier",
            message: "The channel-owned schedule identifier is already used",
          });
        }
        await transaction
          .insertInto("schedules")
          .values({
            id: request.id,
            channel_id: request.id,
            name: request.name,
            timezone: "UTC",
            enabled: request.enabled ? 1 : 0,
            graph_revision: 0,
            created_at_ms: nowMs,
            updated_at_ms: nowMs,
          })
          .executeTakeFirstOrThrow();
        await transaction
          .insertInto("schedule_points")
          .values([
            {
              id: identifierSchema.parse(this.#schedulePointIdGenerator()),
              schedule_id: request.id,
              position: 0,
              minute_of_day: 0,
              percentage: 0,
              editor_x: null,
              editor_y: null,
              created_at_ms: nowMs,
              updated_at_ms: nowMs,
            },
            {
              id: identifierSchema.parse(this.#schedulePointIdGenerator()),
              schedule_id: request.id,
              position: 1,
              minute_of_day: 1_439,
              percentage: 0,
              editor_x: null,
              editor_y: null,
              created_at_ms: nowMs,
              updated_at_ms: nowMs,
            },
          ])
          .execute();
        return true;
      },
    );
  }

  async renameChannel(
    rawChannelId: string,
    rawRequest: RenameChannelRequest,
  ): Promise<MutationResult> {
    const channelId = identifierSchema.parse(rawChannelId);
    const request = renameChannelRequestSchema.parse(rawRequest);
    return this.commitMutation(
      "channel",
      channelId,
      "updated",
      request.expectedRevision,
      `Rename channel ${channelId}`,
      async (transaction) => {
        const channel = await transaction
          .selectFrom("channels")
          .selectAll()
          .where("id", "=", channelId)
          .executeTakeFirst();
        if (channel === undefined) {
          throw new ConfigurationNotFoundError("channel", channelId);
        }
        if (channel.name === request.name) return false;
        await this.assertChannelNameAvailable(
          transaction,
          request.name,
          channelId,
        );
        await transaction
          .updateTable("channels")
          .set({ name: request.name, updated_at_ms: assertTime(this.#nowMs()) })
          .where("id", "=", channelId)
          .executeTakeFirstOrThrow();
        return true;
      },
    );
  }

  async deleteChannel(
    rawChannelId: string,
    rawExpectedRevision: number,
  ): Promise<MutationResult> {
    const channelId = identifierSchema.parse(rawChannelId);
    const { expectedRevision } = expectedRevisionSchema.parse({
      expectedRevision: rawExpectedRevision,
    });
    return this.commitMutation(
      "channel",
      channelId,
      "deleted",
      expectedRevision,
      `Delete channel ${channelId}`,
      async (transaction) => {
        const channel = await transaction
          .selectFrom("channels")
          .select("id")
          .where("id", "=", channelId)
          .executeTakeFirst();
        if (channel === undefined) {
          throw new ConfigurationNotFoundError("channel", channelId);
        }
        const conflicts: RelationConflict[] = [];
        const mapping = await transaction
          .selectFrom("pin_mappings")
          .select("id")
          .where("channel_id", "=", channelId)
          .executeTakeFirst();
        if (mapping !== undefined) {
          conflicts.push({
            resource: "pin_mapping",
            id: mapping.id,
            relation: "channel",
            message: "Remove channel pin mappings before deleting the channel",
          });
        }
        const override = await transaction
          .selectFrom("overrides")
          .select("id")
          .where("channel_id", "=", channelId)
          .executeTakeFirst();
        if (override !== undefined) {
          conflicts.push({
            resource: "override",
            id: override.id,
            relation: "channel",
            message: "Channel history prevents deletion",
          });
        }
        if (conflicts.length > 0) {
          throw new ConfigurationRelationalConflictError(conflicts);
        }
        await transaction
          .deleteFrom("schedules")
          .where("channel_id", "=", channelId)
          .execute();
        await transaction
          .deleteFrom("channels")
          .where("id", "=", channelId)
          .executeTakeFirstOrThrow();
        return true;
      },
    );
  }

  async replaceSchedule(
    rawChannelId: string,
    rawRequest: ReplaceScheduleRequest,
  ): Promise<MutationResult> {
    const channelId = identifierSchema.parse(rawChannelId);
    const request = replaceScheduleRequestSchema.parse(rawRequest);
    const proposedGraph = validateSchedulePoints(request.points);
    return this.commitMutation(
      "schedule",
      channelId,
      "replaced",
      request.expectedRevision,
      `Replace schedule for channel ${channelId}`,
      async (transaction) => {
        const channel = await transaction
          .selectFrom("channels")
          .select("id")
          .where("id", "=", channelId)
          .executeTakeFirst();
        if (channel === undefined) {
          throw new ConfigurationNotFoundError("channel", channelId);
        }
        const schedule = await transaction
          .selectFrom("schedules")
          .selectAll()
          .where("channel_id", "=", channelId)
          .executeTakeFirst();
        if (schedule === undefined) {
          throw new ConfigurationNotFoundError("schedule", channelId);
        }
        const storedPoints = await transaction
          .selectFrom("schedule_points")
          .selectAll()
          .where("schedule_id", "=", schedule.id)
          .orderBy("position")
          .execute();
        const equal =
          storedPoints.length === request.points.length &&
          storedPoints.every((point, index) => {
            const expected = request.points[index];
            return (
              expected !== undefined &&
              point.id === expected.id &&
              point.position === expected.position &&
              point.minute_of_day === expected.minuteOfDay &&
              point.percentage === expected.percentage &&
              point.editor_x === expected.editorX &&
              point.editor_y === expected.editorY
            );
          });
        if (equal) return false;
        const requestedIds = request.points.map((point) => point.id);
        const reusedId = await transaction
          .selectFrom("schedule_points")
          .select("id")
          .where("id", "in", requestedIds)
          .where("schedule_id", "!=", schedule.id)
          .executeTakeFirst();
        if (reusedId !== undefined) {
          return relationalConflict({
            resource: "schedule_point",
            id: reusedId.id,
            relation: "identifier",
            message: "Schedule point identifier belongs to another schedule",
          });
        }
        await this.assertFirmwareCapacity(
          transaction,
          schedule.id,
          proposedGraph,
        );
        const nowMs = assertTime(this.#nowMs());
        await transaction
          .deleteFrom("schedule_points")
          .where("schedule_id", "=", schedule.id)
          .execute();
        await transaction
          .insertInto("schedule_points")
          .values(
            request.points.map((point) => ({
              id: point.id,
              schedule_id: schedule.id,
              position: point.position,
              minute_of_day: point.minuteOfDay,
              percentage: point.percentage,
              editor_x: point.editorX,
              editor_y: point.editorY,
              created_at_ms: nowMs,
              updated_at_ms: nowMs,
            })),
          )
          .execute();
        await transaction
          .updateTable("schedules")
          .set({
            graph_revision: schedule.graph_revision + 1,
            updated_at_ms: nowMs,
          })
          .where("id", "=", schedule.id)
          .executeTakeFirstOrThrow();
        return schedule.id;
      },
    );
  }

  async updateThrottle(
    rawTypeKey: string,
    rawRequest: UpdateThrottleRequest,
  ): Promise<MutationResult> {
    const request = updateThrottleRequestSchema.parse(rawRequest);
    const typeKey = controlTypeKeySchema.parse(rawTypeKey);
    return this.commitMutation(
      "throttle",
      typeKey,
      "updated",
      request.expectedRevision,
      `Update throttle ${typeKey}`,
      async (transaction) => {
        const throttle = await transaction
          .selectFrom("throttles")
          .selectAll()
          .where("type_key", "=", typeKey)
          .executeTakeFirst();
        if (throttle === undefined) {
          throw new ConfigurationNotFoundError("throttle", typeKey);
        }
        if (throttle.percentage === request.percentage) return false;
        await transaction
          .updateTable("throttles")
          .set({
            percentage: request.percentage,
            updated_at_ms: assertTime(this.#nowMs()),
          })
          .where("id", "=", throttle.id)
          .executeTakeFirstOrThrow();
        return throttle.id;
      },
    );
  }

  async replaceMappingProfile(
    rawProfileId: string,
    rawRequest: ReplaceMappingProfileRequest,
  ): Promise<MutationResult> {
    const profileId =
      mappingProfileParamsSchema.shape.profileId.parse(rawProfileId);
    const request = replaceMappingProfileRequestSchema.parse(rawRequest);
    return this.commitMutation(
      "mapping_profile",
      profileId,
      "replaced",
      request.expectedRevision,
      `Replace mapping profile ${profileId}`,
      async (transaction) => {
        const profile = await transaction
          .selectFrom("mapping_profiles")
          .selectAll()
          .where("id", "=", profileId)
          .executeTakeFirst();
        const profiles = await transaction
          .selectFrom("mapping_profiles")
          .select(["id", "name", "device_name_prefix"])
          .where("id", "!=", profileId)
          .execute();
        const conflicts: RelationConflict[] = [];
        const nameOwner = profiles.find((item) => item.name === request.name);
        if (nameOwner !== undefined) {
          conflicts.push({
            resource: "mapping_profile",
            id: nameOwner.id,
            relation: "name",
            message: "Mapping profile name is already in use",
          });
        }
        for (const item of profiles) {
          if (
            item.device_name_prefix.startsWith(request.deviceNamePrefix) ||
            request.deviceNamePrefix.startsWith(item.device_name_prefix)
          ) {
            conflicts.push({
              resource: "mapping_profile",
              id: item.id,
              relation: "device_name_prefix",
              message: "Mapping profile prefixes must not overlap",
            });
          }
        }
        const existingMappings =
          profile === undefined
            ? []
            : await transaction
                .selectFrom("pin_mappings")
                .selectAll()
                .where("mapping_profile_id", "=", profileId)
                .execute();
        for (const mapping of request.mappings) {
          const targetExists =
            mapping.target.kind === "channel"
              ? await transaction
                  .selectFrom("channels")
                  .select("id")
                  .where("id", "=", mapping.target.id)
                  .executeTakeFirst()
              : await transaction
                  .selectFrom("outputs")
                  .select("id")
                  .where("id", "=", mapping.target.id)
                  .executeTakeFirst();
          if (targetExists === undefined) {
            conflicts.push({
              resource: mapping.target.kind,
              id: mapping.target.id,
              relation: "pin_mapping_target",
              message: "Pin mapping target does not exist",
            });
          }
          const reusedId = await transaction
            .selectFrom("pin_mappings")
            .select("mapping_profile_id")
            .where("id", "=", mapping.id)
            .where("mapping_profile_id", "!=", profileId)
            .executeTakeFirst();
          if (reusedId !== undefined) {
            conflicts.push({
              resource: "pin_mapping",
              id: mapping.id,
              relation: "identifier",
              message: "Pin mapping identifier belongs to another profile",
            });
          }
        }
        if (conflicts.length > 0) {
          throw new ConfigurationRelationalConflictError(
            conflicts.slice(0, 100),
          );
        }
        if (
          profile !== undefined &&
          profile.name === request.name &&
          profile.device_name_prefix === request.deviceNamePrefix &&
          profile.output_gain === request.outputGain &&
          mappingsEqual(existingMappings, request.mappings)
        ) {
          return false;
        }
        const nowMs = assertTime(this.#nowMs());
        if (profile === undefined) {
          await transaction
            .insertInto("mapping_profiles")
            .values({
              id: profileId,
              name: request.name,
              device_name_prefix: request.deviceNamePrefix,
              output_gain: request.outputGain,
              created_at_ms: nowMs,
              updated_at_ms: nowMs,
            })
            .executeTakeFirstOrThrow();
        } else {
          await transaction
            .updateTable("mapping_profiles")
            .set({
              name: request.name,
              device_name_prefix: request.deviceNamePrefix,
              output_gain: request.outputGain,
              updated_at_ms: nowMs,
            })
            .where("id", "=", profileId)
            .executeTakeFirstOrThrow();
          await transaction
            .deleteFrom("pin_mappings")
            .where("mapping_profile_id", "=", profileId)
            .execute();
        }
        if (request.mappings.length > 0) {
          await transaction
            .insertInto("pin_mappings")
            .values(
              request.mappings.map((mapping) => ({
                id: mapping.id,
                mapping_profile_id: profileId,
                channel_id:
                  mapping.target.kind === "channel" ? mapping.target.id : null,
                output_id:
                  mapping.target.kind === "output" ? mapping.target.id : null,
                pin: mapping.pin,
                display_order: mapping.displayOrder,
                enabled: mapping.enabled ? 1 : 0,
                created_at_ms: nowMs,
                updated_at_ms: nowMs,
              })),
            )
            .execute();
        }
        return true;
      },
    );
  }

  async getOperation(
    rawOperationId: string,
  ): Promise<OperationDetailsResponse> {
    const operationId = identifierSchema.parse(rawOperationId);
    const operation = await this.database
      .selectFrom("control_operations")
      .selectAll()
      .where("id", "=", operationId)
      .executeTakeFirst();
    if (operation === undefined) {
      throw new ConfigurationNotFoundError("operation", operationId);
    }
    const request = parseStoredDocument(
      operation.request_json,
      operation.request_schema_version,
      DEVICE_OPERATION_REQUEST_SCHEMA_VERSION,
      deviceOperationRequestSchema,
      `operation ${operation.id} request`,
    );
    const result =
      operation.result_json === null && operation.result_schema_version === null
        ? null
        : operation.result_json === null ||
            operation.result_schema_version === null
          ? (() => {
              throw new Error(
                `Persisted operation ${operation.id} result version is incomplete`,
              );
            })()
          : parseStoredDocument(
              operation.result_json,
              operation.result_schema_version,
              DEVICE_OPERATION_RESULT_SCHEMA_VERSION,
              deviceOperationResultSchema,
              `operation ${operation.id} result`,
            );
    if (result !== null)
      assertDeviceOperationResultMatchesRequest(request, result);
    return operationDetailsResponseSchema.parse({
      operation: {
        id: operation.id,
        deviceId: operation.device_id,
        kind: operation.kind,
        status: operation.status,
        requestedAt: toIsoTimestamp(
          operation.requested_at_ms,
          `operation ${operation.id} request`,
        ),
        deadlineAt: toIsoTimestamp(
          operation.deadline_at_ms,
          `operation ${operation.id} deadline`,
        ),
        completedAt:
          operation.completed_at_ms === null
            ? null
            : toIsoTimestamp(
                operation.completed_at_ms,
                `operation ${operation.id} completion`,
              ),
      },
      request: {
        schemaVersion: operation.request_schema_version,
        data: request,
      },
      result:
        result === null
          ? null
          : {
              schemaVersion: operation.result_schema_version,
              data: result,
            },
    });
  }

  async listAlertRules(): Promise<AlertRulesResponse> {
    const rows = await this.database
      .selectFrom("alert_rules")
      .selectAll()
      .orderBy("id")
      .execute();
    for (const row of rows) this.validateAlertRuleConfiguration(row);
    return alertRulesResponseSchema.parse({ items: rows.map(toAlertRule) });
  }

  async createAlertRule(
    rawRequest: CreateAlertRuleRequest,
  ): Promise<MutationResult> {
    const request = createAlertRuleRequestSchema.parse(rawRequest);
    return this.commitMutation(
      "alert_rule",
      request.id,
      "created",
      request.expectedRevision,
      `Create alert rule ${request.id}`,
      async (transaction) => {
        const existing = await transaction
          .selectFrom("alert_rules")
          .selectAll()
          .where("id", "=", request.id)
          .executeTakeFirst();
        if (existing !== undefined) {
          this.validateAlertRuleConfiguration(existing);
          if (
            JSON.stringify(toAlertRuleInput(existing)) ===
            JSON.stringify(request.rule)
          ) {
            return false;
          }
          return relationalConflict({
            resource: "alert_rule",
            id: request.id,
            relation: "identifier",
            message: "Alert rule identifier is already used",
          });
        }
        await this.assertAlertRuleNameAvailable(
          transaction,
          request.rule.name,
          null,
        );
        await this.assertAlertRuleReference(transaction, request.rule);
        const nowMs = assertTime(this.#nowMs());
        await transaction
          .insertInto("alert_rules")
          .values({
            id: request.id,
            name: request.rule.name,
            ...alertRuleValues(request.rule),
            delay_ms: request.rule.delayMs,
            severity: request.rule.severity,
            enabled: request.rule.enabled ? 1 : 0,
            created_at_ms: nowMs,
            updated_at_ms: nowMs,
            configuration_json: null,
            configuration_schema_version: null,
          })
          .executeTakeFirstOrThrow();
        return true;
      },
    );
  }

  async patchAlertRule(
    rawAlertRuleId: string,
    rawRequest: PatchAlertRuleRequest,
  ): Promise<MutationResult> {
    const alertRuleId = identifierSchema.parse(rawAlertRuleId);
    const request = patchAlertRuleRequestSchema.parse(rawRequest);
    return this.commitMutation(
      "alert_rule",
      alertRuleId,
      "updated",
      request.expectedRevision,
      `Update alert rule ${alertRuleId}`,
      async (transaction) => {
        const stored = await transaction
          .selectFrom("alert_rules")
          .selectAll()
          .where("id", "=", alertRuleId)
          .executeTakeFirst();
        if (stored === undefined) {
          throw new ConfigurationNotFoundError("alert_rule", alertRuleId);
        }
        this.validateAlertRuleConfiguration(stored);
        const current = toAlertRuleInput(stored);
        const parsed = alertRuleInputSchema.safeParse({
          name: request.name ?? current.name,
          source: request.source ?? current.source,
          condition: request.condition ?? current.condition,
          delayMs: request.delayMs ?? current.delayMs,
          severity: request.severity ?? current.severity,
          enabled: request.enabled ?? current.enabled,
        });
        if (!parsed.success) {
          throw new ConfigurationValidationError(zodIssues(parsed.error));
        }
        const next = parsed.data;
        if (JSON.stringify(next) === JSON.stringify(current)) return false;
        const openAlert = await transaction
          .selectFrom("active_alerts")
          .select("id")
          .where("alert_rule_id", "=", alertRuleId)
          .where("state", "!=", "recovered")
          .executeTakeFirst();
        if (openAlert !== undefined) {
          return relationalConflict({
            resource: "alert",
            id: openAlert.id,
            relation: "active_rule",
            message:
              "Recover the active alert before changing or disabling its rule",
          });
        }
        await this.assertAlertRuleNameAvailable(
          transaction,
          next.name,
          alertRuleId,
        );
        await this.assertAlertRuleReference(transaction, next);
        await transaction
          .updateTable("alert_rules")
          .set({
            name: next.name,
            ...alertRuleValues(next),
            delay_ms: next.delayMs,
            severity: next.severity,
            enabled: next.enabled ? 1 : 0,
            updated_at_ms: assertTime(this.#nowMs()),
          })
          .where("id", "=", alertRuleId)
          .executeTakeFirstOrThrow();
        if (!next.enabled) {
          await transaction
            .deleteFrom("alert_condition_states")
            .where("alert_rule_id", "=", alertRuleId)
            .execute();
        }
        return true;
      },
    );
  }

  async deleteAlertRule(
    rawAlertRuleId: string,
    rawExpectedRevision: number,
  ): Promise<MutationResult> {
    const alertRuleId = identifierSchema.parse(rawAlertRuleId);
    const { expectedRevision } = expectedRevisionSchema.parse({
      expectedRevision: rawExpectedRevision,
    });
    return this.commitMutation(
      "alert_rule",
      alertRuleId,
      "deleted",
      expectedRevision,
      `Delete alert rule ${alertRuleId}`,
      async (transaction) => {
        const rule = await transaction
          .selectFrom("alert_rules")
          .select("id")
          .where("id", "=", alertRuleId)
          .executeTakeFirst();
        if (rule === undefined) {
          throw new ConfigurationNotFoundError("alert_rule", alertRuleId);
        }
        const alert = await transaction
          .selectFrom("active_alerts")
          .select("id")
          .where("alert_rule_id", "=", alertRuleId)
          .executeTakeFirst();
        if (alert !== undefined) {
          return relationalConflict({
            resource: "alert",
            id: alert.id,
            relation: "rule_history",
            message: "Alert history prevents deleting this rule",
          });
        }
        await transaction
          .deleteFrom("alert_rules")
          .where("id", "=", alertRuleId)
          .executeTakeFirstOrThrow();
        return true;
      },
    );
  }

  private async commitMutation(
    resource:
      "channel" | "schedule" | "throttle" | "mapping_profile" | "alert_rule",
    fallbackEntityId: string,
    action: "created" | "updated" | "deleted" | "replaced",
    expectedRevision: number,
    summary: string,
    mutate: (
      transaction: StateDatabaseTransaction,
    ) => Promise<boolean | string>,
  ): Promise<MutationResult> {
    const occurredAtMs = assertTime(this.#nowMs());
    const committed = await commitConditionalStateChange<{
      readonly changed: boolean;
      readonly result: string;
    }>(
      this.database,
      (entityId) => {
        const payload = configurationMutationEventV1Schema.parse({
          schemaVersion: 1,
          action,
          resource,
          id: entityId,
        });
        return {
          actor: this.#actor,
          mutationType: `${resource}.${action}`,
          summary,
          eventType: `${resource}.${action}`,
          entityType: resource,
          entityId,
          occurredAtMs,
          retentionClass: "audit" as const,
          payloadJson: JSON.stringify(payload),
          payloadSchemaVersion: 1,
        };
      },
      async (transaction) => {
        const outcome = await mutate(transaction);
        return outcome === false
          ? { changed: false as const, result: fallbackEntityId }
          : {
              changed: true as const,
              result: typeof outcome === "string" ? outcome : fallbackEntityId,
            };
      },
      undefined,
      {
        expectedRevision,
        conflictError: (expected, current) =>
          new ConfigurationRevisionConflictError(expected, current),
      },
    );
    if (!committed.changed) return unchangedResult(committed.revision);
    return mutationResultSchema.parse({
      changed: true,
      revision: committed.revision,
      event: toCommittedStateEvent(committed.outboxEvent),
    });
  }

  private async assertChannelNameAvailable(
    transaction: StateDatabaseTransaction,
    name: string,
    exceptId: string | null,
  ): Promise<void> {
    let query = transaction
      .selectFrom("channels")
      .select("id")
      .where("name", "=", name);
    if (exceptId !== null) query = query.where("id", "!=", exceptId);
    const owner = await query.executeTakeFirst();
    if (owner !== undefined) {
      relationalConflict({
        resource: "channel",
        id: owner.id,
        relation: "name",
        message: "Channel name is already in use",
      });
    }
  }

  private async assertAlertRuleNameAvailable(
    transaction: StateDatabaseTransaction,
    name: string,
    exceptId: string | null,
  ): Promise<void> {
    let query = transaction
      .selectFrom("alert_rules")
      .select("id")
      .where("name", "=", name);
    if (exceptId !== null) query = query.where("id", "!=", exceptId);
    const owner = await query.executeTakeFirst();
    if (owner !== undefined) {
      relationalConflict({
        resource: "alert_rule",
        id: owner.id,
        relation: "name",
        message: "Alert rule name is already in use",
      });
    }
  }

  private async assertAlertRuleReference(
    transaction: StateDatabaseTransaction,
    rule: AlertRuleInput,
  ): Promise<void> {
    const source = rule.source;
    const found =
      source.type === "device"
        ? await transaction
            .selectFrom("devices")
            .select("id")
            .where("id", "=", source.id)
            .executeTakeFirst()
        : source.type === "output"
          ? await transaction
              .selectFrom("outputs")
              .select("id")
              .where("id", "=", source.id)
              .executeTakeFirst()
          : source.type === "sensor"
            ? await transaction
                .selectFrom("sensors")
                .select("id")
                .where("id", "=", source.id)
                .executeTakeFirst()
            : await transaction
                .selectFrom("switches")
                .select("id")
                .where("id", "=", source.id)
                .executeTakeFirst();
    if (found === undefined) {
      throw new ConfigurationRelationalConflictError([
        {
          resource: source.type,
          id: source.id,
          relation: "alert_rule_source",
          message: "Alert rule source does not exist",
        },
      ]);
    }
  }

  private validateAlertRuleConfiguration(rule: StoredAlertRule): void {
    if (
      rule.configuration_json === null &&
      rule.configuration_schema_version === null
    ) {
      return;
    }
    if (
      rule.configuration_json === null ||
      rule.configuration_schema_version === null ||
      rule.configuration_schema_version <= 0
    ) {
      throw new Error(
        `Persisted alert rule ${rule.id} configuration is invalid`,
      );
    }
    const parsed = parseJsonDocument(
      rule.configuration_json,
      `alert rule ${rule.id} configuration`,
    );
    if (parsed.duplicateKeys.length > 0) {
      throw new Error(
        `Persisted alert rule ${rule.id} configuration has duplicate keys`,
      );
    }
    z.json().parse(parsed.value);
  }

  private async assertFirmwareCapacity(
    transaction: StateDatabaseTransaction,
    replacedScheduleId: string,
    proposedGraph: ValidatedScheduleGraph,
  ): Promise<void> {
    const [mappings, channels, schedules, points, throttles] =
      await Promise.all([
        transaction
          .selectFrom("pin_mappings")
          .selectAll()
          .where("enabled", "=", 1)
          .where("channel_id", "is not", null)
          .orderBy("mapping_profile_id")
          .orderBy("display_order")
          .orderBy("id")
          .execute(),
        transaction.selectFrom("channels").selectAll().execute(),
        transaction.selectFrom("schedules").selectAll().execute(),
        transaction
          .selectFrom("schedule_points")
          .selectAll()
          .orderBy("schedule_id")
          .orderBy("position")
          .execute(),
        transaction.selectFrom("throttles").selectAll().execute(),
      ]);
    const channelById = new Map(
      channels.map((channel) => [channel.id, channel]),
    );
    const scheduleByChannel = new Map(
      schedules.map((schedule) => [schedule.channel_id, schedule]),
    );
    const throttleById = new Map(
      throttles.map((throttle) => [throttle.id, throttle]),
    );
    const profileIds = [
      ...new Set(mappings.map((mapping) => mapping.mapping_profile_id)),
    ];
    for (const profileId of profileIds) {
      const inputs = mappings
        .filter((mapping) => mapping.mapping_profile_id === profileId)
        .flatMap((mapping) => {
          if (mapping.channel_id === null) return [];
          const channel = channelById.get(mapping.channel_id);
          if (channel === undefined) {
            throw new Error(`Persisted mapping ${mapping.id} has no channel`);
          }
          const schedule = scheduleByChannel.get(channel.id);
          if (
            schedule === undefined ||
            channel.enabled !== 1 ||
            schedule.enabled !== 1
          ) {
            return [];
          }
          const throttle = throttleById.get(channel.throttle_id);
          if (throttle === undefined) {
            throw new Error(`Persisted channel ${channel.id} has no throttle`);
          }
          let graph: ValidatedScheduleGraph;
          if (schedule.id === replacedScheduleId) {
            graph = proposedGraph;
          } else {
            const validated = validateScheduleGraph(
              scheduleGraphFromPoints(
                points
                  .filter((point) => point.schedule_id === schedule.id)
                  .map((point) => ({
                    minute: point.minute_of_day,
                    percent: point.percentage,
                  })),
              ),
            );
            if (!validated.ok) {
              throw new Error(`Persisted schedule ${schedule.id} is invalid`);
            }
            graph = validated.graph;
          }
          return [
            {
              pin: mapping.pin,
              kind:
                channel.kind === "pump"
                  ? ("pump" as const)
                  : ("light" as const),
              graph,
              throttlePercent: throttle.percentage,
            },
          ];
        });
      const compiled = compileFirmwareSchedule(inputs);
      const core: LegacyScheduleCore = {
        c: compiled.channels.map((channel) => ({
          o: channel.pin,
          t:
            channel.kind === "pump"
              ? LEGACY_PUMP_CHANNEL_TYPE
              : LEGACY_LIGHT_CHANNEL_TYPE,
          l: channel.links.map((link) => ({
            s: { t: link.source.minute, p: link.source.percent },
            d: { t: link.target.minute, p: link.target.percent },
          })),
        })),
      };
      try {
        // Preflight the largest syncTime the firmware can append.
        // A channels-only core can fit while the actual firmware document does
        // not, so accepting the core alone would create a guaranteed compile
        // failure after the configuration mutation commits.
        serializeLegacyScheduleDocument(core, LEGACY_MAX_SYNC_TIME);
      } catch (error) {
        if (error instanceof RangeError) {
          throw new ConfigurationValidationError([
            {
              path: ["points"],
              code: "schedule_capacity",
              message: "Compiled device schedule exceeds the 4095-byte limit",
            },
          ]);
        }
        throw error;
      }
    }
  }
}
