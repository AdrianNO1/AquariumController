import {
  alertNotificationV1Schema,
  identifierSchema,
  type AlertNotificationV1,
} from "@aquarium/contracts";
import type { Kysely, Selectable } from "kysely";

import type {
  NotificationDeliveriesTable,
  StateChangeEvent,
  StateDatabaseSchema,
} from "../../infrastructure/database/index.js";
import {
  commitConditionalStateChange,
  commitStateChange,
} from "../../infrastructure/database/index.js";
import { parseJsonDocument } from "../../infrastructure/import/index.js";
import type {
  AlertNotificationBinding,
  AlertNotifier,
} from "./notification-port.js";
import type { AlertClock } from "./types.js";

const MAX_DISPATCH_BATCH_SIZE = 100;
const MAX_OUTCOME_AUDIT_BATCH_SIZE = 100;
const NOTIFIER_FAILURE_CODE = "notifier_error";
const NOTIFIER_FAILURE_MESSAGE = "Alert notifier failed";
const INVALID_NOTIFICATION_CODE = "invalid_notification";
const INVALID_NOTIFICATION_MESSAGE =
  "Stored alert notification failed validation";
const MISSING_DESTINATION_CODE = "destination_unavailable";
const MISSING_DESTINATION_MESSAGE =
  "Configured alert notification destination is unavailable";
const INTERRUPTED_CODE = "delivery_interrupted";
const INTERRUPTED_MESSAGE =
  "Controller stopped before the delivery outcome was recorded";
const NOTIFICATION_DELIVERY_ACTOR = "runtime.alert-notifications";

type StoredNotificationDelivery = Selectable<NotificationDeliveriesTable>;

export interface AlertNotificationDispatchOutcome {
  readonly deliveryId: number;
  readonly status: "delivered" | "failed";
  readonly errorCode: string | null;
}

export interface AlertNotificationDispatchResult {
  readonly outcomes: readonly AlertNotificationDispatchOutcome[];
}

export interface AlertNotificationTerminalOutcomeRecord {
  readonly deliveryId: number;
  readonly alertTransitionRevision: number;
  readonly alertId: string;
  readonly transition: StoredNotificationDelivery["transition"];
  readonly destinationKind: StoredNotificationDelivery["destination_kind"];
  readonly destinationKey: string;
  readonly status: "delivered" | "failed" | "outcome_unknown";
  readonly completedAtMs: number;
  readonly errorCode: string | null;
}

export interface AlertNotificationOutcomeRecorder {
  recordTerminalOutcome(
    outcome: AlertNotificationTerminalOutcomeRecord,
  ): Promise<void>;
}

export class NotificationDeliveryConcurrencyError extends Error {
  override readonly name = "NotificationDeliveryConcurrencyError";

  constructor(deliveryId: number, operation: string) {
    super(
      `Notification delivery ${deliveryId} changed concurrently during ${operation}`,
    );
  }
}

function assertTimestamp(value: number, field: string): void {
  if (
    !Number.isSafeInteger(value) ||
    value < 0 ||
    !Number.isFinite(new Date(value).getTime())
  ) {
    throw new RangeError(`${field} must be a representable non-negative time`);
  }
}

function bindingKey(kind: "webhook", key: string): string {
  return `${kind}:${key}`;
}

function parseStoredNotification(
  delivery: StoredNotificationDelivery,
): AlertNotificationV1 {
  if (delivery.notification_schema_version !== 1) {
    throw new Error(INVALID_NOTIFICATION_MESSAGE);
  }

  let notification: AlertNotificationV1;
  try {
    const parsed = parseJsonDocument(
      delivery.notification_json,
      `notification delivery ${delivery.id}`,
    );
    if (parsed.duplicateKeys.length > 0) {
      throw new Error(INVALID_NOTIFICATION_MESSAGE);
    }
    notification = alertNotificationV1Schema.parse(parsed.value);
  } catch {
    throw new Error(INVALID_NOTIFICATION_MESSAGE);
  }

  if (
    notification.eventRevision !== delivery.alert_transition_revision ||
    notification.alert.id !== delivery.alert_id ||
    notification.transition !== delivery.transition
  ) {
    throw new Error(INVALID_NOTIFICATION_MESSAGE);
  }
  return notification;
}

export class AlertNotificationDispatcher {
  readonly #notifiers = new Map<string, AlertNotifier>();

  constructor(
    private readonly database: Kysely<StateDatabaseSchema>,
    private readonly clock: AlertClock,
    bindings: readonly AlertNotificationBinding[],
    private readonly outcomeRecorder: AlertNotificationOutcomeRecorder,
  ) {
    for (const binding of bindings) {
      const destinationKey = identifierSchema.parse(binding.key);
      const key = bindingKey(binding.kind, destinationKey);
      if (this.#notifiers.has(key)) {
        throw new TypeError(
          `Duplicate alert notification destination ${binding.kind}:${destinationKey}`,
        );
      }
      this.#notifiers.set(key, binding.notifier);
    }
  }

  async recoverInterrupted(): Promise<readonly number[]> {
    const nowMs = this.clock.nowMs();
    assertTimestamp(nowMs, "notification recovery clock");
    const interrupted = await this.database
      .selectFrom("notification_deliveries")
      .selectAll()
      .where("status", "=", "attempting")
      .orderBy("id")
      .execute();
    for (const delivery of interrupted) {
      if (
        delivery.attempt_started_at_ms === null ||
        nowMs < delivery.attempt_started_at_ms
      ) {
        throw new RangeError(
          `Notification recovery clock precedes delivery ${delivery.id}`,
        );
      }
    }

    for (const delivery of interrupted) {
      if (delivery.attempt_started_at_ms === null) {
        throw new Error(
          `Notification delivery ${delivery.id} has no attempt timestamp`,
        );
      }
      await commitStateChange(
        this.database,
        notificationDeliveryStateEvent(
          delivery,
          "outcome_unknown",
          nowMs,
          INTERRUPTED_CODE,
        ),
        async (transaction) => {
          const updated = await transaction
            .updateTable("notification_deliveries")
            .set({
              status: "outcome_unknown",
              completed_at_ms: nowMs,
              updated_at_ms: nowMs,
              last_error_code: INTERRUPTED_CODE,
              last_error_message: INTERRUPTED_MESSAGE,
              outcome_audit_recorded_at_ms: null,
            })
            .where("id", "=", delivery.id)
            .where("status", "=", "attempting")
            .where("attempt_count", "=", 1)
            .where("attempt_started_at_ms", "=", delivery.attempt_started_at_ms)
            .executeTakeFirst();
          if (updated.numUpdatedRows !== 1n) {
            throw new NotificationDeliveryConcurrencyError(
              delivery.id,
              "startup recovery",
            );
          }
        },
      );
    }
    await this.flushUnrecordedTerminalOutcomes();
    return interrupted.map(({ id }) => id);
  }

  async dispatchPending(
    batchSize = MAX_DISPATCH_BATCH_SIZE,
  ): Promise<AlertNotificationDispatchResult> {
    if (
      !Number.isSafeInteger(batchSize) ||
      batchSize <= 0 ||
      batchSize > MAX_DISPATCH_BATCH_SIZE
    ) {
      throw new RangeError(
        `Notification batch size must be between 1 and ${MAX_DISPATCH_BATCH_SIZE}`,
      );
    }
    await this.flushUnrecordedTerminalOutcomes();
    const pending = await this.database
      .selectFrom("notification_deliveries")
      .selectAll()
      .where("status", "=", "pending")
      .orderBy("created_at_ms")
      .orderBy("id")
      .limit(batchSize)
      .execute();
    const outcomes: AlertNotificationDispatchOutcome[] = [];

    for (const delivery of pending) {
      const attemptStartedAtMs = this.clock.nowMs();
      assertTimestamp(attemptStartedAtMs, "notification attempt clock");
      if (attemptStartedAtMs < delivery.updated_at_ms) {
        throw new RangeError(
          `Notification attempt clock precedes delivery ${delivery.id}`,
        );
      }
      const claim = await commitConditionalStateChange<{
        readonly changed: boolean;
        readonly result: { readonly claimed: boolean };
      }>(
        this.database,
        notificationDeliveryStateEvent(
          delivery,
          "attempting",
          attemptStartedAtMs,
          null,
        ),
        async (transaction) => {
          const claimed = await transaction
            .updateTable("notification_deliveries")
            .set({
              status: "attempting",
              attempt_count: 1,
              attempt_started_at_ms: attemptStartedAtMs,
              updated_at_ms: attemptStartedAtMs,
            })
            .where("id", "=", delivery.id)
            .where("status", "=", "pending")
            .where("attempt_count", "=", 0)
            .where("updated_at_ms", "=", delivery.updated_at_ms)
            .where("notification_json", "=", delivery.notification_json)
            .where(
              "notification_schema_version",
              "=",
              delivery.notification_schema_version,
            )
            .executeTakeFirst();
          if (claimed.numUpdatedRows > 1n) {
            throw new NotificationDeliveryConcurrencyError(
              delivery.id,
              "claim",
            );
          }
          return {
            changed: claimed.numUpdatedRows === 1n,
            result: { claimed: claimed.numUpdatedRows === 1n },
          };
        },
      );
      if (!claim.result.claimed) continue;

      let notification: AlertNotificationV1;
      try {
        notification = parseStoredNotification(delivery);
      } catch {
        await this.markFailed(
          delivery,
          attemptStartedAtMs,
          INVALID_NOTIFICATION_CODE,
          INVALID_NOTIFICATION_MESSAGE,
        );
        outcomes.push({
          deliveryId: delivery.id,
          status: "failed",
          errorCode: INVALID_NOTIFICATION_CODE,
        });
        continue;
      }

      const notifier = this.#notifiers.get(
        bindingKey(delivery.destination_kind, delivery.destination_key),
      );
      if (notifier === undefined) {
        await this.markFailed(
          delivery,
          attemptStartedAtMs,
          MISSING_DESTINATION_CODE,
          MISSING_DESTINATION_MESSAGE,
        );
        outcomes.push({
          deliveryId: delivery.id,
          status: "failed",
          errorCode: MISSING_DESTINATION_CODE,
        });
        continue;
      }

      try {
        await notifier.send(notification);
      } catch {
        await this.markFailed(
          delivery,
          attemptStartedAtMs,
          NOTIFIER_FAILURE_CODE,
          NOTIFIER_FAILURE_MESSAGE,
        );
        outcomes.push({
          deliveryId: delivery.id,
          status: "failed",
          errorCode: NOTIFIER_FAILURE_CODE,
        });
        continue;
      }

      await this.markDelivered(delivery, attemptStartedAtMs);
      outcomes.push({
        deliveryId: delivery.id,
        status: "delivered",
        errorCode: null,
      });
    }

    return { outcomes };
  }

  private async markDelivered(
    delivery: StoredNotificationDelivery,
    attemptStartedAtMs: number,
  ): Promise<void> {
    const deliveryId = delivery.id;
    const completedAtMs = this.clock.nowMs();
    assertTimestamp(completedAtMs, "notification completion clock");
    if (completedAtMs < attemptStartedAtMs) {
      throw new RangeError(
        `Notification completion clock precedes delivery ${deliveryId}`,
      );
    }
    await commitStateChange(
      this.database,
      notificationDeliveryStateEvent(
        delivery,
        "delivered",
        completedAtMs,
        null,
      ),
      async (transaction) => {
        const updated = await transaction
          .updateTable("notification_deliveries")
          .set({
            status: "delivered",
            completed_at_ms: completedAtMs,
            updated_at_ms: completedAtMs,
            last_error_code: null,
            last_error_message: null,
            outcome_audit_recorded_at_ms: null,
          })
          .where("id", "=", deliveryId)
          .where("status", "=", "attempting")
          .where("attempt_count", "=", 1)
          .where("attempt_started_at_ms", "=", attemptStartedAtMs)
          .executeTakeFirst();
        if (updated.numUpdatedRows !== 1n) {
          throw new NotificationDeliveryConcurrencyError(
            deliveryId,
            "completion",
          );
        }
      },
    );
    await this.recordUnrecordedTerminalOutcome(deliveryId);
  }

  private async markFailed(
    delivery: StoredNotificationDelivery,
    attemptStartedAtMs: number,
    errorCode: string,
    errorMessage: string,
  ): Promise<void> {
    const deliveryId = delivery.id;
    const completedAtMs = this.clock.nowMs();
    assertTimestamp(completedAtMs, "notification failure clock");
    if (completedAtMs < attemptStartedAtMs) {
      throw new RangeError(
        `Notification failure clock precedes delivery ${deliveryId}`,
      );
    }
    await commitStateChange(
      this.database,
      notificationDeliveryStateEvent(
        delivery,
        "failed",
        completedAtMs,
        errorCode,
      ),
      async (transaction) => {
        const updated = await transaction
          .updateTable("notification_deliveries")
          .set({
            status: "failed",
            completed_at_ms: completedAtMs,
            updated_at_ms: completedAtMs,
            last_error_code: errorCode,
            last_error_message: errorMessage,
            outcome_audit_recorded_at_ms: null,
          })
          .where("id", "=", deliveryId)
          .where("status", "=", "attempting")
          .where("attempt_count", "=", 1)
          .where("attempt_started_at_ms", "=", attemptStartedAtMs)
          .executeTakeFirst();
        if (updated.numUpdatedRows !== 1n) {
          throw new NotificationDeliveryConcurrencyError(deliveryId, "failure");
        }
      },
    );
    await this.recordUnrecordedTerminalOutcome(deliveryId);
  }

  private async flushUnrecordedTerminalOutcomes(): Promise<void> {
    while (true) {
      const pending = await this.database
        .selectFrom("notification_deliveries")
        .select("id")
        .where("status", "in", ["delivered", "failed", "outcome_unknown"])
        .where("outcome_audit_recorded_at_ms", "is", null)
        .orderBy("completed_at_ms")
        .orderBy("id")
        .limit(MAX_OUTCOME_AUDIT_BATCH_SIZE)
        .execute();
      for (const { id } of pending) {
        await this.recordUnrecordedTerminalOutcome(id);
      }
      if (pending.length < MAX_OUTCOME_AUDIT_BATCH_SIZE) {
        return;
      }
    }
  }

  private async recordUnrecordedTerminalOutcome(
    deliveryId: number,
  ): Promise<void> {
    const delivery = await this.database
      .selectFrom("notification_deliveries")
      .select([
        "id",
        "alert_transition_revision",
        "alert_id",
        "transition",
        "destination_kind",
        "destination_key",
        "status",
        "completed_at_ms",
        "updated_at_ms",
        "last_error_code",
        "outcome_audit_recorded_at_ms",
      ])
      .where("id", "=", deliveryId)
      .executeTakeFirstOrThrow();
    if (delivery.outcome_audit_recorded_at_ms !== null) {
      return;
    }
    const status = terminalOutcomeStatus(delivery.status);
    const completedAtMs = delivery.completed_at_ms;
    if (completedAtMs === null) {
      throw new Error(
        `Terminal notification delivery ${deliveryId} has no completion time`,
      );
    }
    await this.outcomeRecorder.recordTerminalOutcome({
      deliveryId: delivery.id,
      alertTransitionRevision: delivery.alert_transition_revision,
      alertId: delivery.alert_id,
      transition: delivery.transition,
      destinationKind: delivery.destination_kind,
      destinationKey: delivery.destination_key,
      status,
      completedAtMs,
      errorCode: delivery.last_error_code,
    });

    const recordedAtMs = this.clock.nowMs();
    assertTimestamp(recordedAtMs, "notification audit recording clock");
    if (recordedAtMs < completedAtMs) {
      throw new RangeError(
        `Notification audit clock precedes delivery ${deliveryId}`,
      );
    }
    const updated = await this.database
      .updateTable("notification_deliveries")
      .set({ outcome_audit_recorded_at_ms: recordedAtMs })
      .where("id", "=", deliveryId)
      .where("status", "=", status)
      .where("completed_at_ms", "=", completedAtMs)
      .where("updated_at_ms", "=", delivery.updated_at_ms)
      .where("outcome_audit_recorded_at_ms", "is", null)
      .executeTakeFirst();
    if (updated.numUpdatedRows === 1n) {
      return;
    }
    const current = await this.database
      .selectFrom("notification_deliveries")
      .select([
        "status",
        "completed_at_ms",
        "updated_at_ms",
        "last_error_code",
        "outcome_audit_recorded_at_ms",
      ])
      .where("id", "=", deliveryId)
      .executeTakeFirst();
    if (
      updated.numUpdatedRows === 0n &&
      current?.status === status &&
      current.completed_at_ms === completedAtMs &&
      current.updated_at_ms === delivery.updated_at_ms &&
      current.last_error_code === delivery.last_error_code &&
      current.outcome_audit_recorded_at_ms !== null
    ) {
      return;
    }
    throw new NotificationDeliveryConcurrencyError(
      deliveryId,
      "outcome audit checkpoint",
    );
  }
}

function terminalOutcomeStatus(
  status: StoredNotificationDelivery["status"],
): AlertNotificationTerminalOutcomeRecord["status"] {
  switch (status) {
    case "delivered":
    case "failed":
    case "outcome_unknown":
      return status;
    case "pending":
    case "attempting":
      throw new Error(`Notification delivery is not terminal: ${status}`);
  }
}

function notificationDeliveryStateEvent(
  delivery: StoredNotificationDelivery,
  status: "attempting" | "delivered" | "failed" | "outcome_unknown",
  occurredAtMs: number,
  errorCode: string | null,
): StateChangeEvent {
  return {
    actor: NOTIFICATION_DELIVERY_ACTOR,
    mutationType: "alert.notification-delivery-status",
    summary: `Changed notification delivery ${delivery.id} to ${status}`,
    eventType: "alert.notification-delivery-status-changed",
    entityType: "alert",
    entityId: delivery.alert_id,
    occurredAtMs,
    retentionClass: "audit",
    payloadJson: JSON.stringify({
      schemaVersion: 1,
      deliveryId: delivery.id,
      alertTransitionRevision: delivery.alert_transition_revision,
      transition: delivery.transition,
      status,
      errorCode,
    }),
    payloadSchemaVersion: 1,
    invalidations: [{ resource: "alert", id: delivery.alert_id }],
  };
}
