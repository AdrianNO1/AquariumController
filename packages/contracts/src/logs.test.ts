import { describe, expect, it } from "vitest";

import {
  createLogFilterFingerprint,
  decodeLogCursor,
  encodeLogCursor,
  logCursorPayloadSchema,
  logCursorSchema,
  logExportMetadataSchema,
  logExportRequestSchema,
  logFilterSchema,
  logEntrySchema,
  logsListRequestSchema,
  logsListResponseSchema,
} from "./index.js";

const payloadSha256 =
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

const olderEntry = {
  id: 1,
  occurredAtMs: 100,
  direction: "internal",
  kind: "scheduler.tick",
  severity: "info",
  topic: null,
  deviceId: null,
  correlationId: null,
  operationId: null,
  outcome: "succeeded",
  durationMs: 2,
  byteCount: 2,
  retentionClass: "operational",
  payload: {},
  payloadSchemaVersion: 1,
  payloadSha256,
} as const;

const newerEntry = {
  ...olderEntry,
  id: 2,
  occurredAtMs: 200,
  byteCount: 3,
} as const;

describe("log contracts", () => {
  it("canonically encodes strict cursors scoped to filters and ordering", () => {
    const filters = logFilterSchema.parse({
      startAtMs: 100,
      endAtMs: 200,
      direction: "inbound",
      severity: "warning",
      outcome: "failed",
    });
    const filterFingerprint = createLogFilterFingerprint(filters);
    const payload = {
      schemaVersion: 1,
      order: "occurred_at_ms_desc_id_desc",
      filterFingerprint,
      occurredAtMs: 200,
      id: 2,
    } as const;
    const cursor = encodeLogCursor(payload);

    expect(logCursorSchema.parse(cursor)).toBe(cursor);
    expect(decodeLogCursor(cursor)).toEqual(payload);
    expect(
      logsListRequestSchema.parse({ filters, cursor, pageSize: 25 }),
    ).toEqual({ filters, cursor, pageSize: 25 });
    expect(
      logsListRequestSchema.safeParse({
        filters: { ...filters, outcome: "succeeded" },
        cursor,
      }).success,
    ).toBe(false);
    expect(
      createLogFilterFingerprint({
        outcome: "failed",
        severity: "warning",
        direction: "inbound",
        endAtMs: 200,
        startAtMs: 100,
      }),
    ).toBe(filterFingerprint);
    expect(
      createLogFilterFingerprint({ ...filters, outcome: "succeeded" }),
    ).not.toBe(filterFingerprint);

    expect(
      logFilterSchema.safeParse({ startAtMs: 201, endAtMs: 200 }).success,
    ).toBe(false);
    expect(
      logCursorPayloadSchema.safeParse({
        schemaVersion: 1,
        order: "occurred_at_ms_desc_id_desc",
        filterFingerprint,
        occurredAtMs: 100,
        id: 0,
      }).success,
    ).toBe(false);
  });

  it("rejects malformed and noncanonical cursor encodings", () => {
    const payload = {
      schemaVersion: 1,
      order: "occurred_at_ms_desc_id_desc",
      filterFingerprint: createLogFilterFingerprint({}),
      occurredAtMs: 200,
      id: 2,
    } as const;
    const cursor = encodeLogCursor(payload);
    expect(payload.filterFingerprint).toBe("b4e325174a94215c");
    expect(cursor).toBe(
      "eyJzY2hlbWFWZXJzaW9uIjoxLCJvcmRlciI6Im9jY3VycmVkX2F0X21zX2Rlc2NfaWRfZGVzYyIsImZpbHRlckZpbmdlcnByaW50IjoiYjRlMzI1MTc0YTk0MjE1YyIsIm9jY3VycmVkQXRNcyI6MjAwLCJpZCI6Mn0",
    );
    const reorderedJson = JSON.stringify({
      id: payload.id,
      occurredAtMs: payload.occurredAtMs,
      filterFingerprint: payload.filterFingerprint,
      order: payload.order,
      schemaVersion: payload.schemaVersion,
    });
    const reorderedCursor = btoa(reorderedJson)
      .replace(/\+/gu, "-")
      .replace(/\//gu, "_")
      .replace(/=+$/u, "");

    for (const malformed of [
      "not+a+base64url/cursor",
      "A",
      "e30",
      `${cursor}=`,
      reorderedCursor,
    ]) {
      expect(logCursorSchema.safeParse(malformed).success).toBe(false);
      expect(() => decodeLogCursor(malformed)).toThrow(
        "Log cursor is malformed",
      );
    }
  });

  it("defaults bounded list and export sizes", () => {
    expect(logsListRequestSchema.parse({})).toEqual({
      filters: {},
      pageSize: 50,
    });
    expect(logsListRequestSchema.safeParse({ pageSize: 101 }).success).toBe(
      false,
    );
    expect(logExportRequestSchema.parse({ format: "ndjson" })).toEqual({
      filters: {},
      format: "ndjson",
      maxRows: 10_000,
    });
    expect(
      logExportRequestSchema.safeParse({ format: "csv", maxRows: 100_001 })
        .success,
    ).toBe(false);
  });

  it("requires pagination metadata to match a descending unique page", () => {
    const nextCursor = encodeLogCursor({
      schemaVersion: 1,
      order: "occurred_at_ms_desc_id_desc",
      filterFingerprint: createLogFilterFingerprint({}),
      occurredAtMs: olderEntry.occurredAtMs,
      id: olderEntry.id,
    });
    const response = {
      schemaVersion: 1,
      items: [newerEntry, olderEntry],
      nextCursor,
      hasMore: true,
      summary: {
        returnedCount: 2,
        totalByteCount: 5,
        firstOccurredAtMs: newerEntry.occurredAtMs,
        lastOccurredAtMs: olderEntry.occurredAtMs,
      },
    };

    expect(logsListResponseSchema.parse(response)).toEqual(response);
    expect(
      logsListResponseSchema.safeParse({ ...response, hasMore: false }).success,
    ).toBe(false);
    expect(
      logsListResponseSchema.safeParse({
        ...response,
        summary: { ...response.summary, totalByteCount: 4 },
      }).success,
    ).toBe(false);
    expect(
      logsListResponseSchema.safeParse({
        ...response,
        items: [olderEntry, newerEntry],
        summary: {
          ...response.summary,
          firstOccurredAtMs: olderEntry.occurredAtMs,
          lastOccurredAtMs: newerEntry.occurredAtMs,
        },
      }).success,
    ).toBe(false);
    expect(
      logsListResponseSchema.safeParse({
        ...response,
        items: [newerEntry, { ...olderEntry, id: newerEntry.id }],
      }).success,
    ).toBe(false);
    expect(
      logsListResponseSchema.safeParse({
        ...response,
        nextCursor: encodeLogCursor({
          ...decodeLogCursor(nextCursor),
          occurredAtMs: newerEntry.occurredAtMs,
          id: newerEntry.id,
        }),
      }).success,
    ).toBe(false);

    const emptyResponse = {
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
    };
    expect(logsListResponseSchema.parse(emptyResponse)).toEqual(emptyResponse);
  });

  it("requires version and hash whenever a persisted payload is exposed", () => {
    expect(logEntrySchema.parse(olderEntry)).toEqual(olderEntry);
    expect(
      logEntrySchema.safeParse({ ...olderEntry, payloadSchemaVersion: null })
        .success,
    ).toBe(false);
    expect(
      logEntrySchema.safeParse({
        ...olderEntry,
        payload: ["not", "an", "object"],
      }).success,
    ).toBe(false);
  });

  it("keeps export metadata within its requested row and format bounds", () => {
    const metadata = {
      schemaVersion: 1,
      format: "csv",
      generatedAt: "2026-07-13T08:00:00.000Z",
      requestedFilters: {},
      requestedMaxRows: 100,
      rowCount: 25,
      truncated: false,
      contentType: "text/csv",
      filename: "aquarium-events-20260713.csv",
    };

    expect(logExportMetadataSchema.parse(metadata)).toEqual(metadata);
    expect(
      logExportMetadataSchema.parse({
        ...metadata,
        rowCount: metadata.requestedMaxRows,
        truncated: true,
      }),
    ).toBeDefined();
    expect(
      logExportMetadataSchema.safeParse({
        ...metadata,
        filename: "../secret.csv",
      }).success,
    ).toBe(false);
    expect(
      logExportMetadataSchema.safeParse({
        ...metadata,
        rowCount: metadata.requestedMaxRows + 1,
      }).success,
    ).toBe(false);
    expect(
      logExportMetadataSchema.safeParse({
        ...metadata,
        truncated: true,
      }).success,
    ).toBe(false);
    expect(
      logExportMetadataSchema.safeParse({
        ...metadata,
        contentType: "application/x-ndjson",
      }).success,
    ).toBe(false);
    expect(
      logExportMetadataSchema.safeParse({
        ...metadata,
        filename: "aquarium-events-20260713.ndjson",
      }).success,
    ).toBe(false);
    expect(
      logExportMetadataSchema.safeParse({ ...metadata, extra: true }).success,
    ).toBe(false);
  });
});
