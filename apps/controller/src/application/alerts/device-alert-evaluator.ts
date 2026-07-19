import { createHash } from "node:crypto";

import {
  boundedTextSchema,
  nonnegativeSafeIntegerSchema,
  type AlertObservation,
} from "@aquarium/contracts";
import type { Kysely } from "kysely";

import {
  commitConditionalStateChange,
  type StateDatabaseSchema,
} from "../../infrastructure/database/index.js";
import type { AlertEvaluationResult } from "./types.js";

export const DEFAULT_DEVICE_HEALTH_ALERT_RULE_PREFIX = "device-health";
const DEVICE_HEALTH_ALERT_ACTOR = "runtime.device-alerts";
const MAX_RULES_PER_STATE_EVENT = 99;

interface DeviceHealthRuleChanges {
  readonly alertRuleIds: readonly string[];
}

export interface AlertObservationEvaluationPort {
  evaluate(
    observation: AlertObservation,
    actor?: string,
  ): Promise<AlertEvaluationResult>;
}

export interface DeviceAlertEvaluationResult {
  readonly observedAtMs: number;
  readonly deviceCount: number;
  readonly evaluations: readonly AlertEvaluationResult[];
}

export interface DeviceAlertEvaluatorPort {
  evaluateAll(observedAtMs: number): Promise<DeviceAlertEvaluationResult>;
}

/**
 * Ensures every enabled device has a conservative not-online rule and feeds
 * current persisted statuses through the durable alert state machine.
 */
export class DeviceAlertEvaluator implements DeviceAlertEvaluatorPort {
  constructor(
    private readonly database: Kysely<StateDatabaseSchema>,
    private readonly alerts: AlertObservationEvaluationPort,
  ) {}

  async evaluateAll(
    observedAtMs: number,
  ): Promise<DeviceAlertEvaluationResult> {
    const parsedObservedAtMs = nonnegativeSafeIntegerSchema.parse(observedAtMs);
    const devices = await this.database
      .selectFrom("devices")
      .select(["id", "status"])
      .where("enabled", "=", 1)
      .orderBy("id")
      .execute();

    for (
      let offset = 0;
      offset < devices.length;
      offset += MAX_RULES_PER_STATE_EVENT
    ) {
      const batch = devices.slice(offset, offset + MAX_RULES_PER_STATE_EVENT);
      await commitConditionalStateChange<{
        readonly changed: boolean;
        readonly result: DeviceHealthRuleChanges;
      }>(
        this.database,
        (changes) => ({
          actor: DEVICE_HEALTH_ALERT_ACTOR,
          mutationType: "device.health-alert-rules",
          summary: "Created built-in device health alert rules",
          eventType: "device.health-alert-rules-created",
          entityType: "controller",
          occurredAtMs: parsedObservedAtMs,
          retentionClass: "audit",
          payloadJson: JSON.stringify({
            schemaVersion: 1,
            alertRuleIds: changes.alertRuleIds,
          }),
          payloadSchemaVersion: 1,
          invalidations: [
            { resource: "controller", id: null },
            ...changes.alertRuleIds.map((id) => ({
              resource: "alert_rule" as const,
              id,
            })),
          ],
        }),
        async (transaction) => {
          const ruleIds = batch.map((device) =>
            defaultDeviceHealthRuleId(device.id),
          );
          const existing = await transaction
            .selectFrom("alert_rules")
            .select([
              "id",
              "source_type",
              "device_id",
              "condition",
              "threshold",
            ])
            .where("id", "in", ruleIds)
            .execute();
          const existingById = new Map(existing.map((rule) => [rule.id, rule]));
          const missing: (typeof batch)[number][] = [];
          for (const device of batch) {
            const ruleId = defaultDeviceHealthRuleId(device.id);
            const stored = existingById.get(ruleId);
            if (stored === undefined) {
              missing.push(device);
              continue;
            }
            if (
              stored.source_type !== "device" ||
              stored.device_id !== device.id ||
              stored.condition !== "not_online" ||
              stored.threshold !== null
            ) {
              throw new Error(
                `Built-in device health rule ${ruleId} conflicts with persisted data`,
              );
            }
          }
          if (missing.length > 0) {
            await transaction
              .insertInto("alert_rules")
              .values(
                missing.map((device) => ({
                  id: defaultDeviceHealthRuleId(device.id),
                  name: boundedTextSchema.parse(`Device health: ${device.id}`),
                  source_type: "device" as const,
                  device_id: device.id,
                  output_id: null,
                  sensor_id: null,
                  switch_id: null,
                  condition: "not_online" as const,
                  threshold: null,
                  delay_ms: 0,
                  severity: "error" as const,
                  enabled: 1,
                  created_at_ms: parsedObservedAtMs,
                  updated_at_ms: parsedObservedAtMs,
                  configuration_json: null,
                  configuration_schema_version: null,
                })),
              )
              .executeTakeFirstOrThrow();
          }
          const alertRuleIds = missing.map((device) =>
            defaultDeviceHealthRuleId(device.id),
          );
          return {
            changed: alertRuleIds.length > 0,
            result: { alertRuleIds },
          };
        },
      );
    }

    const evaluations: AlertEvaluationResult[] = [];
    for (const device of devices) {
      evaluations.push(
        await this.alerts.evaluate(
          {
            sourceType: "device",
            sourceId: device.id,
            status: device.status,
          },
          DEVICE_HEALTH_ALERT_ACTOR,
        ),
      );
    }
    return {
      observedAtMs: parsedObservedAtMs,
      deviceCount: devices.length,
      evaluations,
    };
  }
}

export function defaultDeviceHealthRuleId(deviceId: string): string {
  const digest = createHash("sha256").update(deviceId, "utf8").digest("hex");
  return `${DEFAULT_DEVICE_HEALTH_ALERT_RULE_PREFIX}-${digest.slice(0, 24)}`;
}
