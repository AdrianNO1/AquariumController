import { createHash } from "node:crypto";

import {
  logEntrySchema,
  logPayloadSchema,
  nonnegativeSafeIntegerSchema,
  stateInvalidationSchema,
} from "@aquarium/contracts";
import type { Kysely } from "kysely";
import type { Migration } from "kysely/migration";

import { parseJsonDocument } from "../import/strict-json.js";
import { executeSqlStatements } from "./migration-utils.js";
import {
  parseStoredStateOutboxEnvelope,
  serializeStateOutboxEnvelope,
  STATE_OUTBOX_ENVELOPE_SCHEMA_VERSION,
  toCommittedStateEvent,
} from "./state-outbox.js";
import type { EventsDatabaseSchema } from "./types.js";

const stateEventsEnvelopeDownStatements = [
  `UPDATE state_events
  SET
    payload_schema_version = json_extract(
      payload_json,
      '$.details.schemaVersion'
    ),
    payload_json = payload_json -> '$.details.data'`,
  `UPDATE state_events
  SET byte_count = length(CAST(payload_json AS BLOB))`,
] as const;

interface StateEventEnvelopeUpdate {
  readonly revision: number;
  readonly payloadJson: string;
  readonly byteCount: number;
}

async function prepareStateEventEnvelopeUpdates(
  database: Kysely<EventsDatabaseSchema>,
): Promise<readonly StateEventEnvelopeUpdate[]> {
  const rows = await database
    .selectFrom("state_events")
    .selectAll()
    .orderBy("revision", "asc")
    .execute();
  return rows.map((row) => {
    try {
      nonnegativeSafeIntegerSchema.parse(row.byte_count);
      const originalByteCount = new TextEncoder().encode(
        row.payload_json,
      ).byteLength;
      if (row.byte_count !== originalByteCount) {
        throw new Error("stored byte count does not match the legacy payload");
      }
      const primary = stateInvalidationSchema.parse({
        resource: row.entity_type,
        id: row.entity_id,
      });
      const payloadJson = serializeStateOutboxEnvelope(
        row.payload_json,
        row.payload_schema_version,
        [primary],
      );
      const byteCount = new TextEncoder().encode(payloadJson).byteLength;
      toCommittedStateEvent({
        ...row,
        payload_json: payloadJson,
        payload_schema_version: STATE_OUTBOX_ENVELOPE_SCHEMA_VERSION,
      });
      return { revision: row.revision, payloadJson, byteCount };
    } catch (error) {
      throw new Error(
        `State event revision ${row.revision} cannot be upgraded to the versioned wire envelope`,
        { cause: error },
      );
    }
  });
}

async function applyStateEventEnvelopeUpdates(
  database: Kysely<EventsDatabaseSchema>,
  updates: readonly StateEventEnvelopeUpdate[],
): Promise<void> {
  for (const update of updates) {
    await database
      .updateTable("state_events")
      .set({
        payload_json: update.payloadJson,
        payload_schema_version: STATE_OUTBOX_ENVELOPE_SCHEMA_VERSION,
        byte_count: update.byteCount,
      })
      .where("revision", "=", update.revision)
      .executeTakeFirstOrThrow();
  }
}

async function validateStoredInteractions(
  database: Kysely<EventsDatabaseSchema>,
): Promise<void> {
  const rows = await database
    .selectFrom("interactions")
    .selectAll()
    .orderBy("id", "asc")
    .execute();
  for (const row of rows) {
    try {
      const payloadFields = [
        row.payload_json,
        row.payload_schema_version,
        row.payload_sha256,
      ];
      const populatedCount = payloadFields.filter(
        (field) => field !== null,
      ).length;
      if (populatedCount !== 0 && populatedCount !== payloadFields.length) {
        throw new Error(
          "payload JSON, schema version, and SHA-256 must be present together",
        );
      }

      let payload: ReturnType<typeof logPayloadSchema.parse> | null = null;
      if (row.payload_json !== null) {
        const document = parseJsonDocument(
          row.payload_json,
          `interaction ${row.id} payload`,
        );
        if (document.duplicateKeys.length > 0) {
          throw new Error("payload contains duplicate JSON keys");
        }
        payload = logPayloadSchema.parse(document.value);
        const actualSha256 = createHash("sha256")
          .update(row.payload_json, "utf8")
          .digest("hex");
        if (row.payload_sha256 !== actualSha256) {
          throw new Error("payload SHA-256 does not match the stored JSON");
        }
      }

      logEntrySchema.parse({
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
    } catch (error) {
      throw new Error(
        `Stored interaction ${row.id} is outside the public log boundary`,
        { cause: error },
      );
    }
  }
}

async function validateStateEventEnvelopeDown(
  database: Kysely<EventsDatabaseSchema>,
): Promise<void> {
  const rows = await database
    .selectFrom("state_events")
    .selectAll()
    .orderBy("revision", "asc")
    .execute();
  for (const row of rows) {
    parseStoredStateOutboxEnvelope(row);
    toCommittedStateEvent(row);
  }
}

const eventQueryIndexStatements = [
  "CREATE INDEX interactions_direction_cursor_idx ON interactions(direction, occurred_at_ms DESC, id DESC)",
  "CREATE INDEX interactions_severity_cursor_idx ON interactions(severity, occurred_at_ms DESC, id DESC)",
  "CREATE INDEX interactions_kind_cursor_idx ON interactions(kind, occurred_at_ms DESC, id DESC)",
  "CREATE INDEX interactions_outcome_cursor_idx ON interactions(outcome, occurred_at_ms DESC, id DESC)",
  "CREATE INDEX interactions_device_cursor_idx ON interactions(device_id, occurred_at_ms DESC, id DESC) WHERE device_id IS NOT NULL",
  "CREATE INDEX interactions_operation_cursor_idx ON interactions(operation_id, occurred_at_ms DESC, id DESC) WHERE operation_id IS NOT NULL",
  "CREATE INDEX interactions_correlation_cursor_idx ON interactions(correlation_id, occurred_at_ms DESC, id DESC) WHERE correlation_id IS NOT NULL",
] as const;

const eventQueryIndexDropStatements = [
  "DROP INDEX IF EXISTS interactions_correlation_cursor_idx",
  "DROP INDEX IF EXISTS interactions_operation_cursor_idx",
  "DROP INDEX IF EXISTS interactions_device_cursor_idx",
  "DROP INDEX IF EXISTS interactions_outcome_cursor_idx",
  "DROP INDEX IF EXISTS interactions_kind_cursor_idx",
  "DROP INDEX IF EXISTS interactions_severity_cursor_idx",
  "DROP INDEX IF EXISTS interactions_direction_cursor_idx",
] as const;

export const eventsQueryMigration: Migration = {
  async up(database): Promise<void> {
    const eventsDatabase = database as Kysely<EventsDatabaseSchema>;
    const envelopeUpdates =
      await prepareStateEventEnvelopeUpdates(eventsDatabase);
    await validateStoredInteractions(eventsDatabase);
    await applyStateEventEnvelopeUpdates(eventsDatabase, envelopeUpdates);
    await executeSqlStatements(database, eventQueryIndexStatements);
  },
  async down(database): Promise<void> {
    await validateStateEventEnvelopeDown(
      database as Kysely<EventsDatabaseSchema>,
    );
    await executeSqlStatements(database, stateEventsEnvelopeDownStatements);
    await executeSqlStatements(database, eventQueryIndexDropStatements);
  },
};
