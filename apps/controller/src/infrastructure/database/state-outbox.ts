import {
  boundedTextSchema,
  committedStateEventSchema,
  nonnegativeSafeIntegerSchema,
  stateInvalidationsSchema,
  stateInvalidationSchema,
  stateOutboxEnvelopeV1Schema,
  type CommittedStateEvent,
  type EntityStateResource,
  type StateInvalidation,
  type StateOutboxEnvelopeV1,
} from "@aquarium/contracts";
import { sql, type Kysely, type Selectable, type Transaction } from "kysely";
import { z } from "zod";

import { parseJsonDocument } from "../import/strict-json.js";
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
export const STATE_OUTBOX_ENVELOPE_SCHEMA_VERSION = 1;

export type StateDatabaseTransaction = Transaction<StateDatabaseSchema>;
export type StoredStateOutboxEvent = Selectable<StateOutboxTable>;

export interface StoredStateEnvelopeRecord {
  readonly revision: number;
  readonly payload_json: JsonText;
  readonly payload_schema_version: number;
}

export interface StoredCommittedStateEventRecord extends StoredStateEnvelopeRecord {
  readonly occurred_at_ms: number;
  readonly event_type: string;
  readonly entity_type: string;
  readonly entity_id: string | null;
  readonly retention_class: RetentionClass;
}

interface StateChangeEventBase {
  readonly actor: string;
  readonly mutationType: string;
  readonly summary: string;
  readonly eventType: string;
  readonly occurredAtMs: number;
  readonly retentionClass: RetentionClass;
  readonly payloadJson: JsonText;
  readonly payloadSchemaVersion: number;
  readonly invalidations?: readonly StateInvalidation[];
  readonly availableAtMs?: number;
}

export type StateChangeEvent = StateChangeEventBase &
  (
    | { readonly entityType: "controller"; readonly entityId?: null }
    | {
        readonly entityType: EntityStateResource;
        readonly entityId: string;
      }
  );

export interface CommittedStateChange<Result> {
  readonly revision: number;
  readonly result: Result;
  readonly outboxEvent: StoredStateOutboxEvent;
}

export type ConditionalStateMutation<Result> =
  | { readonly changed: false; readonly result: Result }
  | { readonly changed: true; readonly result: Result };

export type ConditionalCommittedStateChange<Result> =
  | {
      readonly changed: false;
      readonly revision: number;
      readonly result: Result;
      readonly outboxEvent: null;
    }
  | {
      readonly changed: true;
      readonly revision: number;
      readonly result: Result;
      readonly outboxEvent: StoredStateOutboxEvent;
    };

export type ConditionalStateChangeEvent<Result> =
  StateChangeEvent | ((result: Result) => StateChangeEvent);

type ConditionalStateMutationValue = string | number | boolean | null | object;

export interface StateChangePostOutboxContext {
  readonly revision: number;
  readonly outboxEvent: StoredStateOutboxEvent;
}

export type StateChangePostOutboxHook = (
  transaction: StateDatabaseTransaction,
  context: StateChangePostOutboxContext,
) => Promise<void>;

export interface OperatorConcurrencyGuard {
  readonly expectedRevision: number;
  readonly conflictError: (
    expectedRevision: number,
    currentRevision: number,
  ) => Error;
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

interface ValidatedStateChangeEvent {
  readonly availableAtMs: number;
  readonly payloadJson: JsonText;
}

export function serializeStateOutboxEnvelope(
  detailsJson: JsonText,
  detailsSchemaVersion: number,
  invalidations: readonly StateInvalidation[],
): JsonText {
  assertPositiveInteger(detailsSchemaVersion, "detailsSchemaVersion");
  let parsedDetails: ReturnType<typeof parseJsonDocument>;
  try {
    parsedDetails = parseJsonDocument(detailsJson, "state event details");
  } catch (error) {
    throw new TypeError("payloadJson must contain valid JSON", {
      cause: error,
    });
  }
  if (parsedDetails.duplicateKeys.length > 0) {
    throw new TypeError("payloadJson must not contain duplicate keys");
  }
  const data = z.json().parse(parsedDetails.value);
  const validatedInvalidations = stateInvalidationsSchema.parse({
    invalidations,
  }).invalidations;
  return JSON.stringify(
    stateOutboxEnvelopeV1Schema.parse({
      schemaVersion: STATE_OUTBOX_ENVELOPE_SCHEMA_VERSION,
      invalidations: validatedInvalidations,
      details: { schemaVersion: detailsSchemaVersion, data },
    }),
  );
}

export function parseStoredStateOutboxEnvelope(
  event: StoredStateEnvelopeRecord,
): StateOutboxEnvelopeV1 {
  if (event.payload_schema_version !== STATE_OUTBOX_ENVELOPE_SCHEMA_VERSION) {
    throw new Error(
      `Unsupported state outbox envelope version ${event.payload_schema_version}`,
    );
  }
  const parsed = parseJsonDocument(
    event.payload_json,
    `state outbox revision ${event.revision}`,
  );
  if (parsed.duplicateKeys.length > 0) {
    throw new Error(
      `State outbox revision ${event.revision} contains duplicate JSON keys`,
    );
  }
  return stateOutboxEnvelopeV1Schema.parse(parsed.value);
}

export function toCommittedStateEvent(
  event: StoredCommittedStateEventRecord,
): CommittedStateEvent {
  const primary = stateInvalidationSchema.parse({
    resource: event.entity_type,
    id: event.entity_id,
  });
  const envelope = parseStoredStateOutboxEnvelope(event);
  return committedStateEventSchema.parse({
    revision: event.revision,
    type: event.event_type,
    occurredAt: new Date(event.occurred_at_ms).toISOString(),
    entity: { type: primary.resource, id: primary.id },
    schemaVersion: STATE_OUTBOX_ENVELOPE_SCHEMA_VERSION,
    data: { invalidations: envelope.invalidations },
    retentionClass: event.retention_class,
  });
}

function validateStateChangeEvent(
  event: StateChangeEvent,
): ValidatedStateChangeEvent {
  boundedTextSchema.parse(event.actor);
  boundedTextSchema.parse(event.mutationType);
  boundedTextSchema.parse(event.summary);
  boundedTextSchema.parse(event.eventType);
  const primary = stateInvalidationSchema.parse({
    resource: event.entityType,
    id: event.entityId ?? null,
  });
  assertNonNegativeInteger(event.occurredAtMs, "occurredAtMs");

  if (!Number.isFinite(new Date(event.occurredAtMs).getTime())) {
    throw new RangeError("occurredAtMs must be representable as a timestamp");
  }

  const availableAtMs = event.availableAtMs ?? event.occurredAtMs;
  assertNonNegativeInteger(availableAtMs, "availableAtMs");
  if (availableAtMs < event.occurredAtMs) {
    throw new RangeError("availableAtMs must not precede occurredAtMs");
  }
  const invalidations = event.invalidations ?? [primary];
  if (
    !invalidations.some(
      (invalidation) =>
        invalidation.resource === primary.resource &&
        invalidation.id === primary.id,
    )
  ) {
    throw new TypeError(
      "State event invalidations must include its primary entity",
    );
  }
  return {
    availableAtMs,
    payloadJson: serializeStateOutboxEnvelope(
      event.payloadJson,
      event.payloadSchemaVersion,
      invalidations,
    ),
  };
}

/**
 * Runs an authoritative state mutation and records its one replayable event in
 * the same SQLite transaction. Callers must keep the callback limited to state
 * database work; external side effects cannot be made atomic with this commit.
 * The optional post-outbox hook exists for dependent state rows that require
 * the allocated revision, such as a durable notification-delivery intent. It
 * still runs inside this transaction and must never perform remote I/O.
 */
export async function commitStateChange<Result>(
  database: Kysely<StateDatabaseSchema>,
  event: StateChangeEvent,
  mutate: (transaction: StateDatabaseTransaction) => Promise<Result>,
  postOutbox?: StateChangePostOutboxHook,
): Promise<CommittedStateChange<Result>> {
  const validatedEvent = validateStateChangeEvent(event);

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
        payload_json: validatedEvent.payloadJson,
        payload_schema_version: STATE_OUTBOX_ENVELOPE_SCHEMA_VERSION,
        available_at_ms: validatedEvent.availableAtMs,
      })
      .executeTakeFirstOrThrow();

    const outboxEvent = await transaction
      .selectFrom("state_outbox")
      .selectAll()
      .where("revision", "=", revisionRow.revision)
      .executeTakeFirstOrThrow();

    await postOutbox?.(transaction, {
      revision: revisionRow.revision,
      outboxEvent,
    });

    return {
      revision: revisionRow.revision,
      result,
      outboxEvent,
    };
  });
}

/**
 * Runs a revision-aware mutation in one SQLite transaction while allowing a
 * verified no-op to return the existing revision without allocating an outbox
 * event. The callback must perform all reads used to decide `changed` through
 * the supplied transaction and must not write before returning `changed: false`.
 */
export async function commitConditionalStateChange<
  const Mutation extends {
    readonly changed: boolean;
    readonly result: ConditionalStateMutationValue;
  },
>(
  database: Kysely<StateDatabaseSchema>,
  event: ConditionalStateChangeEvent<Mutation["result"]>,
  mutate: (
    transaction: StateDatabaseTransaction,
    currentRevision: number,
  ) => Promise<Mutation>,
  postOutbox?: StateChangePostOutboxHook,
  operatorGuard?: OperatorConcurrencyGuard,
): Promise<ConditionalCommittedStateChange<Mutation["result"]>> {
  const expectedOperatorRevision =
    operatorGuard === undefined
      ? null
      : nonnegativeSafeIntegerSchema.parse(operatorGuard.expectedRevision);
  return database.transaction().execute(async (transaction) => {
    const lockedOperatorFloor =
      operatorGuard === undefined
        ? null
        : await acquireOperatorConcurrencyFloor(transaction);
    const currentRevisionRow = await transaction
      .selectFrom("state_revisions")
      .select("revision")
      .orderBy("revision", "desc")
      .limit(1)
      .executeTakeFirst();
    const currentRevision = currentRevisionRow?.revision ?? 0;
    if (lockedOperatorFloor !== null && operatorGuard !== undefined) {
      if (lockedOperatorFloor > currentRevision) {
        throw new Error(
          `Operator concurrency floor ${lockedOperatorFloor} exceeds current state revision ${currentRevision}`,
        );
      }
      if (
        expectedOperatorRevision === null ||
        expectedOperatorRevision < lockedOperatorFloor ||
        expectedOperatorRevision > currentRevision
      ) {
        throw operatorGuard.conflictError(
          operatorGuard.expectedRevision,
          currentRevision,
        );
      }
    }
    const mutation = await mutate(transaction, currentRevision);
    if (!mutation.changed) {
      return {
        changed: false,
        revision: currentRevision,
        result: mutation.result,
        outboxEvent: null,
      };
    }

    const resolvedEvent =
      typeof event === "function" ? event(mutation.result) : event;
    const validatedEvent = validateStateChangeEvent(resolvedEvent);

    const revisionRow = await transaction
      .insertInto("state_revisions")
      .values({
        committed_at_ms: resolvedEvent.occurredAtMs,
        actor: resolvedEvent.actor,
        mutation_type: resolvedEvent.mutationType,
        summary: resolvedEvent.summary,
      })
      .returning("revision")
      .executeTakeFirstOrThrow();
    await transaction
      .insertInto("state_outbox")
      .values({
        revision: revisionRow.revision,
        event_type: resolvedEvent.eventType,
        entity_type: resolvedEvent.entityType,
        entity_id: resolvedEvent.entityId ?? null,
        occurred_at_ms: resolvedEvent.occurredAtMs,
        retention_class: resolvedEvent.retentionClass,
        payload_json: validatedEvent.payloadJson,
        payload_schema_version: STATE_OUTBOX_ENVELOPE_SCHEMA_VERSION,
        available_at_ms: validatedEvent.availableAtMs,
      })
      .executeTakeFirstOrThrow();
    const outboxEvent = await transaction
      .selectFrom("state_outbox")
      .selectAll()
      .where("revision", "=", revisionRow.revision)
      .executeTakeFirstOrThrow();
    if (lockedOperatorFloor !== null) {
      await advanceOperatorConcurrencyFloor(
        transaction,
        lockedOperatorFloor,
        revisionRow.revision,
      );
    }
    await postOutbox?.(transaction, {
      revision: revisionRow.revision,
      outboxEvent,
    });
    return {
      changed: true,
      revision: revisionRow.revision,
      result: mutation.result,
      outboxEvent,
    };
  });
}

export async function acquireOperatorConcurrencyFloor(
  transaction: StateDatabaseTransaction,
): Promise<number> {
  const singleton = await transaction
    .updateTable("operator_concurrency")
    .set({
      last_operator_revision: sql<number>`last_operator_revision`,
    })
    .where("singleton_key", "=", 1)
    .returning("last_operator_revision")
    .executeTakeFirst();
  if (singleton === undefined) {
    throw new Error("Operator concurrency singleton is missing");
  }
  return nonnegativeSafeIntegerSchema.parse(singleton.last_operator_revision);
}

export async function advanceOperatorConcurrencyFloor(
  transaction: StateDatabaseTransaction,
  lockedFloor: number,
  revision: number,
): Promise<void> {
  const parsedLockedFloor = nonnegativeSafeIntegerSchema.parse(lockedFloor);
  const parsedRevision = nonnegativeSafeIntegerSchema.parse(revision);
  if (parsedRevision <= parsedLockedFloor) {
    throw new RangeError(
      "Operator concurrency revision must advance beyond its locked floor",
    );
  }
  const update = await transaction
    .updateTable("operator_concurrency")
    .set({ last_operator_revision: parsedRevision })
    .where("singleton_key", "=", 1)
    .where("last_operator_revision", "=", parsedLockedFloor)
    .executeTakeFirst();
  if (update.numUpdatedRows !== 1n) {
    throw new Error("Operator concurrency singleton changed during mutation");
  }
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
  toCommittedStateEvent(outboxEvent);
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
    .orderBy("revision", "asc")
    .limit(batchSize)
    .execute();
  const mirroredRevisions: number[] = [];

  for (const outboxEvent of pendingEvents) {
    if (outboxEvent.available_at_ms > options.nowMs) {
      break;
    }
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
