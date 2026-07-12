import type { AlertNotificationV1, AlertTransition } from "./types.js";

export interface AlertNotifier {
  send(notification: AlertNotificationV1): Promise<void>;
}

export class RecordingAlertNotifier implements AlertNotifier {
  readonly notifications: AlertNotificationV1[] = [];

  async send(notification: AlertNotificationV1): Promise<void> {
    this.notifications.push(structuredClone(notification));
  }
}

export type AlertNotificationDelivery =
  | {
      readonly status: "delivered";
      readonly notification: AlertNotificationV1;
      readonly attemptCount: 1;
    }
  | {
      readonly status: "failed";
      readonly notification: AlertNotificationV1;
      readonly attemptCount: 1;
      readonly errorName: string;
      readonly errorMessage: string;
    };

function toNotification(
  transition: AlertTransition,
): AlertNotificationV1 | null {
  if (transition.transition === "observed") {
    return null;
  }

  return {
    schemaVersion: 1,
    kind: "aquarium.alert",
    eventRevision: transition.revision,
    occurredAt: new Date(transition.occurredAtMs).toISOString(),
    transition: transition.transition,
    alert: transition.payload.alert,
    rule: transition.payload.rule,
    observation: transition.payload.observation,
    note: transition.payload.note,
  };
}

/**
 * Delivers each lifecycle notification at most once per call. Durable retry and
 * replay belongs to the state outbox consumer; this boundary never retries
 * blindly or rolls back the already-committed alert state.
 */
export async function deliverAlertNotifications(
  transitions: readonly AlertTransition[],
  notifier: AlertNotifier,
): Promise<readonly AlertNotificationDelivery[]> {
  const deliveries: AlertNotificationDelivery[] = [];

  for (const transition of transitions) {
    const notification = toNotification(transition);
    if (notification === null) {
      continue;
    }

    try {
      await notifier.send(notification);
      deliveries.push({
        status: "delivered",
        notification,
        attemptCount: 1,
      });
    } catch (error) {
      deliveries.push({
        status: "failed",
        notification,
        attemptCount: 1,
        errorName: error instanceof Error ? error.name : "NonErrorFailure",
        errorMessage:
          error instanceof Error
            ? error.message
            : "Notifier failed with a non-Error value",
      });
    }
  }

  return deliveries;
}
