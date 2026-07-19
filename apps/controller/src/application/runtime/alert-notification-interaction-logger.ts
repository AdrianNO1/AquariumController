import type {
  AlertNotificationOutcomeRecorder,
  AlertNotificationTerminalOutcomeRecord,
} from "../alerts/index.js";
import {
  serializeCanonicalJson,
  type InteractionLogInput,
  type InteractionRepository,
  type StoredInteraction,
} from "../../infrastructure/storage/interaction-repository.js";

const NOTIFICATION_DELIVERY_INTERACTION_KIND = "alert.notification-delivery";

/**
 * Mirrors terminal webhook metadata into the durable event store. Notification
 * documents and error messages are deliberately excluded; the state row keeps
 * those details during its live retention window.
 */
export class AlertNotificationInteractionLogger implements AlertNotificationOutcomeRecorder {
  constructor(private readonly repository: InteractionRepository) {}

  async recordTerminalOutcome(
    record: AlertNotificationTerminalOutcomeRecord,
  ): Promise<void> {
    const outcome = record.status === "delivered" ? "succeeded" : record.status;
    const operationId = `notification-delivery-${record.deliveryId}`;
    const input = {
      occurredAtMs: record.completedAtMs,
      direction: record.status === "outcome_unknown" ? "internal" : "outbound",
      kind: NOTIFICATION_DELIVERY_INTERACTION_KIND,
      severity:
        record.status === "delivered"
          ? "info"
          : record.status === "outcome_unknown"
            ? "critical"
            : "error",
      operationId,
      outcome,
      byteCount: 0,
      retentionClass:
        record.status === "outcome_unknown" ? "critical" : "audit",
      payload: {
        deliveryId: record.deliveryId,
        alertTransitionRevision: record.alertTransitionRevision,
        alertId: record.alertId,
        transition: record.transition,
        destinationKind: record.destinationKind,
        destinationKey: record.destinationKey,
        status: record.status,
        errorCode: record.errorCode,
        notificationPayloadStored: false,
        errorMessageStored: false,
      },
      payloadSchemaVersion: 1,
    } satisfies InteractionLogInput;

    if (await this.matchesExistingOutcome(operationId, input)) {
      return;
    }
    try {
      await this.repository.log(input);
    } catch (error) {
      if (!isUniqueConstraintError(error)) {
        throw error;
      }
      if (await this.matchesExistingOutcome(operationId, input)) {
        return;
      }
      throw error;
    }
  }

  private async matchesExistingOutcome(
    operationId: string,
    input: InteractionLogInput,
  ): Promise<boolean> {
    const existing = await this.repository.listByKindAndOperationId(
      NOTIFICATION_DELIVERY_INTERACTION_KIND,
      operationId,
    );
    if (existing.length === 0) {
      return false;
    }
    const stored = existing[0];
    if (existing.length !== 1 || stored === undefined) {
      throw new Error(
        `Notification delivery audit ${operationId} is not unique`,
      );
    }
    assertEquivalentOutcome(stored, input);
    return true;
  }
}

function assertEquivalentOutcome(
  stored: StoredInteraction,
  expected: InteractionLogInput,
): void {
  const payloadMatches =
    stored.payload !== null &&
    expected.payload !== undefined &&
    serializeCanonicalJson(stored.payload) ===
      serializeCanonicalJson(expected.payload);
  if (
    stored.occurredAtMs !== expected.occurredAtMs ||
    stored.direction !== expected.direction ||
    stored.kind !== expected.kind ||
    stored.severity !== expected.severity ||
    stored.topic !== (expected.topic ?? null) ||
    stored.deviceId !== (expected.deviceId ?? null) ||
    stored.correlationId !== (expected.correlationId ?? null) ||
    stored.operationId !== (expected.operationId ?? null) ||
    stored.outcome !== expected.outcome ||
    stored.durationMs !== (expected.durationMs ?? null) ||
    stored.byteCount !== expected.byteCount ||
    stored.retentionClass !== expected.retentionClass ||
    stored.payloadSchemaVersion !== (expected.payloadSchemaVersion ?? null) ||
    !payloadMatches
  ) {
    throw new Error(
      `Notification delivery audit ${expected.operationId ?? "without-operation-id"} conflicts with its durable outcome`,
    );
  }
}

function isUniqueConstraintError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    error.code === "SQLITE_CONSTRAINT_UNIQUE"
  );
}
