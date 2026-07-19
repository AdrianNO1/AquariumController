import { sql, type Kysely } from "kysely";

import type {
  EventsDatabaseSchema,
  RetentionClass,
} from "../database/index.js";

const DAY_MS = 24 * 60 * 60 * 1_000;
const YEAR_MS = 365 * DAY_MS;
const RETENTION_CLASSES = [
  "critical",
  "audit",
  "operational",
  "raw",
  "aggregate",
] as const satisfies readonly RetentionClass[];

export interface EventStorageUsageOptions {
  readonly nowMs: number;
  readonly projectionWindowMs?: number;
  readonly backupFreshnessThresholdMs?: number;
  readonly latestVerifiedBackupAtMs?: number | null;
}

export interface RetentionBudgetStatus {
  readonly retentionClass: RetentionClass;
  readonly currentBytes: number;
  readonly byteBudget: number;
  readonly remainingBytes: number;
  readonly overBudget: boolean;
  readonly projectedAnnualIngestBytes: number;
  readonly estimatedDaysUntilBudgetExhaustion: number | null;
}

export interface EventStorageUsage {
  readonly measuredAtMs: number;
  readonly projectionWindowMs: number;
  readonly logicalEventBytes: number;
  readonly logicalBytesByRetentionClass: Readonly<
    Record<RetentionClass, number>
  >;
  readonly recentIngestBytes: number;
  readonly projectedAnnualIngestBytes: number;
  readonly databaseAllocatedBytes: number;
  readonly databaseReclaimableBytes: number;
  readonly completeArchiveBytes: number;
  readonly completeArchiveUncompressedBytes: number;
  readonly archiveCompressionRatio: number | null;
  readonly pendingArchiveBytes: number;
  readonly trackedStorageBytes: number;
  readonly projectedUpperBoundStorageBytesAfterOneYear: number;
  readonly failedArchiveCount: number;
  readonly pendingArchiveCount: number;
  readonly failedRetentionRunCount: number;
  readonly runningRetentionRunCount: number;
  readonly latestBackupOutcomeFailed: 0 | 1;
  readonly successfulBackupMissingOrStale: 0 | 1;
  readonly retentionBudgets: readonly RetentionBudgetStatus[];
}

interface RetentionBytesRow {
  readonly retention_class: RetentionClass;
  readonly bytes: number | string | null;
}

interface CountBytesRow {
  readonly count: number | string;
  readonly bytes: number | string | null;
}

export async function readEventStorageUsage(
  database: Kysely<EventsDatabaseSchema>,
  options: EventStorageUsageOptions,
): Promise<EventStorageUsage> {
  assertNonNegativeSafeInteger(options.nowMs, "Usage measurement time");
  const projectionWindowMs = options.projectionWindowMs ?? 7 * DAY_MS;
  if (!Number.isSafeInteger(projectionWindowMs) || projectionWindowMs <= 0) {
    throw new RangeError("Projection window must be a positive safe integer");
  }
  const backupFreshnessThresholdMs =
    options.backupFreshnessThresholdMs ?? 36 * 60 * 60 * 1_000;
  if (
    !Number.isSafeInteger(backupFreshnessThresholdMs) ||
    backupFreshnessThresholdMs <= 0
  ) {
    throw new RangeError(
      "Backup freshness threshold must be a positive safe integer",
    );
  }
  const windowStartMs = Math.max(0, options.nowMs - projectionWindowMs);

  const [
    interactionBytes,
    aggregateBytes,
    stateEventBytes,
    recentInteractionBytes,
    recentStateEventBytes,
    archiveSummary,
    failedArchiveCount,
    pendingArchiveSummary,
    failedRetentionRunCount,
    runningRunSummary,
    latestBackupOutcomeFailed,
    latestSuccessfulBackupAtMs,
    policies,
    pageCountResult,
    pageSizeResult,
    freelistResult,
  ] = await Promise.all([
    sumBytesByRetentionClass(database, "interactions"),
    sumBytesByRetentionClass(database, "event_aggregates"),
    sumBytesByRetentionClass(database, "state_events"),
    database
      .selectFrom("interactions")
      .select("retention_class")
      .select((expression) =>
        expression.fn.sum<number>("byte_count").as("bytes"),
      )
      .where("occurred_at_ms", ">=", windowStartMs)
      .where("occurred_at_ms", "<", options.nowMs)
      .groupBy("retention_class")
      .execute(),
    database
      .selectFrom("state_events")
      .select("retention_class")
      .select((expression) =>
        expression.fn.sum<number>("byte_count").as("bytes"),
      )
      .where("occurred_at_ms", ">=", windowStartMs)
      .where("occurred_at_ms", "<", options.nowMs)
      .groupBy("retention_class")
      .execute(),
    database
      .selectFrom("event_archives")
      .select((expression) => [
        expression.fn.sum<number>("compressed_bytes").as("bytes"),
        expression.fn
          .sum<number>("uncompressed_bytes")
          .as("uncompressed_bytes"),
      ])
      .where("status", "=", "complete")
      .executeTakeFirstOrThrow(),
    countUnresolvedArchiveFailures(database),
    countArchives(database, "pending"),
    countUnresolvedRetentionFailures(database),
    countRetentionRuns(database, "running"),
    readLatestBackupOutcomeFailed(database),
    options.latestVerifiedBackupAtMs === undefined
      ? readLatestSuccessfulBackupAtMs(database)
      : Promise.resolve(options.latestVerifiedBackupAtMs),
    database
      .selectFrom("retention_policies")
      .select(["retention_class", "byte_budget"])
      .where("enabled", "=", 1)
      .orderBy("priority")
      .execute(),
    sql<{ page_count: number }>`PRAGMA page_count`.execute(database),
    sql<{ page_size: number }>`PRAGMA page_size`.execute(database),
    sql<{ freelist_count: number }>`PRAGMA freelist_count`.execute(database),
  ]);

  const logicalBytes = emptyRetentionRecord();
  addRetentionRows(logicalBytes, interactionBytes);
  addRetentionRows(logicalBytes, aggregateBytes);
  addRetentionRows(logicalBytes, stateEventBytes);
  const recentBytes = emptyRetentionRecord();
  addRetentionRows(recentBytes, recentInteractionBytes);
  addRetentionRows(recentBytes, recentStateEventBytes);

  const logicalEventBytes = sumRetentionRecord(logicalBytes);
  const recentIngestBytes = sumRetentionRecord(recentBytes);
  const projectedAnnualIngestBytes = Math.ceil(
    (recentIngestBytes * YEAR_MS) / projectionWindowMs,
  );
  const retentionBudgets = policies.map((policy) => {
    const currentBytes = logicalBytes[policy.retention_class];
    const recentClassBytes = recentBytes[policy.retention_class];
    const projectedAnnualClassBytes = Math.ceil(
      (recentClassBytes * YEAR_MS) / projectionWindowMs,
    );
    const remainingBytes = Math.max(0, policy.byte_budget - currentBytes);
    const bytesPerDay = (recentClassBytes * DAY_MS) / projectionWindowMs;
    return {
      retentionClass: policy.retention_class,
      currentBytes,
      byteBudget: policy.byte_budget,
      remainingBytes,
      overBudget: currentBytes > policy.byte_budget,
      projectedAnnualIngestBytes: projectedAnnualClassBytes,
      estimatedDaysUntilBudgetExhaustion:
        currentBytes >= policy.byte_budget
          ? 0
          : bytesPerDay <= 0
            ? null
            : remainingBytes / bytesPerDay,
    } satisfies RetentionBudgetStatus;
  });

  const pageCount = pageCountResult.rows[0]?.page_count ?? 0;
  const pageSize = pageSizeResult.rows[0]?.page_size ?? 0;
  const freelistCount = freelistResult.rows[0]?.freelist_count ?? 0;
  const databaseAllocatedBytes = pageCount * pageSize;
  const completeArchiveBytes = toSafeNonNegativeInteger(archiveSummary.bytes);
  const completeArchiveUncompressedBytes = toSafeNonNegativeInteger(
    archiveSummary.uncompressed_bytes,
  );
  const pendingArchiveBytes = toSafeNonNegativeInteger(
    pendingArchiveSummary.bytes,
  );
  const trackedStorageBytes = safeSum([
    databaseAllocatedBytes,
    completeArchiveBytes,
    pendingArchiveBytes,
  ]);
  if (latestSuccessfulBackupAtMs !== null) {
    assertNonNegativeSafeInteger(
      latestSuccessfulBackupAtMs,
      "Latest successful backup time",
    );
  }
  if (
    latestSuccessfulBackupAtMs !== null &&
    latestSuccessfulBackupAtMs > options.nowMs
  ) {
    throw new RangeError(
      "Latest successful backup time cannot be in the future",
    );
  }
  const successfulBackupMissingOrStale =
    latestSuccessfulBackupAtMs === null ||
    options.nowMs - latestSuccessfulBackupAtMs > backupFreshnessThresholdMs
      ? 1
      : 0;
  return {
    measuredAtMs: options.nowMs,
    projectionWindowMs,
    logicalEventBytes,
    logicalBytesByRetentionClass: logicalBytes,
    recentIngestBytes,
    projectedAnnualIngestBytes,
    databaseAllocatedBytes,
    databaseReclaimableBytes: freelistCount * pageSize,
    completeArchiveBytes,
    completeArchiveUncompressedBytes,
    archiveCompressionRatio:
      completeArchiveUncompressedBytes === 0
        ? null
        : completeArchiveBytes / completeArchiveUncompressedBytes,
    pendingArchiveBytes,
    trackedStorageBytes,
    projectedUpperBoundStorageBytesAfterOneYear: safeSum([
      trackedStorageBytes,
      projectedAnnualIngestBytes,
    ]),
    failedArchiveCount,
    pendingArchiveCount: toSafeNonNegativeInteger(pendingArchiveSummary.count),
    failedRetentionRunCount,
    runningRetentionRunCount: toSafeNonNegativeInteger(runningRunSummary.count),
    latestBackupOutcomeFailed,
    successfulBackupMissingOrStale,
    retentionBudgets,
  };
}

function safeSum(values: readonly number[]): number {
  return values.reduce((total, value) => {
    const next = total + value;
    if (!Number.isSafeInteger(next) || next < 0) {
      throw new RangeError("Projected storage exceeds safe integer range");
    }
    return next;
  }, 0);
}

function sumBytesByRetentionClass(
  database: Kysely<EventsDatabaseSchema>,
  table: "interactions" | "event_aggregates" | "state_events",
): Promise<readonly RetentionBytesRow[]> {
  return database
    .selectFrom(table)
    .select("retention_class")
    .select((expression) => expression.fn.sum<number>("byte_count").as("bytes"))
    .groupBy("retention_class")
    .execute();
}

function countArchives(
  database: Kysely<EventsDatabaseSchema>,
  status: "pending",
): Promise<CountBytesRow> {
  return database
    .selectFrom("event_archives")
    .select((expression) => [
      expression.fn.count<number>("id").as("count"),
      expression.fn.sum<number>("compressed_bytes").as("bytes"),
    ])
    .where("status", "=", status)
    .executeTakeFirstOrThrow();
}

async function countUnresolvedArchiveFailures(
  database: Kysely<EventsDatabaseSchema>,
): Promise<number> {
  const result = await sql<{ readonly count: number | string | bigint }>`
    WITH latest_success AS (
      SELECT created_at_ms, rowid AS outcome_rowid
      FROM event_archives
      WHERE status = 'complete'
      ORDER BY created_at_ms DESC, rowid DESC
      LIMIT 1
    )
    SELECT COUNT(*) AS count
    FROM event_archives AS failed
    WHERE failed.status = 'failed'
      AND (
        NOT EXISTS (SELECT 1 FROM latest_success)
        OR failed.created_at_ms > (SELECT created_at_ms FROM latest_success)
        OR (
          failed.created_at_ms = (SELECT created_at_ms FROM latest_success)
          AND failed.rowid > (SELECT outcome_rowid FROM latest_success)
        )
      )
  `.execute(database);
  return toSafeNonNegativeInteger(result.rows[0]?.count ?? 0);
}

async function countUnresolvedRetentionFailures(
  database: Kysely<EventsDatabaseSchema>,
): Promise<number> {
  const result = await sql<{ readonly count: number | string | bigint }>`
    WITH latest_success AS (
      SELECT completed_at_ms, rowid AS outcome_rowid
      FROM retention_runs
      WHERE status = 'succeeded' AND completed_at_ms IS NOT NULL
      ORDER BY completed_at_ms DESC, rowid DESC
      LIMIT 1
    )
    SELECT COUNT(*) AS count
    FROM retention_runs AS failed
    WHERE failed.status = 'failed'
      AND failed.completed_at_ms IS NOT NULL
      AND (
        NOT EXISTS (SELECT 1 FROM latest_success)
        OR failed.completed_at_ms > (SELECT completed_at_ms FROM latest_success)
        OR (
          failed.completed_at_ms = (SELECT completed_at_ms FROM latest_success)
          AND failed.rowid > (SELECT outcome_rowid FROM latest_success)
        )
      )
  `.execute(database);
  return toSafeNonNegativeInteger(result.rows[0]?.count ?? 0);
}

async function readLatestBackupOutcomeFailed(
  database: Kysely<EventsDatabaseSchema>,
): Promise<0 | 1> {
  const latest = await database
    .selectFrom("interactions")
    .select("outcome")
    .where("kind", "=", "maintenance.backup")
    .orderBy("occurred_at_ms", "desc")
    .orderBy("id", "desc")
    .executeTakeFirst();
  if (latest === undefined) return 0;
  if (latest.outcome === "failed") return 1;
  if (latest.outcome === "succeeded") return 0;
  throw new Error(
    `Latest maintenance.backup interaction has invalid outcome ${latest.outcome}`,
  );
}

async function readLatestSuccessfulBackupAtMs(
  database: Kysely<EventsDatabaseSchema>,
): Promise<number | null> {
  const latest = await database
    .selectFrom("interactions")
    .select("occurred_at_ms")
    .where("kind", "=", "maintenance.backup")
    .where("outcome", "=", "succeeded")
    .orderBy("occurred_at_ms", "desc")
    .orderBy("id", "desc")
    .executeTakeFirst();
  return latest?.occurred_at_ms ?? null;
}

function countRetentionRuns(
  database: Kysely<EventsDatabaseSchema>,
  status: "running",
): Promise<Pick<CountBytesRow, "count">> {
  return database
    .selectFrom("retention_runs")
    .select((expression) => expression.fn.count<number>("id").as("count"))
    .where("status", "=", status)
    .executeTakeFirstOrThrow();
}

function emptyRetentionRecord(): Record<RetentionClass, number> {
  return {
    critical: 0,
    audit: 0,
    operational: 0,
    raw: 0,
    aggregate: 0,
  };
}

function addRetentionRows(
  target: Record<RetentionClass, number>,
  rows: readonly RetentionBytesRow[],
): void {
  for (const row of rows) {
    target[row.retention_class] += toSafeNonNegativeInteger(row.bytes);
  }
}

function sumRetentionRecord(
  record: Readonly<Record<RetentionClass, number>>,
): number {
  return RETENTION_CLASSES.reduce((total, retentionClass) => {
    const next = total + record[retentionClass];
    if (!Number.isSafeInteger(next)) {
      throw new RangeError("Event byte accounting exceeds safe integer range");
    }
    return next;
  }, 0);
}

function toSafeNonNegativeInteger(
  value: number | string | bigint | null,
): number {
  const parsed = Number(value ?? 0);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new RangeError("SQLite returned an invalid byte or count value");
  }
  return parsed;
}

function assertNonNegativeSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer`);
  }
}
