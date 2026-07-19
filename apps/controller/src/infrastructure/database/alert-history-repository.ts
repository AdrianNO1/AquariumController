import { Buffer } from "node:buffer";

import {
  alertDetailsSchema,
  alertHistoryListRequestSchema,
  alertHistoryListResponseSchema,
  alertHistoryStateFilterSchema,
  alertNotificationV1Schema,
  notificationDeliverySchema,
  type ActiveAlert,
  type AlertHistoryListRequest,
  type AlertHistoryListResponse,
  type AlertHistoryStateFilter,
  type AlertNotificationV1,
  type NotificationDelivery,
} from "@aquarium/contracts";
import type { Kysely, Selectable } from "kysely";
import { z } from "zod";

import { parseJsonDocument } from "../import/strict-json.js";
import type {
  ActiveAlertsTable,
  NotificationDeliveriesTable,
  StateDatabaseSchema,
} from "./types.js";

export const ALERT_HISTORY_DELIVERY_LIMIT = 20;

const alertHistoryCursorPayloadSchema = z.strictObject({
  schemaVersion: z.literal(1),
  state: alertHistoryStateFilterSchema,
  lastObservedAtMs: z.number().int().nonnegative().safe(),
  id: z.string().min(1).max(200),
});

interface AlertHistoryCursorPayload {
  readonly schemaVersion: 1;
  readonly state: AlertHistoryStateFilter;
  readonly lastObservedAtMs: number;
  readonly id: string;
}

export class InvalidAlertHistoryCursorError extends Error {
  override readonly name = "InvalidAlertHistoryCursorError";

  constructor() {
    super("Alert history cursor is malformed or belongs to another filter");
  }
}

export class InvalidPersistedAlertHistoryError extends Error {
  override readonly name = "InvalidPersistedAlertHistoryError";

  constructor(subject: string) {
    super(`Persisted ${subject} failed alert-history validation`);
  }
}

export class AlertHistoryRepository {
  constructor(private readonly database: Kysely<StateDatabaseSchema>) {}

  async list(
    rawRequest: AlertHistoryListRequest,
  ): Promise<AlertHistoryListResponse> {
    const request = alertHistoryListRequestSchema.parse(rawRequest);
    const cursor =
      request.cursor === undefined
        ? null
        : decodeAlertHistoryCursor(request.cursor, request.state);
    let query = this.database.selectFrom("active_alerts").selectAll();
    switch (request.state) {
      case "active":
        query = query.where("state", "in", ["open", "acknowledged"]);
        break;
      case "open":
      case "acknowledged":
      case "recovered":
        query = query.where("state", "=", request.state);
        break;
      case "all":
        break;
    }
    if (cursor !== null) {
      query = query.where((expressions) =>
        expressions.or([
          expressions("last_observed_at_ms", "<", cursor.lastObservedAtMs),
          expressions.and([
            expressions("last_observed_at_ms", "=", cursor.lastObservedAtMs),
            expressions("id", "<", cursor.id),
          ]),
        ]),
      );
    }
    const rows = await query
      .orderBy("last_observed_at_ms", "desc")
      .orderBy("id", "desc")
      .limit(request.pageSize + 1)
      .execute();
    const hasMore = rows.length > request.pageSize;
    const pageRows = rows.slice(0, request.pageSize);
    const items: ActiveAlert[] = [];
    const deliveriesTruncatedAlertIds: string[] = [];
    for (const row of pageRows) {
      const deliveries = await this.#readDeliveries(row.id);
      if (deliveries.truncated) {
        deliveriesTruncatedAlertIds.push(row.id);
      }
      items.push(projectAlert(row, deliveries.items));
    }
    const lastRow = pageRows.at(-1);
    return alertHistoryListResponseSchema.parse({
      schemaVersion: 1,
      items,
      nextCursor:
        hasMore && lastRow !== undefined
          ? encodeAlertHistoryCursor({
              schemaVersion: 1,
              state: request.state,
              lastObservedAtMs: lastRow.last_observed_at_ms,
              id: lastRow.id,
            })
          : null,
      hasMore,
      deliveriesTruncatedAlertIds,
    });
  }

  async #readDeliveries(alertId: string): Promise<{
    readonly items: readonly NotificationDelivery[];
    readonly truncated: boolean;
  }> {
    const rows = await this.database
      .selectFrom("notification_deliveries")
      .selectAll()
      .where("alert_id", "=", alertId)
      .orderBy("created_at_ms", "desc")
      .orderBy("id", "desc")
      .limit(ALERT_HISTORY_DELIVERY_LIMIT + 1)
      .execute();
    return {
      items: rows
        .slice(0, ALERT_HISTORY_DELIVERY_LIMIT)
        .map(projectNotificationDelivery),
      truncated: rows.length > ALERT_HISTORY_DELIVERY_LIMIT,
    };
  }
}

function projectAlert(
  row: Selectable<ActiveAlertsTable>,
  notificationDeliveries: readonly NotificationDelivery[],
): ActiveAlert {
  const details = parseOptionalDetails(row);
  return {
    id: row.id,
    alertRuleId: row.alert_rule_id,
    deduplicationKey: row.deduplication_key,
    state: row.state,
    openedAt: toIsoTimestamp(row.opened_at_ms, `alert ${row.id} opening time`),
    lastObservedAt: toIsoTimestamp(
      row.last_observed_at_ms,
      `alert ${row.id} observation time`,
    ),
    acknowledgedAt:
      row.acknowledged_at_ms === null
        ? null
        : toIsoTimestamp(
            row.acknowledged_at_ms,
            `alert ${row.id} acknowledgement time`,
          ),
    recoveredAt:
      row.recovered_at_ms === null
        ? null
        : toIsoTimestamp(row.recovered_at_ms, `alert ${row.id} recovery time`),
    details,
    notificationDeliveries: [...notificationDeliveries],
  };
}

function projectNotificationDelivery(
  row: Selectable<NotificationDeliveriesTable>,
): NotificationDelivery {
  const notification = parseNotification(row);
  if (
    notification.eventRevision !== row.alert_transition_revision ||
    notification.alert.id !== row.alert_id ||
    notification.transition !== row.transition
  ) {
    throw new InvalidPersistedAlertHistoryError(
      `notification delivery ${row.id} binding`,
    );
  }
  const hasErrorCode = row.last_error_code !== null;
  if (hasErrorCode !== (row.last_error_message !== null)) {
    throw new InvalidPersistedAlertHistoryError(
      `notification delivery ${row.id} error`,
    );
  }
  return notificationDeliverySchema.parse({
    id: row.id,
    alertTransitionRevision: row.alert_transition_revision,
    transition: row.transition,
    destinationKind: row.destination_kind,
    destinationKey: row.destination_key,
    status: row.status,
    attemptCount: row.attempt_count,
    createdAt: toIsoTimestamp(
      row.created_at_ms,
      `notification delivery ${row.id} creation time`,
    ),
    attemptedAt:
      row.attempt_started_at_ms === null
        ? null
        : toIsoTimestamp(
            row.attempt_started_at_ms,
            `notification delivery ${row.id} attempt time`,
          ),
    completedAt:
      row.completed_at_ms === null
        ? null
        : toIsoTimestamp(
            row.completed_at_ms,
            `notification delivery ${row.id} completion time`,
          ),
    lastError:
      row.last_error_code === null || row.last_error_message === null
        ? null
        : { code: row.last_error_code, message: row.last_error_message },
  });
}

function parseOptionalDetails(
  row: Selectable<ActiveAlertsTable>,
): ReturnType<typeof alertDetailsSchema.parse> | null {
  if (row.details_json === null && row.details_schema_version === null) {
    return null;
  }
  if (row.details_json === null || row.details_schema_version !== 1) {
    throw new InvalidPersistedAlertHistoryError(`alert ${row.id} details`);
  }
  try {
    const document = parseJsonDocument(
      row.details_json,
      `alert ${row.id} details`,
    );
    if (document.duplicateKeys.length > 0) {
      throw new Error("Alert details contain duplicate keys");
    }
    return alertDetailsSchema.parse(document.value);
  } catch {
    throw new InvalidPersistedAlertHistoryError(`alert ${row.id} details`);
  }
}

function parseNotification(
  row: Selectable<NotificationDeliveriesTable>,
): AlertNotificationV1 {
  if (row.notification_schema_version !== 1) {
    throw new InvalidPersistedAlertHistoryError(
      `notification delivery ${row.id}`,
    );
  }
  try {
    const document = parseJsonDocument(
      row.notification_json,
      `notification delivery ${row.id}`,
    );
    if (document.duplicateKeys.length > 0) {
      throw new Error("Notification contains duplicate keys");
    }
    return alertNotificationV1Schema.parse(document.value);
  } catch {
    throw new InvalidPersistedAlertHistoryError(
      `notification delivery ${row.id}`,
    );
  }
}

function toIsoTimestamp(value: number, subject: string): string {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new InvalidPersistedAlertHistoryError(subject);
  }
  const result = new Date(value);
  if (!Number.isFinite(result.getTime())) {
    throw new InvalidPersistedAlertHistoryError(subject);
  }
  return result.toISOString();
}

function encodeAlertHistoryCursor(payload: AlertHistoryCursorPayload): string {
  const parsed = alertHistoryCursorPayloadSchema.parse(payload);
  return Buffer.from(JSON.stringify(parsed), "utf8").toString("base64url");
}

function decodeAlertHistoryCursor(
  cursor: string,
  state: AlertHistoryStateFilter,
): AlertHistoryCursorPayload {
  try {
    const source = Buffer.from(cursor, "base64url").toString("utf8");
    const document = parseJsonDocument(source, "alert history cursor");
    if (document.duplicateKeys.length > 0) {
      throw new Error("Alert history cursor contains duplicate keys");
    }
    const payload = alertHistoryCursorPayloadSchema.parse(document.value);
    if (
      payload.state !== state ||
      encodeAlertHistoryCursor(payload) !== cursor
    ) {
      throw new Error("Alert history cursor scope or encoding differs");
    }
    return payload;
  } catch {
    throw new InvalidAlertHistoryCursorError();
  }
}
