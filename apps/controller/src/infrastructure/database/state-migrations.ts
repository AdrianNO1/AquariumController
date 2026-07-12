import type { Migration } from "kysely/migration";

import { executeSqlStatements } from "./migration-utils.js";

const stateSchemaStatements = [
  `CREATE TABLE mapping_profiles (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL COLLATE BINARY UNIQUE,
    device_name_prefix TEXT NOT NULL COLLATE BINARY UNIQUE,
    output_gain REAL NOT NULL DEFAULT 1.0 CHECK (output_gain BETWEEN 0.0 AND 1.0),
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
    updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
    CHECK (length(id) > 0),
    CHECK (length(name) > 0),
    CHECK (length(device_name_prefix) > 0)
  ) STRICT`,
  `CREATE TABLE devices (
    id TEXT PRIMARY KEY NOT NULL,
    hardware_id TEXT NOT NULL COLLATE BINARY UNIQUE,
    name TEXT NOT NULL COLLATE BINARY,
    mapping_profile_id TEXT REFERENCES mapping_profiles(id) ON UPDATE CASCADE ON DELETE RESTRICT,
    reported_name TEXT COLLATE BINARY,
    desired_pwm_frequency_hz INTEGER NOT NULL CHECK (desired_pwm_frequency_hz BETWEEN 1 AND 40000),
    desired_pwm_resolution_bits INTEGER NOT NULL CHECK (desired_pwm_resolution_bits BETWEEN 1 AND 16),
    reported_pwm_frequency_hz INTEGER CHECK (reported_pwm_frequency_hz IS NULL OR reported_pwm_frequency_hz BETWEEN 1 AND 40000),
    reported_pwm_resolution_bits INTEGER CHECK (reported_pwm_resolution_bits IS NULL OR reported_pwm_resolution_bits BETWEEN 1 AND 16),
    firmware_version TEXT,
    reported_schedule_hash TEXT CHECK (
      reported_schedule_hash IS NULL OR
      (length(reported_schedule_hash) > 0 AND reported_schedule_hash NOT GLOB '*[^0-9]*')
    ),
    status TEXT NOT NULL DEFAULT 'unknown' CHECK (status IN ('unknown', 'online', 'stale', 'offline', 'error')),
    last_seen_at_ms INTEGER CHECK (last_seen_at_ms IS NULL OR last_seen_at_ms >= 0),
    last_error_code TEXT,
    last_error_message TEXT,
    enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
    updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
    metadata_json TEXT,
    metadata_schema_version INTEGER,
    CHECK (length(id) > 0),
    CHECK (length(hardware_id) > 0),
    CHECK (length(name) > 0),
    CHECK (
      (metadata_json IS NULL AND metadata_schema_version IS NULL) OR
      (metadata_json IS NOT NULL AND metadata_schema_version IS NOT NULL AND metadata_schema_version > 0 AND json_valid(metadata_json))
    )
  ) STRICT`,
  `CREATE TABLE outputs (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL COLLATE BINARY UNIQUE,
    kind TEXT NOT NULL,
    display_order INTEGER NOT NULL CHECK (display_order >= 0),
    enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
    output_gain REAL NOT NULL DEFAULT 1.0 CHECK (output_gain BETWEEN 0.0 AND 1.0),
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
    updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
    CHECK (length(id) > 0),
    CHECK (length(name) > 0),
    CHECK (length(kind) > 0)
  ) STRICT`,
  `CREATE TABLE throttles (
    id TEXT PRIMARY KEY NOT NULL,
    type_key TEXT NOT NULL COLLATE BINARY UNIQUE,
    percentage REAL NOT NULL CHECK (percentage BETWEEN 0.0 AND 100.0),
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
    updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
    CHECK (length(id) > 0),
    CHECK (length(type_key) > 0)
  ) STRICT`,
  `CREATE TABLE channels (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL COLLATE BINARY UNIQUE,
    kind TEXT NOT NULL,
    throttle_id TEXT NOT NULL REFERENCES throttles(id) ON UPDATE CASCADE ON DELETE RESTRICT,
    display_order INTEGER NOT NULL CHECK (display_order >= 0),
    enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
    updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
    CHECK (length(id) > 0),
    CHECK (length(name) > 0),
    CHECK (length(kind) > 0)
  ) STRICT`,
  `CREATE TABLE pin_mappings (
    id TEXT PRIMARY KEY NOT NULL,
    mapping_profile_id TEXT NOT NULL REFERENCES mapping_profiles(id) ON UPDATE CASCADE ON DELETE CASCADE,
    output_id TEXT REFERENCES outputs(id) ON UPDATE CASCADE ON DELETE RESTRICT,
    channel_id TEXT REFERENCES channels(id) ON UPDATE CASCADE ON DELETE RESTRICT,
    pin INTEGER NOT NULL CHECK (pin BETWEEN 0 AND 63),
    display_order INTEGER NOT NULL CHECK (display_order >= 0),
    enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
    updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
    UNIQUE (mapping_profile_id, pin),
    CHECK (length(id) > 0),
    CHECK (
      (output_id IS NOT NULL AND channel_id IS NULL) OR
      (output_id IS NULL AND channel_id IS NOT NULL)
    )
  ) STRICT`,
  `CREATE TABLE schedules (
    id TEXT PRIMARY KEY NOT NULL,
    channel_id TEXT NOT NULL UNIQUE REFERENCES channels(id) ON UPDATE CASCADE ON DELETE RESTRICT,
    name TEXT NOT NULL COLLATE BINARY,
    timezone TEXT NOT NULL DEFAULT 'UTC' CHECK (timezone = 'UTC'),
    enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
    graph_revision INTEGER NOT NULL DEFAULT 0 CHECK (graph_revision >= 0),
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
    updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
    CHECK (length(id) > 0),
    CHECK (length(name) > 0)
  ) STRICT`,
  `CREATE TABLE schedule_points (
    id TEXT PRIMARY KEY NOT NULL,
    schedule_id TEXT NOT NULL REFERENCES schedules(id) ON UPDATE CASCADE ON DELETE CASCADE,
    position INTEGER NOT NULL CHECK (position >= 0),
    minute_of_day INTEGER NOT NULL CHECK (minute_of_day BETWEEN 0 AND 1439),
    percentage REAL NOT NULL CHECK (percentage BETWEEN 0.0 AND 100.0),
    editor_x REAL,
    editor_y REAL,
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
    updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
    UNIQUE (schedule_id, position),
    UNIQUE (schedule_id, minute_of_day),
    CHECK (length(id) > 0)
  ) STRICT`,
  `CREATE TABLE control_operations (
    id TEXT PRIMARY KEY NOT NULL,
    device_id TEXT REFERENCES devices(id) ON UPDATE CASCADE ON DELETE RESTRICT,
    kind TEXT NOT NULL,
    status TEXT NOT NULL CHECK (
      status IN ('pending', 'in_flight', 'succeeded', 'failed', 'timed_out', 'outcome_unknown', 'cancelled')
    ),
    requested_at_ms INTEGER NOT NULL CHECK (requested_at_ms >= 0),
    deadline_at_ms INTEGER NOT NULL CHECK (deadline_at_ms >= requested_at_ms),
    completed_at_ms INTEGER CHECK (completed_at_ms IS NULL OR completed_at_ms >= requested_at_ms),
    request_json TEXT NOT NULL CHECK (json_valid(request_json)),
    request_schema_version INTEGER NOT NULL CHECK (request_schema_version > 0),
    result_json TEXT,
    result_schema_version INTEGER,
    CHECK (length(id) > 0),
    CHECK (length(kind) > 0),
    CHECK (
      (result_json IS NULL AND result_schema_version IS NULL) OR
      (result_json IS NOT NULL AND result_schema_version IS NOT NULL AND result_schema_version > 0 AND json_valid(result_json))
    )
  ) STRICT`,
  `CREATE TABLE overrides (
    id TEXT PRIMARY KEY NOT NULL,
    channel_id TEXT REFERENCES channels(id) ON UPDATE CASCADE ON DELETE RESTRICT,
    output_id TEXT REFERENCES outputs(id) ON UPDATE CASCADE ON DELETE RESTRICT,
    value_percentage REAL NOT NULL CHECK (value_percentage BETWEEN 0.0 AND 100.0),
    status TEXT NOT NULL CHECK (status IN ('pending', 'active', 'expired', 'cancelled', 'failed')),
    requested_at_ms INTEGER NOT NULL CHECK (requested_at_ms >= 0),
    starts_at_ms INTEGER CHECK (starts_at_ms IS NULL OR starts_at_ms >= requested_at_ms),
    expires_at_ms INTEGER NOT NULL CHECK (expires_at_ms > requested_at_ms),
    completed_at_ms INTEGER CHECK (completed_at_ms IS NULL OR completed_at_ms >= requested_at_ms),
    operation_id TEXT REFERENCES control_operations(id) ON UPDATE CASCADE ON DELETE RESTRICT,
    CHECK (length(id) > 0),
    CHECK (
      (channel_id IS NOT NULL AND output_id IS NULL) OR
      (channel_id IS NULL AND output_id IS NOT NULL)
    )
  ) STRICT`,
  `CREATE TABLE timers (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL COLLATE BINARY UNIQUE,
    kind TEXT NOT NULL,
    target_output_id TEXT REFERENCES outputs(id) ON UPDATE CASCADE ON DELETE RESTRICT,
    duration_ms INTEGER NOT NULL CHECK (duration_ms >= 0),
    status TEXT NOT NULL CHECK (status IN ('inactive', 'pending', 'active', 'expired', 'cancelled')),
    starts_at_ms INTEGER CHECK (starts_at_ms IS NULL OR starts_at_ms >= 0),
    expires_at_ms INTEGER CHECK (expires_at_ms IS NULL OR expires_at_ms >= 0),
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
    updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
    configuration_json TEXT,
    configuration_schema_version INTEGER,
    CHECK (length(id) > 0),
    CHECK (length(name) > 0),
    CHECK (length(kind) > 0),
    CHECK (
      (configuration_json IS NULL AND configuration_schema_version IS NULL) OR
      (configuration_json IS NOT NULL AND configuration_schema_version IS NOT NULL AND configuration_schema_version > 0 AND json_valid(configuration_json))
    )
  ) STRICT`,
  `CREATE TABLE sensors (
    id TEXT PRIMARY KEY NOT NULL,
    device_id TEXT NOT NULL REFERENCES devices(id) ON UPDATE CASCADE ON DELETE RESTRICT,
    name TEXT NOT NULL COLLATE BINARY UNIQUE,
    pin INTEGER NOT NULL CHECK (pin BETWEEN 0 AND 63),
    read_type TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
    latest_value REAL,
    latest_observed_at_ms INTEGER CHECK (latest_observed_at_ms IS NULL OR latest_observed_at_ms >= 0),
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
    updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
    metadata_json TEXT,
    metadata_schema_version INTEGER,
    UNIQUE (device_id, pin),
    CHECK (length(id) > 0),
    CHECK (length(name) > 0),
    CHECK (length(read_type) > 0),
    CHECK (
      (metadata_json IS NULL AND metadata_schema_version IS NULL) OR
      (metadata_json IS NOT NULL AND metadata_schema_version IS NOT NULL AND metadata_schema_version > 0 AND json_valid(metadata_json))
    )
  ) STRICT`,
  `CREATE TABLE switches (
    id TEXT PRIMARY KEY NOT NULL,
    device_id TEXT NOT NULL REFERENCES devices(id) ON UPDATE CASCADE ON DELETE RESTRICT,
    name TEXT NOT NULL COLLATE BINARY UNIQUE,
    pin INTEGER NOT NULL CHECK (pin BETWEEN 0 AND 63),
    normally_open INTEGER NOT NULL DEFAULT 1 CHECK (normally_open IN (0, 1)),
    enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
    latest_is_open INTEGER CHECK (latest_is_open IS NULL OR latest_is_open IN (0, 1)),
    latest_observed_at_ms INTEGER CHECK (latest_observed_at_ms IS NULL OR latest_observed_at_ms >= 0),
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
    updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
    metadata_json TEXT,
    metadata_schema_version INTEGER,
    UNIQUE (device_id, pin),
    CHECK (length(id) > 0),
    CHECK (length(name) > 0),
    CHECK (
      (metadata_json IS NULL AND metadata_schema_version IS NULL) OR
      (metadata_json IS NOT NULL AND metadata_schema_version IS NOT NULL AND metadata_schema_version > 0 AND json_valid(metadata_json))
    )
  ) STRICT`,
  `CREATE TABLE pump_calibrations (
    id TEXT PRIMARY KEY NOT NULL,
    output_id TEXT NOT NULL UNIQUE REFERENCES outputs(id) ON UPDATE CASCADE ON DELETE RESTRICT,
    measured_volume_ml REAL NOT NULL CHECK (measured_volume_ml > 0.0),
    run_duration_ms INTEGER NOT NULL CHECK (run_duration_ms > 0),
    millilitres_per_second REAL NOT NULL CHECK (millilitres_per_second > 0.0),
    calibrated_at_ms INTEGER NOT NULL CHECK (calibrated_at_ms >= 0),
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
    updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
    CHECK (length(id) > 0)
  ) STRICT`,
  `CREATE TABLE dsl_program_revisions (
    id TEXT PRIMARY KEY NOT NULL,
    output_id TEXT NOT NULL REFERENCES outputs(id) ON UPDATE CASCADE ON DELETE RESTRICT,
    revision INTEGER NOT NULL CHECK (revision > 0),
    language_version INTEGER NOT NULL CHECK (language_version > 0),
    source_text TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('draft', 'valid', 'invalid', 'active', 'retired')),
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
    diagnostics_json TEXT,
    diagnostics_schema_version INTEGER,
    UNIQUE (output_id, revision),
    CHECK (length(id) > 0),
    CHECK (
      (diagnostics_json IS NULL AND diagnostics_schema_version IS NULL) OR
      (diagnostics_json IS NOT NULL AND diagnostics_schema_version IS NOT NULL AND diagnostics_schema_version > 0 AND json_valid(diagnostics_json))
    )
  ) STRICT`,
  `CREATE TABLE alert_rules (
    id TEXT PRIMARY KEY NOT NULL,
    name TEXT NOT NULL COLLATE BINARY UNIQUE,
    source_type TEXT NOT NULL CHECK (source_type IN ('device', 'output', 'sensor', 'switch')),
    device_id TEXT REFERENCES devices(id) ON UPDATE CASCADE ON DELETE RESTRICT,
    output_id TEXT REFERENCES outputs(id) ON UPDATE CASCADE ON DELETE RESTRICT,
    sensor_id TEXT REFERENCES sensors(id) ON UPDATE CASCADE ON DELETE RESTRICT,
    switch_id TEXT REFERENCES switches(id) ON UPDATE CASCADE ON DELETE RESTRICT,
    condition TEXT NOT NULL,
    threshold REAL,
    delay_ms INTEGER NOT NULL DEFAULT 0 CHECK (delay_ms >= 0),
    severity TEXT NOT NULL CHECK (severity IN ('info', 'warning', 'error', 'critical')),
    enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
    updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
    configuration_json TEXT,
    configuration_schema_version INTEGER,
    CHECK (length(id) > 0),
    CHECK (length(name) > 0),
    CHECK (length(condition) > 0),
    CHECK (
      (source_type = 'device' AND device_id IS NOT NULL AND output_id IS NULL AND sensor_id IS NULL AND switch_id IS NULL) OR
      (source_type = 'output' AND device_id IS NULL AND output_id IS NOT NULL AND sensor_id IS NULL AND switch_id IS NULL) OR
      (source_type = 'sensor' AND device_id IS NULL AND output_id IS NULL AND sensor_id IS NOT NULL AND switch_id IS NULL) OR
      (source_type = 'switch' AND device_id IS NULL AND output_id IS NULL AND sensor_id IS NULL AND switch_id IS NOT NULL)
    ),
    CHECK (
      (configuration_json IS NULL AND configuration_schema_version IS NULL) OR
      (configuration_json IS NOT NULL AND configuration_schema_version IS NOT NULL AND configuration_schema_version > 0 AND json_valid(configuration_json))
    )
  ) STRICT`,
  `CREATE TABLE active_alerts (
    id TEXT PRIMARY KEY NOT NULL,
    alert_rule_id TEXT NOT NULL REFERENCES alert_rules(id) ON UPDATE CASCADE ON DELETE RESTRICT,
    deduplication_key TEXT NOT NULL COLLATE BINARY,
    state TEXT NOT NULL CHECK (state IN ('open', 'acknowledged', 'recovered')),
    opened_at_ms INTEGER NOT NULL CHECK (opened_at_ms >= 0),
    last_observed_at_ms INTEGER NOT NULL CHECK (last_observed_at_ms >= opened_at_ms),
    acknowledged_at_ms INTEGER CHECK (acknowledged_at_ms IS NULL OR acknowledged_at_ms >= opened_at_ms),
    recovered_at_ms INTEGER CHECK (recovered_at_ms IS NULL OR recovered_at_ms >= opened_at_ms),
    details_json TEXT,
    details_schema_version INTEGER,
    UNIQUE (alert_rule_id, deduplication_key),
    CHECK (length(id) > 0),
    CHECK (length(deduplication_key) > 0),
    CHECK (state != 'recovered' OR recovered_at_ms IS NOT NULL),
    CHECK (
      (details_json IS NULL AND details_schema_version IS NULL) OR
      (details_json IS NOT NULL AND details_schema_version IS NOT NULL AND details_schema_version > 0 AND json_valid(details_json))
    )
  ) STRICT`,
  `CREATE TABLE state_revisions (
    revision INTEGER PRIMARY KEY AUTOINCREMENT,
    committed_at_ms INTEGER NOT NULL CHECK (committed_at_ms >= 0),
    actor TEXT NOT NULL,
    mutation_type TEXT NOT NULL,
    summary TEXT NOT NULL,
    CHECK (length(actor) > 0),
    CHECK (length(mutation_type) > 0)
  ) STRICT`,
  `CREATE TABLE state_outbox (
    revision INTEGER PRIMARY KEY NOT NULL REFERENCES state_revisions(revision) ON UPDATE CASCADE ON DELETE RESTRICT,
    event_type TEXT NOT NULL,
    entity_type TEXT NOT NULL,
    entity_id TEXT,
    occurred_at_ms INTEGER NOT NULL CHECK (occurred_at_ms >= 0),
    retention_class TEXT NOT NULL CHECK (retention_class IN ('critical', 'audit', 'operational', 'raw', 'aggregate')),
    payload_json TEXT NOT NULL CHECK (json_valid(payload_json)),
    payload_schema_version INTEGER NOT NULL CHECK (payload_schema_version > 0),
    delivery_attempts INTEGER NOT NULL DEFAULT 0 CHECK (delivery_attempts >= 0),
    available_at_ms INTEGER NOT NULL CHECK (available_at_ms >= occurred_at_ms),
    published_at_ms INTEGER CHECK (published_at_ms IS NULL OR published_at_ms >= occurred_at_ms),
    last_error TEXT,
    CHECK (length(event_type) > 0),
    CHECK (length(entity_type) > 0)
  ) STRICT`,
  `CREATE TABLE import_runs (
    id TEXT PRIMARY KEY NOT NULL,
    source_kind TEXT NOT NULL,
    source_fingerprint TEXT NOT NULL,
    dry_run INTEGER NOT NULL CHECK (dry_run IN (0, 1)),
    status TEXT NOT NULL CHECK (status IN ('pending', 'validating', 'succeeded', 'failed', 'rolled_back')),
    started_at_ms INTEGER NOT NULL CHECK (started_at_ms >= 0),
    completed_at_ms INTEGER CHECK (completed_at_ms IS NULL OR completed_at_ms >= started_at_ms),
    report_json TEXT,
    report_schema_version INTEGER,
    CHECK (length(id) > 0),
    CHECK (length(source_kind) > 0),
    CHECK (length(source_fingerprint) > 0),
    CHECK (
      (report_json IS NULL AND report_schema_version IS NULL) OR
      (report_json IS NOT NULL AND report_schema_version IS NOT NULL AND report_schema_version > 0 AND json_valid(report_json))
    )
  ) STRICT`,
  `CREATE TABLE import_issues (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    import_run_id TEXT NOT NULL REFERENCES import_runs(id) ON UPDATE CASCADE ON DELETE CASCADE,
    severity TEXT NOT NULL CHECK (severity IN ('warning', 'error')),
    code TEXT NOT NULL,
    source_file TEXT NOT NULL,
    source_path TEXT NOT NULL,
    message TEXT NOT NULL,
    details_json TEXT,
    details_schema_version INTEGER,
    CHECK (length(code) > 0),
    CHECK (length(source_file) > 0),
    CHECK (length(message) > 0),
    CHECK (
      (details_json IS NULL AND details_schema_version IS NULL) OR
      (details_json IS NOT NULL AND details_schema_version IS NOT NULL AND details_schema_version > 0 AND json_valid(details_json))
    )
  ) STRICT`,
] as const;

const stateIndexStatements = [
  "CREATE INDEX mapping_profiles_prefix_idx ON mapping_profiles(device_name_prefix COLLATE BINARY)",
  "CREATE INDEX devices_status_last_seen_idx ON devices(status, last_seen_at_ms)",
  "CREATE INDEX devices_name_idx ON devices(name COLLATE BINARY)",
  "CREATE INDEX devices_mapping_profile_idx ON devices(mapping_profile_id)",
  "CREATE INDEX outputs_kind_order_idx ON outputs(kind, display_order)",
  "CREATE INDEX channels_throttle_order_idx ON channels(throttle_id, display_order)",
  "CREATE INDEX pin_mappings_profile_order_idx ON pin_mappings(mapping_profile_id, display_order)",
  "CREATE UNIQUE INDEX pin_mappings_profile_output_idx ON pin_mappings(mapping_profile_id, output_id) WHERE output_id IS NOT NULL",
  "CREATE UNIQUE INDEX pin_mappings_profile_channel_idx ON pin_mappings(mapping_profile_id, channel_id) WHERE channel_id IS NOT NULL",
  "CREATE INDEX schedules_enabled_idx ON schedules(enabled, updated_at_ms)",
  "CREATE INDEX schedule_points_schedule_minute_idx ON schedule_points(schedule_id, minute_of_day, position)",
  "CREATE INDEX control_operations_status_deadline_idx ON control_operations(status, deadline_at_ms)",
  "CREATE INDEX control_operations_device_requested_idx ON control_operations(device_id, requested_at_ms DESC)",
  "CREATE INDEX overrides_status_expiry_idx ON overrides(status, expires_at_ms)",
  "CREATE INDEX overrides_channel_expiry_idx ON overrides(channel_id, expires_at_ms)",
  "CREATE INDEX overrides_output_expiry_idx ON overrides(output_id, expires_at_ms)",
  "CREATE INDEX timers_status_expiry_idx ON timers(status, expires_at_ms)",
  "CREATE INDEX sensors_observed_idx ON sensors(latest_observed_at_ms)",
  "CREATE INDEX switches_observed_idx ON switches(latest_observed_at_ms)",
  "CREATE INDEX dsl_program_revisions_status_idx ON dsl_program_revisions(output_id, status, revision DESC)",
  "CREATE INDEX alert_rules_enabled_source_idx ON alert_rules(enabled, source_type)",
  "CREATE INDEX active_alerts_state_seen_idx ON active_alerts(state, last_observed_at_ms DESC)",
  "CREATE INDEX state_revisions_committed_idx ON state_revisions(committed_at_ms)",
  "CREATE INDEX state_outbox_delivery_idx ON state_outbox(published_at_ms, available_at_ms, revision)",
  "CREATE INDEX import_runs_status_started_idx ON import_runs(status, started_at_ms DESC)",
  "CREATE UNIQUE INDEX import_runs_committed_fingerprint_idx ON import_runs(source_fingerprint) WHERE dry_run = 0 AND status = 'succeeded'",
  "CREATE INDEX import_issues_run_severity_idx ON import_issues(import_run_id, severity, id)",
] as const;

const stateDropStatements = [
  "DROP TABLE IF EXISTS import_issues",
  "DROP TABLE IF EXISTS import_runs",
  "DROP TABLE IF EXISTS state_outbox",
  "DROP TABLE IF EXISTS state_revisions",
  "DROP TABLE IF EXISTS active_alerts",
  "DROP TABLE IF EXISTS alert_rules",
  "DROP TABLE IF EXISTS dsl_program_revisions",
  "DROP TABLE IF EXISTS pump_calibrations",
  "DROP TABLE IF EXISTS switches",
  "DROP TABLE IF EXISTS sensors",
  "DROP TABLE IF EXISTS timers",
  "DROP TABLE IF EXISTS overrides",
  "DROP TABLE IF EXISTS control_operations",
  "DROP TABLE IF EXISTS schedule_points",
  "DROP TABLE IF EXISTS schedules",
  "DROP TABLE IF EXISTS pin_mappings",
  "DROP TABLE IF EXISTS channels",
  "DROP TABLE IF EXISTS throttles",
  "DROP TABLE IF EXISTS outputs",
  "DROP TABLE IF EXISTS devices",
  "DROP TABLE IF EXISTS mapping_profiles",
] as const;

export const stateInitialMigration: Migration = {
  async up(database): Promise<void> {
    await executeSqlStatements(database, stateSchemaStatements);
    await executeSqlStatements(database, stateIndexStatements);
  },
  async down(database): Promise<void> {
    await executeSqlStatements(database, stateDropStatements);
  },
};
