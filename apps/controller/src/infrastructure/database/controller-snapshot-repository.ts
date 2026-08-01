import {
  alertDetailsSchema,
  alertNotificationV1Schema,
  controllerSnapshotSchema,
  type AlertNotificationV1,
  type ControllerSnapshot,
  type ControlArea,
} from "@aquarium/contracts";
import { sql, type Kysely, type Selectable } from "kysely";
import { z, type ZodType } from "zod";

import {
  DEVICE_OPERATION_RESULT_SCHEMA_VERSION,
  deviceOperationResultSchema,
} from "../../application/operations/index.js";
import { CONTROLLER_STORAGE_HEALTH_DEVICE_ID } from "../../application/maintenance/controller-storage-health-service.js";
import type { ControllerSnapshotReader } from "../../application/snapshot/index.js";
import { parseJsonDocument } from "../import/strict-json.js";
import type { StateDatabaseSchema } from "./types.js";

export const RECENT_OPERATION_LIMIT = 100;
export const UNRESOLVED_DEVICE_OPERATION_LIMIT = 100;
const RECENT_IMPORT_RUN_LIMIT = 100;
const ALERT_DELIVERY_LIMIT = 100;
const outcomeUnknownReconciliationSchema = z.object({
  status: z.literal("outcome_unknown"),
  reconciledAtMs: z
    .number()
    .int()
    .nonnegative()
    .max(Number.MAX_SAFE_INTEGER)
    .nullable(),
});

export const CONTROL_AREA_DEFINITIONS = [
  { slug: "lights", typeKey: "light", label: "Lights" },
  { slug: "pumps", typeKey: "pump", label: "Pumps" },
  { slug: "testlights", typeKey: "testlight", label: "Test lights" },
  { slug: "bad", typeKey: "bad", label: "Bad" },
  { slug: "loft", typeKey: "loft", label: "Loft" },
  { slug: "biljard", typeKey: "biljard", label: "Biljard" },
  { slug: "frag", typeKey: "frag", label: "Frag" },
  { slug: "qt1", typeKey: "qt1", label: "QT1" },
  { slug: "qt2", typeKey: "qt2", label: "QT2" },
  { slug: "qt3", typeKey: "qt3", label: "QT3" },
  { slug: "qt4", typeKey: "qt4", label: "QT4" },
] as const satisfies readonly ControlArea[];

export interface ControllerSnapshotRepositoryOptions {
  readonly now?: () => Date;
}

export class InvalidPersistedSnapshotDataError extends Error {
  override readonly name = "InvalidPersistedSnapshotDataError";

  constructor(subject: string) {
    super(`Persisted ${subject} failed snapshot validation`);
  }
}

function toIsoTimestamp(value: number, subject: string): string {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new InvalidPersistedSnapshotDataError(subject);
  }
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new InvalidPersistedSnapshotDataError(subject);
  }
  return date.toISOString();
}

function parseStoredJson<Output>(
  source: string,
  schemaVersion: number,
  expectedSchemaVersion: number | null,
  schema: ZodType<Output>,
  subject: string,
): Output {
  try {
    if (
      !Number.isSafeInteger(schemaVersion) ||
      schemaVersion <= 0 ||
      (expectedSchemaVersion !== null &&
        schemaVersion !== expectedSchemaVersion)
    ) {
      throw new Error("Unsupported persisted JSON schema version");
    }
    const document = parseJsonDocument(source, subject);
    if (document.duplicateKeys.length > 0) {
      throw new Error("Persisted JSON contains duplicate keys");
    }
    return schema.parse(document.value);
  } catch {
    throw new InvalidPersistedSnapshotDataError(subject);
  }
}

function parseOptionalStoredJson<Output>(
  source: string | null,
  schemaVersion: number | null,
  expectedSchemaVersion: number | null,
  schema: ZodType<Output>,
  subject: string,
): Output | null {
  if (source === null && schemaVersion === null) return null;
  if (source === null || schemaVersion === null) {
    throw new InvalidPersistedSnapshotDataError(subject);
  }
  return parseStoredJson(
    source,
    schemaVersion,
    expectedSchemaVersion,
    schema,
    subject,
  );
}

function toOperationSummary(
  operation: Selectable<StateDatabaseSchema["control_operations"]>,
) {
  return {
    id: operation.id,
    deviceId: operation.device_id,
    kind: operation.kind,
    status: operation.status,
    requestedAt: toIsoTimestamp(
      operation.requested_at_ms,
      `operation ${operation.id} request time`,
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
            `operation ${operation.id} completion time`,
          ),
    outcomeUnresolved: operationOutcomeUnresolved(operation),
  };
}

function operationOutcomeUnresolved(
  operation: Selectable<StateDatabaseSchema["control_operations"]>,
): boolean {
  if (operation.status !== "outcome_unknown") {
    return false;
  }
  const result = parseOptionalStoredJson(
    operation.result_json,
    operation.result_schema_version,
    null,
    outcomeUnknownReconciliationSchema,
    `operation ${operation.id} reconciliation state`,
  );
  if (result === null) {
    throw new InvalidPersistedSnapshotDataError(
      `operation ${operation.id} reconciliation state`,
    );
  }
  return result.reconciledAtMs === null;
}

export class ControllerSnapshotRepository implements ControllerSnapshotReader {
  readonly #now: () => Date;

  constructor(
    private readonly database: Kysely<StateDatabaseSchema>,
    options: ControllerSnapshotRepositoryOptions = {},
  ) {
    this.#now = options.now ?? (() => new Date());
  }

  read(): Promise<ControllerSnapshot> {
    return this.database.transaction().execute(async (transaction) => {
      // This first read establishes the SQLite read snapshot. Every projection
      // below uses the same transaction and therefore the same state revision.
      const revisionRow = await transaction
        .selectFrom("state_revisions")
        .select(["revision", "committed_at_ms"])
        .orderBy("revision", "desc")
        .limit(1)
        .executeTakeFirst();

      const [
        channelRows,
        scheduleRows,
        schedulePointRows,
        throttleRows,
        outputRows,
        profileRows,
        mappingRows,
        deviceRows,
        operationRows,
        unresolvedDeviceOperationRows,
        importRunRows,
        overrideRows,
        alertRuleRows,
        alertRows,
      ] = await Promise.all([
        transaction
          .selectFrom("channels")
          .selectAll()
          .orderBy("kind", "asc")
          .orderBy("display_order", "asc")
          .orderBy("id", "asc")
          .execute(),
        transaction
          .selectFrom("schedules")
          .selectAll()
          .orderBy("channel_id", "asc")
          .orderBy("id", "asc")
          .execute(),
        transaction
          .selectFrom("schedule_points")
          .selectAll()
          .orderBy("schedule_id", "asc")
          .orderBy("position", "asc")
          .orderBy("id", "asc")
          .execute(),
        transaction
          .selectFrom("throttles")
          .selectAll()
          .orderBy("type_key", "asc")
          .orderBy("id", "asc")
          .execute(),
        transaction
          .selectFrom("outputs")
          .selectAll()
          .orderBy("kind", "asc")
          .orderBy("display_order", "asc")
          .orderBy("id", "asc")
          .execute(),
        transaction
          .selectFrom("mapping_profiles")
          .selectAll()
          .orderBy("device_name_prefix", "asc")
          .orderBy("id", "asc")
          .execute(),
        transaction
          .selectFrom("pin_mappings")
          .selectAll()
          .orderBy("mapping_profile_id", "asc")
          .orderBy("display_order", "asc")
          .orderBy("id", "asc")
          .execute(),
        transaction
          .selectFrom("devices")
          .selectAll()
          .where("id", "!=", CONTROLLER_STORAGE_HEALTH_DEVICE_ID)
          .orderBy("id", "asc")
          .execute(),
        transaction
          .selectFrom("control_operations")
          .selectAll()
          .where((expression) =>
            expression.or([
              expression("kind", "!=", "set_pwm"),
              expression("status", "in", [
                "failed",
                "timed_out",
                "outcome_unknown",
                "cancelled",
              ]),
            ]),
          )
          .orderBy("requested_at_ms", "desc")
          .orderBy("id", "asc")
          .limit(RECENT_OPERATION_LIMIT + 1)
          .execute(),
        transaction
          .selectFrom("control_operations")
          .selectAll()
          .where("device_id", "is not", null)
          .where("status", "=", "outcome_unknown")
          .where(
            sql<boolean>`json_extract(${sql.ref("result_json")}, '$.reconciledAtMs') is null`,
          )
          .orderBy("requested_at_ms", "asc")
          .orderBy("id", "asc")
          .limit(UNRESOLVED_DEVICE_OPERATION_LIMIT + 1)
          .execute(),
        transaction
          .selectFrom("import_runs")
          .selectAll()
          .orderBy("started_at_ms", "desc")
          .orderBy("id", "asc")
          .limit(RECENT_IMPORT_RUN_LIMIT)
          .execute(),
        transaction
          .selectFrom("overrides")
          .selectAll()
          .where("status", "in", ["pending", "active"])
          .orderBy("requested_at_ms", "desc")
          .orderBy("id", "asc")
          .execute(),
        transaction
          .selectFrom("alert_rules")
          .selectAll()
          .where((expression) =>
            expression.or([
              expression("source_type", "!=", "device"),
              expression(
                "device_id",
                "!=",
                CONTROLLER_STORAGE_HEALTH_DEVICE_ID,
              ),
            ]),
          )
          .orderBy("id", "asc")
          .execute(),
        transaction
          .selectFrom("active_alerts")
          .selectAll()
          .where("state", "!=", "recovered")
          .orderBy("opened_at_ms", "desc")
          .orderBy("id", "asc")
          .execute(),
      ]);
      const publicAlertRuleIds = new Set(alertRuleRows.map((rule) => rule.id));
      const publicAlertRows = alertRows.filter((alert) =>
        publicAlertRuleIds.has(alert.alert_rule_id),
      );
      const deliveryRows = (
        await Promise.all(
          publicAlertRows.map((alert) =>
            transaction
              .selectFrom("notification_deliveries")
              .selectAll()
              .where("alert_id", "=", alert.id)
              .orderBy("created_at_ms", "desc")
              .orderBy("id", "desc")
              .limit(ALERT_DELIVERY_LIMIT)
              .execute(),
          ),
        )
      ).flat();

      const schedules = scheduleRows.map((schedule) => ({
        id: schedule.id,
        channelId: schedule.channel_id,
        name: schedule.name,
        timezone: schedule.timezone,
        enabled: schedule.enabled === 1,
        graphRevision: schedule.graph_revision,
        createdAt: toIsoTimestamp(
          schedule.created_at_ms,
          `schedule ${schedule.id} creation time`,
        ),
        updatedAt: toIsoTimestamp(
          schedule.updated_at_ms,
          `schedule ${schedule.id} update time`,
        ),
        points: schedulePointRows
          .filter((point) => point.schedule_id === schedule.id)
          .map((point) => ({
            id: point.id,
            position: point.position,
            minuteOfDay: point.minute_of_day,
            percentage: point.percentage,
            editorX: point.editor_x,
            editorY: point.editor_y,
          })),
      }));

      const mappingProfiles = profileRows.map((profile) => ({
        id: profile.id,
        name: profile.name,
        deviceNamePrefix: profile.device_name_prefix,
        outputGain: profile.output_gain,
        createdAt: toIsoTimestamp(
          profile.created_at_ms,
          `mapping profile ${profile.id} creation time`,
        ),
        updatedAt: toIsoTimestamp(
          profile.updated_at_ms,
          `mapping profile ${profile.id} update time`,
        ),
        mappings: mappingRows
          .filter((mapping) => mapping.mapping_profile_id === profile.id)
          .map((mapping) => {
            if (mapping.channel_id === null && mapping.output_id === null) {
              throw new InvalidPersistedSnapshotDataError(
                `pin mapping ${mapping.id} target`,
              );
            }
            if (mapping.channel_id !== null && mapping.output_id !== null) {
              throw new InvalidPersistedSnapshotDataError(
                `pin mapping ${mapping.id} target`,
              );
            }
            return {
              id: mapping.id,
              pin: mapping.pin,
              displayOrder: mapping.display_order,
              enabled: mapping.enabled === 1,
              target:
                mapping.channel_id === null
                  ? { kind: "output" as const, id: mapping.output_id }
                  : { kind: "channel" as const, id: mapping.channel_id },
            };
          }),
      }));

      const devices = deviceRows.map((device) => {
        parseOptionalStoredJson(
          device.metadata_json,
          device.metadata_schema_version,
          null,
          z.json(),
          `device ${device.id} metadata`,
        );
        const hasErrorCode = device.last_error_code !== null;
        if (hasErrorCode !== (device.last_error_message !== null)) {
          throw new InvalidPersistedSnapshotDataError(
            `device ${device.id} error`,
          );
        }
        return {
          id: device.id,
          hardwareId: device.hardware_id,
          mappingProfileId: device.mapping_profile_id,
          desired: {
            name: device.name,
            pwmFrequencyHz: device.desired_pwm_frequency_hz,
            pwmResolutionBits: device.desired_pwm_resolution_bits,
          },
          reported: {
            name: device.reported_name,
            pwmFrequencyHz: device.reported_pwm_frequency_hz,
            pwmResolutionBits: device.reported_pwm_resolution_bits,
            firmwareVersion: device.firmware_version,
            scheduleHash: device.reported_schedule_hash,
          },
          status: device.status,
          lastSeenAt:
            device.last_seen_at_ms === null
              ? null
              : toIsoTimestamp(
                  device.last_seen_at_ms,
                  `device ${device.id} last-seen time`,
                ),
          lastError:
            device.last_error_code === null ||
            device.last_error_message === null
              ? null
              : {
                  code: device.last_error_code,
                  message: device.last_error_message,
                },
          enabled: device.enabled === 1,
          createdAt: toIsoTimestamp(
            device.created_at_ms,
            `device ${device.id} creation time`,
          ),
          updatedAt: toIsoTimestamp(
            device.updated_at_ms,
            `device ${device.id} update time`,
          ),
        };
      });

      const operationWindow = operationRows.slice(0, RECENT_OPERATION_LIMIT);
      const operations = operationWindow.map((operation) => {
        parseStoredJson(
          operation.request_json,
          operation.request_schema_version,
          null,
          z.json(),
          `operation ${operation.id} request`,
        );
        parseOptionalStoredJson(
          operation.result_json,
          operation.result_schema_version,
          null,
          z.json(),
          `operation ${operation.id} result`,
        );
        return toOperationSummary(operation);
      });
      const unresolvedDeviceOperationWindow =
        unresolvedDeviceOperationRows.slice(
          0,
          UNRESOLVED_DEVICE_OPERATION_LIMIT,
        );
      const unresolvedDeviceOperations = unresolvedDeviceOperationWindow.map(
        (operation) => {
          const result = parseOptionalStoredJson(
            operation.result_json,
            operation.result_schema_version,
            DEVICE_OPERATION_RESULT_SCHEMA_VERSION,
            deviceOperationResultSchema,
            `operation ${operation.id} result`,
          );
          if (
            result?.status !== "outcome_unknown" ||
            result.reconciledAtMs !== null
          ) {
            throw new InvalidPersistedSnapshotDataError(
              `operation ${operation.id} unresolved outcome`,
            );
          }
          return toOperationSummary(operation);
        },
      );

      const importRuns = importRunRows.map((run) => {
        parseOptionalStoredJson(
          run.report_json,
          run.report_schema_version,
          null,
          z.json(),
          `import run ${run.id} report`,
        );
        return {
          id: run.id,
          sourceKind: run.source_kind,
          sourceFingerprint: run.source_fingerprint,
          dryRun: run.dry_run === 1,
          status: run.status,
          startedAt: toIsoTimestamp(
            run.started_at_ms,
            `import run ${run.id} start time`,
          ),
          completedAt:
            run.completed_at_ms === null
              ? null
              : toIsoTimestamp(
                  run.completed_at_ms,
                  `import run ${run.id} completion time`,
                ),
        };
      });

      const alertRules = alertRuleRows.map((rule) => {
        parseOptionalStoredJson(
          rule.configuration_json,
          rule.configuration_schema_version,
          null,
          z.json(),
          `alert rule ${rule.id} configuration`,
        );
        let sourceId: string | null;
        switch (rule.source_type) {
          case "device":
            sourceId = rule.device_id;
            break;
          case "output":
            sourceId = rule.output_id;
            break;
          case "sensor":
            sourceId = rule.sensor_id;
            break;
          case "switch":
            sourceId = rule.switch_id;
            break;
        }
        if (sourceId === null) {
          throw new InvalidPersistedSnapshotDataError(
            `alert rule ${rule.id} source`,
          );
        }
        return {
          id: rule.id,
          name: rule.name,
          source: { type: rule.source_type, id: sourceId },
          condition:
            rule.source_type === "output" || rule.source_type === "sensor"
              ? { kind: rule.condition, threshold: rule.threshold }
              : { kind: rule.condition },
          delayMs: rule.delay_ms,
          severity: rule.severity,
          enabled: rule.enabled === 1,
          createdAt: toIsoTimestamp(
            rule.created_at_ms,
            `alert rule ${rule.id} creation time`,
          ),
          updatedAt: toIsoTimestamp(
            rule.updated_at_ms,
            `alert rule ${rule.id} update time`,
          ),
        };
      });

      const alerts = publicAlertRows.map((alert) => {
        const details = parseOptionalStoredJson(
          alert.details_json,
          alert.details_schema_version,
          1,
          alertDetailsSchema,
          `alert ${alert.id} details`,
        );
        const notificationDeliveries = deliveryRows
          .filter((delivery) => delivery.alert_id === alert.id)
          .map((delivery) => {
            const notification = parseStoredJson(
              delivery.notification_json,
              delivery.notification_schema_version,
              1,
              alertNotificationV1Schema,
              `notification delivery ${delivery.id}`,
            );
            validateNotificationBinding(notification, delivery);
            const hasErrorCode = delivery.last_error_code !== null;
            if (hasErrorCode !== (delivery.last_error_message !== null)) {
              throw new InvalidPersistedSnapshotDataError(
                `notification delivery ${delivery.id} error`,
              );
            }
            return {
              id: delivery.id,
              alertTransitionRevision: delivery.alert_transition_revision,
              transition: delivery.transition,
              destinationKind: delivery.destination_kind,
              destinationKey: delivery.destination_key,
              status: delivery.status,
              attemptCount: delivery.attempt_count,
              createdAt: toIsoTimestamp(
                delivery.created_at_ms,
                `notification delivery ${delivery.id} creation time`,
              ),
              attemptedAt:
                delivery.attempt_started_at_ms === null
                  ? null
                  : toIsoTimestamp(
                      delivery.attempt_started_at_ms,
                      `notification delivery ${delivery.id} attempt time`,
                    ),
              completedAt:
                delivery.completed_at_ms === null
                  ? null
                  : toIsoTimestamp(
                      delivery.completed_at_ms,
                      `notification delivery ${delivery.id} completion time`,
                    ),
              lastError:
                delivery.last_error_code === null ||
                delivery.last_error_message === null
                  ? null
                  : {
                      code: delivery.last_error_code,
                      message: delivery.last_error_message,
                    },
            };
          });
        return {
          id: alert.id,
          alertRuleId: alert.alert_rule_id,
          deduplicationKey: alert.deduplication_key,
          state: alert.state,
          openedAt: toIsoTimestamp(
            alert.opened_at_ms,
            `alert ${alert.id} opening time`,
          ),
          lastObservedAt: toIsoTimestamp(
            alert.last_observed_at_ms,
            `alert ${alert.id} observation time`,
          ),
          acknowledgedAt:
            alert.acknowledged_at_ms === null
              ? null
              : toIsoTimestamp(
                  alert.acknowledged_at_ms,
                  `alert ${alert.id} acknowledgement time`,
                ),
          recoveredAt:
            alert.recovered_at_ms === null
              ? null
              : toIsoTimestamp(
                  alert.recovered_at_ms,
                  `alert ${alert.id} recovery time`,
                ),
          details,
          notificationDeliveries,
        };
      });

      const generatedAt = this.#now();
      if (!Number.isFinite(generatedAt.getTime())) {
        throw new RangeError("Snapshot clock must return a valid date");
      }

      return controllerSnapshotSchema.parse({
        schemaVersion: 1,
        revision: revisionRow?.revision ?? 0,
        committedAt:
          revisionRow === undefined
            ? null
            : toIsoTimestamp(
                revisionRow.committed_at_ms,
                `state revision ${revisionRow.revision} commit time`,
              ),
        generatedAt: generatedAt.toISOString(),
        controlAreas: CONTROL_AREA_DEFINITIONS,
        channels: channelRows.map((channel) => ({
          id: channel.id,
          name: channel.name,
          color: channel.color,
          typeKey: channel.kind,
          throttleId: channel.throttle_id,
          displayOrder: channel.display_order,
          enabled: channel.enabled === 1,
          createdAt: toIsoTimestamp(
            channel.created_at_ms,
            `channel ${channel.id} creation time`,
          ),
          updatedAt: toIsoTimestamp(
            channel.updated_at_ms,
            `channel ${channel.id} update time`,
          ),
        })),
        schedules,
        throttles: throttleRows.map((throttle) => ({
          id: throttle.id,
          typeKey: throttle.type_key,
          percentage: throttle.percentage,
          createdAt: toIsoTimestamp(
            throttle.created_at_ms,
            `throttle ${throttle.id} creation time`,
          ),
          updatedAt: toIsoTimestamp(
            throttle.updated_at_ms,
            `throttle ${throttle.id} update time`,
          ),
        })),
        outputs: outputRows.map((output) => ({
          id: output.id,
          name: output.name,
          typeKey: output.kind,
          displayOrder: output.display_order,
          enabled: output.enabled === 1,
          outputGain: output.output_gain,
          createdAt: toIsoTimestamp(
            output.created_at_ms,
            `output ${output.id} creation time`,
          ),
          updatedAt: toIsoTimestamp(
            output.updated_at_ms,
            `output ${output.id} update time`,
          ),
        })),
        mappingProfiles,
        devices,
        operations: {
          items: operations,
          limit: RECENT_OPERATION_LIMIT,
          truncated: operationRows.length > RECENT_OPERATION_LIMIT,
        },
        unresolvedDeviceOperations: {
          items: unresolvedDeviceOperations,
          limit: UNRESOLVED_DEVICE_OPERATION_LIMIT,
          truncated:
            unresolvedDeviceOperationRows.length >
            UNRESOLVED_DEVICE_OPERATION_LIMIT,
        },
        importRuns,
        overrides: overrideRows.map((override) => {
          if (override.channel_id === null && override.output_id === null) {
            throw new InvalidPersistedSnapshotDataError(
              `override ${override.id} target`,
            );
          }
          if (override.channel_id !== null && override.output_id !== null) {
            throw new InvalidPersistedSnapshotDataError(
              `override ${override.id} target`,
            );
          }
          return {
            id: override.id,
            targetType:
              override.channel_id === null
                ? ("output" as const)
                : ("channel" as const),
            targetId: override.channel_id ?? override.output_id,
            valuePercentage: override.value_percentage,
            status: override.status,
            requestedAt: toIsoTimestamp(
              override.requested_at_ms,
              `override ${override.id} request time`,
            ),
            startsAt:
              override.starts_at_ms === null
                ? null
                : toIsoTimestamp(
                    override.starts_at_ms,
                    `override ${override.id} start time`,
                  ),
            expiresAt: toIsoTimestamp(
              override.expires_at_ms,
              `override ${override.id} expiry time`,
            ),
            completedAt:
              override.completed_at_ms === null
                ? null
                : toIsoTimestamp(
                    override.completed_at_ms,
                    `override ${override.id} completion time`,
                  ),
            operationId: override.operation_id,
          };
        }),
        alertRules,
        alerts,
      });
    });
  }
}

function validateNotificationBinding(
  notification: AlertNotificationV1,
  delivery: {
    readonly id: number;
    readonly alert_transition_revision: number;
    readonly alert_id: string;
    readonly transition: string;
  },
): void {
  if (
    notification.eventRevision !== delivery.alert_transition_revision ||
    notification.alert.id !== delivery.alert_id ||
    notification.transition !== delivery.transition
  ) {
    throw new InvalidPersistedSnapshotDataError(
      `notification delivery ${delivery.id} binding`,
    );
  }
}
