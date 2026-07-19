import type { Kysely } from "kysely";

import type {
  EventsDatabaseSchema,
  RetentionClass,
} from "../database/index.js";

const DAY_MS = 24 * 60 * 60 * 1_000;
const MEBIBYTE = 1_024 * 1_024;

export interface DefaultRetentionPolicy {
  readonly retentionClass: RetentionClass;
  readonly retainForMs: number;
  readonly byteBudget: number;
  readonly archiveBeforeDelete: boolean;
  readonly priority: number;
}

/**
 * Live-database budgets total 6.5 GiB. Raw traffic is aggregated and discarded
 * after seven days; durable classes are archived before their live rows age or
 * exceed budget. Archive growth is measured separately by storage projections.
 */
export const DEFAULT_RETENTION_POLICIES = [
  {
    retentionClass: "raw",
    retainForMs: 7 * DAY_MS,
    byteBudget: 512 * MEBIBYTE,
    archiveBeforeDelete: false,
    priority: 0,
  },
  {
    retentionClass: "operational",
    retainForMs: 180 * DAY_MS,
    byteBudget: 2_048 * MEBIBYTE,
    archiveBeforeDelete: true,
    priority: 10,
  },
  {
    retentionClass: "aggregate",
    retainForMs: 3 * 365 * DAY_MS,
    byteBudget: 1_024 * MEBIBYTE,
    archiveBeforeDelete: true,
    priority: 20,
  },
  {
    retentionClass: "audit",
    retainForMs: 3 * 365 * DAY_MS,
    byteBudget: 2_048 * MEBIBYTE,
    archiveBeforeDelete: true,
    priority: 30,
  },
  {
    retentionClass: "critical",
    retainForMs: 10 * 365 * DAY_MS,
    byteBudget: 1_024 * MEBIBYTE,
    archiveBeforeDelete: true,
    priority: 40,
  },
] as const satisfies readonly DefaultRetentionPolicy[];

export async function seedDefaultRetentionPolicies(
  database: Kysely<EventsDatabaseSchema>,
  nowMs: number,
): Promise<readonly RetentionClass[]> {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
    throw new RangeError(
      "Retention policy seed time must be a non-negative safe integer",
    );
  }
  const inserted: RetentionClass[] = [];
  await database.transaction().execute(async (transaction) => {
    for (const policy of DEFAULT_RETENTION_POLICIES) {
      const result = await transaction
        .insertInto("retention_policies")
        .values({
          retention_class: policy.retentionClass,
          retain_for_ms: policy.retainForMs,
          byte_budget: policy.byteBudget,
          archive_before_delete: policy.archiveBeforeDelete ? 1 : 0,
          priority: policy.priority,
          enabled: 1,
          updated_at_ms: nowMs,
        })
        .onConflict((conflict) =>
          conflict.column("retention_class").doNothing(),
        )
        .executeTakeFirst();
      if (result.numInsertedOrUpdatedRows === 1n) {
        inserted.push(policy.retentionClass);
      }
    }
  });
  return inserted;
}
