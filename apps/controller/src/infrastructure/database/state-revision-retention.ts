import type { Kysely, Transaction } from "kysely";

import type { StateDatabaseSchema } from "./types.js";

export const DEFAULT_STATE_REVISION_DELETE_BATCH_SIZE = 1_000;
export const MAX_STATE_REVISION_DELETE_BATCH_SIZE = 10_000;

export interface PruneOrphanedStateRevisionsInput {
  readonly batchSize?: number;
}

export interface PruneOrphanedStateRevisionsResult {
  readonly deletedCount: number;
}

/**
 * Removes revision metadata after its replay outbox row has been pruned. Each
 * write transaction deletes at most `batchSize` rows, keeping writer lock
 * duration bounded while the method drains an accumulated maintenance backlog.
 * The current revision and revisions referenced by notification delivery
 * history are deliberately retained.
 */
export class StateRevisionRetentionRepository {
  constructor(private readonly database: Kysely<StateDatabaseSchema>) {}

  async pruneOrphanedRevisions(
    input: PruneOrphanedStateRevisionsInput = {},
  ): Promise<PruneOrphanedStateRevisionsResult> {
    const batchSize =
      input.batchSize ?? DEFAULT_STATE_REVISION_DELETE_BATCH_SIZE;
    assertBatchSize(batchSize);
    let deletedCount = 0;

    while (true) {
      const deletedInBatch = await this.database
        .transaction()
        .execute((transaction) =>
          deleteOrphanedRevisionBatch(transaction, batchSize),
        );
      deletedCount += deletedInBatch;
      if (!Number.isSafeInteger(deletedCount)) {
        throw new RangeError(
          "State revision deletion count exceeds the safe integer range",
        );
      }
      if (deletedInBatch < batchSize) {
        return { deletedCount };
      }
    }
  }
}

async function deleteOrphanedRevisionBatch(
  transaction: Transaction<StateDatabaseSchema>,
  batchSize: number,
): Promise<number> {
  const current = await transaction
    .selectFrom("state_revisions")
    .select(({ fn }) => fn.max<number>("revision").as("revision"))
    .executeTakeFirstOrThrow();
  if (current.revision === null) {
    return 0;
  }

  const candidates = await transaction
    .selectFrom("state_revisions as revision")
    .leftJoin("state_outbox as outbox", "outbox.revision", "revision.revision")
    .leftJoin(
      "notification_deliveries as notification",
      "notification.alert_transition_revision",
      "revision.revision",
    )
    .select("revision.revision")
    .where("revision.revision", "<", current.revision)
    .where("outbox.revision", "is", null)
    .where("notification.id", "is", null)
    .orderBy("revision.revision", "asc")
    .limit(batchSize)
    .execute();
  const revisions = candidates.map(({ revision }) => revision);
  if (revisions.length === 0) {
    return 0;
  }

  const deletion = await transaction
    .deleteFrom("state_revisions")
    .where("revision", "in", revisions)
    .executeTakeFirst();
  const deletedCount = Number(deletion.numDeletedRows);
  if (deletedCount !== revisions.length) {
    throw new Error(
      "State revision selection changed before deletion; transaction rolled back",
    );
  }
  return deletedCount;
}

function assertBatchSize(batchSize: number): void {
  if (
    !Number.isSafeInteger(batchSize) ||
    batchSize < 1 ||
    batchSize > MAX_STATE_REVISION_DELETE_BATCH_SIZE
  ) {
    throw new RangeError(
      `batchSize must be an integer between 1 and ${MAX_STATE_REVISION_DELETE_BATCH_SIZE}`,
    );
  }
}
