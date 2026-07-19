import {
  createLogFilterFingerprint,
  decodeLogCursor,
  encodeLogCursor,
  logEntrySchema,
  logExportMetadataSchema,
  logExportRequestSchema,
  logsListRequestSchema,
  logsListResponseSchema,
  type LogEntry,
  type LogExportMetadata,
  type LogExportRequest,
  type LogFilter,
  type LogsListRequest,
  type LogsListResponse,
} from "@aquarium/contracts";

export const MAX_LOG_QUERY_BATCH_SIZE = 101;
export const DEFAULT_LOG_EXPORT_BATCH_SIZE = 100;

export const CSV_LOG_EXPORT_COLUMNS = [
  "id",
  "occurredAtMs",
  "direction",
  "kind",
  "severity",
  "topic",
  "deviceId",
  "correlationId",
  "operationId",
  "outcome",
  "durationMs",
  "byteCount",
  "retentionClass",
  "payload",
  "payloadSchemaVersion",
  "payloadSha256",
  "csvFormulaEscapedFields",
] as const;

/**
 * Potential spreadsheet formulas are prefixed with an apostrophe. The
 * csvFormulaEscapedFields column names every changed field, so consumers can
 * reverse that transport encoding deliberately. NDJSON is never transformed.
 */
export const CSV_FORMULA_INJECTION_POLICY =
  "Prefix formula-like CSV cells with an apostrophe and record their column names in csvFormulaEscapedFields.";

export interface LogQueryPosition {
  readonly occurredAtMs: number;
  readonly id: number;
}

export interface ReadLogBatchRequest {
  readonly filters: LogFilter;
  readonly after?: LogQueryPosition;
  readonly limit: number;
}

export interface LogQueryPort {
  readBatch(request: ReadLogBatchRequest): Promise<readonly LogEntry[]>;
}

export interface LogExportSink {
  write(chunk: string): Promise<void>;
}

export interface LogsServiceOptions {
  readonly now?: () => Date;
  readonly exportBatchSize?: number;
}

export class LogsService {
  readonly #query: LogQueryPort;
  readonly #now: () => Date;
  readonly #exportBatchSize: number;

  constructor(query: LogQueryPort, options: LogsServiceOptions = {}) {
    const exportBatchSize =
      options.exportBatchSize ?? DEFAULT_LOG_EXPORT_BATCH_SIZE;
    if (
      !Number.isSafeInteger(exportBatchSize) ||
      exportBatchSize < 1 ||
      exportBatchSize > 100
    ) {
      throw new RangeError(
        "Log export batch size must be an integer between 1 and 100",
      );
    }
    this.#query = query;
    this.#now = options.now ?? (() => new Date());
    this.#exportBatchSize = exportBatchSize;
  }

  async list(request: LogsListRequest): Promise<LogsListResponse> {
    const parsed = logsListRequestSchema.parse(request);
    const cursor =
      parsed.cursor === undefined ? undefined : decodeLogCursor(parsed.cursor);
    const batch = await this.#readValidatedBatch({
      filters: parsed.filters,
      ...(cursor === undefined
        ? {}
        : {
            after: {
              occurredAtMs: cursor.occurredAtMs,
              id: cursor.id,
            },
          }),
      limit: parsed.pageSize + 1,
    });
    const hasMore = batch.length > parsed.pageSize;
    const items = batch.slice(0, parsed.pageSize);
    const lastItem = items.at(-1);
    const nextCursor =
      hasMore && lastItem !== undefined
        ? encodeLogCursor({
            schemaVersion: 1,
            order: "occurred_at_ms_desc_id_desc",
            filterFingerprint: createLogFilterFingerprint(parsed.filters),
            occurredAtMs: lastItem.occurredAtMs,
            id: lastItem.id,
          })
        : null;
    const totalByteCount = items.reduce(
      (total, item) => total + item.byteCount,
      0,
    );
    if (!Number.isSafeInteger(totalByteCount)) {
      throw new RangeError(
        "Log page byte total exceeds the safe integer range",
      );
    }

    return logsListResponseSchema.parse({
      schemaVersion: 1,
      items,
      nextCursor,
      hasMore,
      summary: {
        returnedCount: items.length,
        totalByteCount,
        firstOccurredAtMs: items[0]?.occurredAtMs ?? null,
        lastOccurredAtMs: lastItem?.occurredAtMs ?? null,
      },
    });
  }

  async export(
    request: LogExportRequest,
    sink: LogExportSink,
  ): Promise<LogExportMetadata> {
    const parsed = logExportRequestSchema.parse(request);
    const generatedAt = this.#now().toISOString();
    const extension = parsed.format === "csv" ? "csv" : "ndjson";
    const filename = `aquarium-logs-${generatedAt.replace(/[-:.]/gu, "")}.${extension}`;
    if (parsed.format === "csv") {
      await sink.write(`${CSV_LOG_EXPORT_COLUMNS.join(",")}\r\n`);
    }

    let after: LogQueryPosition | undefined;
    let rowCount = 0;
    let truncated = false;
    while (rowCount <= parsed.maxRows) {
      const rowsNeededToDetectTruncation = parsed.maxRows + 1 - rowCount;
      const limit = Math.min(
        this.#exportBatchSize,
        rowsNeededToDetectTruncation,
      );
      const batch = await this.#readValidatedBatch({
        filters: parsed.filters,
        ...(after === undefined ? {} : { after }),
        limit,
      });
      if (batch.length === 0) break;

      for (const entry of batch) {
        if (rowCount === parsed.maxRows) {
          truncated = true;
          break;
        }
        await sink.write(
          parsed.format === "csv"
            ? serializeLogEntryCsv(entry)
            : `${JSON.stringify(entry)}\n`,
        );
        rowCount += 1;
      }
      if (truncated || batch.length < limit) break;
      const lastEntry = batch.at(-1);
      if (lastEntry === undefined) {
        throw new Error("Non-empty log batch unexpectedly had no final row");
      }
      after = { occurredAtMs: lastEntry.occurredAtMs, id: lastEntry.id };
    }

    return logExportMetadataSchema.parse({
      schemaVersion: 1,
      format: parsed.format,
      generatedAt,
      requestedFilters: parsed.filters,
      requestedMaxRows: parsed.maxRows,
      rowCount,
      truncated,
      contentType:
        parsed.format === "csv" ? "text/csv" : "application/x-ndjson",
      filename,
    });
  }

  async #readValidatedBatch(
    request: ReadLogBatchRequest,
  ): Promise<readonly LogEntry[]> {
    if (
      !Number.isSafeInteger(request.limit) ||
      request.limit < 1 ||
      request.limit > MAX_LOG_QUERY_BATCH_SIZE
    ) {
      throw new RangeError(
        `Log query limit must be between 1 and ${MAX_LOG_QUERY_BATCH_SIZE}`,
      );
    }
    const batch = (await this.#query.readBatch(request)).map((entry) =>
      logEntrySchema.parse(entry),
    );
    if (batch.length > request.limit) {
      throw new Error("Log query returned more rows than requested");
    }
    for (const [index, entry] of batch.entries()) {
      const previous = batch[index - 1];
      if (
        previous !== undefined &&
        (previous.occurredAtMs < entry.occurredAtMs ||
          (previous.occurredAtMs === entry.occurredAtMs &&
            previous.id <= entry.id))
      ) {
        throw new Error("Log query returned rows outside the required order");
      }
      if (
        request.after !== undefined &&
        (entry.occurredAtMs > request.after.occurredAtMs ||
          (entry.occurredAtMs === request.after.occurredAtMs &&
            entry.id >= request.after.id))
      ) {
        throw new Error("Log query returned a row before its cursor boundary");
      }
    }
    return batch;
  }
}

function serializeLogEntryCsv(entry: LogEntry): string {
  const escapedFields: string[] = [];
  const fields: ReadonlyArray<readonly [string, string]> = [
    ["id", String(entry.id)],
    ["occurredAtMs", String(entry.occurredAtMs)],
    ["direction", entry.direction],
    ["kind", entry.kind],
    ["severity", entry.severity],
    ["topic", entry.topic ?? ""],
    ["deviceId", entry.deviceId ?? ""],
    ["correlationId", entry.correlationId ?? ""],
    ["operationId", entry.operationId ?? ""],
    ["outcome", entry.outcome],
    ["durationMs", entry.durationMs === null ? "" : String(entry.durationMs)],
    ["byteCount", String(entry.byteCount)],
    ["retentionClass", entry.retentionClass],
    ["payload", entry.payload === null ? "" : JSON.stringify(entry.payload)],
    [
      "payloadSchemaVersion",
      entry.payloadSchemaVersion === null
        ? ""
        : String(entry.payloadSchemaVersion),
    ],
    ["payloadSha256", entry.payloadSha256 ?? ""],
  ];
  const encoded = fields.map(([column, value]) => {
    if (/^[=+\-@\t\r]/u.test(value)) {
      escapedFields.push(column);
      return encodeCsvCell(`'${value}`);
    }
    return encodeCsvCell(value);
  });
  encoded.push(encodeCsvCell(JSON.stringify(escapedFields)));
  return `${encoded.join(",")}\r\n`;
}

function encodeCsvCell(value: string): string {
  return /[",\r\n]/u.test(value) ? `"${value.replace(/"/gu, '""')}"` : value;
}
