import { randomUUID } from "node:crypto";

import type { Kysely, Transaction } from "kysely";
import { z } from "zod";

import type { EventOutcome, EventsDatabaseSchema } from "../database/index.js";
import { parseJsonDocument } from "../import/strict-json.js";
import {
  assertArchiveComplete,
  createEventArchive,
  type EventArchiveFileWriter,
} from "./event-archive.js";
import {
  InteractionRepository,
  serializeCanonicalJson,
  type StoredInteraction,
} from "./interaction-repository.js";
import { readEventStorageUsage } from "./event-storage-usage.js";

const DEFAULT_AGGREGATE_BUCKET_MS = 5 * 60 * 1_000;
const DEFAULT_PROJECTION_WINDOW_MS = 7 * 24 * 60 * 60 * 1_000;

const aggregateDetailsSchema = z.strictObject({
  schemaVersion: z.literal(1),
  source: z.literal("raw-interactions"),
  sourceByteCount: z.number().int().nonnegative(),
});

const retentionFailureSchema = z.strictObject({
  schemaVersion: z.literal(1),
  message: z.string().min(1).max(1_000),
});

export interface RunEventRetentionRequest {
  readonly database: Kysely<EventsDatabaseSchema>;
  readonly archiveDirectory: string;
  readonly nowMs: number;
  readonly runId?: string;
  readonly aggregateBucketMs?: number;
  readonly projectionWindowMs?: number;
  readonly archiveFileWriter?: EventArchiveFileWriter;
}

export interface EventRetentionRunResult {
  readonly runId: string;
  readonly status: "succeeded";
  readonly bytesBefore: number;
  readonly bytesAfter: number;
  readonly interactionsDeleted: number;
  readonly aggregatesDeleted: number;
  readonly archivesCreated: number;
}

interface RetentionCandidate {
  readonly recordType: "interaction" | "aggregate";
  readonly id: number;
  readonly timestampMs: number;
  readonly byteCount: number;
}

interface AggregateSource {
  readonly bucketStartMs: number;
  readonly bucketEndMs: number;
  readonly kind: string;
  readonly deviceId: string | null;
  readonly outcome: EventOutcome;
  readonly eventCount: number;
  readonly errorCount: number;
  readonly sourceByteCount: number;
  readonly latencyTotalMs: number;
  readonly latencyMinMs: number | null;
  readonly latencyMaxMs: number | null;
}

export async function runEventRetention(
  request: RunEventRetentionRequest,
): Promise<EventRetentionRunResult> {
  assertNonNegativeSafeInteger(request.nowMs, "Retention run time");
  if (request.archiveDirectory.trim().length === 0) {
    throw new TypeError("Archive directory must not be empty");
  }
  const runId = request.runId ?? randomUUID();
  if (runId.trim().length === 0) {
    throw new TypeError("Retention run identifier must not be empty");
  }
  const aggregateBucketMs =
    request.aggregateBucketMs ?? DEFAULT_AGGREGATE_BUCKET_MS;
  if (!Number.isSafeInteger(aggregateBucketMs) || aggregateBucketMs <= 0) {
    throw new RangeError("Aggregate bucket must be a positive safe integer");
  }
  const projectionWindowMs =
    request.projectionWindowMs ?? DEFAULT_PROJECTION_WINDOW_MS;
  const usageBefore = await readEventStorageUsage(request.database, {
    nowMs: request.nowMs,
    projectionWindowMs,
  });
  await request.database
    .insertInto("retention_runs")
    .values({
      id: runId,
      started_at_ms: request.nowMs,
      status: "running",
      bytes_before: usageBefore.logicalEventBytes,
    })
    .executeTakeFirstOrThrow();

  let interactionsDeleted = 0;
  let aggregatesDeleted = 0;
  let archivesCreated = 0;
  try {
    const policies = await request.database
      .selectFrom("retention_policies")
      .selectAll()
      .where("enabled", "=", 1)
      .orderBy("priority")
      .orderBy("retention_class")
      .execute();

    for (const policy of policies) {
      assertPositiveSafeInteger(
        policy.retain_for_ms,
        `${policy.retention_class} retention age`,
      );
      assertPositiveSafeInteger(
        policy.byte_budget,
        `${policy.retention_class} byte budget`,
      );
      const repository = new InteractionRepository(request.database);
      const interactions =
        request.nowMs === 0
          ? []
          : await repository.listRange({
              rangeStartMs: 0,
              rangeEndMs: request.nowMs,
              retentionClass: policy.retention_class,
            });
      const aggregateRows = await request.database
        .selectFrom("event_aggregates")
        .selectAll()
        .where("retention_class", "=", policy.retention_class)
        .where("bucket_end_ms", "<", request.nowMs)
        .orderBy("bucket_end_ms")
        .orderBy("id")
        .execute();
      const candidates = selectRetentionCandidates(
        interactions,
        aggregateRows.map((row) => ({
          recordType: "aggregate" as const,
          id: row.id,
          timestampMs: row.bucket_end_ms,
          byteCount: row.byte_count,
        })),
        request.nowMs - policy.retain_for_ms,
        policy.byte_budget,
      );
      if (candidates.length === 0) continue;

      const interactionIds = candidates.flatMap((candidate) =>
        candidate.recordType === "interaction" ? [candidate.id] : [],
      );
      const aggregateIds = candidates.flatMap((candidate) =>
        candidate.recordType === "aggregate" ? [candidate.id] : [],
      );
      const selectedInteractions = interactions.filter((interaction) =>
        interactionIds.includes(interaction.id),
      );
      let archiveId: string | null = null;
      if (policy.archive_before_delete === 1) {
        const rangeStartMs = Math.min(
          ...candidates.map((candidate) => candidate.timestampMs),
        );
        const rangeEndMs =
          Math.max(...candidates.map((candidate) => candidate.timestampMs)) + 1;
        const createdArchive = await createEventArchive({
          database: request.database,
          archiveDirectory: request.archiveDirectory,
          rangeStartMs,
          rangeEndMs,
          nowMs: request.nowMs,
          retentionClass: policy.retention_class,
          selection: {
            interactionIds,
            aggregateIds,
            stateEventRevisions: [],
          },
          ...(request.archiveFileWriter === undefined
            ? {}
            : { fileWriter: request.archiveFileWriter }),
        });
        assertArchiveContainsCandidates(
          createdArchive.records,
          interactionIds,
          aggregateIds,
        );
        archiveId = createdArchive.archive.id;
        if (createdArchive.created) archivesCreated += 1;
      }

      const deleted = await request.database
        .transaction()
        .execute(async (transaction) => {
          if (archiveId !== null) {
            await assertArchiveComplete(transaction, archiveId);
          }
          if (policy.retention_class === "raw") {
            await aggregateRawInteractions(
              transaction,
              selectedInteractions,
              aggregateBucketMs,
            );
          }
          const deletedInteractions = await deleteRows(
            transaction,
            "interactions",
            interactionIds,
          );
          const deletedAggregates = await deleteRows(
            transaction,
            "event_aggregates",
            aggregateIds,
          );
          if (
            deletedInteractions !== interactionIds.length ||
            deletedAggregates !== aggregateIds.length
          ) {
            throw new Error(
              "Retention selection changed before deletion; transaction rolled back",
            );
          }
          return { deletedInteractions, deletedAggregates };
        });
      interactionsDeleted += deleted.deletedInteractions;
      aggregatesDeleted += deleted.deletedAggregates;
    }

    const usageAfter = await readEventStorageUsage(request.database, {
      nowMs: request.nowMs,
      projectionWindowMs,
    });
    await request.database
      .updateTable("retention_runs")
      .set({
        status: "succeeded",
        completed_at_ms: request.nowMs,
        bytes_after: usageAfter.logicalEventBytes,
        interactions_deleted: interactionsDeleted,
        aggregates_deleted: aggregatesDeleted,
        archives_created: archivesCreated,
        error_json: null,
        error_schema_version: null,
      })
      .where("id", "=", runId)
      .where("status", "=", "running")
      .executeTakeFirstOrThrow();
    return {
      runId,
      status: "succeeded",
      bytesBefore: usageBefore.logicalEventBytes,
      bytesAfter: usageAfter.logicalEventBytes,
      interactionsDeleted,
      aggregatesDeleted,
      archivesCreated,
    };
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Non-Error retention failure";
    const usageAfter = await readEventStorageUsage(request.database, {
      nowMs: request.nowMs,
      projectionWindowMs,
    });
    const failure = retentionFailureSchema.parse({
      schemaVersion: 1,
      message: message.slice(0, 1_000) || "Unknown retention failure",
    });
    await request.database
      .updateTable("retention_runs")
      .set({
        status: "failed",
        completed_at_ms: request.nowMs,
        bytes_after: usageAfter.logicalEventBytes,
        interactions_deleted: interactionsDeleted,
        aggregates_deleted: aggregatesDeleted,
        archives_created: archivesCreated,
        error_json: serializeCanonicalJson(failure),
        error_schema_version: 1,
      })
      .where("id", "=", runId)
      .executeTakeFirst();
    throw error;
  }
}

function selectRetentionCandidates(
  interactions: readonly StoredInteraction[],
  aggregates: readonly RetentionCandidate[],
  ageCutoffMs: number,
  byteBudget: number,
): readonly RetentionCandidate[] {
  const all = [
    ...interactions.map((interaction) => ({
      recordType: "interaction" as const,
      id: interaction.id,
      timestampMs: interaction.occurredAtMs,
      byteCount: interaction.byteCount,
    })),
    ...aggregates,
  ].sort((left, right) => {
    const timestampDifference = left.timestampMs - right.timestampMs;
    if (timestampDifference !== 0) return timestampDifference;
    const typeDifference =
      left.recordType === right.recordType
        ? 0
        : left.recordType < right.recordType
          ? -1
          : 1;
    return typeDifference !== 0 ? typeDifference : left.id - right.id;
  });
  let projectedBytes = all.reduce((total, candidate) => {
    const next = total + candidate.byteCount;
    if (!Number.isSafeInteger(next)) {
      throw new RangeError(
        "Retention byte accounting exceeds safe integer range",
      );
    }
    return next;
  }, 0);
  const selected: RetentionCandidate[] = [];
  for (const candidate of all) {
    if (candidate.timestampMs < ageCutoffMs || projectedBytes > byteBudget) {
      selected.push(candidate);
      projectedBytes -= candidate.byteCount;
    }
  }
  return selected;
}

async function aggregateRawInteractions(
  transaction: Transaction<EventsDatabaseSchema>,
  interactions: readonly StoredInteraction[],
  bucketDurationMs: number,
): Promise<void> {
  const groups = new Map<string, AggregateSource>();
  for (const interaction of interactions) {
    const bucketStartMs =
      Math.floor(interaction.occurredAtMs / bucketDurationMs) *
      bucketDurationMs;
    const bucketEndMs = bucketStartMs + bucketDurationMs;
    const key = serializeCanonicalJson([
      bucketStartMs,
      bucketEndMs,
      interaction.kind,
      interaction.deviceId,
      interaction.outcome,
    ]);
    const previous = groups.get(key);
    const durationMs = interaction.durationMs;
    const isError =
      interaction.severity === "error" ||
      interaction.severity === "critical" ||
      interaction.outcome === "failed" ||
      interaction.outcome === "timed_out" ||
      interaction.outcome === "outcome_unknown";
    groups.set(key, {
      bucketStartMs,
      bucketEndMs,
      kind: interaction.kind,
      deviceId: interaction.deviceId,
      outcome: interaction.outcome,
      eventCount: (previous?.eventCount ?? 0) + 1,
      errorCount: (previous?.errorCount ?? 0) + (isError ? 1 : 0),
      sourceByteCount: (previous?.sourceByteCount ?? 0) + interaction.byteCount,
      latencyTotalMs: (previous?.latencyTotalMs ?? 0) + (durationMs ?? 0),
      latencyMinMs: minimumNullable(previous?.latencyMinMs ?? null, durationMs),
      latencyMaxMs: maximumNullable(previous?.latencyMaxMs ?? null, durationMs),
    });
  }

  for (const group of groups.values()) {
    let existingQuery = transaction
      .selectFrom("event_aggregates")
      .selectAll()
      .where("bucket_start_ms", "=", group.bucketStartMs)
      .where("bucket_end_ms", "=", group.bucketEndMs)
      .where("kind", "=", group.kind)
      .where("outcome", "=", group.outcome);
    existingQuery =
      group.deviceId === null
        ? existingQuery.where("device_id", "is", null)
        : existingQuery.where("device_id", "=", group.deviceId);
    const existing = await existingQuery.executeTakeFirst();
    const existingDetails =
      existing?.details_json === null || existing?.details_json === undefined
        ? null
        : parseAggregateDetails(existing.details_json, existing.id);
    const sourceByteCount =
      (existingDetails?.sourceByteCount ?? 0) + group.sourceByteCount;
    const detailsJson = serializeCanonicalJson(
      aggregateDetailsSchema.parse({
        schemaVersion: 1,
        source: "raw-interactions",
        sourceByteCount,
      }),
    );
    const values = {
      event_count: (existing?.event_count ?? 0) + group.eventCount,
      error_count: (existing?.error_count ?? 0) + group.errorCount,
      byte_count: Buffer.byteLength(detailsJson, "utf8"),
      latency_total_ms:
        (existing?.latency_total_ms ?? 0) + group.latencyTotalMs,
      latency_min_ms: minimumNullable(
        existing?.latency_min_ms ?? null,
        group.latencyMinMs,
      ),
      latency_max_ms: maximumNullable(
        existing?.latency_max_ms ?? null,
        group.latencyMaxMs,
      ),
      retention_class: "aggregate" as const,
      details_json: detailsJson,
      details_schema_version: 1,
    };
    if (existing === undefined) {
      await transaction
        .insertInto("event_aggregates")
        .values({
          bucket_start_ms: group.bucketStartMs,
          bucket_end_ms: group.bucketEndMs,
          kind: group.kind,
          device_id: group.deviceId,
          outcome: group.outcome,
          ...values,
        })
        .executeTakeFirstOrThrow();
    } else {
      await transaction
        .updateTable("event_aggregates")
        .set(values)
        .where("id", "=", existing.id)
        .executeTakeFirstOrThrow();
    }
  }
}

function parseAggregateDetails(
  source: string,
  aggregateId: number,
): z.infer<typeof aggregateDetailsSchema> {
  const document = parseJsonDocument(
    source,
    `aggregate ${aggregateId} details`,
  );
  if (document.duplicateKeys.length > 0) {
    throw new Error(`Aggregate ${aggregateId} details contain duplicate keys`);
  }
  return aggregateDetailsSchema.parse(document.value);
}

function assertArchiveContainsCandidates(
  records: readonly {
    readonly recordType: "interaction" | "aggregate" | "state-event";
    readonly data: { readonly id?: number; readonly revision?: number };
  }[],
  interactionIds: readonly number[],
  aggregateIds: readonly number[],
): void {
  const archivedInteractionIds = records.flatMap((record) =>
    record.recordType === "interaction" && record.data.id !== undefined
      ? [record.data.id]
      : [],
  );
  const archivedAggregateIds = records.flatMap((record) =>
    record.recordType === "aggregate" && record.data.id !== undefined
      ? [record.data.id]
      : [],
  );
  if (
    !sameIntegerSet(archivedInteractionIds, interactionIds) ||
    !sameIntegerSet(archivedAggregateIds, aggregateIds)
  ) {
    throw new Error(
      "Verified archive does not contain the exact retention selection",
    );
  }
}

async function deleteRows(
  transaction: Transaction<EventsDatabaseSchema>,
  table: "interactions" | "event_aggregates",
  ids: readonly number[],
): Promise<number> {
  if (ids.length === 0) return 0;
  const result = await transaction
    .deleteFrom(table)
    .where("id", "in", [...ids])
    .executeTakeFirstOrThrow();
  return Number(result.numDeletedRows);
}

function sameIntegerSet(
  left: readonly number[],
  right: readonly number[],
): boolean {
  if (left.length !== right.length) return false;
  const leftSorted = [...left].sort((a, b) => a - b);
  const rightSorted = [...right].sort((a, b) => a - b);
  return leftSorted.every((value, index) => value === rightSorted[index]);
}

function minimumNullable(
  left: number | null,
  right: number | null,
): number | null {
  if (left === null) return right;
  if (right === null) return left;
  return Math.min(left, right);
}

function maximumNullable(
  left: number | null,
  right: number | null,
): number | null {
  if (left === null) return right;
  if (right === null) return left;
  return Math.max(left, right);
}

function assertNonNegativeSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer`);
  }
}

function assertPositiveSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${label} must be a positive safe integer`);
  }
}
