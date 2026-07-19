import { z } from "zod";

import {
  boundedTextSchema,
  eventDirectionSchema,
  eventOutcomeSchema,
  identifierSchema,
  isoTimestampSchema,
  nonnegativeSafeIntegerSchema,
  positiveSafeIntegerSchema,
  retentionClassSchema,
  sha256Schema,
} from "./primitives.js";

export const logSeveritySchema = z.enum([
  "debug",
  "info",
  "warning",
  "error",
  "critical",
]);

export const logPayloadSchema = z.record(z.string(), z.json());

export const logFilterSchema = z
  .strictObject({
    startAtMs: nonnegativeSafeIntegerSchema.optional(),
    endAtMs: nonnegativeSafeIntegerSchema.optional(),
    direction: eventDirectionSchema.optional(),
    kind: boundedTextSchema.optional(),
    severity: logSeveritySchema.optional(),
    deviceId: identifierSchema.optional(),
    operationId: identifierSchema.optional(),
    correlationId: identifierSchema.optional(),
    outcome: eventOutcomeSchema.optional(),
    retentionClass: retentionClassSchema.optional(),
  })
  .superRefine((filter, context) => {
    if (
      filter.startAtMs !== undefined &&
      filter.endAtMs !== undefined &&
      filter.startAtMs > filter.endAtMs
    ) {
      context.addIssue({
        code: "custom",
        path: ["endAtMs"],
        message: "Log end time must not precede the start time",
      });
    }
  });

export type LogFilter = z.infer<typeof logFilterSchema>;

export const logCursorOrderSchema = z.literal("occurred_at_ms_desc_id_desc");

export const logFilterFingerprintSchema = z.string().regex(/^[a-f0-9]{16}$/u);

export const logCursorPayloadSchema = z.strictObject({
  schemaVersion: z.literal(1),
  order: logCursorOrderSchema,
  filterFingerprint: logFilterFingerprintSchema,
  occurredAtMs: nonnegativeSafeIntegerSchema,
  id: positiveSafeIntegerSchema,
});

export type LogCursorPayload = z.infer<typeof logCursorPayloadSchema>;

const encodedLogCursorSchema = z
  .string()
  .min(1)
  .max(512)
  .regex(/^[A-Za-z0-9_-]+$/u);

const utf8Encoder = new TextEncoder();
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

/**
 * Produces a stable, non-cryptographic scope for detecting accidental cursor
 * reuse with different filters. It is not an authorization or integrity
 * mechanism; every query must still apply and validate its requested filters.
 */
export function createLogFilterFingerprint(filters: LogFilter): string {
  const parsed = logFilterSchema.parse(filters);
  const canonicalFilter = JSON.stringify({
    startAtMs: parsed.startAtMs ?? null,
    endAtMs: parsed.endAtMs ?? null,
    direction: parsed.direction ?? null,
    kind: parsed.kind ?? null,
    severity: parsed.severity ?? null,
    deviceId: parsed.deviceId ?? null,
    operationId: parsed.operationId ?? null,
    correlationId: parsed.correlationId ?? null,
    outcome: parsed.outcome ?? null,
    retentionClass: parsed.retentionClass ?? null,
  });

  let fingerprint = 0xcbf29ce484222325n;
  for (const byte of utf8Encoder.encode(canonicalFilter)) {
    fingerprint ^= BigInt(byte);
    fingerprint = BigInt.asUintN(64, fingerprint * 0x100000001b3n);
  }
  return logFilterFingerprintSchema.parse(
    fingerprint.toString(16).padStart(16, "0"),
  );
}

export function encodeLogCursor(payload: LogCursorPayload): string {
  const parsed = logCursorPayloadSchema.parse(payload);
  const canonicalJson = JSON.stringify({
    schemaVersion: parsed.schemaVersion,
    order: parsed.order,
    filterFingerprint: parsed.filterFingerprint,
    occurredAtMs: parsed.occurredAtMs,
    id: parsed.id,
  });
  const binary = String.fromCharCode(...utf8Encoder.encode(canonicalJson));
  return encodedLogCursorSchema.parse(
    btoa(binary).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, ""),
  );
}

export function decodeLogCursor(cursor: string): LogCursorPayload {
  try {
    const encoded = encodedLogCursorSchema.parse(cursor);
    const remainder = encoded.length % 4;
    if (remainder === 1) {
      throw new TypeError("Invalid base64url length");
    }
    const padded =
      encoded.replace(/-/gu, "+").replace(/_/gu, "/") +
      "=".repeat((4 - remainder) % 4);
    const binary = atob(padded);
    const bytes = Uint8Array.from(binary, (character) =>
      character.charCodeAt(0),
    );
    const payload = logCursorPayloadSchema.parse(
      JSON.parse(utf8Decoder.decode(bytes)),
    );
    if (encodeLogCursor(payload) !== encoded) {
      throw new TypeError("Log cursor is not canonically encoded");
    }
    return payload;
  } catch {
    throw new TypeError("Log cursor is malformed");
  }
}

export const logCursorSchema = encodedLogCursorSchema.superRefine(
  (cursor, context) => {
    try {
      decodeLogCursor(cursor);
    } catch {
      context.addIssue({
        code: "custom",
        message: "Log cursor must contain a canonical versioned payload",
      });
    }
  },
);

export const logsListRequestSchema = z
  .strictObject({
    filters: logFilterSchema.default({}),
    cursor: logCursorSchema.optional(),
    pageSize: z.number().int().min(1).max(100).default(50),
  })
  .superRefine((request, context) => {
    if (request.cursor === undefined) {
      return;
    }
    try {
      const cursor = decodeLogCursor(request.cursor);
      if (
        cursor.filterFingerprint !== createLogFilterFingerprint(request.filters)
      ) {
        context.addIssue({
          code: "custom",
          path: ["cursor"],
          message: "Log cursor does not belong to the requested filters",
        });
      }
    } catch {
      // The nested cursor schema reports malformed cursor details.
    }
  });

export const logEntrySchema = z
  .strictObject({
    id: positiveSafeIntegerSchema,
    occurredAtMs: nonnegativeSafeIntegerSchema,
    direction: eventDirectionSchema,
    kind: boundedTextSchema,
    severity: logSeveritySchema,
    topic: boundedTextSchema.nullable(),
    deviceId: identifierSchema.nullable(),
    correlationId: identifierSchema.nullable(),
    operationId: identifierSchema.nullable(),
    outcome: eventOutcomeSchema,
    durationMs: nonnegativeSafeIntegerSchema.nullable(),
    byteCount: nonnegativeSafeIntegerSchema,
    retentionClass: retentionClassSchema,
    payload: logPayloadSchema.nullable(),
    payloadSchemaVersion: positiveSafeIntegerSchema.nullable(),
    payloadSha256: sha256Schema.nullable(),
  })
  .superRefine((entry, context) => {
    const hasPayload = entry.payload !== null;
    if (
      hasPayload !== (entry.payloadSchemaVersion !== null) ||
      hasPayload !== (entry.payloadSha256 !== null)
    ) {
      context.addIssue({
        code: "custom",
        path: ["payload"],
        message:
          "Log payload, schema version, and hash must be present together",
      });
    }
  });

export const logsSummarySchema = z.strictObject({
  returnedCount: nonnegativeSafeIntegerSchema,
  totalByteCount: nonnegativeSafeIntegerSchema,
  firstOccurredAtMs: nonnegativeSafeIntegerSchema.nullable(),
  lastOccurredAtMs: nonnegativeSafeIntegerSchema.nullable(),
});

export const logsListResponseSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    items: z.array(logEntrySchema).max(100),
    nextCursor: logCursorSchema.nullable(),
    hasMore: z.boolean(),
    summary: logsSummarySchema,
  })
  .superRefine((response, context) => {
    if (response.hasMore !== (response.nextCursor !== null)) {
      context.addIssue({
        code: "custom",
        path: ["nextCursor"],
        message: "A next cursor is required exactly when more rows exist",
      });
    }

    if (response.summary.returnedCount !== response.items.length) {
      context.addIssue({
        code: "custom",
        path: ["summary", "returnedCount"],
        message: "Log summary count must match the returned rows",
      });
    }

    let totalByteCount = 0;
    let totalByteCountIsSafe = true;
    const seenIds = new Set<number>();
    for (const [index, item] of response.items.entries()) {
      totalByteCount += item.byteCount;
      if (totalByteCountIsSafe && !Number.isSafeInteger(totalByteCount)) {
        totalByteCountIsSafe = false;
        context.addIssue({
          code: "custom",
          path: ["summary", "totalByteCount"],
          message: "Log page byte total must be a safe integer",
        });
      }

      if (seenIds.has(item.id)) {
        context.addIssue({
          code: "custom",
          path: ["items", index, "id"],
          message: "Log entries must have unique identifiers",
        });
      }
      seenIds.add(item.id);

      const previous = response.items[index - 1];
      if (
        previous !== undefined &&
        (previous.occurredAtMs < item.occurredAtMs ||
          (previous.occurredAtMs === item.occurredAtMs &&
            previous.id <= item.id))
      ) {
        context.addIssue({
          code: "custom",
          path: ["items", index],
          message:
            "Log entries must use descending occurred-at and identifier order",
        });
      }
    }

    if (
      totalByteCountIsSafe &&
      response.summary.totalByteCount !== totalByteCount
    ) {
      context.addIssue({
        code: "custom",
        path: ["summary", "totalByteCount"],
        message: "Log summary bytes must equal the returned rows",
      });
    }

    const firstItem = response.items[0];
    const lastItem = response.items.at(-1);
    const expectedFirstOccurredAtMs = firstItem?.occurredAtMs ?? null;
    const expectedLastOccurredAtMs = lastItem?.occurredAtMs ?? null;
    if (response.summary.firstOccurredAtMs !== expectedFirstOccurredAtMs) {
      context.addIssue({
        code: "custom",
        path: ["summary", "firstOccurredAtMs"],
        message: "Log summary first time must match the first returned row",
      });
    }
    if (response.summary.lastOccurredAtMs !== expectedLastOccurredAtMs) {
      context.addIssue({
        code: "custom",
        path: ["summary", "lastOccurredAtMs"],
        message: "Log summary last time must match the last returned row",
      });
    }

    if (response.nextCursor !== null) {
      if (lastItem === undefined) {
        context.addIssue({
          code: "custom",
          path: ["nextCursor"],
          message: "An empty log page cannot have a continuation cursor",
        });
      } else {
        try {
          const cursor = decodeLogCursor(response.nextCursor);
          if (
            cursor.occurredAtMs !== lastItem.occurredAtMs ||
            cursor.id !== lastItem.id
          ) {
            context.addIssue({
              code: "custom",
              path: ["nextCursor"],
              message: "The continuation cursor must identify the last row",
            });
          }
        } catch {
          // The nested cursor schema reports malformed cursor details.
        }
      }
    }
  });

export const logExportFormatSchema = z.enum(["ndjson", "csv"]);

const logExportMaxRowsSchema = z.number().int().min(1).max(100_000);

export const logExportRequestSchema = z.strictObject({
  filters: logFilterSchema.default({}),
  format: logExportFormatSchema,
  maxRows: logExportMaxRowsSchema.default(10_000),
});

export const logExportMetadataSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    format: logExportFormatSchema,
    generatedAt: isoTimestampSchema,
    requestedFilters: logFilterSchema,
    requestedMaxRows: logExportMaxRowsSchema,
    rowCount: nonnegativeSafeIntegerSchema,
    truncated: z.boolean(),
    contentType: z.enum(["application/x-ndjson", "text/csv"]),
    filename: z
      .string()
      .min(1)
      .max(200)
      .regex(/^[A-Za-z0-9][A-Za-z0-9._-]*\.(csv|ndjson)$/u),
  })
  .superRefine((metadata, context) => {
    const expectedContentType =
      metadata.format === "csv" ? "text/csv" : "application/x-ndjson";
    if (metadata.contentType !== expectedContentType) {
      context.addIssue({
        code: "custom",
        path: ["contentType"],
        message: `Export format ${metadata.format} requires ${expectedContentType}`,
      });
    }

    const expectedExtension = metadata.format === "csv" ? ".csv" : ".ndjson";
    if (!metadata.filename.endsWith(expectedExtension)) {
      context.addIssue({
        code: "custom",
        path: ["filename"],
        message: `Export format ${metadata.format} requires a ${expectedExtension} filename`,
      });
    }

    if (metadata.rowCount > metadata.requestedMaxRows) {
      context.addIssue({
        code: "custom",
        path: ["rowCount"],
        message: "Export rows must not exceed the requested maximum",
      });
    }
    if (metadata.truncated && metadata.rowCount !== metadata.requestedMaxRows) {
      context.addIssue({
        code: "custom",
        path: ["truncated"],
        message: "A truncated export must fill its requested row limit",
      });
    }
  });

export type LogsListRequest = z.infer<typeof logsListRequestSchema>;
export type LogEntry = z.infer<typeof logEntrySchema>;
export type LogsListResponse = z.infer<typeof logsListResponseSchema>;
export type LogExportRequest = z.infer<typeof logExportRequestSchema>;
export type LogExportMetadata = z.infer<typeof logExportMetadataSchema>;
