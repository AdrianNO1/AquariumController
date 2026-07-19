import {
  nonnegativeSafeIntegerSchema,
  stateInvalidationSchema,
} from "@aquarium/contracts";
import type { Kysely } from "kysely";
import type { Migration } from "kysely/migration";

import { executeSqlStatements } from "./migration-utils.js";
import {
  parseStoredStateOutboxEnvelope,
  serializeStateOutboxEnvelope,
  STATE_OUTBOX_ENVELOPE_SCHEMA_VERSION,
  toCommittedStateEvent,
} from "./state-outbox.js";
import type { StateDatabaseSchema } from "./types.js";

const stateOutboxEnvelopeDownStatements = [
  `UPDATE state_outbox
  SET
    payload_schema_version = json_extract(
      payload_json,
      '$.details.schemaVersion'
    ),
    payload_json = payload_json -> '$.details.data'`,
] as const;

async function migrateStateOutboxEnvelopeUp(
  database: Kysely<StateDatabaseSchema>,
): Promise<void> {
  const rows = await database
    .selectFrom("state_outbox")
    .selectAll()
    .orderBy("revision", "asc")
    .execute();
  const updates = rows.map((row) => {
    try {
      nonnegativeSafeIntegerSchema.parse(row.delivery_attempts);
      nonnegativeSafeIntegerSchema.parse(row.available_at_ms);
      if (row.published_at_ms !== null) {
        nonnegativeSafeIntegerSchema.parse(row.published_at_ms);
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
      toCommittedStateEvent({
        ...row,
        payload_json: payloadJson,
        payload_schema_version: STATE_OUTBOX_ENVELOPE_SCHEMA_VERSION,
      });
      return { revision: row.revision, payloadJson };
    } catch (error) {
      throw new Error(
        `State outbox revision ${row.revision} cannot be upgraded to the versioned wire envelope`,
        { cause: error },
      );
    }
  });

  for (const update of updates) {
    await database
      .updateTable("state_outbox")
      .set({
        payload_json: update.payloadJson,
        payload_schema_version: STATE_OUTBOX_ENVELOPE_SCHEMA_VERSION,
      })
      .where("revision", "=", update.revision)
      .executeTakeFirstOrThrow();
  }
}

async function validateStateOutboxEnvelopeDown(
  database: Kysely<StateDatabaseSchema>,
): Promise<void> {
  const rows = await database
    .selectFrom("state_outbox")
    .selectAll()
    .orderBy("revision", "asc")
    .execute();
  for (const row of rows) {
    parseStoredStateOutboxEnvelope(row);
    toCommittedStateEvent(row);
  }
}

const runtimeStateSchemaStatements = [
  `CREATE TABLE device_schedule_artifacts (
    device_id TEXT PRIMARY KEY NOT NULL REFERENCES devices(id) ON UPDATE CASCADE ON DELETE CASCADE,
    source_state_revision INTEGER NOT NULL CHECK (source_state_revision BETWEEN 0 AND 9007199254740991),
    compile_status TEXT NOT NULL CHECK (compile_status IN ('succeeded', 'failed')),
    desired_schedule_hash TEXT COLLATE BINARY,
    compiled_payload_json TEXT,
    compiled_payload_schema_version INTEGER,
    byte_count INTEGER,
    delivery_status TEXT NOT NULL DEFAULT 'not_required' CHECK (
      delivery_status IN ('not_required', 'pending', 'in_flight', 'succeeded', 'failed', 'timed_out', 'outcome_unknown', 'unsupported')
    ),
    last_delivery_operation_id TEXT REFERENCES control_operations(id) ON UPDATE CASCADE ON DELETE RESTRICT,
    compile_error_code TEXT,
    compile_error_message TEXT,
    delivery_error_code TEXT,
    delivery_error_message TEXT,
    compiled_at_ms INTEGER NOT NULL CHECK (compiled_at_ms BETWEEN 0 AND 8640000000000000),
    delivery_updated_at_ms INTEGER NOT NULL CHECK (delivery_updated_at_ms BETWEEN compiled_at_ms AND 8640000000000000),
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms BETWEEN 0 AND 8640000000000000),
    updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms BETWEEN created_at_ms AND 8640000000000000),
    CHECK (
      (
        compile_status = 'succeeded' AND
        desired_schedule_hash IS NOT NULL AND
        length(desired_schedule_hash) BETWEEN 1 AND 10 AND
        desired_schedule_hash NOT GLOB '*[^0-9]*' AND
        (desired_schedule_hash = '0' OR substr(desired_schedule_hash, 1, 1) != '0') AND
        (length(desired_schedule_hash) < 10 OR desired_schedule_hash <= '4294967295') AND
        compiled_payload_json IS NOT NULL AND
        json_valid(compiled_payload_json) AND
        compiled_payload_schema_version IS NOT NULL AND
        compiled_payload_schema_version > 0 AND
        byte_count IS NOT NULL AND
        byte_count BETWEEN 1 AND 4095 AND
        compile_error_code IS NULL AND
        compile_error_message IS NULL
      ) OR
      (
        compile_status = 'failed' AND
        desired_schedule_hash IS NULL AND
        compiled_payload_json IS NULL AND
        compiled_payload_schema_version IS NULL AND
        byte_count IS NULL AND
        compile_error_code IS NOT NULL AND
        compile_error_message IS NOT NULL AND
        length(compile_error_code) > 0 AND
        length(compile_error_message) > 0 AND
        delivery_status = 'not_required' AND
        last_delivery_operation_id IS NULL
      )
    ),
    CHECK (
      (delivery_status IN ('not_required', 'unsupported') AND last_delivery_operation_id IS NULL) OR
      (delivery_status NOT IN ('not_required', 'unsupported') AND last_delivery_operation_id IS NOT NULL)
    ),
    CHECK (
      (
        delivery_status IN ('failed', 'timed_out', 'outcome_unknown', 'unsupported') AND
        delivery_error_code IS NOT NULL AND
        delivery_error_message IS NOT NULL AND
        length(delivery_error_code) > 0 AND
        length(delivery_error_message) > 0
      ) OR
      (
        delivery_status NOT IN ('failed', 'timed_out', 'outcome_unknown', 'unsupported') AND
        delivery_error_code IS NULL AND
        delivery_error_message IS NULL
      )
    ),
    CHECK (compiled_at_ms BETWEEN created_at_ms AND updated_at_ms),
    CHECK (delivery_updated_at_ms BETWEEN compiled_at_ms AND updated_at_ms)
  ) STRICT`,
  `CREATE TABLE scheduler_guards (
    job_key TEXT NOT NULL COLLATE BINARY,
    scope_key TEXT NOT NULL COLLATE BINARY,
    last_started_utc_day_start_ms INTEGER,
    last_started_at_ms INTEGER,
    last_operation_id TEXT REFERENCES control_operations(id) ON UPDATE CASCADE ON DELETE RESTRICT,
    last_success_utc_day_start_ms INTEGER,
    last_success_at_ms INTEGER,
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms BETWEEN 0 AND 8640000000000000),
    updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms BETWEEN created_at_ms AND 8640000000000000),
    PRIMARY KEY (job_key, scope_key),
    CHECK (length(job_key) BETWEEN 1 AND 128),
    CHECK (length(scope_key) BETWEEN 1 AND 256),
    CHECK (
      (last_started_utc_day_start_ms IS NULL AND last_started_at_ms IS NULL AND last_operation_id IS NULL) OR
      (
        last_started_utc_day_start_ms IS NOT NULL AND
        last_started_at_ms IS NOT NULL AND
        last_started_utc_day_start_ms BETWEEN 0 AND 8640000000000000 AND
        last_started_utc_day_start_ms % 86400000 = 0 AND
        last_started_at_ms >= last_started_utc_day_start_ms AND
        last_started_at_ms < last_started_utc_day_start_ms + 86400000
      )
    ),
    CHECK (
      (last_success_utc_day_start_ms IS NULL AND last_success_at_ms IS NULL) OR
      (
        last_success_utc_day_start_ms IS NOT NULL AND
        last_success_at_ms IS NOT NULL AND
        last_success_utc_day_start_ms BETWEEN 0 AND 8640000000000000 AND
        last_success_utc_day_start_ms % 86400000 = 0 AND
        last_success_at_ms >= last_success_utc_day_start_ms AND
        last_success_at_ms < last_success_utc_day_start_ms + 86400000
      )
    ),
    CHECK (last_started_at_ms IS NULL OR last_started_at_ms <= updated_at_ms),
    CHECK (last_success_at_ms IS NULL OR last_success_at_ms <= updated_at_ms)
  ) STRICT`,
  `CREATE TABLE alert_condition_states (
    alert_rule_id TEXT NOT NULL REFERENCES alert_rules(id) ON UPDATE CASCADE ON DELETE CASCADE,
    deduplication_key TEXT NOT NULL COLLATE BINARY,
    source_type TEXT NOT NULL CHECK (source_type IN ('device', 'output', 'sensor', 'switch')),
    source_id TEXT NOT NULL COLLATE BINARY,
    pending_since_ms INTEGER NOT NULL CHECK (pending_since_ms BETWEEN 0 AND 8640000000000000),
    last_observed_at_ms INTEGER NOT NULL CHECK (last_observed_at_ms BETWEEN pending_since_ms AND 8640000000000000),
    observation_json TEXT NOT NULL CHECK (json_valid(observation_json)),
    observation_schema_version INTEGER NOT NULL CHECK (observation_schema_version > 0),
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms BETWEEN 0 AND 8640000000000000),
    updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms BETWEEN created_at_ms AND 8640000000000000),
    PRIMARY KEY (alert_rule_id, deduplication_key),
    CHECK (length(deduplication_key) BETWEEN 1 AND 256),
    CHECK (length(source_id) BETWEEN 1 AND 256),
    CHECK (pending_since_ms <= created_at_ms),
    CHECK (last_observed_at_ms <= updated_at_ms)
  ) STRICT`,
  `CREATE TABLE notification_deliveries (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    alert_transition_revision INTEGER NOT NULL CHECK (alert_transition_revision > 0) REFERENCES state_revisions(revision) ON UPDATE CASCADE ON DELETE RESTRICT,
    alert_id TEXT NOT NULL REFERENCES active_alerts(id) ON UPDATE CASCADE ON DELETE RESTRICT,
    transition TEXT NOT NULL CHECK (transition IN ('opened', 'acknowledged', 'recovered', 'reopened')),
    destination_kind TEXT NOT NULL CHECK (destination_kind = 'webhook'),
    destination_key TEXT NOT NULL COLLATE BINARY,
    deduplication_key TEXT NOT NULL COLLATE BINARY UNIQUE,
    status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'attempting', 'delivered', 'failed', 'outcome_unknown')),
    attempt_count INTEGER NOT NULL DEFAULT 0 CHECK (attempt_count BETWEEN 0 AND 1),
    notification_json TEXT NOT NULL CHECK (json_valid(notification_json)),
    notification_schema_version INTEGER NOT NULL CHECK (notification_schema_version > 0),
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms BETWEEN 0 AND 8640000000000000),
    attempt_started_at_ms INTEGER,
    completed_at_ms INTEGER,
    updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms BETWEEN created_at_ms AND 8640000000000000),
    last_error_code TEXT,
    last_error_message TEXT,
    UNIQUE (alert_transition_revision, destination_key),
    CHECK (length(alert_id) > 0),
    CHECK (length(destination_key) BETWEEN 1 AND 128),
    CHECK (length(deduplication_key) BETWEEN 1 AND 256),
    CHECK (
      (
        status = 'pending' AND
        attempt_count = 0 AND
        attempt_started_at_ms IS NULL AND
        completed_at_ms IS NULL AND
        last_error_code IS NULL AND
        last_error_message IS NULL
      ) OR
      (
        status = 'attempting' AND
        attempt_count = 1 AND
        attempt_started_at_ms IS NOT NULL AND
        attempt_started_at_ms BETWEEN created_at_ms AND updated_at_ms AND
        completed_at_ms IS NULL AND
        last_error_code IS NULL AND
        last_error_message IS NULL
      ) OR
      (
        status = 'delivered' AND
        attempt_count = 1 AND
        attempt_started_at_ms IS NOT NULL AND
        completed_at_ms IS NOT NULL AND
        attempt_started_at_ms BETWEEN created_at_ms AND completed_at_ms AND
        completed_at_ms <= updated_at_ms AND
        last_error_code IS NULL AND
        last_error_message IS NULL
      ) OR
      (
        status IN ('failed', 'outcome_unknown') AND
        attempt_count = 1 AND
        attempt_started_at_ms IS NOT NULL AND
        completed_at_ms IS NOT NULL AND
        attempt_started_at_ms BETWEEN created_at_ms AND completed_at_ms AND
        completed_at_ms <= updated_at_ms AND
        last_error_code IS NOT NULL AND
        last_error_message IS NOT NULL AND
        length(last_error_code) > 0 AND
        length(last_error_message) > 0
      )
    )
  ) STRICT`,
] as const;

const runtimeStateIndexStatements = [
  "CREATE INDEX device_schedule_artifacts_delivery_idx ON device_schedule_artifacts(delivery_status, updated_at_ms, device_id)",
  "CREATE INDEX device_schedule_artifacts_source_revision_idx ON device_schedule_artifacts(source_state_revision, device_id)",
  "CREATE INDEX devices_schedule_reconciliation_idx ON devices(enabled, reported_schedule_hash, id)",
  "CREATE INDEX scheduler_guards_started_idx ON scheduler_guards(job_key, last_started_utc_day_start_ms, scope_key)",
  "CREATE INDEX alert_condition_states_due_idx ON alert_condition_states(pending_since_ms, alert_rule_id, deduplication_key)",
  "CREATE INDEX alert_condition_states_source_idx ON alert_condition_states(source_type, source_id, last_observed_at_ms, alert_rule_id)",
  "CREATE INDEX notification_deliveries_status_idx ON notification_deliveries(status, created_at_ms, id)",
  "CREATE INDEX notification_deliveries_alert_idx ON notification_deliveries(alert_id, created_at_ms DESC, id DESC)",
  "CREATE INDEX alert_rules_device_lookup_idx ON alert_rules(device_id, id) WHERE source_type = 'device'",
  "CREATE INDEX alert_rules_output_lookup_idx ON alert_rules(output_id, id) WHERE source_type = 'output'",
  "CREATE INDEX alert_rules_sensor_lookup_idx ON alert_rules(sensor_id, id) WHERE source_type = 'sensor'",
  "CREATE INDEX alert_rules_switch_lookup_idx ON alert_rules(switch_id, id) WHERE source_type = 'switch'",
  "CREATE INDEX control_operations_recent_idx ON control_operations(requested_at_ms DESC, id)",
  "CREATE INDEX active_alerts_state_cursor_idx ON active_alerts(state, last_observed_at_ms DESC, id)",
] as const;

const runtimeStateDropStatements = [
  "DROP INDEX IF EXISTS active_alerts_state_cursor_idx",
  "DROP INDEX IF EXISTS control_operations_recent_idx",
  "DROP INDEX IF EXISTS alert_rules_switch_lookup_idx",
  "DROP INDEX IF EXISTS alert_rules_sensor_lookup_idx",
  "DROP INDEX IF EXISTS alert_rules_output_lookup_idx",
  "DROP INDEX IF EXISTS alert_rules_device_lookup_idx",
  "DROP TABLE IF EXISTS notification_deliveries",
  "DROP TABLE IF EXISTS alert_condition_states",
  "DROP TABLE IF EXISTS scheduler_guards",
  "DROP INDEX IF EXISTS devices_schedule_reconciliation_idx",
  "DROP TABLE IF EXISTS device_schedule_artifacts",
] as const;

export const stateRuntimeMigration: Migration = {
  async up(database): Promise<void> {
    await migrateStateOutboxEnvelopeUp(database as Kysely<StateDatabaseSchema>);
    await executeSqlStatements(database, runtimeStateSchemaStatements);
    await executeSqlStatements(database, runtimeStateIndexStatements);
  },
  async down(database): Promise<void> {
    await validateStateOutboxEnvelopeDown(
      database as Kysely<StateDatabaseSchema>,
    );
    await executeSqlStatements(database, stateOutboxEnvelopeDownStatements);
    await executeSqlStatements(database, runtimeStateDropStatements);
  },
};
