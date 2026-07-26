import {
  interactionPayloadSchema,
  type InteractionRepository,
} from "../../infrastructure/storage/interaction-repository.js";
import type { ScheduleReconciliationBatchResult } from "../schedule-artifacts/index.js";
import type {
  OutputRefreshTickReport,
  TimeSyncDiagnostic,
} from "../scheduling/index.js";

const NORMAL_RECONCILIATION_OUTCOMES = new Set([
  "not_mapped",
  "awaiting_announcement",
  "hash_match",
  "coalesced",
  "delivered",
]);

/**
 * Persists actionable scheduler diagnostics without duplicating every healthy
 * five-second tick. Individual wire operations remain available in MQTT logs.
 */
export class SchedulingInteractionLogger {
  constructor(private readonly repository: InteractionRepository) {}

  async logOutputRefresh(
    report: OutputRefreshTickReport,
    occurredAtMs: number,
  ): Promise<void> {
    if (report.diagnostics.length === 0) {
      return;
    }
    const critical = report.diagnostics.some(
      (diagnostic) =>
        diagnostic.code === "scheduled_operation_not_succeeded" &&
        diagnostic.status === "outcome_unknown",
    );
    await this.repository.log({
      occurredAtMs,
      direction: "internal",
      kind: "scheduler.output-refresh-diagnostic",
      severity: critical ? "error" : "warning",
      outcome: critical ? "outcome_unknown" : "failed",
      byteCount: 0,
      retentionClass: critical ? "critical" : "operational",
      payload: interactionPayloadSchema.parse({
        evaluatedUtcMinute: report.evaluatedUtcMinute,
        outputCount: report.outputCount,
        operationCount: report.operationCount,
        diagnostics: report.diagnostics,
      }),
      payloadSchemaVersion: 1,
    });
  }

  async logTimeSync(
    diagnostic: TimeSyncDiagnostic,
    occurredAtMs: number,
  ): Promise<void> {
    const critical =
      diagnostic.code === "time_sync_operation_not_succeeded" &&
      diagnostic.status === "outcome_unknown";
    await this.repository.log({
      occurredAtMs,
      direction: "internal",
      kind: "scheduler.time-sync-diagnostic",
      severity: critical ? "error" : "warning",
      outcome:
        diagnostic.code === "daily_guard_result_superseded"
          ? "ignored"
          : critical
            ? "outcome_unknown"
            : "failed",
      byteCount: 0,
      retentionClass: critical ? "critical" : "operational",
      payload: interactionPayloadSchema.parse({ diagnostic }),
      payloadSchemaVersion: 1,
    });
  }

  async logScheduleReconciliation(
    result: ScheduleReconciliationBatchResult,
    occurredAtMs: number,
  ): Promise<void> {
    const actionable = result.devices.filter(
      (device) => !NORMAL_RECONCILIATION_OUTCOMES.has(device.outcome),
    );
    if (actionable.length === 0) {
      return;
    }
    const critical = actionable.some(
      (device) =>
        device.outcome === "blocked_unknown" ||
        device.outcome === "delivery_outcome_unknown",
    );
    await this.repository.log({
      occurredAtMs,
      direction: "internal",
      kind: "scheduler.schedule-reconciliation-diagnostic",
      severity: critical ? "error" : "warning",
      outcome: critical ? "outcome_unknown" : "failed",
      byteCount: 0,
      retentionClass: critical ? "critical" : "operational",
      payload: interactionPayloadSchema.parse({
        trigger: result.trigger,
        devices: actionable,
      }),
      payloadSchemaVersion: 1,
    });
  }
}
