import type { Migration } from "kysely/migration";

import { executeSqlStatements } from "./migration-utils.js";

const eventsSchemaStatements = [
  `CREATE TABLE state_events (
    revision INTEGER PRIMARY KEY NOT NULL CHECK (revision > 0),
    occurred_at_ms INTEGER NOT NULL CHECK (occurred_at_ms >= 0),
    event_type TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id TEXT,
    retention_class TEXT NOT NULL CHECK (retention_class IN ('critical', 'audit', 'operational', 'raw', 'aggregate')),
    payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
    payload_schema_version INTEGER NOT NULL CHECK (payload_schema_version > 0),
    byte_count INTEGER NOT NULL CHECK (byte_count >= 0),
    CHECK (length(event_type) > 0),
    CHECK (length(entity_type) > 0)
  ) STRICT`,
  `CREATE TABLE interactions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    occurred_at_ms INTEGER NOT NULL CHECK (occurred_at_ms >= 0),
    direction TEXT NOT NULL CHECK (direction IN ('inbound', 'outbound', 'internal')),
    kind TEXT NOT NULL,
    severity TEXT NOT NULL CHECK (severity IN ('debug', 'info', 'warning', 'error', 'critical')),
    topic TEXT,
    device_id TEXT,
    correlation_id TEXT,
    operation_id TEXT,
    outcome TEXT NOT NULL CHECK (
      outcome IN ('pending', 'succeeded', 'failed', 'timed_out', 'outcome_unknown', 'ignored')
    ),
    duration_ms INTEGER CHECK (duration_ms IS NULL OR duration_ms >= 0),
    byte_count INTEGER NOT NULL CHECK (byte_count >= 0),
    retention_class TEXT NOT NULL CHECK (retention_class IN ('critical', 'audit', 'operational', 'raw', 'aggregate')),
    payload_json TEXT,
    payload_schema_version INTEGER,
    payload_sha256 TEXT CHECK (payload_sha256 IS NULL OR length(payload_sha256) = 64),
    CHECK (length(kind) > 0),
    CHECK (
      (payload_json IS NULL AND payload_schema_version IS NULL) OR
      (payload_json IS NOT NULL AND payload_schema_version IS NOT NULL AND payload_schema_version > 0 AND json_valid(payload_json))
    )
  ) STRICT`,
  `CREATE TABLE event_aggregates (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    bucket_start_ms INTEGER NOT NULL CHECK (bucket_start_ms >= 0),
    bucket_end_ms INTEGER NOT NULL CHECK (bucket_end_ms > bucket_start_ms),
    kind TEXT NOT NULL,
    device_id TEXT,
    outcome TEXT NOT NULL CHECK (
      outcome IN ('pending', 'succeeded', 'failed', 'timed_out', 'outcome_unknown', 'ignored')
    ),
    event_count INTEGER NOT NULL CHECK (event_count > 0),
    error_count INTEGER NOT NULL CHECK (error_count BETWEEN 0 AND event_count),
    byte_count INTEGER NOT NULL CHECK (byte_count >= 0),
    latency_total_ms INTEGER NOT NULL CHECK (latency_total_ms >= 0),
    latency_min_ms INTEGER CHECK (latency_min_ms IS NULL OR latency_min_ms >= 0),
    latency_max_ms INTEGER CHECK (latency_max_ms IS NULL OR latency_max_ms >= 0),
    retention_class TEXT NOT NULL CHECK (retention_class IN ('critical', 'audit', 'operational', 'raw', 'aggregate')),
    details_json TEXT,
    details_schema_version INTEGER,
    CHECK (length(kind) > 0),
    CHECK (latency_min_ms IS NULL OR latency_max_ms IS NULL OR latency_max_ms >= latency_min_ms),
    CHECK (
      (details_json IS NULL AND details_schema_version IS NULL) OR
      (details_json IS NOT NULL AND details_schema_version IS NOT NULL AND details_schema_version > 0 AND json_valid(details_json))
    )
  ) STRICT`,
  `CREATE TABLE event_archives (
    id TEXT PRIMARY KEY NOT NULL,
    range_start_ms INTEGER NOT NULL CHECK (range_start_ms >= 0),
    range_end_ms INTEGER NOT NULL CHECK (range_end_ms > range_start_ms),
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= range_end_ms),
    codec TEXT NOT NULL CHECK (codec = 'zstd'),
    storage_path TEXT NOT NULL,
    sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
    event_count INTEGER NOT NULL CHECK (event_count >= 0),
    uncompressed_bytes INTEGER NOT NULL CHECK (uncompressed_bytes >= 0),
    compressed_bytes INTEGER NOT NULL CHECK (compressed_bytes >= 0),
    status TEXT NOT NULL CHECK (status IN ('pending', 'complete', 'failed')),
    metadata_json TEXT,
    metadata_schema_version INTEGER,
    CHECK (length(id) > 0),
    CHECK (length(storage_path) > 0),
    CHECK (
      (metadata_json IS NULL AND metadata_schema_version IS NULL) OR
      (metadata_json IS NOT NULL AND metadata_schema_version IS NOT NULL AND metadata_schema_version > 0 AND json_valid(metadata_json))
    )
  ) STRICT`,
  `CREATE TABLE retention_policies (
    retention_class TEXT PRIMARY KEY NOT NULL CHECK (
      retention_class IN ('critical', 'audit', 'operational', 'raw', 'aggregate')
    ),
    retain_for_ms INTEGER NOT NULL CHECK (retain_for_ms > 0),
    byte_budget INTEGER NOT NULL CHECK (byte_budget > 0),
    archive_before_delete INTEGER NOT NULL CHECK (archive_before_delete IN (0, 1)),
    priority INTEGER NOT NULL CHECK (priority >= 0),
    enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
    updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= 0)
  ) STRICT`,
  `CREATE TABLE retention_runs (
    id TEXT PRIMARY KEY NOT NULL,
    started_at_ms INTEGER NOT NULL CHECK (started_at_ms >= 0),
    completed_at_ms INTEGER CHECK (completed_at_ms IS NULL OR completed_at_ms >= started_at_ms),
    status TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed')),
    bytes_before INTEGER NOT NULL CHECK (bytes_before >= 0),
    bytes_after INTEGER CHECK (bytes_after IS NULL OR bytes_after >= 0),
    interactions_deleted INTEGER NOT NULL DEFAULT 0 CHECK (interactions_deleted >= 0),
    aggregates_deleted INTEGER NOT NULL DEFAULT 0 CHECK (aggregates_deleted >= 0),
    archives_created INTEGER NOT NULL DEFAULT 0 CHECK (archives_created >= 0),
    error_json TEXT,
    error_schema_version INTEGER,
    CHECK (length(id) > 0),
    CHECK (
      (error_json IS NULL AND error_schema_version IS NULL) OR
      (error_json IS NOT NULL AND error_schema_version IS NOT NULL AND error_schema_version > 0 AND json_valid(error_json))
    )
  ) STRICT`,
] as const;

const eventsIndexStatements = [
  "CREATE INDEX state_events_occurred_idx ON state_events(occurred_at_ms, revision)",
  "CREATE INDEX state_events_entity_idx ON state_events(entity_type, entity_id, revision)",
  "CREATE INDEX state_events_retention_idx ON state_events(retention_class, occurred_at_ms)",
  "CREATE INDEX interactions_occurred_idx ON interactions(occurred_at_ms, id)",
  "CREATE INDEX interactions_device_occurred_idx ON interactions(device_id, occurred_at_ms DESC)",
  "CREATE INDEX interactions_kind_outcome_idx ON interactions(kind, outcome, occurred_at_ms DESC)",
  "CREATE INDEX interactions_operation_idx ON interactions(operation_id, occurred_at_ms)",
  "CREATE INDEX interactions_correlation_idx ON interactions(correlation_id, occurred_at_ms)",
  "CREATE INDEX interactions_retention_idx ON interactions(retention_class, occurred_at_ms, id)",
  "CREATE UNIQUE INDEX event_aggregates_bucket_key_idx ON event_aggregates(bucket_start_ms, bucket_end_ms, kind, IFNULL(device_id, ''), outcome)",
  "CREATE INDEX event_aggregates_retention_idx ON event_aggregates(retention_class, bucket_end_ms)",
  "CREATE INDEX event_archives_range_idx ON event_archives(range_start_ms, range_end_ms)",
  "CREATE INDEX event_archives_status_idx ON event_archives(status, created_at_ms)",
  "CREATE INDEX retention_policies_priority_idx ON retention_policies(enabled, priority)",
  "CREATE INDEX retention_runs_started_idx ON retention_runs(started_at_ms DESC)",
] as const;

const eventsDropStatements = [
  "DROP TABLE IF EXISTS retention_runs",
  "DROP TABLE IF EXISTS retention_policies",
  "DROP TABLE IF EXISTS event_archives",
  "DROP TABLE IF EXISTS event_aggregates",
  "DROP TABLE IF EXISTS interactions",
  "DROP TABLE IF EXISTS state_events",
] as const;

export const eventsInitialMigration: Migration = {
  async up(database): Promise<void> {
    await executeSqlStatements(database, eventsSchemaStatements);
    await executeSqlStatements(database, eventsIndexStatements);
  },
  async down(database): Promise<void> {
    await executeSqlStatements(database, eventsDropStatements);
  },
};
