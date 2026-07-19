import type { Kysely } from "kysely";

import type { StateDatabaseSchema } from "./types.js";

export const DEFAULT_RETAINED_STATE_OUTBOX_REVISIONS = 10_000;
export const DEFAULT_STATE_OUTBOX_PRUNE_BATCH_SIZE = 1_000;
export const MAX_STATE_OUTBOX_PRUNE_BATCH_SIZE = 10_000;

export interface PrunePublishedStateOutboxOptions {
  readonly retainRevisionCount?: number;
  readonly maxDeleteRows?: number;
}

export interface PrunePublishedStateOutboxResult {
  readonly currentRevision: number;
  readonly earliestAvailableRevision: number;
  readonly deletedCount: number;
  readonly deletedFromRevision: number | null;
  readonly deletedThroughRevision: number | null;
}

/**
 * Deletes a bounded, contiguous prefix of replay events only after the event
 * mirror marked them published. A pending/unavailable row is a hard watermark:
 * no later revision can be pruned even if it was somehow published already.
 */
export async function prunePublishedStateOutbox(
  database: Kysely<StateDatabaseSchema>,
  options: PrunePublishedStateOutboxOptions = {},
): Promise<PrunePublishedStateOutboxResult> {
  const retainRevisionCount =
    options.retainRevisionCount ?? DEFAULT_RETAINED_STATE_OUTBOX_REVISIONS;
  const maxDeleteRows =
    options.maxDeleteRows ?? DEFAULT_STATE_OUTBOX_PRUNE_BATCH_SIZE;
  assertPositiveSafeInteger(retainRevisionCount, "retainRevisionCount");
  assertPositiveSafeInteger(maxDeleteRows, "maxDeleteRows");
  if (maxDeleteRows > MAX_STATE_OUTBOX_PRUNE_BATCH_SIZE) {
    throw new RangeError(
      `maxDeleteRows must not exceed ${MAX_STATE_OUTBOX_PRUNE_BATCH_SIZE}`,
    );
  }

  return database.transaction().execute(async (transaction) => {
    const [currentRow, earliestUnpublishedRow] = await Promise.all([
      transaction
        .selectFrom("state_revisions")
        .select(({ fn }) => fn.max<number>("revision").as("revision"))
        .executeTakeFirstOrThrow(),
      transaction
        .selectFrom("state_outbox")
        .select(({ fn }) => fn.min<number>("revision").as("revision"))
        .where("published_at_ms", "is", null)
        .executeTakeFirstOrThrow(),
    ]);
    const currentRevision = currentRow.revision ?? 0;
    const retainedHistoryBoundary = currentRevision - retainRevisionCount;
    const unpublishedBoundary =
      earliestUnpublishedRow.revision === null
        ? currentRevision
        : earliestUnpublishedRow.revision - 1;
    const eligibleThroughRevision = Math.min(
      retainedHistoryBoundary,
      unpublishedBoundary,
    );

    const candidates =
      eligibleThroughRevision < 1
        ? []
        : await transaction
            .selectFrom("state_outbox")
            .select("revision")
            .where("revision", "<=", eligibleThroughRevision)
            .where("published_at_ms", "is not", null)
            .orderBy("revision", "asc")
            .limit(maxDeleteRows)
            .execute();
    const firstCandidate = candidates[0];
    const lastCandidate = candidates.at(-1);
    let deletedCount = 0;
    if (lastCandidate !== undefined) {
      const result = await transaction
        .deleteFrom("state_outbox")
        .where("revision", "<=", lastCandidate.revision)
        .where("published_at_ms", "is not", null)
        .executeTakeFirst();
      deletedCount = Number(result.numDeletedRows);
      if (!Number.isSafeInteger(deletedCount) || deletedCount < 0) {
        throw new RangeError("SQLite returned an invalid outbox delete count");
      }
      if (deletedCount !== candidates.length) {
        throw new Error(
          "State outbox changed unexpectedly during its pruning transaction",
        );
      }
    }

    const earliestRow = await transaction
      .selectFrom("state_outbox")
      .select(({ fn }) => fn.min<number>("revision").as("revision"))
      .executeTakeFirstOrThrow();
    return {
      currentRevision,
      earliestAvailableRevision:
        earliestRow.revision ??
        (currentRevision === 0 ? 0 : currentRevision + 1),
      deletedCount,
      deletedFromRevision: firstCandidate?.revision ?? null,
      deletedThroughRevision: lastCandidate?.revision ?? null,
    };
  });
}

function assertPositiveSafeInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new RangeError(`${field} must be a positive safe integer`);
  }
}
