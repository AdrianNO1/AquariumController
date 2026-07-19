import {
  createLogFilterFingerprint,
  decodeLogCursor,
  encodeLogCursor,
  logEntrySchema,
  type LogEntry,
} from "@aquarium/contracts";
import { describe, expect, it } from "vitest";

import {
  CSV_FORMULA_INJECTION_POLICY,
  LogsService,
  type LogExportSink,
  type LogQueryPort,
  type ReadLogBatchRequest,
} from "./log-service.js";

class MemoryLogQuery implements LogQueryPort {
  readonly requests: ReadLogBatchRequest[] = [];
  readonly #entries: readonly LogEntry[];

  constructor(entries: readonly LogEntry[]) {
    this.#entries = entries;
  }

  async readBatch(request: ReadLogBatchRequest): Promise<readonly LogEntry[]> {
    this.requests.push(request);
    return this.#entries
      .filter(
        (entry) =>
          request.after === undefined ||
          entry.occurredAtMs < request.after.occurredAtMs ||
          (entry.occurredAtMs === request.after.occurredAtMs &&
            entry.id < request.after.id),
      )
      .slice(0, request.limit);
  }
}

class RecordingSink implements LogExportSink {
  readonly chunks: string[] = [];

  async write(chunk: string): Promise<void> {
    this.chunks.push(chunk);
  }
}

function entry(
  id: number,
  occurredAtMs: number,
  overrides: Partial<LogEntry> = {},
): LogEntry {
  return logEntrySchema.parse({
    id,
    occurredAtMs,
    direction: "internal",
    kind: "test-event",
    severity: "info",
    topic: null,
    deviceId: null,
    correlationId: null,
    operationId: null,
    outcome: "succeeded",
    durationMs: null,
    byteCount: 10,
    retentionClass: "operational",
    payload: null,
    payloadSchemaVersion: null,
    payloadSha256: null,
    ...overrides,
  });
}

describe("LogsService list", () => {
  it("uses a filter-bound cursor without skipping rows that share a timestamp", async () => {
    const query = new MemoryLogQuery([
      entry(5, 1_000),
      entry(4, 1_000),
      entry(3, 900),
    ]);
    const service = new LogsService(query);

    const first = await service.list({ filters: {}, pageSize: 2 });
    expect(first.items.map((item) => item.id)).toEqual([5, 4]);
    expect(first.summary).toEqual({
      returnedCount: 2,
      totalByteCount: 20,
      firstOccurredAtMs: 1_000,
      lastOccurredAtMs: 1_000,
    });
    expect(first.hasMore).toBe(true);
    expect(first.nextCursor).not.toBeNull();
    expect(decodeLogCursor(first.nextCursor ?? "")).toMatchObject({
      occurredAtMs: 1_000,
      id: 4,
      filterFingerprint: createLogFilterFingerprint({}),
    });

    const second = await service.list({
      filters: {},
      pageSize: 2,
      cursor: first.nextCursor ?? undefined,
    });
    expect(second.items.map((item) => item.id)).toEqual([3]);
    expect(second.hasMore).toBe(false);
    expect(second.nextCursor).toBeNull();
    expect(query.requests[1]?.after).toEqual({ occurredAtMs: 1_000, id: 4 });
  });

  it("returns an exact 100-row page and a cursor identifying its final row", async () => {
    const entries = Array.from({ length: 101 }, (_, index) =>
      entry(101 - index, 5_000),
    );
    const service = new LogsService(new MemoryLogQuery(entries));

    const page = await service.list({ filters: {}, pageSize: 100 });
    expect(page.items).toHaveLength(100);
    expect(page.items[0]?.id).toBe(101);
    expect(page.items.at(-1)?.id).toBe(2);
    expect(page.summary.returnedCount).toBe(100);
    expect(page.summary.totalByteCount).toBe(1_000);
    expect(page.hasMore).toBe(true);
    expect(decodeLogCursor(page.nextCursor ?? "").id).toBe(2);
  });

  it("returns the exact empty-page summary", async () => {
    const response = await new LogsService(new MemoryLogQuery([])).list({
      filters: {},
      pageSize: 50,
    });
    expect(response).toEqual({
      schemaVersion: 1,
      items: [],
      nextCursor: null,
      hasMore: false,
      summary: {
        returnedCount: 0,
        totalByteCount: 0,
        firstOccurredAtMs: null,
        lastOccurredAtMs: null,
      },
    });
  });

  it("rejects malformed and wrong-filter cursors before querying storage", async () => {
    const query = new MemoryLogQuery([entry(1, 1)]);
    const service = new LogsService(query);
    await expect(
      service.list({ filters: {}, pageSize: 10, cursor: "not-a-cursor" }),
    ).rejects.toThrow();

    const cursor = encodeLogCursor({
      schemaVersion: 1,
      order: "occurred_at_ms_desc_id_desc",
      filterFingerprint: createLogFilterFingerprint({}),
      occurredAtMs: 1,
      id: 1,
    });
    await expect(
      service.list({ filters: { kind: "other" }, pageSize: 10, cursor }),
    ).rejects.toThrow(/cursor/i);
    expect(query.requests).toEqual([]);
  });
});

describe("LogsService export", () => {
  const now = () => new Date("2026-07-13T12:34:56.789Z");

  it("writes bounded NDJSON with exact unicode and escaped payload newlines", async () => {
    const source = entry(1, 100, {
      kind: "temperature-β",
      payload: { message: "linje én\nlinje to", value: 23.5 },
      payloadSchemaVersion: 1,
      payloadSha256: "a".repeat(64),
    });
    const sink = new RecordingSink();
    const metadata = await new LogsService(new MemoryLogQuery([source]), {
      now,
    }).export({ filters: {}, format: "ndjson", maxRows: 10 }, sink);

    expect(sink.chunks).toHaveLength(1);
    expect(sink.chunks[0]).toContain("temperature-β");
    expect(sink.chunks[0]).toContain("linje én\\nlinje to");
    expect(JSON.parse(sink.chunks.join(""))).toEqual(source);
    expect(metadata).toEqual({
      schemaVersion: 1,
      format: "ndjson",
      generatedAt: "2026-07-13T12:34:56.789Z",
      requestedFilters: {},
      requestedMaxRows: 10,
      rowCount: 1,
      truncated: false,
      contentType: "application/x-ndjson",
      filename: "aquarium-logs-20260713T123456789Z.ndjson",
    });
  });

  it("uses RFC 4180 escaping and records every reversible formula guard", async () => {
    const source = entry(1, 100, {
      kind: "=SUM(1,2)",
      topic: '+pump,"β"',
      payload: { message: "first\nsecond", unicode: "blå" },
      payloadSchemaVersion: 1,
      payloadSha256: "b".repeat(64),
    });
    const sink = new RecordingSink();
    const metadata = await new LogsService(new MemoryLogQuery([source]), {
      now,
    }).export({ filters: {}, format: "csv", maxRows: 5 }, sink);
    const csv = sink.chunks.join("");

    expect(CSV_FORMULA_INJECTION_POLICY).toContain("csvFormulaEscapedFields");
    expect(csv).toMatch(/\r\n$/u);
    expect(csv).toContain('"\'=SUM(1,2)"');
    expect(csv).toContain('"\'+pump,""β"""');
    expect(csv).toContain('"[""kind"",""topic""]"');
    expect(csv).toContain("first\\nsecond");
    expect(csv).toContain("blå");
    expect(metadata).toMatchObject({
      format: "csv",
      contentType: "text/csv",
      filename: "aquarium-logs-20260713T123456789Z.csv",
      rowCount: 1,
      truncated: false,
    });
  });

  it("detects truncation with maxRows plus one while keeping every query bounded", async () => {
    const entries = Array.from({ length: 251 }, (_, index) =>
      entry(251 - index, 10_000 - index),
    );
    const query = new MemoryLogQuery(entries);
    const sink = new RecordingSink();
    const metadata = await new LogsService(query, {
      now,
      exportBatchSize: 40,
    }).export({ filters: {}, format: "ndjson", maxRows: 250 }, sink);

    expect(metadata.rowCount).toBe(250);
    expect(metadata.truncated).toBe(true);
    expect(sink.chunks).toHaveLength(250);
    expect(query.requests.map((request) => request.limit)).toEqual([
      40, 40, 40, 40, 40, 40, 11,
    ]);
    expect(query.requests.every((request) => request.limit <= 40)).toBe(true);
  });

  it("does one bounded look-ahead query for an exact non-truncated limit", async () => {
    const entries = Array.from({ length: 5 }, (_, index) =>
      entry(5 - index, 100 - index),
    );
    const query = new MemoryLogQuery(entries);
    const metadata = await new LogsService(query, {
      now,
      exportBatchSize: 5,
    }).export(
      { filters: {}, format: "ndjson", maxRows: 5 },
      new RecordingSink(),
    );
    expect(metadata).toMatchObject({ rowCount: 5, truncated: false });
    expect(query.requests.map((request) => request.limit)).toEqual([5, 1]);
  });
});
