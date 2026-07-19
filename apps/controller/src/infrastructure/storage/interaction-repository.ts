import { createHash } from "node:crypto";

import {
  boundedTextSchema,
  eventDirectionSchema,
  eventOutcomeSchema,
  identifierSchema,
  logPayloadSchema,
  logSeveritySchema,
  nonnegativeSafeIntegerSchema,
  positiveSafeIntegerSchema,
  retentionClassSchema,
  sha256Schema,
} from "@aquarium/contracts";
import type { Kysely } from "kysely";
import { z } from "zod";

import type {
  EventDirection,
  EventOutcome,
  EventsDatabaseSchema,
  RetentionClass,
} from "../database/index.js";
import { parseJsonDocument } from "../import/strict-json.js";

export const interactionPayloadSchema = logPayloadSchema;

export type InteractionPayload = z.infer<typeof interactionPayloadSchema>;
export type InteractionPayloadValue = InteractionPayload[string];

export const interactionLogInputSchema = z
  .strictObject({
    occurredAtMs: nonnegativeSafeIntegerSchema,
    direction: eventDirectionSchema,
    kind: boundedTextSchema,
    severity: logSeveritySchema,
    topic: boundedTextSchema.optional(),
    deviceId: identifierSchema.optional(),
    correlationId: identifierSchema.optional(),
    operationId: identifierSchema.optional(),
    outcome: eventOutcomeSchema,
    durationMs: nonnegativeSafeIntegerSchema.optional(),
    byteCount: nonnegativeSafeIntegerSchema,
    retentionClass: retentionClassSchema,
    payload: interactionPayloadSchema.optional(),
    payloadSchemaVersion: positiveSafeIntegerSchema.optional(),
  })
  .superRefine((value, context) => {
    if (
      (value.payload === undefined) !==
      (value.payloadSchemaVersion === undefined)
    ) {
      context.addIssue({
        code: "custom",
        message: "Payload and payload schema version must be provided together",
      });
    }
  });

export type InteractionLogInput = z.infer<typeof interactionLogInputSchema>;

const storedInteractionRowSchema = z
  .strictObject({
    id: positiveSafeIntegerSchema,
    occurred_at_ms: nonnegativeSafeIntegerSchema,
    direction: eventDirectionSchema,
    kind: boundedTextSchema,
    severity: logSeveritySchema,
    topic: boundedTextSchema.nullable(),
    device_id: identifierSchema.nullable(),
    correlation_id: identifierSchema.nullable(),
    operation_id: identifierSchema.nullable(),
    outcome: eventOutcomeSchema,
    duration_ms: nonnegativeSafeIntegerSchema.nullable(),
    byte_count: nonnegativeSafeIntegerSchema,
    retention_class: retentionClassSchema,
    payload_json: z.string().nullable(),
    payload_schema_version: positiveSafeIntegerSchema.nullable(),
    payload_sha256: sha256Schema.nullable(),
  })
  .superRefine((value, context) => {
    const payloadFields = [
      value.payload_json,
      value.payload_schema_version,
      value.payload_sha256,
    ];
    const populatedCount = payloadFields.filter(
      (field) => field !== null,
    ).length;
    if (populatedCount !== 0 && populatedCount !== payloadFields.length) {
      context.addIssue({
        code: "custom",
        message:
          "Persisted payload, schema version, and checksum must be paired",
      });
    }
  });

export interface StoredInteraction {
  readonly id: number;
  readonly occurredAtMs: number;
  readonly direction: EventDirection;
  readonly kind: string;
  readonly severity: z.infer<typeof logSeveritySchema>;
  readonly topic: string | null;
  readonly deviceId: string | null;
  readonly correlationId: string | null;
  readonly operationId: string | null;
  readonly outcome: EventOutcome;
  readonly durationMs: number | null;
  readonly byteCount: number;
  readonly retentionClass: RetentionClass;
  readonly payload: InteractionPayload | null;
  readonly payloadSchemaVersion: number | null;
  readonly payloadSha256: string | null;
}

export interface InteractionRedactionContext {
  readonly kind: string;
  readonly payload: InteractionPayload;
}

export type InteractionPayloadRedactor = (
  context: InteractionRedactionContext,
) => InteractionPayload | null;

export interface InteractionRepositoryOptions {
  readonly redactPayload?: InteractionPayloadRedactor;
}

export interface InteractionRange {
  readonly rangeStartMs: number;
  readonly rangeEndMs: number;
  readonly retentionClass?: RetentionClass;
  readonly ids?: readonly number[];
}

export class InteractionRepository {
  readonly #database: Kysely<EventsDatabaseSchema>;
  readonly #redactPayload: InteractionPayloadRedactor | undefined;

  constructor(
    database: Kysely<EventsDatabaseSchema>,
    options: InteractionRepositoryOptions = {},
  ) {
    this.#database = database;
    this.#redactPayload = options.redactPayload;
  }

  async log(input: InteractionLogInput): Promise<StoredInteraction> {
    const parsed = interactionLogInputSchema.parse(input);
    const redactionResult =
      parsed.payload === undefined
        ? null
        : this.#redactPayload === undefined
          ? parsed.payload
          : this.#redactPayload({ kind: parsed.kind, payload: parsed.payload });
    const redacted =
      redactionResult === null
        ? null
        : interactionPayloadSchema.parse(redactionResult);
    const payloadJson =
      redacted === null ? null : serializeCanonicalJson(redacted);
    const payloadSha256 =
      payloadJson === null ? null : sha256(Buffer.from(payloadJson, "utf8"));
    const payloadSchemaVersion =
      redacted === null ? null : (parsed.payloadSchemaVersion ?? null);

    const result = await this.#database
      .insertInto("interactions")
      .values({
        occurred_at_ms: parsed.occurredAtMs,
        direction: parsed.direction,
        kind: parsed.kind,
        severity: parsed.severity,
        topic: parsed.topic ?? null,
        device_id: parsed.deviceId ?? null,
        correlation_id: parsed.correlationId ?? null,
        operation_id: parsed.operationId ?? null,
        outcome: parsed.outcome,
        duration_ms: parsed.durationMs ?? null,
        byte_count: parsed.byteCount,
        retention_class: parsed.retentionClass,
        payload_json: payloadJson,
        payload_schema_version: payloadSchemaVersion,
        payload_sha256: payloadSha256,
      })
      .executeTakeFirstOrThrow();
    const id = Number(result.insertId);
    if (!Number.isSafeInteger(id) || id <= 0) {
      throw new Error("SQLite returned an invalid interaction identifier");
    }
    const stored = await this.getById(id);
    if (stored === null) {
      throw new Error(
        `Interaction ${id} disappeared immediately after insertion`,
      );
    }
    return stored;
  }

  async getById(id: number): Promise<StoredInteraction | null> {
    assertPositiveSafeInteger(id, "Interaction identifier");
    const row = await this.#database
      .selectFrom("interactions")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst();
    return row === undefined ? null : parseStoredInteraction(row);
  }

  async listByKindAndOperationId(
    kind: string,
    operationId: string,
  ): Promise<readonly StoredInteraction[]> {
    const parsedKind = boundedTextSchema.parse(kind);
    const parsedOperationId = identifierSchema.parse(operationId);
    const rows = await this.#database
      .selectFrom("interactions")
      .selectAll()
      .where("kind", "=", parsedKind)
      .where("operation_id", "=", parsedOperationId)
      .orderBy("id")
      .limit(2)
      .execute();
    return rows.map(parseStoredInteraction);
  }

  async listRange(
    range: InteractionRange,
  ): Promise<readonly StoredInteraction[]> {
    assertRange(range.rangeStartMs, range.rangeEndMs);
    let query = this.#database
      .selectFrom("interactions")
      .selectAll()
      .where("occurred_at_ms", ">=", range.rangeStartMs)
      .where("occurred_at_ms", "<", range.rangeEndMs);
    if (range.retentionClass !== undefined) {
      query = query.where("retention_class", "=", range.retentionClass);
    }
    if (range.ids !== undefined) {
      if (range.ids.length === 0) return [];
      for (const id of range.ids)
        assertPositiveSafeInteger(id, "Interaction identifier");
      query = query.where("id", "in", [...range.ids]);
    }
    const rows = await query.orderBy("occurred_at_ms").orderBy("id").execute();
    return rows.map(parseStoredInteraction);
  }
}

export function createSensitiveKeyRedactor(
  sensitiveKeys: readonly string[] = [
    "authorization",
    "password",
    "secret",
    "token",
  ],
  replacement = "[REDACTED]",
): InteractionPayloadRedactor {
  if (sensitiveKeys.length === 0) {
    throw new RangeError("At least one sensitive key is required");
  }
  const normalizedKeys = new Set(
    sensitiveKeys.map((key) => {
      const normalized = key.trim().toLocaleLowerCase("en-US");
      if (normalized.length === 0) {
        throw new TypeError("Sensitive keys must not be empty");
      }
      return normalized;
    }),
  );
  return ({ payload }) =>
    interactionPayloadSchema.parse(
      redactValue(payload, normalizedKeys, replacement),
    );
}

export function serializeCanonicalJson(value: InteractionPayloadValue): string {
  return JSON.stringify(canonicalize(value));
}

export function sha256(value: Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function assertRange(rangeStartMs: number, rangeEndMs: number): void {
  if (!Number.isSafeInteger(rangeStartMs) || rangeStartMs < 0) {
    throw new RangeError("Range start must be a non-negative safe integer");
  }
  if (!Number.isSafeInteger(rangeEndMs) || rangeEndMs <= rangeStartMs) {
    throw new RangeError("Range end must be a safe integer after range start");
  }
}

function parseStoredInteraction(row: object): StoredInteraction {
  const parsed = storedInteractionRowSchema.parse(row);
  let payload: InteractionPayload | null = null;
  if (parsed.payload_json !== null) {
    const document = parseJsonDocument(
      parsed.payload_json,
      `interaction ${parsed.id} payload`,
    );
    if (document.duplicateKeys.length > 0) {
      throw new Error(
        `Interaction ${parsed.id} payload contains duplicate keys`,
      );
    }
    payload = interactionPayloadSchema.parse(document.value);
    const actualSha256 = sha256(Buffer.from(parsed.payload_json, "utf8"));
    if (actualSha256 !== parsed.payload_sha256) {
      throw new Error(`Interaction ${parsed.id} payload checksum mismatch`);
    }
  }
  return {
    id: parsed.id,
    occurredAtMs: parsed.occurred_at_ms,
    direction: parsed.direction,
    kind: parsed.kind,
    severity: parsed.severity,
    topic: parsed.topic,
    deviceId: parsed.device_id,
    correlationId: parsed.correlation_id,
    operationId: parsed.operation_id,
    outcome: parsed.outcome,
    durationMs: parsed.duration_ms,
    byteCount: parsed.byte_count,
    retentionClass: parsed.retention_class,
    payload,
    payloadSchemaVersion: parsed.payload_schema_version,
    payloadSha256: parsed.payload_sha256,
  };
}

function redactValue(
  value: InteractionPayloadValue,
  sensitiveKeys: ReadonlySet<string>,
  replacement: string,
): InteractionPayloadValue {
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, sensitiveKeys, replacement));
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        sensitiveKeys.has(key.toLocaleLowerCase("en-US"))
          ? replacement
          : redactValue(item, sensitiveKeys, replacement),
      ]),
    );
  }
  return value;
}

function canonicalize(value: InteractionPayloadValue): InteractionPayloadValue {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => (left === right ? 0 : left < right ? -1 : 1))
        .map(([key, item]) => [key, canonicalize(item)]),
    );
  }
  return value;
}

function assertPositiveSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${label} must be a positive safe integer`);
  }
}
