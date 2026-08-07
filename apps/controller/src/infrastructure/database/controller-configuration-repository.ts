import { randomUUID } from "node:crypto";

import {
  alertRuleInputSchema,
  alertRuleSchema,
  alertRulesResponseSchema,
  configurationMutationEventV1Schema,
  controlAreaMutationEventV1Schema,
  controlAreaSchema,
  controlAreaSlugSchema,
  createControlAreaRequestSchema,
  createAlertRuleRequestSchema,
  createChannelRequestSchema,
  expectedRevisionSchema,
  identifierSchema,
  mappingProfileParamsSchema,
  mutationResultSchema,
  operationDetailsResponseSchema,
  patchAlertRuleRequestSchema,
  renameChannelRequestSchema,
  renameControlAreaRequestSchema,
  replaceControlAreaChannelsRequestSchema,
  replaceControlAreaScheduleConfigurationRequestSchema,
  replaceControlAreasRequestSchema,
  replaceMappingProfileRequestSchema,
  replaceScheduleRequestSchema,
  setDeviceEnabledRequestSchema,
  updateChannelRequestSchema,
  updateThrottleRequestSchema,
  controlTypeKeySchema,
  type AlertRule,
  type AlertRuleInput,
  type AlertRulesResponse,
  type CreateAlertRuleRequest,
  type CreateChannelRequest,
  type CreateControlAreaRequest,
  type ControlArea,
  type MutationResult,
  type OperationDetailsResponse,
  type PatchAlertRuleRequest,
  type RenameChannelRequest,
  type RenameControlAreaRequest,
  type ReplaceControlAreaChannelsRequest,
  type ReplaceControlAreaScheduleConfigurationRequest,
  type ReplaceControlAreasRequest,
  type ReplaceMappingProfileRequest,
  type ReplaceScheduleRequest,
  type SchedulePoint,
  type SetDeviceEnabledRequest,
  type StateInvalidation,
  type UpdateChannelRequest,
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
import { CONTROLLER_STORAGE_HEALTH_DEVICE_ID } from "../../application/maintenance/controller-storage-health-service.js";
import {
  DEVICE_OPERATION_REQUEST_SCHEMA_VERSION,
  DEVICE_OPERATION_RESULT_SCHEMA_VERSION,
  assertDeviceOperationResultMatchesRequest,
  deviceOperationRequestSchema,
  deviceOperationResultSchema,
} from "../../application/operations/device-operation-types.js";
import {
  MANUAL_OVERRIDE_OPERATION_SCHEMA_VERSION,
  manualOverrideOperationRequestSchema,
  manualOverrideOperationResultSchema,
} from "../../application/overrides/manual-override-types.js";
import { parseJsonDocument } from "../import/strict-json.js";
import {
  commitConditionalStateChange,
  toCommittedStateEvent,
} from "./state-outbox.js";
import type {
  AlertRulesTable,
  ControlOperationsTable,
  PinMappingsTable,
  StateDatabaseSchema,
} from "./types.js";
import type { StateDatabaseTransaction } from "./state-outbox.js";

type StoredAlertRule = Selectable<AlertRulesTable>;
type StoredPinMapping = Selectable<PinMappingsTable>;

interface ControlAreaAuditState {
  readonly area: ControlArea;
  readonly throttle: {
    readonly id: string;
    readonly percentage: number;
  } | null;
}

interface ControlAreaMutationOutcome {
  readonly changed: boolean;
  readonly entityId: string;
  readonly before: ControlAreaAuditState | null;
  readonly after: ControlAreaAuditState | null;
}

interface ControlAreaCollectionAudit {
  readonly areas: readonly ControlAreaAuditState[];
}

interface BatchMutationOutcome {
  readonly changed: boolean;
  readonly invalidations: readonly StateInvalidation[];
}

interface AreaOwnedResources {
  readonly channelIds: readonly string[];
  readonly outputIds: readonly string[];
  readonly conflicts: readonly RelationConflict[];
}

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

function slugifyControlAreaLabel(label: string): string | null {
  const slug = label
    .toLocaleLowerCase("en-US")
    .replaceAll("æ", "ae")
    .replaceAll("ø", "o")
    .replaceAll("å", "a")
    .normalize("NFKD")
    .replace(/\p{Mark}+/gu, "")
    .replace(/[^a-z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .slice(0, 64)
    .replace(/-+$/gu, "");
  return controlAreaSlugSchema.safeParse(slug).success ? slug : null;
}

function storedControlArea(
  row: Selectable<StateDatabaseSchema["control_areas"]>,
): ControlArea {
  return controlAreaSchema.parse({
    slug: row.slug,
    typeKey: row.type_key,
    label: row.label,
  });
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

function parseOptionalOperationResult<Output>(
  operation: Selectable<ControlOperationsTable>,
  expectedVersion: number,
  schema: ZodType<Output>,
  subjectPrefix: string,
): Output | null {
  if (
    operation.result_json === null &&
    operation.result_schema_version === null
  ) {
    return null;
  }
  if (
    operation.result_json === null ||
    operation.result_schema_version === null
  ) {
    throw new Error(
      `Persisted operation ${operation.id} result version is incomplete`,
    );
  }
  return parseStoredDocument(
    operation.result_json,
    operation.result_schema_version,
    expectedVersion,
    schema,
    `${subjectPrefix} ${operation.id} result`,
  );
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

  async createControlArea(
    rawRequest: CreateControlAreaRequest,
  ): Promise<MutationResult> {
    const request = createControlAreaRequestSchema.parse(rawRequest);
    const slug = slugifyControlAreaLabel(request.label);
    if (slug === null) {
      throw new ConfigurationValidationError([
        {
          path: ["label"],
          code: "invalid_slug",
          message: "Area name must contain at least one Latin letter or number",
        },
      ]);
    }
    const throttleId = identifierSchema.parse(`throttle-${slug}`);
    return this.commitControlAreaMutation(
      "created",
      slug,
      request.expectedRevision,
      `Create control area ${request.label}`,
      async (transaction) => {
        await this.assertControlAreaAvailable(
          transaction,
          slug,
          slug,
          request.label,
          null,
        );
        const throttleOwner = await transaction
          .selectFrom("throttles")
          .select(["id", "type_key"])
          .where((expression) =>
            expression.or([
              expression("id", "=", throttleId),
              expression("type_key", "=", slug),
            ]),
          )
          .executeTakeFirst();
        if (throttleOwner !== undefined) {
          return relationalConflict({
            resource: "throttle",
            id: throttleOwner.id,
            relation: "control_area",
            message: "The new area would reuse an existing schedule multiplier",
          });
        }
        const lastArea = await transaction
          .selectFrom("control_areas")
          .select("display_order")
          .orderBy("display_order", "desc")
          .limit(1)
          .executeTakeFirst();
        const nowMs = assertTime(this.#nowMs());
        const area = controlAreaSchema.parse({
          slug,
          typeKey: slug,
          label: request.label,
        });
        await transaction
          .insertInto("control_areas")
          .values({
            slug: area.slug,
            type_key: area.typeKey,
            label: area.label,
            display_order: (lastArea?.display_order ?? -1) + 1,
            created_at_ms: nowMs,
            updated_at_ms: nowMs,
          })
          .executeTakeFirstOrThrow();
        await transaction
          .insertInto("throttles")
          .values({
            id: throttleId,
            type_key: area.typeKey,
            percentage: 100,
            created_at_ms: nowMs,
            updated_at_ms: nowMs,
          })
          .executeTakeFirstOrThrow();
        return {
          changed: true,
          entityId: slug,
          before: null,
          after: {
            area,
            throttle: { id: throttleId, percentage: 100 },
          },
        };
      },
    );
  }

  async renameControlArea(
    rawAreaSlug: string,
    rawRequest: RenameControlAreaRequest,
  ): Promise<MutationResult> {
    const areaSlug = controlAreaSlugSchema.parse(rawAreaSlug);
    const request = renameControlAreaRequestSchema.parse(rawRequest);
    return this.commitControlAreaMutation(
      "updated",
      areaSlug,
      request.expectedRevision,
      `Rename control area ${areaSlug}`,
      async (transaction) => {
        const stored = await transaction
          .selectFrom("control_areas")
          .selectAll()
          .where("slug", "=", areaSlug)
          .executeTakeFirst();
        if (stored === undefined) {
          throw new ConfigurationNotFoundError("control_area", areaSlug);
        }
        const before = await this.controlAreaAuditState(transaction, stored);
        if (stored.label === request.label) {
          return {
            changed: false,
            entityId: areaSlug,
            before,
            after: before,
          };
        }
        await this.assertControlAreaAvailable(
          transaction,
          areaSlug,
          stored.type_key,
          request.label,
          areaSlug,
        );
        await transaction
          .updateTable("control_areas")
          .set({
            label: request.label,
            updated_at_ms: assertTime(this.#nowMs()),
          })
          .where("slug", "=", areaSlug)
          .executeTakeFirstOrThrow();
        return {
          changed: true,
          entityId: areaSlug,
          before,
          after: {
            area: { ...before.area, label: request.label },
            throttle: before.throttle,
          },
        };
      },
    );
  }

  async deleteControlArea(
    rawAreaSlug: string,
    rawExpectedRevision: number,
  ): Promise<MutationResult> {
    const areaSlug = controlAreaSlugSchema.parse(rawAreaSlug);
    const { expectedRevision } = expectedRevisionSchema.parse({
      expectedRevision: rawExpectedRevision,
    });
    return this.commitControlAreaMutation(
      "deleted",
      areaSlug,
      expectedRevision,
      `Delete control area ${areaSlug}`,
      async (transaction) => {
        const stored = await transaction
          .selectFrom("control_areas")
          .selectAll()
          .where("slug", "=", areaSlug)
          .executeTakeFirst();
        if (stored === undefined) {
          throw new ConfigurationNotFoundError("control_area", areaSlug);
        }
        const owned = await this.areaOwnedResources(
          transaction,
          stored.type_key,
        );
        if (owned.conflicts.length > 0) {
          throw new ConfigurationRelationalConflictError(owned.conflicts);
        }
        const before = await this.controlAreaAuditState(transaction, stored);
        await this.deleteAreaOwnedResources(transaction, owned);
        await transaction
          .deleteFrom("throttles")
          .where("type_key", "=", stored.type_key)
          .execute();
        await transaction
          .deleteFrom("control_areas")
          .where("slug", "=", areaSlug)
          .executeTakeFirstOrThrow();
        return {
          changed: true,
          entityId: areaSlug,
          before,
          after: null,
        };
      },
    );
  }

  async replaceControlAreas(
    rawRequest: ReplaceControlAreasRequest,
  ): Promise<MutationResult> {
    const request = replaceControlAreasRequestSchema.parse(rawRequest);
    const occurredAtMs = assertTime(this.#nowMs());
    const committed = await commitConditionalStateChange<{
      readonly changed: boolean;
      readonly result: {
        readonly before: ControlAreaCollectionAudit;
        readonly after: ControlAreaCollectionAudit;
      };
    }>(
      this.database,
      (audit) => ({
        actor: this.#actor,
        mutationType: "control_areas.replaced",
        summary: "Replace control area collection",
        eventType: "control_areas.replaced",
        entityType: "controller",
        entityId: null,
        occurredAtMs,
        retentionClass: "audit",
        payloadJson: JSON.stringify({
          schemaVersion: 1,
          action: "replaced",
          resource: "control_areas",
          before: audit.before.areas,
          after: audit.after.areas,
        }),
        payloadSchemaVersion: 1,
      }),
      async (transaction) => {
        const storedAreas = await transaction
          .selectFrom("control_areas")
          .selectAll()
          .orderBy("display_order")
          .orderBy("slug")
          .execute();
        const beforeStates = await Promise.all(
          storedAreas.map((area) =>
            this.controlAreaAuditState(transaction, area),
          ),
        );
        const storedBySlug = new Map(
          storedAreas.map((area) => [area.slug, area]),
        );
        const planned = request.areas.map((draft, displayOrder) => {
          if (draft.slug !== null) {
            const stored = storedBySlug.get(draft.slug);
            if (stored === undefined) {
              throw new ConfigurationNotFoundError("control_area", draft.slug);
            }
            return {
              slug: stored.slug,
              typeKey: stored.type_key,
              label: draft.label,
              displayOrder,
              existing: stored,
            };
          }
          const slug = slugifyControlAreaLabel(draft.label);
          if (slug === null) {
            throw new ConfigurationValidationError([
              {
                path: ["areas", displayOrder, "label"],
                code: "invalid_slug",
                message:
                  "Area name must contain at least one Latin letter or number",
              },
            ]);
          }
          return {
            slug,
            typeKey: slug,
            label: draft.label,
            displayOrder,
            existing: null,
          };
        });
        const conflicts: RelationConflict[] = [];
        for (const [index, area] of planned.entries()) {
          const slugOwner = planned.findIndex(
            (candidate) => candidate.slug === area.slug,
          );
          if (slugOwner !== index) {
            conflicts.push({
              resource: "control_area",
              id: area.slug,
              relation: "slug",
              message: "Area names must produce unique URLs",
            });
          }
          const labelOwner = planned.findIndex(
            (candidate) => candidate.label === area.label,
          );
          if (labelOwner !== index) {
            conflicts.push({
              resource: "control_area",
              id: area.slug,
              relation: "label",
              message: "Area names must be unique",
            });
          }
        }
        const retainedSlugs = new Set(
          planned.flatMap((area) =>
            area.existing === null ? [] : [area.existing.slug],
          ),
        );
        const deletedAreas = storedAreas.filter(
          (area) => !retainedSlugs.has(area.slug),
        );
        const ownedByTypeKey = new Map<string, AreaOwnedResources>();
        for (const area of deletedAreas) {
          const owned = await this.areaOwnedResources(
            transaction,
            area.type_key,
          );
          ownedByTypeKey.set(area.type_key, owned);
          conflicts.push(...owned.conflicts);
        }
        const deletedTypeKeys = new Set(
          deletedAreas.map((area) => area.type_key),
        );
        for (const area of planned.filter((item) => item.existing === null)) {
          const throttleId = identifierSchema.parse(`throttle-${area.slug}`);
          const throttleOwner = await transaction
            .selectFrom("throttles")
            .select(["id", "type_key"])
            .where((expression) =>
              expression.or([
                expression("id", "=", throttleId),
                expression("type_key", "=", area.typeKey),
              ]),
            )
            .executeTakeFirst();
          if (
            throttleOwner !== undefined &&
            !deletedTypeKeys.has(throttleOwner.type_key)
          ) {
            conflicts.push({
              resource: "throttle",
              id: throttleOwner.id,
              relation: "control_area",
              message: "The new area would reuse an existing schedule multiplier",
            });
          }
        }
        if (conflicts.length > 0) {
          throw new ConfigurationRelationalConflictError(conflicts);
        }
        const changed =
          storedAreas.length !== planned.length ||
          planned.some(
            (area) =>
              area.existing === null ||
              area.existing.label !== area.label ||
              area.existing.display_order !== area.displayOrder,
          );
        const afterStates: ControlAreaAuditState[] = planned.map((area) => {
          const existingThrottle = beforeStates.find(
            (state) => state.area.slug === area.existing?.slug,
          )?.throttle;
          return {
            area: {
              slug: area.slug,
              typeKey: area.typeKey,
              label: area.label,
            },
            throttle:
              area.existing === null
                ? { id: `throttle-${area.slug}`, percentage: 100 }
                : (existingThrottle ?? null),
          };
        });
        const audit = {
          before: { areas: beforeStates },
          after: { areas: afterStates },
        };
        if (!changed) return { changed: false, result: audit };

        const nowMs = assertTime(this.#nowMs());
        for (const area of deletedAreas) {
          const owned = ownedByTypeKey.get(area.type_key);
          if (owned === undefined) {
            throw new Error("Validated area deletion plan is missing");
          }
          await this.deleteAreaOwnedResources(transaction, owned);
          await transaction
            .deleteFrom("throttles")
            .where("type_key", "=", area.type_key)
            .execute();
          await transaction
            .deleteFrom("control_areas")
            .where("slug", "=", area.slug)
            .executeTakeFirstOrThrow();
        }
        for (const area of planned) {
          if (
            area.existing !== null &&
            area.existing.label !== area.label
          ) {
            await transaction
              .updateTable("control_areas")
              .set({ label: `pending-${randomUUID()}`, updated_at_ms: nowMs })
              .where("slug", "=", area.slug)
              .executeTakeFirstOrThrow();
          }
        }
        for (const area of planned) {
          if (area.existing === null) {
            await transaction
              .insertInto("control_areas")
              .values({
                slug: area.slug,
                type_key: area.typeKey,
                label: area.label,
                display_order: area.displayOrder,
                created_at_ms: nowMs,
                updated_at_ms: nowMs,
              })
              .executeTakeFirstOrThrow();
            await transaction
              .insertInto("throttles")
              .values({
                id: identifierSchema.parse(`throttle-${area.slug}`),
                type_key: area.typeKey,
                percentage: 100,
                created_at_ms: nowMs,
                updated_at_ms: nowMs,
              })
              .executeTakeFirstOrThrow();
          } else if (
            area.existing.label !== area.label ||
            area.existing.display_order !== area.displayOrder
          ) {
            await transaction
              .updateTable("control_areas")
              .set({
                label: area.label,
                display_order: area.displayOrder,
                updated_at_ms: nowMs,
              })
              .where("slug", "=", area.slug)
              .executeTakeFirstOrThrow();
          }
        }
        return { changed: true, result: audit };
      },
      undefined,
      {
        expectedRevision: request.expectedRevision,
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
            existing.color === request.color &&
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
        await this.assertChannelNameAvailable(
          transaction,
          request.name,
          request.typeKey,
          null,
        );
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
            color: request.color,
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
    return this.commitChannelUpdate(channelId, request);
  }

  async updateChannel(
    rawChannelId: string,
    rawRequest: UpdateChannelRequest,
  ): Promise<MutationResult> {
    const channelId = identifierSchema.parse(rawChannelId);
    const request = updateChannelRequestSchema.parse(rawRequest);
    return this.commitChannelUpdate(channelId, request);
  }

  private commitChannelUpdate(
    channelId: string,
    request: {
      readonly expectedRevision: number;
      readonly name: string;
      readonly color?: string | undefined;
    },
  ): Promise<MutationResult> {
    return this.commitMutation(
      "channel",
      channelId,
      "updated",
      request.expectedRevision,
      `Update channel ${channelId}`,
      async (transaction) => {
        const channel = await transaction
          .selectFrom("channels")
          .selectAll()
          .where("id", "=", channelId)
          .executeTakeFirst();
        if (channel === undefined) {
          throw new ConfigurationNotFoundError("channel", channelId);
        }
        const nameChanged = channel.name !== request.name;
        const colorChanged =
          request.color !== undefined && channel.color !== request.color;
        if (!nameChanged && !colorChanged) return false;
        if (nameChanged) {
          await this.assertChannelNameAvailable(
            transaction,
            request.name,
            channel.kind,
            channelId,
          );
        }
        const nowMs = assertTime(this.#nowMs());
        await transaction
          .updateTable("channels")
          .set({
            name: request.name,
            ...(request.color === undefined ? {} : { color: request.color }),
            updated_at_ms: nowMs,
          })
          .where("id", "=", channelId)
          .executeTakeFirstOrThrow();
        if (nameChanged) {
          await transaction
            .updateTable("schedules")
            .set({ name: request.name, updated_at_ms: nowMs })
            .where("channel_id", "=", channelId)
            .executeTakeFirstOrThrow();
        }
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

  async replaceControlAreaChannels(
    rawAreaSlug: string,
    rawRequest: ReplaceControlAreaChannelsRequest,
  ): Promise<MutationResult> {
    const areaSlug = controlAreaSlugSchema.parse(rawAreaSlug);
    const request = replaceControlAreaChannelsRequestSchema.parse(rawRequest);
    return this.commitAreaBatchMutation(
      areaSlug,
      "control_area.channels_replaced",
      request.expectedRevision,
      `Replace channels for control area ${areaSlug}`,
      async (transaction) => {
        const area = await transaction
          .selectFrom("control_areas")
          .selectAll()
          .where("slug", "=", areaSlug)
          .executeTakeFirst();
        if (area === undefined) {
          throw new ConfigurationNotFoundError("control_area", areaSlug);
        }
        const throttle = await transaction
          .selectFrom("throttles")
          .select(["id", "type_key"])
          .where("type_key", "=", area.type_key)
          .executeTakeFirst();
        const storedChannels = await transaction
          .selectFrom("channels")
          .selectAll()
          .where("kind", "=", area.type_key)
          .orderBy("display_order")
          .orderBy("id")
          .execute();
        const storedById = new Map(
          storedChannels.map((channel) => [channel.id, channel]),
        );
        if (
          throttle === undefined &&
          request.channels.some((channel) => !storedById.has(channel.id))
        ) {
          throw new ConfigurationNotFoundError("throttle", area.type_key);
        }
        const requestedIds = new Set(
          request.channels.map((channel) => channel.id),
        );
        const deletedChannels = storedChannels.filter(
          (channel) => !requestedIds.has(channel.id),
        );
        const conflicts: RelationConflict[] = [];
        for (const channel of request.channels) {
          if (storedById.has(channel.id)) continue;
          const owner = await transaction
            .selectFrom("channels")
            .select(["id", "kind"])
            .where("id", "=", channel.id)
            .executeTakeFirst();
          if (owner !== undefined) {
            conflicts.push({
              resource: "channel",
              id: owner.id,
              relation: "identifier",
              message: "Channel identifier belongs to another control area",
            });
          }
          const scheduleOwner = await transaction
            .selectFrom("schedules")
            .select("channel_id")
            .where("id", "=", channel.id)
            .executeTakeFirst();
          if (scheduleOwner !== undefined) {
            conflicts.push({
              resource: "schedule",
              id: channel.id,
              relation: "identifier",
              message: "The channel-owned schedule identifier is already used",
            });
          }
        }
        for (const channel of deletedChannels) {
          const [mapping, override] = await Promise.all([
            transaction
              .selectFrom("pin_mappings")
              .select("id")
              .where("channel_id", "=", channel.id)
              .executeTakeFirst(),
            transaction
              .selectFrom("overrides")
              .select("id")
              .where("channel_id", "=", channel.id)
              .executeTakeFirst(),
          ]);
          if (mapping !== undefined) {
            conflicts.push({
              resource: "pin_mapping",
              id: mapping.id,
              relation: "channel",
              message: "Remove channel pin mappings before deleting the channel",
            });
          }
          if (override !== undefined) {
            conflicts.push({
              resource: "override",
              id: override.id,
              relation: "channel",
              message: "Channel history prevents deletion",
            });
          }
        }
        if (conflicts.length > 0) {
          throw new ConfigurationRelationalConflictError(conflicts);
        }
        const changed =
          storedChannels.length !== request.channels.length ||
          request.channels.some((channel, displayOrder) => {
            const stored = storedById.get(channel.id);
            return (
              stored === undefined ||
              stored.name !== channel.name ||
              stored.color !== channel.color ||
              stored.display_order !== displayOrder
            );
          });
        const affectedIds = new Set([
          ...storedChannels.map((channel) => channel.id),
          ...request.channels.map((channel) => channel.id),
        ]);
        const invalidations: StateInvalidation[] = [
          { resource: "control_area", id: areaSlug },
          ...[...affectedIds].map((id) => ({
            resource: "channel" as const,
            id,
          })),
        ];
        if (!changed) return { changed: false, invalidations };

        const nowMs = assertTime(this.#nowMs());
        for (const channel of deletedChannels) {
          await transaction
            .deleteFrom("schedules")
            .where("channel_id", "=", channel.id)
            .execute();
          await transaction
            .deleteFrom("channels")
            .where("id", "=", channel.id)
            .executeTakeFirstOrThrow();
        }
        for (const channel of request.channels) {
          const stored = storedById.get(channel.id);
          if (stored !== undefined && stored.name !== channel.name) {
            await transaction
              .updateTable("channels")
              .set({ name: `pending-${randomUUID()}`, updated_at_ms: nowMs })
              .where("id", "=", channel.id)
              .executeTakeFirstOrThrow();
          }
        }
        for (const [displayOrder, channel] of request.channels.entries()) {
          const stored = storedById.get(channel.id);
          if (stored === undefined) {
            if (throttle === undefined) {
              throw new Error("Validated control area throttle is missing");
            }
            await transaction
              .insertInto("channels")
              .values({
                id: channel.id,
                name: channel.name,
                color: channel.color,
                kind: area.type_key,
                throttle_id: throttle.id,
                display_order: displayOrder,
                enabled: 1,
                created_at_ms: nowMs,
                updated_at_ms: nowMs,
              })
              .executeTakeFirstOrThrow();
            await transaction
              .insertInto("schedules")
              .values({
                id: channel.id,
                channel_id: channel.id,
                name: channel.name,
                timezone: "UTC",
                enabled: 1,
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
                  schedule_id: channel.id,
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
                  schedule_id: channel.id,
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
            continue;
          }
          if (
            stored.name === channel.name &&
            stored.color === channel.color &&
            stored.display_order === displayOrder
          ) {
            continue;
          }
          await transaction
            .updateTable("channels")
            .set({
              name: channel.name,
              color: channel.color,
              display_order: displayOrder,
              updated_at_ms: nowMs,
            })
            .where("id", "=", channel.id)
            .executeTakeFirstOrThrow();
          if (stored.name !== channel.name) {
            await transaction
              .updateTable("schedules")
              .set({ name: channel.name, updated_at_ms: nowMs })
              .where("channel_id", "=", channel.id)
              .executeTakeFirstOrThrow();
          }
        }
        return { changed: true, invalidations };
      },
    );
  }

  async replaceControlAreaScheduleConfiguration(
    rawAreaSlug: string,
    rawRequest: ReplaceControlAreaScheduleConfigurationRequest,
  ): Promise<MutationResult> {
    const areaSlug = controlAreaSlugSchema.parse(rawAreaSlug);
    const request =
      replaceControlAreaScheduleConfigurationRequestSchema.parse(rawRequest);
    const proposedGraphs = new Map(
      request.schedules.map((schedule) => [
        schedule.channelId,
        validateSchedulePoints(schedule.points),
      ]),
    );
    return this.commitAreaBatchMutation(
      areaSlug,
      "control_area.schedule_configuration_replaced",
      request.expectedRevision,
      `Replace schedule configuration for control area ${areaSlug}`,
      async (transaction) => {
        const area = await transaction
          .selectFrom("control_areas")
          .selectAll()
          .where("slug", "=", areaSlug)
          .executeTakeFirst();
        if (area === undefined) {
          throw new ConfigurationNotFoundError("control_area", areaSlug);
        }
        const throttle = await transaction
          .selectFrom("throttles")
          .selectAll()
          .where("type_key", "=", area.type_key)
          .executeTakeFirst();
        if (throttle === undefined) {
          throw new ConfigurationNotFoundError("throttle", area.type_key);
        }
        const schedules = [];
        const scheduleGraphsById = new Map<string, ValidatedScheduleGraph>();
        for (const draft of request.schedules) {
          const channel = await transaction
            .selectFrom("channels")
            .select(["id", "kind"])
            .where("id", "=", draft.channelId)
            .executeTakeFirst();
          if (channel === undefined) {
            throw new ConfigurationNotFoundError("channel", draft.channelId);
          }
          if (channel.kind !== area.type_key) {
            throw new ConfigurationRelationalConflictError([
              {
                resource: "channel",
                id: channel.id,
                relation: "control_area",
                message: "Schedule channel belongs to another control area",
              },
            ]);
          }
          const schedule = await transaction
            .selectFrom("schedules")
            .selectAll()
            .where("channel_id", "=", channel.id)
            .executeTakeFirst();
          if (schedule === undefined) {
            throw new ConfigurationNotFoundError("schedule", channel.id);
          }
          const storedPoints = await transaction
            .selectFrom("schedule_points")
            .selectAll()
            .where("schedule_id", "=", schedule.id)
            .orderBy("position")
            .execute();
          const changed =
            storedPoints.length !== draft.points.length ||
            storedPoints.some((point, index) => {
              const expected = draft.points[index];
              return (
                expected === undefined ||
                point.id !== expected.id ||
                point.position !== expected.position ||
                point.minute_of_day !== expected.minuteOfDay ||
                point.percentage !== expected.percentage ||
                point.editor_x !== expected.editorX ||
                point.editor_y !== expected.editorY
              );
            });
          if (changed) {
            const requestedIds = draft.points.map((point) => point.id);
            const reusedId = await transaction
              .selectFrom("schedule_points")
              .select("id")
              .where("id", "in", requestedIds)
              .where("schedule_id", "!=", schedule.id)
              .executeTakeFirst();
            if (reusedId !== undefined) {
              throw new ConfigurationRelationalConflictError([
                {
                  resource: "schedule_point",
                  id: reusedId.id,
                  relation: "identifier",
                  message:
                    "Schedule point identifier belongs to another schedule",
                },
              ]);
            }
            const graph = proposedGraphs.get(draft.channelId);
            if (graph === undefined) {
              throw new Error("Validated schedule graph is missing");
            }
            scheduleGraphsById.set(schedule.id, graph);
          }
          schedules.push({ draft, schedule, changed });
        }
        const throttleChanged =
          request.throttlePercentage !== undefined &&
          request.throttlePercentage !== throttle.percentage;
        const changedSchedules = schedules.filter((entry) => entry.changed);
        const invalidations: StateInvalidation[] = [
          { resource: "control_area", id: areaSlug },
          ...changedSchedules.map(({ schedule }) => ({
            resource: "schedule" as const,
            id: schedule.id,
          })),
          ...(throttleChanged
            ? [{ resource: "throttle" as const, id: throttle.id }]
            : []),
        ];
        if (changedSchedules.length === 0 && !throttleChanged) {
          return { changed: false, invalidations };
        }
        if (changedSchedules.length > 0) {
          await this.assertFirmwareCapacity(transaction, scheduleGraphsById);
        }
        const nowMs = assertTime(this.#nowMs());
        for (const { draft, schedule } of changedSchedules) {
          await transaction
            .deleteFrom("schedule_points")
            .where("schedule_id", "=", schedule.id)
            .execute();
          await transaction
            .insertInto("schedule_points")
            .values(
              draft.points.map((point) => ({
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
        }
        if (throttleChanged) {
          await transaction
            .updateTable("throttles")
            .set({
              percentage: request.throttlePercentage,
              updated_at_ms: nowMs,
            })
            .where("id", "=", throttle.id)
            .executeTakeFirstOrThrow();
        }
        return { changed: true, invalidations };
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
          new Map([[schedule.id, proposedGraph]]),
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
          .select(["id", "name"])
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
        const assignedDevices = await transaction
          .selectFrom("devices")
          .select(["id", "reported_hardware_profile_id"])
          .where("mapping_profile_id", "=", profileId)
          .execute();
        for (const device of assignedDevices) {
          if (
            device.reported_hardware_profile_id !== null &&
            device.reported_hardware_profile_id !== request.hardwareProfileId
          ) {
            conflicts.push({
              resource: "device",
              id: device.id,
              relation: "hardware_profile",
              message: `Device ${device.id} reports hardware profile ${device.reported_hardware_profile_id}`,
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
          profile.hardware_profile_id === request.hardwareProfileId &&
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
              device_name_prefix: profileId,
              hardware_profile_id: request.hardwareProfileId,
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
              hardware_profile_id: request.hardwareProfileId,
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

  async deleteMappingProfile(
    rawProfileId: string,
    rawExpectedRevision: number,
  ): Promise<MutationResult> {
    const profileId =
      mappingProfileParamsSchema.shape.profileId.parse(rawProfileId);
    const { expectedRevision } = expectedRevisionSchema.parse({
      expectedRevision: rawExpectedRevision,
    });
    return this.commitMutation(
      "mapping_profile",
      profileId,
      "deleted",
      expectedRevision,
      `Delete mapping profile ${profileId}`,
      async (transaction) => {
        const profile = await transaction
          .selectFrom("mapping_profiles")
          .select("id")
          .where("id", "=", profileId)
          .executeTakeFirst();
        if (profile === undefined) {
          throw new ConfigurationNotFoundError("mapping_profile", profileId);
        }
        const nowMs = assertTime(this.#nowMs());
        await transaction
          .updateTable("devices")
          .set({ mapping_profile_id: null, updated_at_ms: nowMs })
          .where("mapping_profile_id", "=", profileId)
          .execute();
        await transaction
          .deleteFrom("mapping_profiles")
          .where("id", "=", profileId)
          .executeTakeFirstOrThrow();
        return true;
      },
    );
  }

  async setDeviceEnabled(
    rawDeviceId: string,
    rawRequest: SetDeviceEnabledRequest,
  ): Promise<MutationResult> {
    const deviceId = identifierSchema.parse(rawDeviceId);
    const request = setDeviceEnabledRequestSchema.parse(rawRequest);
    if (deviceId === CONTROLLER_STORAGE_HEALTH_DEVICE_ID) {
      throw new ConfigurationNotFoundError("device", deviceId);
    }
    return this.commitMutation(
      "device",
      deviceId,
      "updated",
      request.expectedRevision,
      `${request.enabled ? "Include" : "Exclude"} device ${deviceId}`,
      async (transaction) => {
        const device = await transaction
          .selectFrom("devices")
          .select(["id", "enabled", "status", "last_error_code"])
          .where("id", "=", deviceId)
          .executeTakeFirst();
        if (device === undefined) {
          throw new ConfigurationNotFoundError("device", deviceId);
        }
        if (device.enabled === (request.enabled ? 1 : 0)) {
          return false;
        }
        await transaction
          .updateTable("devices")
          .set({
            enabled: request.enabled ? 1 : 0,
            ...(request.enabled &&
            device.last_error_code === "protocol_invalid_response"
              ? {
                  status: "unknown" as const,
                  last_error_code: null,
                  last_error_message: null,
                }
              : {}),
            updated_at_ms: assertTime(this.#nowMs()),
          })
          .where("id", "=", deviceId)
          .executeTakeFirstOrThrow();
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
    const manualOverrideAggregate = [
      "manual_override_start",
      "manual_override_cancel",
      "manual_override_expire",
    ].includes(operation.kind);
    let request:
      | ReturnType<typeof deviceOperationRequestSchema.parse>
      | ReturnType<typeof manualOverrideOperationRequestSchema.parse>;
    let result:
      | ReturnType<typeof deviceOperationResultSchema.parse>
      | ReturnType<typeof manualOverrideOperationResultSchema.parse>
      | null;
    if (manualOverrideAggregate) {
      if (operation.device_id !== null) {
        throw new Error(
          `Manual override operation ${operation.id} unexpectedly references a device`,
        );
      }
      request = parseStoredDocument(
        operation.request_json,
        operation.request_schema_version,
        MANUAL_OVERRIDE_OPERATION_SCHEMA_VERSION,
        manualOverrideOperationRequestSchema,
        `manual override operation ${operation.id} request`,
      );
      result = parseOptionalOperationResult(
        operation,
        MANUAL_OVERRIDE_OPERATION_SCHEMA_VERSION,
        manualOverrideOperationResultSchema,
        "manual override operation",
      );
    } else {
      if (operation.device_id === null) {
        throw new Error(`Device operation ${operation.id} has no device`);
      }
      const deviceRequest = parseStoredDocument(
        operation.request_json,
        operation.request_schema_version,
        DEVICE_OPERATION_REQUEST_SCHEMA_VERSION,
        deviceOperationRequestSchema,
        `operation ${operation.id} request`,
      );
      const deviceResult = parseOptionalOperationResult(
        operation,
        DEVICE_OPERATION_RESULT_SCHEMA_VERSION,
        deviceOperationResultSchema,
        "operation",
      );
      if (deviceResult !== null) {
        assertDeviceOperationResultMatchesRequest(deviceRequest, deviceResult);
      }
      request = deviceRequest;
      result = deviceResult;
    }
    if (request.kind !== operation.kind) {
      throw new Error(
        `Persisted operation ${operation.id} kind does not match its request`,
      );
    }
    if (result !== null && result.status !== operation.status) {
      throw new Error(
        `Persisted operation ${operation.id} status does not match its result`,
      );
    }
    const terminal = !["pending", "in_flight"].includes(operation.status);
    if (terminal !== (operation.completed_at_ms !== null && result !== null)) {
      throw new Error(
        `Persisted operation ${operation.id} completion fields do not match its status`,
      );
    }
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

  private async controlAreaAuditState(
    transaction: StateDatabaseTransaction,
    row: Selectable<StateDatabaseSchema["control_areas"]>,
  ): Promise<ControlAreaAuditState> {
    const throttle = await transaction
      .selectFrom("throttles")
      .select(["id", "percentage"])
      .where("type_key", "=", row.type_key)
      .executeTakeFirst();
    return {
      area: storedControlArea(row),
      throttle: throttle ?? null,
    };
  }

  private async areaOwnedResources(
    transaction: StateDatabaseTransaction,
    typeKey: string,
  ): Promise<AreaOwnedResources> {
    const [channels, outputs] = await Promise.all([
      transaction
        .selectFrom("channels")
        .select("id")
        .where("kind", "=", typeKey)
        .execute(),
      transaction
        .selectFrom("outputs")
        .select("id")
        .where("kind", "=", typeKey)
        .execute(),
    ]);
    const conflicts: RelationConflict[] = [];
    for (const channel of channels) {
      const [mapping, override] = await Promise.all([
        transaction
          .selectFrom("pin_mappings")
          .select("id")
          .where("channel_id", "=", channel.id)
          .executeTakeFirst(),
        transaction
          .selectFrom("overrides")
          .select("id")
          .where("channel_id", "=", channel.id)
          .executeTakeFirst(),
      ]);
      if (mapping !== undefined) {
        conflicts.push({
          resource: "pin_mapping",
          id: mapping.id,
          relation: "channel",
          message: "Remove channel pin mappings before deleting the area",
        });
      }
      if (override !== undefined) {
        conflicts.push({
          resource: "override",
          id: override.id,
          relation: "channel",
          message: "Channel history prevents deleting the area",
        });
      }
    }
    for (const output of outputs) {
      const [mapping, override, timer, calibration, program, alertRule] =
        await Promise.all([
          transaction
            .selectFrom("pin_mappings")
            .select("id")
            .where("output_id", "=", output.id)
            .executeTakeFirst(),
          transaction
            .selectFrom("overrides")
            .select("id")
            .where("output_id", "=", output.id)
            .executeTakeFirst(),
          transaction
            .selectFrom("timers")
            .select("id")
            .where("target_output_id", "=", output.id)
            .executeTakeFirst(),
          transaction
            .selectFrom("pump_calibrations")
            .select("id")
            .where("output_id", "=", output.id)
            .executeTakeFirst(),
          transaction
            .selectFrom("dsl_program_revisions")
            .select("id")
            .where("output_id", "=", output.id)
            .executeTakeFirst(),
          transaction
            .selectFrom("alert_rules")
            .select("id")
            .where("output_id", "=", output.id)
            .executeTakeFirst(),
        ]);
      const references = [
        mapping === undefined
          ? null
          : {
              resource: "pin_mapping" as const,
              id: mapping.id,
              relation: "output",
              message: "Remove output pin mappings before deleting the area",
            },
        override === undefined
          ? null
          : {
              resource: "override" as const,
              id: override.id,
              relation: "output",
              message: "Output history prevents deleting the area",
            },
        timer === undefined
          ? null
          : {
              resource: "timer" as const,
              id: timer.id,
              relation: "output",
              message: "A timer still targets this area's output",
            },
        calibration === undefined
          ? null
          : {
              resource: "pump_calibration" as const,
              id: calibration.id,
              relation: "output",
              message: "Pump calibration history prevents deleting the area",
            },
        program === undefined
          ? null
          : {
              resource: "dsl_program_revision" as const,
              id: program.id,
              relation: "output",
              message: "Program history prevents deleting the area",
            },
        alertRule === undefined
          ? null
          : {
              resource: "alert_rule" as const,
              id: alertRule.id,
              relation: "output",
              message: "An alert rule still uses this area's output",
            },
      ];
      conflicts.push(
        ...references.filter(
          (reference): reference is NonNullable<typeof reference> =>
            reference !== null,
        ),
      );
    }
    return {
      channelIds: channels.map((channel) => channel.id),
      outputIds: outputs.map((output) => output.id),
      conflicts,
    };
  }

  private async deleteAreaOwnedResources(
    transaction: StateDatabaseTransaction,
    owned: AreaOwnedResources,
  ): Promise<void> {
    if (owned.channelIds.length > 0) {
      await transaction
        .deleteFrom("schedules")
        .where("channel_id", "in", owned.channelIds)
        .execute();
      await transaction
        .deleteFrom("channels")
        .where("id", "in", owned.channelIds)
        .execute();
    }
    if (owned.outputIds.length > 0) {
      await transaction
        .deleteFrom("outputs")
        .where("id", "in", owned.outputIds)
        .execute();
    }
  }

  private async assertControlAreaAvailable(
    transaction: StateDatabaseTransaction,
    slug: string,
    typeKey: string,
    label: string,
    exceptSlug: string | null,
  ): Promise<void> {
    const areas = await transaction
      .selectFrom("control_areas")
      .select(["slug", "type_key", "label"])
      .execute();
    const conflicts: RelationConflict[] = [];
    const slugOwner = areas.find(
      (area) => area.slug === slug && area.slug !== exceptSlug,
    );
    if (slugOwner !== undefined) {
      conflicts.push({
        resource: "control_area",
        id: slugOwner.slug,
        relation: "slug",
        message: "An area with this URL already exists",
      });
    }
    const typeOwner = areas.find(
      (area) => area.type_key === typeKey && area.slug !== exceptSlug,
    );
    if (typeOwner !== undefined) {
      conflicts.push({
        resource: "control_area",
        id: typeOwner.slug,
        relation: "type_key",
        message: "An area with this control type already exists",
      });
    }
    const labelOwner = areas.find(
      (area) => area.label === label && area.slug !== exceptSlug,
    );
    if (labelOwner !== undefined) {
      conflicts.push({
        resource: "control_area",
        id: labelOwner.slug,
        relation: "label",
        message: "An area with this name already exists",
      });
    }
    if (conflicts.length > 0) {
      throw new ConfigurationRelationalConflictError(conflicts);
    }
  }

  private async commitControlAreaMutation(
    action: "created" | "updated" | "deleted",
    fallbackEntityId: string,
    expectedRevision: number,
    summary: string,
    mutate: (
      transaction: StateDatabaseTransaction,
    ) => Promise<ControlAreaMutationOutcome>,
  ): Promise<MutationResult> {
    const occurredAtMs = assertTime(this.#nowMs());
    const committed = await commitConditionalStateChange<{
      readonly changed: boolean;
      readonly result: ControlAreaMutationOutcome;
    }>(
      this.database,
      (outcome) => {
        const payload = controlAreaMutationEventV1Schema.parse({
          schemaVersion: 1,
          action,
          resource: "control_area",
          id: outcome.entityId,
          before: outcome.before?.area ?? null,
          after: outcome.after?.area ?? null,
          throttle: outcome.after?.throttle ?? outcome.before?.throttle ?? null,
        });
        return {
          actor: this.#actor,
          mutationType: `control_area.${action}`,
          summary,
          eventType: `control_area.${action}`,
          entityType: "control_area" as const,
          entityId: outcome.entityId,
          occurredAtMs,
          retentionClass: "audit" as const,
          payloadJson: JSON.stringify(payload),
          payloadSchemaVersion: 1,
        };
      },
      async (transaction) => {
        const outcome = await mutate(transaction);
        return { changed: outcome.changed, result: outcome };
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

  private async commitAreaBatchMutation(
    areaSlug: string,
    eventType: string,
    expectedRevision: number,
    summary: string,
    mutate: (
      transaction: StateDatabaseTransaction,
    ) => Promise<BatchMutationOutcome>,
  ): Promise<MutationResult> {
    const occurredAtMs = assertTime(this.#nowMs());
    const committed = await commitConditionalStateChange<{
      readonly changed: boolean;
      readonly result: BatchMutationOutcome;
    }>(
      this.database,
      (outcome) => ({
        actor: this.#actor,
        mutationType: eventType,
        summary,
        eventType,
        entityType: "control_area",
        entityId: areaSlug,
        occurredAtMs,
        retentionClass: "audit",
        invalidations: outcome.invalidations,
        payloadJson: JSON.stringify(
          configurationMutationEventV1Schema.parse({
            schemaVersion: 1,
            action: "replaced",
            resource: "control_area",
            id: areaSlug,
          }),
        ),
        payloadSchemaVersion: 1,
      }),
      async (transaction) => {
        const outcome = await mutate(transaction);
        return { changed: outcome.changed, result: outcome };
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

  private async commitMutation(
    resource:
      | "channel"
      | "schedule"
      | "throttle"
      | "mapping_profile"
      | "device"
      | "alert_rule",
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
    typeKey: string,
    exceptId: string | null,
  ): Promise<void> {
    let query = transaction
      .selectFrom("channels")
      .select("id")
      .where("name", "=", name)
      .where("kind", "=", typeKey);
    if (exceptId !== null) query = query.where("id", "!=", exceptId);
    const owner = await query.executeTakeFirst();
    if (owner !== undefined) {
      relationalConflict({
        resource: "channel",
        id: owner.id,
        relation: "name",
        message: "Channel name is already in use in this control area",
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
    proposedGraphs: ReadonlyMap<string, ValidatedScheduleGraph>,
  ): Promise<void> {
    const [mappings, mappingProfiles, channels, schedules, points, throttles] =
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
        transaction.selectFrom("mapping_profiles").selectAll().execute(),
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
    const profileById = new Map(
      mappingProfiles.map((profile) => [profile.id, profile]),
    );
    const profileIds = [
      ...new Set(mappings.map((mapping) => mapping.mapping_profile_id)),
    ];
    for (const profileId of profileIds) {
      const profile = profileById.get(profileId);
      if (profile === undefined) {
        throw new Error(`Persisted mapping profile ${profileId} is missing`);
      }
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
          const proposedGraph = proposedGraphs.get(schedule.id);
          if (proposedGraph !== undefined) {
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
              outputGain: profile.output_gain,
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
