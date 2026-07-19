import { alertNotificationV1Schema } from "@aquarium/contracts";

import type { AlertNotificationV1 } from "./types.js";

export interface AlertNotifier {
  send(notification: AlertNotificationV1): Promise<void>;
}

export interface AlertNotificationDestination {
  readonly kind: "webhook";
  readonly key: string;
}

export interface AlertNotificationBinding extends AlertNotificationDestination {
  readonly notifier: AlertNotifier;
}

export class RecordingAlertNotifier implements AlertNotifier {
  readonly notifications: AlertNotificationV1[] = [];

  async send(notification: AlertNotificationV1): Promise<void> {
    this.notifications.push(
      structuredClone(alertNotificationV1Schema.parse(notification)),
    );
  }
}
