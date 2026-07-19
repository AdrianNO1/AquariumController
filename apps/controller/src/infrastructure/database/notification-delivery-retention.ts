import {
  nonnegativeSafeIntegerSchema,
  positiveSafeIntegerSchema,
} from "@aquarium/contracts";
import { sql, type Kysely, type Transaction } from "kysely";

import type { StateDatabaseSchema } from "./types.js";

const DAY_MS = 24 * 60 * 60 * 1_000;

export const DEFAULT_NOTIFICATION_DELIVERY_RETENTION_MS = 180 * DAY_MS;
export const DEFAULT_NOTIFICATION_DELIVERY_DELETE_BATCH_SIZE = 1_000;
export const MAX_NOTIFICATION_DELIVERY_DELETE_BATCH_SIZE = 10_000;

export interface PruneHistoricalNotificationDeliveriesInput {
  readonly nowMs: number;
  readonly retainForMs?: number;
  readonly batchSize?: number;
}

export interface PruneHistoricalNotificationDeliveriesResult {
  readonly cutoffMs: number;
  readonly deletedCount: number;
}

interface DeliveryCandidateRow {
  readonly id: number | string | bigint;
}

/**
 * Bounds completed notification history without touching durable work. A
 * terminal row is removable only when it is strictly older than the retention
 * horizon, its audit outcome has been recorded, and a newer terminal outcome
 * exists for the same alert destination. This preserves every pending,
 * attempting, or unaudited delivery and the latest UI-visible terminal state
 * for each alert/destination pair.
 */
export class NotificationDeliveryRetentionRepository {
  constructor(private readonly database: Kysely<StateDatabaseSchema>) {}

  async pruneHistoricalDeliveries(
    input: PruneHistoricalNotificationDeliveriesInput,
  ): Promise<PruneHistoricalNotificationDeliveriesResult> {
    const nowMs = nonnegativeSafeIntegerSchema.parse(input.nowMs);
    const retainForMs = positiveSafeIntegerSchema.parse(
      input.retainForMs ?? DEFAULT_NOTIFICATION_DELIVERY_RETENTION_MS,
    );
    const batchSize = positiveSafeIntegerSchema
      .max(MAX_NOTIFICATION_DELIVERY_DELETE_BATCH_SIZE)
      .parse(
        input.batchSize ?? DEFAULT_NOTIFICATION_DELIVERY_DELETE_BATCH_SIZE,
      );
    const cutoffMs = Math.max(0, nowMs - retainForMs);
    let deletedCount = 0;

    while (cutoffMs > 0) {
      const deletedInBatch = await this.database
        .transaction()
        .execute((transaction) =>
          deleteHistoricalDeliveryBatch(transaction, cutoffMs, batchSize),
        );
      deletedCount += deletedInBatch;
      if (!Number.isSafeInteger(deletedCount)) {
        throw new RangeError(
          "Notification-delivery deletion count exceeds the safe integer range",
        );
      }
      if (deletedInBatch < batchSize) {
        break;
      }
    }

    return { cutoffMs, deletedCount };
  }
}

async function deleteHistoricalDeliveryBatch(
  transaction: Transaction<StateDatabaseSchema>,
  cutoffMs: number,
  batchSize: number,
): Promise<number> {
  const candidates = await sql<DeliveryCandidateRow>`
    SELECT delivery.id
    FROM notification_deliveries AS delivery
    WHERE delivery.status IN ('delivered', 'failed', 'outcome_unknown')
      AND delivery.outcome_audit_recorded_at_ms IS NOT NULL
      AND delivery.completed_at_ms < ${cutoffMs}
      AND EXISTS (
        SELECT 1
        FROM notification_deliveries AS newer
        WHERE newer.alert_id = delivery.alert_id
          AND newer.destination_kind = delivery.destination_kind
          AND newer.destination_key = delivery.destination_key
          AND newer.status IN ('delivered', 'failed', 'outcome_unknown')
          AND newer.alert_transition_revision > delivery.alert_transition_revision
      )
    ORDER BY delivery.completed_at_ms, delivery.id
    LIMIT ${batchSize}
  `.execute(transaction);
  const ids = candidates.rows.map(({ id }) =>
    parsePositiveSafeInteger(id, "Notification-delivery identifier"),
  );
  if (ids.length === 0) {
    return 0;
  }

  const result = await transaction
    .deleteFrom("notification_deliveries")
    .where("id", "in", ids)
    .executeTakeFirst();
  const deletedCount = Number(result.numDeletedRows);
  if (deletedCount !== ids.length) {
    throw new Error(
      "Notification-delivery selection changed before deletion; transaction rolled back",
    );
  }
  return deletedCount;
}

function parsePositiveSafeInteger(
  value: number | string | bigint,
  label: string,
): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) {
    throw new RangeError(`${label} must be a positive safe integer`);
  }
  return parsed;
}
