import {
  nonnegativeSafeIntegerSchema,
  positiveSafeIntegerSchema,
} from "@aquarium/contracts";
import { sql, type Kysely, type Transaction } from "kysely";

import type { StateDatabaseSchema } from "./types.js";

const DAY_MS = 24 * 60 * 60 * 1_000;

export const DEFAULT_ROUTINE_CONTROL_OPERATION_RETENTION_MS = 7 * DAY_MS;
export const DEFAULT_CONTROL_OPERATION_DELETE_BATCH_SIZE = 1_000;

export interface PruneRoutineControlOperationsInput {
  readonly nowMs: number;
  readonly retainForMs?: number;
  readonly batchSize?: number;
}

export interface PruneRoutineControlOperationsResult {
  readonly cutoffMs: number;
  readonly deletedCount: number;
}

/**
 * Bounds high-volume routine PWM operation history in state.db. Durable wire
 * summaries remain in events.db; unresolved, failed, non-PWM, recent, and
 * foreign-key-referenced operations are never selected.
 */
export class ControlOperationRetentionRepository {
  constructor(private readonly database: Kysely<StateDatabaseSchema>) {}

  async pruneRoutineSucceededOperations(
    input: PruneRoutineControlOperationsInput,
  ): Promise<PruneRoutineControlOperationsResult> {
    const nowMs = nonnegativeSafeIntegerSchema.parse(input.nowMs);
    const retainForMs = positiveSafeIntegerSchema.parse(
      input.retainForMs ?? DEFAULT_ROUTINE_CONTROL_OPERATION_RETENTION_MS,
    );
    const batchSize = positiveSafeIntegerSchema
      .max(10_000)
      .parse(input.batchSize ?? DEFAULT_CONTROL_OPERATION_DELETE_BATCH_SIZE);
    const cutoffMs = Math.max(0, nowMs - retainForMs);
    let deletedCount = 0;

    while (cutoffMs > 0) {
      const deletedInBatch = await this.database
        .transaction()
        .execute((transaction) =>
          deleteRoutineOperationBatch(transaction, cutoffMs, batchSize),
        );
      deletedCount += deletedInBatch;
      if (!Number.isSafeInteger(deletedCount)) {
        throw new RangeError(
          "Routine control-operation deletion count exceeds the safe integer range",
        );
      }
      if (deletedInBatch < batchSize) {
        break;
      }
    }

    return { cutoffMs, deletedCount };
  }
}

async function deleteRoutineOperationBatch(
  transaction: Transaction<StateDatabaseSchema>,
  cutoffMs: number,
  batchSize: number,
): Promise<number> {
  const candidates = await transaction
    .selectFrom("control_operations as operation")
    .leftJoin("overrides as override", "override.operation_id", "operation.id")
    .leftJoin(
      "device_schedule_artifacts as artifact",
      "artifact.last_delivery_operation_id",
      "operation.id",
    )
    .leftJoin(
      "scheduler_guards as guard",
      "guard.last_operation_id",
      "operation.id",
    )
    .select("operation.id")
    .distinct()
    .where("operation.kind", "=", "set_pwm")
    .where((expressions) =>
      expressions.or([
        expressions("operation.status", "=", "succeeded"),
        expressions.and([
          expressions("operation.status", "=", "outcome_unknown"),
          sql<boolean>`json_extract(${sql.ref("operation.result_json")}, '$.reconciledAtMs') is not null`,
        ]),
      ]),
    )
    .where("operation.completed_at_ms", "<", cutoffMs)
    .where("override.id", "is", null)
    .where("artifact.device_id", "is", null)
    .where("guard.job_key", "is", null)
    .orderBy("operation.completed_at_ms", "asc")
    .orderBy("operation.id", "asc")
    .limit(batchSize)
    .execute();
  const ids = candidates.map(({ id }) => id);
  if (ids.length === 0) {
    return 0;
  }
  const result = await transaction
    .deleteFrom("control_operations")
    .where("id", "in", ids)
    .executeTakeFirst();
  const deletedCount = Number(result.numDeletedRows);
  if (deletedCount !== ids.length) {
    throw new Error(
      "Routine control-operation selection changed before deletion; transaction rolled back",
    );
  }
  return deletedCount;
}
