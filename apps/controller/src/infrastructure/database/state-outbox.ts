import { sql, type Kysely, type Selectable, type Transaction } from "kysely";
import { z } from "zod";

import type {
  EventsDatabaseSchema,
  JsonText,
  RetentionClass,
  StateDatabaseSchema,
  StateEventsTable,
  StateOutboxTable,
} from "./types.js";

const DEFAULT_MIRROR_BATCH_SIZE = 100;
const MAX_MIRROR_BATCH_SIZE = 1_000;
const DEFAULT_MIRROR_RETRY_DELAY_MS = 1_000;

export type StateDatabaseTransaction = Transaction<StateDatabaseSchema>;
export type StoredStateOutboxEvent = Selectable<StateOutboxTable>;

export interface StateChangeEvent {
  readonly actor: string;
  readonly mutationType: string;
  readonly summary: string;
  readonly eventType: string;
  readonly entityType: string;
  readonly entityId?: string | null;
  readonly occurredAtMs: number;
  readonly retentionClass: RetentionClass;
  readonly payloadJson: JsonText;
  readonly payloadSchemaVersion: number;
  readonly availableAtMs?: number;
}

export interface CommittedStateChange<Result> {
  readonly revision: number;
  readonly result: Result;
  readonly outboxEvent: StoredStateOutboxEvent;
}

export interface StateEventMirrorOptions {
  readonly nowMs: number;
  readonly batchSize?: number;
  readonly retryDelayMs?: number;
}

export interface StateEventMirrorResult {
  readonly mirroredRevisions: readonly number[];
}

export class StateEventMirrorConflictError extends Error {
  override readonly name = "StateEventMirrorConflictError";
  readonly revision: number;
  readonly mismatchedFields: readonly string[];

  constructor(revision: number, mismatchedFields: readonly string[]) {
    super(
      `State event revision ${revision} already exists with conflicting fields: ${mismatchedFields.join(", ")}`,
    );
    this.revision = revision;
    this.mismatchedFields = mismatchedFields;
  }
}

function assertNonEmpty(value: string, field: string): void {
  if (value.trim().length === 0) {
    throw new TypeError(`${field} must not be empty`);
  }
}

function assertNonNegativeInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${field} must be a non-negative safe integer`);
  }
}

function assertPositiveInteger(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${field} must be a positive safe integer`);
  }
}

function validateStateChangeEvent(event: StateChangeEvent): number {
  assertNonEmpty(event.actor, "actor");
  assertNonEmpty(event.mutationType, "mutationType");
  assertNonEmpty(event.summary, "summary");
  assertNonEmpty(event.eventType, "eventType");
  assertNonEmpty(event.entityType, "entityType");
  if (event.entityId !== undefined && event.entityId !== null) {
    assertNonEmpty(event.entityId, "entityId");
  }
  assertNonNegativeInteger(event.occurredAtMs, "occurredAtMs");
  assertPositiveInteger(event.payloadSchemaVersion, "payloadSchemaVersion");

  try {
    z.json().parse(JSON.parse(event.payloadJson));
  } catch (error) {
    throw new TypeError("payloadJson must contain valid JSON", {
      cause: error,
    });
  }

  if (!Number.isFinite(new Date(event.occurredAtMs).getTime())) {
    throw new RangeError("occurredAtMs must be representable as a timestamp");
  }

  const availableAtMs = event.availableAtMs ?? event.occurredAtMs;
  assertNonNegativeInteger(availableAtMs, "availableAtMs");
  if (availableAtMs < event.occurredAtMs) {
    throw new RangeError("availableAtMs must not precede occurredAtMs");
  }
  return availableAtMs;
}

/**
 * Runs an authoritative state mutation and records its one replayable event in
 * the same SQLite transaction. Callers must keep the callback limited to state
 * database work; external side effects cannot be made atomic with this commit.
 */
export async function commitStateChange<Result>(
  database: Kysely<StateDatabaseSchema>,
  event: StateChangeEvent,
  mutate: (transaction: StateDatabaseTransaction) => Promise<Result>,
): Promise<CommittedStateChange<Result>> {
  const availableAtMs = validateStateChangeEvent(event);

  return database.transaction().execute(async (transaction) => {
    const result = await mutate(transaction);
    const revisionRow = await transaction
      .insertInto("state_revisions")
      .values({
        committed_at_ms: event.occurredAtMs,
        actor: event.actor,
        mutation_type: event.mutationType,
        summary: event.summary,
      })
      .returning("revision")
      .executeTakeFirstOrThrow();

    await transaction
      .insertInto("state_outbox")
      .values({
        revision: revisionRow.revision,
        event_type: event.eventType,
        entity_type: event.entityType,
        entity_id: event.entityId ?? null,
        occurred_at_ms: event.occurredAtMs,
        retention_class: event.retentionClass,
        payload_json: event.payloadJson,
        payload_schema_version: event.payloadSchemaVersion,
        available_at_ms: availableAtMs,
      })
      .executeTakeFirstOrThrow();

    const outboxEvent = await transaction
      .selectFrom("state_outbox")
      .selectAll()
      .where("revision", "=", revisionRow.revision)
      .executeTakeFirstOrThrow();

    return {
      revision: revisionRow.revision,
      result,
      outboxEvent,
    };
  });
}

export async function readCurrentStateRevision(
  database: Kysely<StateDatabaseSchema>,
): Promise<number> {
  const row = await database
    .selectFrom("state_revisions")
    .select(({ fn }) => fn.max<number>("revision").as("revision"))
    .executeTakeFirstOrThrow();
  return row.revision ?? 0;
}

function buildStateEvent(
  outboxEvent: StoredStateOutboxEvent,
): Selectable<StateEventsTable> {
  z.json().parse(JSON.parse(outboxEvent.payload_json));
  return {
    revision: outboxEvent.revision,
    occurred_at_ms: outboxEvent.occurred_at_ms,
    event_type: outboxEvent.event_type,
    entity_type: outboxEvent.entity_type,
    entity_id: outboxEvent.entity_id,
    retention_class: outboxEvent.retention_class,
    payload_json: outboxEvent.payload_json,
    payload_schema_version: outboxEvent.payload_schema_version,
    byte_count: new TextEncoder().encode(outboxEvent.payload_json).byteLength,
  };
}

function findStateEventMismatches(
  expected: Selectable<StateEventsTable>,
  actual: Selectable<StateEventsTable>,
): readonly string[] {
  const mismatches: string[] = [];
  for (const field of [
    "occurred_at_ms",
    "event_type",
    "entity_type",
    "entity_id",
    "retention_class",
    "payload_json",
    "payload_schema_version",
    "byte_count",
  ] as const) {
    if (expected[field] !== actual[field]) {
      mismatches.push(field);
    }
  }
  return mismatches;
}

async function ensureEventMirror(
  eventsDatabase: Kysely<EventsDatabaseSchema>,
  outboxEvent: StoredStateOutboxEvent,
): Promise<void> {
  const expected = buildStateEvent(outboxEvent);
  await eventsDatabase.transaction().execute(async (transaction) => {
    await transaction
      .insertInto("state_events")
      .values(expected)
      .onConflict((conflict) => conflict.column("revision").doNothing())
      .executeTakeFirst();

    const actual = await transaction
      .selectFrom("state_events")
      .selectAll()
      .where("revision", "=", expected.revision)
      .executeTakeFirstOrThrow();
    const mismatches = findStateEventMismatches(expected, actual);
    if (mismatches.length > 0) {
      throw new StateEventMirrorConflictError(expected.revision, mismatches);
    }
  });
}

function describeMirrorError(error: object | null): string {
  if (error instanceof Error) {
    return `${error.name}: ${error.message}`;
  }
  return "State event mirror failed with a non-Error value";
}

/**
 * Mirrors due state outbox rows into events.db in revision order. The events
 * insert is idempotent by revision and verified byte-for-byte before state.db
 * marks an outbox row published, making a restart between those writes safe.
 */
export async function mirrorPendingStateEvents(
  stateDatabase: Kysely<StateDatabaseSchema>,
  eventsDatabase: Kysely<EventsDatabaseSchema>,
  options: StateEventMirrorOptions,
): Promise<StateEventMirrorResult> {
  assertNonNegativeInteger(options.nowMs, "nowMs");
  const batchSize = options.batchSize ?? DEFAULT_MIRROR_BATCH_SIZE;
  if (
    !Number.isSafeInteger(batchSize) ||
    batchSize <= 0 ||
    batchSize > MAX_MIRROR_BATCH_SIZE
  ) {
    throw new RangeError(
      `batchSize must be an integer between 1 and ${MAX_MIRROR_BATCH_SIZE}`,
    );
  }
  const retryDelayMs = options.retryDelayMs ?? DEFAULT_MIRROR_RETRY_DELAY_MS;
  assertNonNegativeInteger(retryDelayMs, "retryDelayMs");
  const retryAtMs = options.nowMs + retryDelayMs;
  assertNonNegativeInteger(retryAtMs, "retryAtMs");

  const pendingEvents = await stateDatabase
    .selectFrom("state_outbox")
    .selectAll()
    .where("published_at_ms", "is", null)
    .where("available_at_ms", "<=", options.nowMs)
    .orderBy("revision", "asc")
    .limit(batchSize)
    .execute();
  const mirroredRevisions: number[] = [];

  for (const outboxEvent of pendingEvents) {
    try {
      await ensureEventMirror(eventsDatabase, outboxEvent);
      const publication = await stateDatabase
        .updateTable("state_outbox")
        .set({
          delivery_attempts: sql<number>`delivery_attempts + 1`,
          published_at_ms: options.nowMs,
          last_error: null,
        })
        .where("revision", "=", outboxEvent.revision)
        .where("published_at_ms", "is", null)
        .executeTakeFirst();
      if (publication.numUpdatedRows === 0n) {
        const currentOutboxState = await stateDatabase
          .selectFrom("state_outbox")
          .select("published_at_ms")
          .where("revision", "=", outboxEvent.revision)
          .executeTakeFirst();
        if (currentOutboxState?.published_at_ms === null) {
          throw new Error(
            `State outbox revision ${outboxEvent.revision} was mirrored but could not be marked published`,
          );
        }
        if (currentOutboxState === undefined) {
          throw new Error(
            `State outbox revision ${outboxEvent.revision} disappeared before it could be marked published`,
          );
        }
      }
      mirroredRevisions.push(outboxEvent.revision);
    } catch (error) {
      const errorDescription = describeMirrorError(
        typeof error === "object" ? error : null,
      );
      await stateDatabase
        .updateTable("state_outbox")
        .set({
          delivery_attempts: sql<number>`delivery_attempts + 1`,
          available_at_ms: retryAtMs,
          last_error: errorDescription,
        })
        .where("revision", "=", outboxEvent.revision)
        .where("published_at_ms", "is", null)
        .executeTakeFirst();
      throw error;
    }
  }

  return { mirroredRevisions };
}
