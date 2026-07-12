import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { zstdCompressSync, zstdDecompressSync } from "node:zlib";

import type { Kysely, Transaction } from "kysely";
import { z } from "zod";

import type {
  EventsDatabaseSchema,
  RetentionClass,
} from "../database/index.js";
import { parseJsonDocument } from "../import/strict-json.js";
import {
  assertRange,
  interactionPayloadSchema,
  InteractionRepository,
  serializeCanonicalJson,
  sha256,
} from "./interaction-repository.js";

const DAY_MS = 24 * 60 * 60 * 1_000;
const retentionClassSchema = z.enum([
  "critical",
  "audit",
  "operational",
  "raw",
  "aggregate",
]);
const eventOutcomeSchema = z.enum([
  "pending",
  "succeeded",
  "failed",
  "timed_out",
  "outcome_unknown",
  "ignored",
]);
const severitySchema = z.enum([
  "debug",
  "info",
  "warning",
  "error",
  "critical",
]);
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);

const archivedInteractionSchema = z.strictObject({
  id: z.number().int().positive(),
  occurredAtMs: z.number().int().nonnegative(),
  direction: z.enum(["inbound", "outbound", "internal"]),
  kind: z.string().min(1),
  severity: severitySchema,
  topic: z.string().min(1).nullable(),
  deviceId: z.string().min(1).nullable(),
  correlationId: z.string().min(1).nullable(),
  operationId: z.string().min(1).nullable(),
  outcome: eventOutcomeSchema,
  durationMs: z.number().int().nonnegative().nullable(),
  byteCount: z.number().int().nonnegative(),
  retentionClass: retentionClassSchema,
  payload: interactionPayloadSchema.nullable(),
  payloadSchemaVersion: z.number().int().positive().nullable(),
  payloadSha256: sha256Schema.nullable(),
});

const archivedAggregateSchema = z.strictObject({
  id: z.number().int().positive(),
  bucketStartMs: z.number().int().nonnegative(),
  bucketEndMs: z.number().int().positive(),
  kind: z.string().min(1),
  deviceId: z.string().min(1).nullable(),
  outcome: eventOutcomeSchema,
  eventCount: z.number().int().positive(),
  errorCount: z.number().int().nonnegative(),
  byteCount: z.number().int().nonnegative(),
  latencyTotalMs: z.number().int().nonnegative(),
  latencyMinMs: z.number().int().nonnegative().nullable(),
  latencyMaxMs: z.number().int().nonnegative().nullable(),
  retentionClass: retentionClassSchema,
  details: z.json().nullable(),
  detailsSchemaVersion: z.number().int().positive().nullable(),
});

const archivedStateEventSchema = z.strictObject({
  revision: z.number().int().positive(),
  occurredAtMs: z.number().int().nonnegative(),
  eventType: z.string().min(1),
  entityType: z.string().min(1),
  entityId: z.string().min(1).nullable(),
  retentionClass: retentionClassSchema,
  payload: z.json(),
  payloadSchemaVersion: z.number().int().positive(),
  byteCount: z.number().int().nonnegative(),
});

export const eventArchiveRecordSchema = z.discriminatedUnion("recordType", [
  z.strictObject({
    schemaVersion: z.literal(1),
    recordType: z.literal("interaction"),
    data: archivedInteractionSchema,
  }),
  z.strictObject({
    schemaVersion: z.literal(1),
    recordType: z.literal("aggregate"),
    data: archivedAggregateSchema,
  }),
  z.strictObject({
    schemaVersion: z.literal(1),
    recordType: z.literal("state-event"),
    data: archivedStateEventSchema,
  }),
]);

export type EventArchiveRecord = z.infer<typeof eventArchiveRecordSchema>;
export type ArchivedAggregate = z.infer<typeof archivedAggregateSchema>;
export type ArchivedStateEvent = z.infer<typeof archivedStateEventSchema>;

const archiveFailureSchema = z.strictObject({
  message: z.string().min(1).max(1_000),
});

export const eventArchiveMetadataSchema = z.strictObject({
  schemaVersion: z.literal(1),
  content: z.literal("events-ndjson"),
  retentionClass: retentionClassSchema.nullable(),
  contentSha256: sha256Schema,
  interactionCount: z.number().int().nonnegative(),
  aggregateCount: z.number().int().nonnegative(),
  stateEventCount: z.number().int().nonnegative(),
  failure: archiveFailureSchema.nullable(),
});

export type EventArchiveMetadata = z.infer<typeof eventArchiveMetadataSchema>;

const eventArchiveRowSchema = z.strictObject({
  id: z.string().min(1),
  range_start_ms: z.number().int().nonnegative(),
  range_end_ms: z.number().int().positive(),
  created_at_ms: z.number().int().nonnegative(),
  codec: z.literal("zstd"),
  storage_path: z.string().min(1),
  sha256: sha256Schema,
  event_count: z.number().int().nonnegative(),
  uncompressed_bytes: z.number().int().nonnegative(),
  compressed_bytes: z.number().int().nonnegative(),
  status: z.enum(["pending", "complete", "failed"]),
  metadata_json: z.string().min(1),
  metadata_schema_version: z.literal(1),
});

export interface StoredEventArchive {
  readonly id: string;
  readonly rangeStartMs: number;
  readonly rangeEndMs: number;
  readonly createdAtMs: number;
  readonly codec: "zstd";
  readonly storagePath: string;
  readonly sha256: string;
  readonly eventCount: number;
  readonly uncompressedBytes: number;
  readonly compressedBytes: number;
  readonly status: "pending" | "complete" | "failed";
  readonly metadata: EventArchiveMetadata;
}

export interface EventArchiveSelection {
  readonly interactionIds?: readonly number[];
  readonly aggregateIds?: readonly number[];
  readonly stateEventRevisions?: readonly number[];
}

export interface CreateEventArchiveRequest {
  readonly database: Kysely<EventsDatabaseSchema>;
  readonly archiveDirectory: string;
  readonly rangeStartMs: number;
  readonly rangeEndMs: number;
  readonly nowMs: number;
  readonly retentionClass?: RetentionClass;
  readonly selection?: EventArchiveSelection;
  readonly fileWriter?: EventArchiveFileWriter;
}

export interface CreateDailyEventArchiveRequest {
  readonly database: Kysely<EventsDatabaseSchema>;
  readonly archiveDirectory: string;
  readonly utcDayMs: number;
  readonly nowMs: number;
  readonly retentionClass?: RetentionClass;
  readonly fileWriter?: EventArchiveFileWriter;
}

export interface EventArchiveFileWriter {
  writeAtomically(filename: string, contents: Uint8Array): Promise<void>;
}

export interface CreatedEventArchive {
  readonly archive: StoredEventArchive;
  readonly records: readonly EventArchiveRecord[];
  readonly created: boolean;
}

export interface VerifiedEventArchive {
  readonly archive: StoredEventArchive;
  readonly records: readonly EventArchiveRecord[];
}

export interface DeletedArchiveRecords {
  readonly interactionsDeleted: number;
  readonly aggregatesDeleted: number;
}

export async function createEventArchive(
  request: CreateEventArchiveRequest,
): Promise<CreatedEventArchive> {
  assertRange(request.rangeStartMs, request.rangeEndMs);
  assertNonNegativeSafeInteger(request.nowMs, "Archive creation time");
  if (request.nowMs < request.rangeEndMs) {
    throw new RangeError("Archive creation time must be at or after range end");
  }
  if (request.archiveDirectory.trim().length === 0) {
    throw new TypeError("Archive directory must not be empty");
  }

  const records = await readArchiveRecords(request);
  const ndjson = encodeEventArchiveRecords(records);
  const uncompressed = Buffer.from(ndjson, "utf8");
  const contentSha256 = sha256(uncompressed);
  const compressed = zstdCompressSync(uncompressed);
  const compressedSha256 = sha256(compressed);
  const filterName = request.retentionClass ?? "all";
  const archiveId = [
    "events",
    filterName,
    request.rangeStartMs,
    request.rangeEndMs,
    contentSha256,
  ].join("-");
  const storagePath = resolve(
    request.archiveDirectory,
    `${archiveId}.ndjson.zst`,
  );
  const counts = countArchiveRecordTypes(records);
  const metadata = eventArchiveMetadataSchema.parse({
    schemaVersion: 1,
    content: "events-ndjson",
    retentionClass: request.retentionClass ?? null,
    contentSha256,
    ...counts,
    failure: null,
  });
  const values = {
    id: archiveId,
    range_start_ms: request.rangeStartMs,
    range_end_ms: request.rangeEndMs,
    created_at_ms: request.nowMs,
    codec: "zstd" as const,
    storage_path: storagePath,
    sha256: compressedSha256,
    event_count: records.length,
    uncompressed_bytes: uncompressed.byteLength,
    compressed_bytes: compressed.byteLength,
    metadata_json: serializeCanonicalJson(metadata),
    metadata_schema_version: 1,
  };

  const existing = await request.database
    .selectFrom("event_archives")
    .selectAll()
    .where("id", "=", archiveId)
    .executeTakeFirst();
  if (existing?.status === "complete") {
    const verified = await verifyCompleteEventArchive(
      request.database,
      archiveId,
    );
    return { ...verified, created: false };
  }

  await request.database
    .insertInto("event_archives")
    .values({ ...values, status: "pending" })
    .onConflict((conflict) =>
      conflict.column("id").doUpdateSet({ ...values, status: "pending" }),
    )
    .executeTakeFirstOrThrow();

  try {
    await (request.fileWriter ?? defaultEventArchiveFileWriter).writeAtomically(
      storagePath,
      compressed,
    );
    const pendingArchive = await readEventArchive(request.database, archiveId);
    const verifiedRecords = await verifyArchiveFile(pendingArchive);
    const completion = await request.database
      .updateTable("event_archives")
      .set({ status: "complete" })
      .where("id", "=", archiveId)
      .where("status", "=", "pending")
      .executeTakeFirstOrThrow();
    if (Number(completion.numUpdatedRows) !== 1) {
      throw new Error(`Archive ${archiveId} was not pending at completion`);
    }
    return {
      archive: { ...pendingArchive, status: "complete" },
      records: verifiedRecords,
      created: true,
    };
  } catch (error) {
    await markArchiveFailed(
      request.database,
      archiveId,
      metadata,
      error instanceof Error ? error.message : "Non-Error archive failure",
    );
    throw error;
  }
}

export async function createDailyEventArchive(
  request: CreateDailyEventArchiveRequest,
): Promise<CreatedEventArchive> {
  assertNonNegativeSafeInteger(request.utcDayMs, "UTC day time");
  const rangeStartMs = Math.floor(request.utcDayMs / DAY_MS) * DAY_MS;
  return createEventArchive({
    database: request.database,
    archiveDirectory: request.archiveDirectory,
    rangeStartMs,
    rangeEndMs: rangeStartMs + DAY_MS,
    nowMs: request.nowMs,
    ...(request.retentionClass === undefined
      ? {}
      : { retentionClass: request.retentionClass }),
    ...(request.fileWriter === undefined
      ? {}
      : { fileWriter: request.fileWriter }),
  });
}

export async function verifyCompleteEventArchive(
  database: Kysely<EventsDatabaseSchema>,
  archiveId: string,
): Promise<VerifiedEventArchive> {
  const archive = await readEventArchive(database, archiveId);
  if (archive.status !== "complete") {
    throw new Error(
      `Archive ${archiveId} cannot be consumed while status is ${archive.status}`,
    );
  }
  try {
    return { archive, records: await verifyArchiveFile(archive) };
  } catch (error) {
    await markArchiveFailed(
      database,
      archiveId,
      archive.metadata,
      error instanceof Error ? error.message : "Non-Error archive failure",
    );
    throw error;
  }
}

export async function deleteVerifiedEventArchiveRecords(
  database: Kysely<EventsDatabaseSchema>,
  archiveId: string,
): Promise<DeletedArchiveRecords> {
  const verified = await verifyCompleteEventArchive(database, archiveId);
  const interactionIds = verified.records.flatMap((record) =>
    record.recordType === "interaction" ? [record.data.id] : [],
  );
  const aggregateIds = verified.records.flatMap((record) =>
    record.recordType === "aggregate" ? [record.data.id] : [],
  );
  return database.transaction().execute(async (transaction) => {
    await assertArchiveComplete(transaction, archiveId);
    const interactionsDeleted = await deleteIds(
      transaction,
      "interactions",
      interactionIds,
    );
    const aggregatesDeleted = await deleteIds(
      transaction,
      "event_aggregates",
      aggregateIds,
    );
    return { interactionsDeleted, aggregatesDeleted };
  });
}

export function encodeEventArchiveRecords(
  records: readonly EventArchiveRecord[],
): string {
  return records
    .map((record) =>
      serializeCanonicalJson(eventArchiveRecordSchema.parse(record)),
    )
    .join("\n")
    .concat(records.length === 0 ? "" : "\n");
}

export function decodeEventArchiveBytes(
  compressed: Uint8Array,
): readonly EventArchiveRecord[] {
  return decodeEventArchiveNdjson(
    zstdDecompressSync(compressed).toString("utf8"),
  );
}

export async function assertArchiveComplete(
  database: Kysely<EventsDatabaseSchema> | Transaction<EventsDatabaseSchema>,
  archiveId: string,
): Promise<void> {
  const row = await database
    .selectFrom("event_archives")
    .select("status")
    .where("id", "=", archiveId)
    .executeTakeFirst();
  if (row?.status !== "complete") {
    throw new Error(`Archive ${archiveId} is not complete`);
  }
}

async function readArchiveRecords(
  request: CreateEventArchiveRequest,
): Promise<readonly EventArchiveRecord[]> {
  const interactions = await readInteractions(request);
  const aggregates = await readAggregates(request);
  const stateEvents = await readStateEvents(request);
  return [...interactions, ...aggregates, ...stateEvents].sort(compareRecords);
}

async function readInteractions(
  request: CreateEventArchiveRequest,
): Promise<readonly EventArchiveRecord[]> {
  const ids = request.selection?.interactionIds;
  if (ids !== undefined && ids.length === 0) return [];
  const repository = new InteractionRepository(request.database);
  const interactions = await repository.listRange({
    rangeStartMs: request.rangeStartMs,
    rangeEndMs: request.rangeEndMs,
    ...(request.retentionClass === undefined
      ? {}
      : { retentionClass: request.retentionClass }),
    ...(ids === undefined ? {} : { ids }),
  });
  return interactions.map((data) =>
    eventArchiveRecordSchema.parse({
      schemaVersion: 1,
      recordType: "interaction",
      data,
    }),
  );
}

async function readAggregates(
  request: CreateEventArchiveRequest,
): Promise<readonly EventArchiveRecord[]> {
  const ids = request.selection?.aggregateIds;
  if (ids !== undefined && ids.length === 0) return [];
  let query = request.database
    .selectFrom("event_aggregates")
    .selectAll()
    .where("bucket_end_ms", ">=", request.rangeStartMs)
    .where("bucket_end_ms", "<", request.rangeEndMs);
  if (request.retentionClass !== undefined) {
    query = query.where("retention_class", "=", request.retentionClass);
  }
  if (ids !== undefined) {
    for (const id of ids) assertPositiveSafeInteger(id, "Aggregate identifier");
    query = query.where("id", "in", [...ids]);
  }
  const rows = await query.orderBy("bucket_end_ms").orderBy("id").execute();
  return rows.map((row) => {
    const details = parseOptionalJson(
      row.details_json,
      `aggregate ${row.id} details`,
    );
    return eventArchiveRecordSchema.parse({
      schemaVersion: 1,
      recordType: "aggregate",
      data: {
        id: row.id,
        bucketStartMs: row.bucket_start_ms,
        bucketEndMs: row.bucket_end_ms,
        kind: row.kind,
        deviceId: row.device_id,
        outcome: row.outcome,
        eventCount: row.event_count,
        errorCount: row.error_count,
        byteCount: row.byte_count,
        latencyTotalMs: row.latency_total_ms,
        latencyMinMs: row.latency_min_ms,
        latencyMaxMs: row.latency_max_ms,
        retentionClass: row.retention_class,
        details,
        detailsSchemaVersion: row.details_schema_version,
      },
    });
  });
}

async function readStateEvents(
  request: CreateEventArchiveRequest,
): Promise<readonly EventArchiveRecord[]> {
  const revisions = request.selection?.stateEventRevisions;
  if (revisions !== undefined && revisions.length === 0) return [];
  let query = request.database
    .selectFrom("state_events")
    .selectAll()
    .where("occurred_at_ms", ">=", request.rangeStartMs)
    .where("occurred_at_ms", "<", request.rangeEndMs);
  if (request.retentionClass !== undefined) {
    query = query.where("retention_class", "=", request.retentionClass);
  }
  if (revisions !== undefined) {
    for (const revision of revisions) {
      assertPositiveSafeInteger(revision, "State event revision");
    }
    query = query.where("revision", "in", [...revisions]);
  }
  const rows = await query
    .orderBy("occurred_at_ms")
    .orderBy("revision")
    .execute();
  return rows.map((row) =>
    eventArchiveRecordSchema.parse({
      schemaVersion: 1,
      recordType: "state-event",
      data: {
        revision: row.revision,
        occurredAtMs: row.occurred_at_ms,
        eventType: row.event_type,
        entityType: row.entity_type,
        entityId: row.entity_id,
        retentionClass: row.retention_class,
        payload: parseRequiredJson(
          row.payload_json,
          `state event ${row.revision} payload`,
        ),
        payloadSchemaVersion: row.payload_schema_version,
        byteCount: row.byte_count,
      },
    }),
  );
}

async function readEventArchive(
  database: Kysely<EventsDatabaseSchema>,
  archiveId: string,
): Promise<StoredEventArchive> {
  if (archiveId.trim().length === 0) {
    throw new TypeError("Archive identifier must not be empty");
  }
  const row = await database
    .selectFrom("event_archives")
    .selectAll()
    .where("id", "=", archiveId)
    .executeTakeFirst();
  if (row === undefined) throw new Error(`Archive ${archiveId} does not exist`);
  const parsed = eventArchiveRowSchema.parse(row);
  const metadata = eventArchiveMetadataSchema.parse(
    parseRequiredJson(parsed.metadata_json, `archive ${archiveId} metadata`),
  );
  return {
    id: parsed.id,
    rangeStartMs: parsed.range_start_ms,
    rangeEndMs: parsed.range_end_ms,
    createdAtMs: parsed.created_at_ms,
    codec: parsed.codec,
    storagePath: parsed.storage_path,
    sha256: parsed.sha256,
    eventCount: parsed.event_count,
    uncompressedBytes: parsed.uncompressed_bytes,
    compressedBytes: parsed.compressed_bytes,
    status: parsed.status,
    metadata,
  };
}

async function verifyArchiveFile(
  archive: StoredEventArchive,
): Promise<readonly EventArchiveRecord[]> {
  const compressed = await readFile(archive.storagePath);
  if (compressed.byteLength !== archive.compressedBytes) {
    throw new Error(`Archive ${archive.id} compressed byte count mismatch`);
  }
  if (sha256(compressed) !== archive.sha256) {
    throw new Error(`Archive ${archive.id} checksum mismatch`);
  }
  const uncompressed = zstdDecompressSync(compressed);
  if (uncompressed.byteLength !== archive.uncompressedBytes) {
    throw new Error(`Archive ${archive.id} uncompressed byte count mismatch`);
  }
  if (sha256(uncompressed) !== archive.metadata.contentSha256) {
    throw new Error(`Archive ${archive.id} content checksum mismatch`);
  }
  const records = decodeEventArchiveNdjson(uncompressed.toString("utf8"));
  if (records.length !== archive.eventCount) {
    throw new Error(`Archive ${archive.id} event count mismatch`);
  }
  const counts = countArchiveRecordTypes(records);
  if (
    counts.interactionCount !== archive.metadata.interactionCount ||
    counts.aggregateCount !== archive.metadata.aggregateCount ||
    counts.stateEventCount !== archive.metadata.stateEventCount
  ) {
    throw new Error(
      `Archive ${archive.id} record type counts do not match metadata`,
    );
  }
  for (const record of records) {
    const timestamp = archiveRecordTimestamp(record);
    const retentionClass = archiveRecordRetentionClass(record);
    if (timestamp < archive.rangeStartMs || timestamp >= archive.rangeEndMs) {
      throw new Error(`Archive ${archive.id} contains an out-of-range record`);
    }
    if (
      archive.metadata.retentionClass !== null &&
      retentionClass !== archive.metadata.retentionClass
    ) {
      throw new Error(
        `Archive ${archive.id} contains a mismatched retention class`,
      );
    }
  }
  return records;
}

function decodeEventArchiveNdjson(
  ndjson: string,
): readonly EventArchiveRecord[] {
  if (ndjson.length === 0) return [];
  if (!ndjson.endsWith("\n")) {
    throw new Error("Event archive NDJSON must end with a newline");
  }
  return ndjson
    .slice(0, -1)
    .split("\n")
    .map((line, index) => {
      if (line.length === 0) {
        throw new Error(`Event archive contains an empty line at ${index + 1}`);
      }
      const document = parseJsonDocument(
        line,
        `event archive line ${index + 1}`,
      );
      if (document.duplicateKeys.length > 0) {
        throw new Error(
          `Event archive line ${index + 1} contains duplicate object keys`,
        );
      }
      return eventArchiveRecordSchema.parse(document.value);
    });
}

async function markArchiveFailed(
  database: Kysely<EventsDatabaseSchema>,
  archiveId: string,
  metadata: EventArchiveMetadata,
  message: string,
): Promise<void> {
  const failedMetadata = eventArchiveMetadataSchema.parse({
    ...metadata,
    failure: { message: message.slice(0, 1_000) || "Unknown archive failure" },
  });
  await database
    .updateTable("event_archives")
    .set({
      status: "failed",
      metadata_json: serializeCanonicalJson(failedMetadata),
    })
    .where("id", "=", archiveId)
    .executeTakeFirst();
}

const defaultEventArchiveFileWriter: EventArchiveFileWriter = {
  async writeAtomically(filename, contents): Promise<void> {
    await mkdir(dirname(resolve(filename)), { recursive: true });
    if (await pathExists(filename)) {
      const current = await readFile(filename);
      if (sha256(current) === sha256(contents)) return;
      await rename(filename, `${filename}.corrupt-${randomUUID()}`);
    }
    const temporary = `${filename}.partial-${randomUUID()}`;
    try {
      await writeFile(temporary, contents, { flag: "wx" });
      await rename(temporary, filename);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  },
};

async function deleteIds(
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

function parseRequiredJson(
  source: string,
  sourceName: string,
): z.infer<ReturnType<typeof z.json>> {
  const document = parseJsonDocument(source, sourceName);
  if (document.duplicateKeys.length > 0) {
    throw new Error(`${sourceName} contains duplicate object keys`);
  }
  return z.json().parse(document.value);
}

function parseOptionalJson(
  source: string | null,
  sourceName: string,
): z.infer<ReturnType<typeof z.json>> | null {
  return source === null ? null : parseRequiredJson(source, sourceName);
}

function compareRecords(
  left: EventArchiveRecord,
  right: EventArchiveRecord,
): number {
  const timestampDifference =
    archiveRecordTimestamp(left) - archiveRecordTimestamp(right);
  if (timestampDifference !== 0) return timestampDifference;
  const typeDifference =
    left.recordType === right.recordType
      ? 0
      : left.recordType < right.recordType
        ? -1
        : 1;
  if (typeDifference !== 0) return typeDifference;
  return archiveRecordIdentifier(left) - archiveRecordIdentifier(right);
}

function archiveRecordTimestamp(record: EventArchiveRecord): number {
  if (record.recordType === "interaction") return record.data.occurredAtMs;
  if (record.recordType === "aggregate") return record.data.bucketEndMs;
  return record.data.occurredAtMs;
}

function archiveRecordIdentifier(record: EventArchiveRecord): number {
  if (record.recordType === "interaction") return record.data.id;
  if (record.recordType === "aggregate") return record.data.id;
  return record.data.revision;
}

function archiveRecordRetentionClass(
  record: EventArchiveRecord,
): RetentionClass {
  return record.data.retentionClass;
}

function countArchiveRecordTypes(records: readonly EventArchiveRecord[]): {
  readonly interactionCount: number;
  readonly aggregateCount: number;
  readonly stateEventCount: number;
} {
  let interactionCount = 0;
  let aggregateCount = 0;
  let stateEventCount = 0;
  for (const record of records) {
    if (record.recordType === "interaction") interactionCount += 1;
    else if (record.recordType === "aggregate") aggregateCount += 1;
    else stateEventCount += 1;
  }
  return { interactionCount, aggregateCount, stateEventCount };
}

function assertPositiveSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${label} must be a positive safe integer`);
  }
}

function assertNonNegativeSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer`);
  }
}

function pathExists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}
