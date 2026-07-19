import { createHash } from "node:crypto";

import {
  logEntrySchema,
  logFilterSchema,
  logPayloadSchema,
  type LogEntry,
} from "@aquarium/contracts";
import { sql, type Kysely, type Selectable } from "kysely";

import {
  MAX_LOG_QUERY_BATCH_SIZE,
  type LogQueryPort,
  type ReadLogBatchRequest,
} from "../../application/logs/log-service.js";
import type {
  EventsDatabaseSchema,
  InteractionsTable,
} from "../database/index.js";
import { parseJsonDocument } from "../import/strict-json.js";

export class CorruptStoredInteractionError extends Error {
  constructor(id: number, reason: string) {
    super(`Stored interaction ${id} is corrupt: ${reason}`);
    this.name = "CorruptStoredInteractionError";
  }
}

export class LogQueryRepository implements LogQueryPort {
  readonly #database: Kysely<EventsDatabaseSchema>;

  constructor(database: Kysely<EventsDatabaseSchema>) {
    this.#database = database;
  }

  async readBatch(request: ReadLogBatchRequest): Promise<readonly LogEntry[]> {
    const filters = logFilterSchema.parse(request.filters);
    if (
      !Number.isSafeInteger(request.limit) ||
      request.limit < 1 ||
      request.limit > MAX_LOG_QUERY_BATCH_SIZE
    ) {
      throw new RangeError(
        `Log query limit must be between 1 and ${MAX_LOG_QUERY_BATCH_SIZE}`,
      );
    }
    if (
      request.after !== undefined &&
      (!Number.isSafeInteger(request.after.occurredAtMs) ||
        request.after.occurredAtMs < 0 ||
        !Number.isSafeInteger(request.after.id) ||
        request.after.id < 1)
    ) {
      throw new RangeError("Log query cursor position is invalid");
    }

    let query = this.#database
      .selectFrom("interactions")
      .selectAll("interactions");
    if (filters.startAtMs !== undefined) {
      query = query.where("occurred_at_ms", ">=", filters.startAtMs);
    }
    if (filters.endAtMs !== undefined) {
      query = query.where("occurred_at_ms", "<=", filters.endAtMs);
    }
    if (filters.direction !== undefined) {
      query = query.where(
        sql<boolean>`${sql.ref("interactions.direction")} = ${filters.direction} COLLATE BINARY`,
      );
    }
    if (filters.kind !== undefined) {
      query = query.where(
        sql<boolean>`${sql.ref("interactions.kind")} = ${filters.kind} COLLATE BINARY`,
      );
    }
    if (filters.severity !== undefined) {
      query = query.where(
        sql<boolean>`${sql.ref("interactions.severity")} = ${filters.severity} COLLATE BINARY`,
      );
    }
    if (filters.deviceId !== undefined) {
      query = query.where(
        sql<boolean>`${sql.ref("interactions.device_id")} = ${filters.deviceId} COLLATE BINARY`,
      );
    }
    if (filters.operationId !== undefined) {
      query = query.where(
        sql<boolean>`${sql.ref("interactions.operation_id")} = ${filters.operationId} COLLATE BINARY`,
      );
    }
    if (filters.correlationId !== undefined) {
      query = query.where(
        sql<boolean>`${sql.ref("interactions.correlation_id")} = ${filters.correlationId} COLLATE BINARY`,
      );
    }
    if (filters.outcome !== undefined) {
      query = query.where(
        sql<boolean>`${sql.ref("interactions.outcome")} = ${filters.outcome} COLLATE BINARY`,
      );
    }
    if (filters.retentionClass !== undefined) {
      query = query.where(
        sql<boolean>`${sql.ref("interactions.retention_class")} = ${filters.retentionClass} COLLATE BINARY`,
      );
    }
    if (request.after !== undefined) {
      const after = request.after;
      query = query.where((expressions) =>
        expressions.or([
          expressions("occurred_at_ms", "<", after.occurredAtMs),
          expressions.and([
            expressions("occurred_at_ms", "=", after.occurredAtMs),
            expressions("id", "<", after.id),
          ]),
        ]),
      );
    }

    const rows = await query
      .orderBy("occurred_at_ms", "desc")
      .orderBy("id", "desc")
      .limit(request.limit)
      .execute();
    return rows.map(parseLogEntry);
  }
}

function parseLogEntry(row: Selectable<InteractionsTable>): LogEntry {
  const payloadFieldCount = [
    row.payload_json,
    row.payload_schema_version,
    row.payload_sha256,
  ].filter((field) => field !== null).length;
  if (payloadFieldCount !== 0 && payloadFieldCount !== 3) {
    throw new CorruptStoredInteractionError(
      row.id,
      "payload JSON, schema version, and checksum are not paired",
    );
  }

  let payload: ReturnType<typeof logPayloadSchema.parse> | null = null;
  if (row.payload_json !== null) {
    let document: ReturnType<typeof parseJsonDocument>;
    try {
      document = parseJsonDocument(
        row.payload_json,
        `stored interaction ${row.id} payload`,
      );
    } catch {
      throw new CorruptStoredInteractionError(
        row.id,
        "payload JSON is invalid",
      );
    }
    if (document.duplicateKeys.length > 0) {
      throw new CorruptStoredInteractionError(
        row.id,
        "payload JSON contains duplicate keys",
      );
    }
    const payloadResult = logPayloadSchema.safeParse(document.value);
    if (!payloadResult.success) {
      throw new CorruptStoredInteractionError(
        row.id,
        "payload is outside the public log schema",
      );
    }
    const checksum = createHash("sha256")
      .update(row.payload_json, "utf8")
      .digest("hex");
    if (checksum !== row.payload_sha256) {
      throw new CorruptStoredInteractionError(
        row.id,
        "payload checksum does not match",
      );
    }
    payload = payloadResult.data;
  }

  const result = logEntrySchema.safeParse({
    id: row.id,
    occurredAtMs: row.occurred_at_ms,
    direction: row.direction,
    kind: row.kind,
    severity: row.severity,
    topic: row.topic,
    deviceId: row.device_id,
    correlationId: row.correlation_id,
    operationId: row.operation_id,
    outcome: row.outcome,
    durationMs: row.duration_ms,
    byteCount: row.byte_count,
    retentionClass: row.retention_class,
    payload,
    payloadSchemaVersion: row.payload_schema_version,
    payloadSha256: row.payload_sha256,
  });
  if (!result.success) {
    throw new CorruptStoredInteractionError(
      row.id,
      "row is outside the public log schema",
    );
  }
  return result.data;
}
