import type { ColumnType, Generated } from "kysely";

export type SqliteBoolean = 0 | 1;
export type JsonText = string;

type OptionalNullable<T> = ColumnType<T | null, T | null | undefined, T | null>;
type InsertOptional<T> = ColumnType<T, T | undefined, T>;

export type DeviceStatus = "unknown" | "online" | "stale" | "offline" | "error";
export type OperationStatus =
  | "pending"
  | "in_flight"
  | "succeeded"
  | "failed"
  | "timed_out"
  | "outcome_unknown"
  | "cancelled";
export type OverrideStatus =
  "pending" | "active" | "expired" | "cancelled" | "failed";
export type TimerStatus =
  "inactive" | "pending" | "active" | "expired" | "cancelled";
export type AlertState = "open" | "acknowledged" | "recovered";
export type AlertSeverity = "info" | "warning" | "error" | "critical";
export type ImportStatus =
  "pending" | "validating" | "succeeded" | "failed" | "rolled_back";
export type ScheduleCompileStatus = "succeeded" | "failed";
export type ScheduleDeliveryStatus =
  | "not_required"
  | "pending"
  | "in_flight"
  | "succeeded"
  | "failed"
  | "timed_out"
  | "outcome_unknown"
  | "unsupported";
export type AlertObservationSourceType =
  "device" | "output" | "sensor" | "switch";
export type AlertNotificationTransition =
  "opened" | "acknowledged" | "recovered" | "reopened";
export type NotificationDeliveryStatus =
  "pending" | "attempting" | "delivered" | "failed" | "outcome_unknown";

export interface DevicesTable {
  id: string;
  hardware_id: string;
  name: string;
  mapping_profile_id: OptionalNullable<string>;
  reported_name: OptionalNullable<string>;
  desired_pwm_frequency_hz: number;
  desired_pwm_resolution_bits: number;
  reported_pwm_frequency_hz: OptionalNullable<number>;
  reported_pwm_resolution_bits: OptionalNullable<number>;
  firmware_version: OptionalNullable<string>;
  reported_schedule_hash: OptionalNullable<string>;
  status: InsertOptional<DeviceStatus>;
  last_seen_at_ms: OptionalNullable<number>;
  last_error_code: OptionalNullable<string>;
  last_error_message: OptionalNullable<string>;
  enabled: InsertOptional<SqliteBoolean>;
  created_at_ms: number;
  updated_at_ms: number;
  metadata_json: OptionalNullable<JsonText>;
  metadata_schema_version: OptionalNullable<number>;
}

export interface MappingProfilesTable {
  id: string;
  name: string;
  device_name_prefix: string;
  output_gain: InsertOptional<number>;
  created_at_ms: number;
  updated_at_ms: number;
}

export interface OutputsTable {
  id: string;
  name: string;
  kind: string;
  display_order: number;
  enabled: InsertOptional<SqliteBoolean>;
  output_gain: InsertOptional<number>;
  created_at_ms: number;
  updated_at_ms: number;
}

export interface ThrottlesTable {
  id: string;
  type_key: string;
  percentage: number;
  created_at_ms: number;
  updated_at_ms: number;
}

export interface ChannelsTable {
  id: string;
  name: string;
  kind: string;
  throttle_id: string;
  display_order: number;
  enabled: InsertOptional<SqliteBoolean>;
  created_at_ms: number;
  updated_at_ms: number;
}

export interface PinMappingsTable {
  id: string;
  mapping_profile_id: string;
  output_id: OptionalNullable<string>;
  channel_id: OptionalNullable<string>;
  pin: number;
  display_order: number;
  enabled: InsertOptional<SqliteBoolean>;
  created_at_ms: number;
  updated_at_ms: number;
}

export interface SchedulesTable {
  id: string;
  channel_id: string;
  name: string;
  timezone: InsertOptional<"UTC">;
  enabled: InsertOptional<SqliteBoolean>;
  graph_revision: InsertOptional<number>;
  created_at_ms: number;
  updated_at_ms: number;
}

export interface SchedulePointsTable {
  id: string;
  schedule_id: string;
  position: number;
  minute_of_day: number;
  percentage: number;
  editor_x: OptionalNullable<number>;
  editor_y: OptionalNullable<number>;
  created_at_ms: number;
  updated_at_ms: number;
}

export interface OverridesTable {
  id: string;
  channel_id: OptionalNullable<string>;
  output_id: OptionalNullable<string>;
  value_percentage: number;
  status: OverrideStatus;
  requested_at_ms: number;
  starts_at_ms: OptionalNullable<number>;
  expires_at_ms: number;
  completed_at_ms: OptionalNullable<number>;
  operation_id: OptionalNullable<string>;
}

export interface TimersTable {
  id: string;
  name: string;
  kind: string;
  target_output_id: OptionalNullable<string>;
  duration_ms: number;
  status: TimerStatus;
  starts_at_ms: OptionalNullable<number>;
  expires_at_ms: OptionalNullable<number>;
  created_at_ms: number;
  updated_at_ms: number;
  configuration_json: OptionalNullable<JsonText>;
  configuration_schema_version: OptionalNullable<number>;
}

export interface SensorsTable {
  id: string;
  device_id: string;
  name: string;
  pin: number;
  read_type: string;
  enabled: InsertOptional<SqliteBoolean>;
  latest_value: OptionalNullable<number>;
  latest_observed_at_ms: OptionalNullable<number>;
  created_at_ms: number;
  updated_at_ms: number;
  metadata_json: OptionalNullable<JsonText>;
  metadata_schema_version: OptionalNullable<number>;
}

export interface SwitchesTable {
  id: string;
  device_id: string;
  name: string;
  pin: number;
  normally_open: InsertOptional<SqliteBoolean>;
  enabled: InsertOptional<SqliteBoolean>;
  latest_is_open: OptionalNullable<SqliteBoolean>;
  latest_observed_at_ms: OptionalNullable<number>;
  created_at_ms: number;
  updated_at_ms: number;
  metadata_json: OptionalNullable<JsonText>;
  metadata_schema_version: OptionalNullable<number>;
}

export interface PumpCalibrationsTable {
  id: string;
  output_id: string;
  measured_volume_ml: number;
  run_duration_ms: number;
  millilitres_per_second: number;
  calibrated_at_ms: number;
  created_at_ms: number;
  updated_at_ms: number;
}

export interface DslProgramRevisionsTable {
  id: string;
  output_id: string;
  revision: number;
  language_version: number;
  source_text: string;
  status: string;
  created_at_ms: number;
  diagnostics_json: OptionalNullable<JsonText>;
  diagnostics_schema_version: OptionalNullable<number>;
}

export interface AlertRulesTable {
  id: string;
  name: string;
  source_type: "device" | "output" | "sensor" | "switch";
  device_id: OptionalNullable<string>;
  output_id: OptionalNullable<string>;
  sensor_id: OptionalNullable<string>;
  switch_id: OptionalNullable<string>;
  condition: string;
  threshold: OptionalNullable<number>;
  delay_ms: InsertOptional<number>;
  severity: AlertSeverity;
  enabled: InsertOptional<SqliteBoolean>;
  created_at_ms: number;
  updated_at_ms: number;
  configuration_json: OptionalNullable<JsonText>;
  configuration_schema_version: OptionalNullable<number>;
}

export interface ActiveAlertsTable {
  id: string;
  alert_rule_id: string;
  deduplication_key: string;
  state: AlertState;
  opened_at_ms: number;
  last_observed_at_ms: number;
  acknowledged_at_ms: OptionalNullable<number>;
  recovered_at_ms: OptionalNullable<number>;
  details_json: OptionalNullable<JsonText>;
  details_schema_version: OptionalNullable<number>;
}

export interface ControlOperationsTable {
  id: string;
  device_id: OptionalNullable<string>;
  kind: string;
  status: OperationStatus;
  requested_at_ms: number;
  deadline_at_ms: number;
  completed_at_ms: OptionalNullable<number>;
  request_json: JsonText;
  request_schema_version: number;
  result_json: OptionalNullable<JsonText>;
  result_schema_version: OptionalNullable<number>;
}

export interface DeviceScheduleArtifactsTable {
  device_id: string;
  source_state_revision: number;
  compile_status: ScheduleCompileStatus;
  desired_schedule_hash: OptionalNullable<string>;
  compiled_payload_json: OptionalNullable<JsonText>;
  compiled_payload_schema_version: OptionalNullable<number>;
  byte_count: OptionalNullable<number>;
  delivery_status: InsertOptional<ScheduleDeliveryStatus>;
  last_delivery_operation_id: OptionalNullable<string>;
  compile_error_code: OptionalNullable<string>;
  compile_error_message: OptionalNullable<string>;
  delivery_error_code: OptionalNullable<string>;
  delivery_error_message: OptionalNullable<string>;
  compiled_at_ms: number;
  delivery_updated_at_ms: number;
  created_at_ms: number;
  updated_at_ms: number;
}

export interface SchedulerGuardsTable {
  job_key: string;
  scope_key: string;
  last_started_utc_day_start_ms: OptionalNullable<number>;
  last_started_at_ms: OptionalNullable<number>;
  last_operation_id: OptionalNullable<string>;
  last_success_utc_day_start_ms: OptionalNullable<number>;
  last_success_at_ms: OptionalNullable<number>;
  created_at_ms: number;
  updated_at_ms: number;
}

export interface AlertConditionStatesTable {
  alert_rule_id: string;
  deduplication_key: string;
  source_type: AlertObservationSourceType;
  source_id: string;
  pending_since_ms: number;
  last_observed_at_ms: number;
  observation_json: JsonText;
  observation_schema_version: number;
  created_at_ms: number;
  updated_at_ms: number;
}

export interface NotificationDeliveriesTable {
  id: Generated<number>;
  alert_transition_revision: number;
  alert_id: string;
  transition: AlertNotificationTransition;
  destination_kind: "webhook";
  destination_key: string;
  deduplication_key: string;
  status: InsertOptional<NotificationDeliveryStatus>;
  attempt_count: InsertOptional<number>;
  notification_json: JsonText;
  notification_schema_version: number;
  created_at_ms: number;
  attempt_started_at_ms: OptionalNullable<number>;
  completed_at_ms: OptionalNullable<number>;
  updated_at_ms: number;
  last_error_code: OptionalNullable<string>;
  last_error_message: OptionalNullable<string>;
  outcome_audit_recorded_at_ms: OptionalNullable<number>;
}

export interface StateRevisionsTable {
  revision: Generated<number>;
  committed_at_ms: number;
  actor: string;
  mutation_type: string;
  summary: string;
}

export interface OperatorConcurrencyTable {
  singleton_key: number;
  last_operator_revision: number;
}

export interface StateOutboxTable {
  revision: number;
  event_type: string;
  entity_type: string;
  entity_id: OptionalNullable<string>;
  occurred_at_ms: number;
  retention_class: RetentionClass;
  payload_json: JsonText;
  payload_schema_version: number;
  delivery_attempts: InsertOptional<number>;
  available_at_ms: number;
  published_at_ms: OptionalNullable<number>;
  last_error: OptionalNullable<string>;
}

export interface ImportRunsTable {
  id: string;
  source_kind: string;
  source_fingerprint: string;
  dry_run: SqliteBoolean;
  status: ImportStatus;
  started_at_ms: number;
  completed_at_ms: OptionalNullable<number>;
  report_json: OptionalNullable<JsonText>;
  report_schema_version: OptionalNullable<number>;
}

export interface ImportIssuesTable {
  id: Generated<number>;
  import_run_id: string;
  severity: "warning" | "error";
  code: string;
  source_file: string;
  source_path: string;
  message: string;
  details_json: OptionalNullable<JsonText>;
  details_schema_version: OptionalNullable<number>;
}

export interface StateDatabaseSchema {
  mapping_profiles: MappingProfilesTable;
  devices: DevicesTable;
  outputs: OutputsTable;
  throttles: ThrottlesTable;
  channels: ChannelsTable;
  pin_mappings: PinMappingsTable;
  schedules: SchedulesTable;
  schedule_points: SchedulePointsTable;
  overrides: OverridesTable;
  timers: TimersTable;
  sensors: SensorsTable;
  switches: SwitchesTable;
  pump_calibrations: PumpCalibrationsTable;
  dsl_program_revisions: DslProgramRevisionsTable;
  alert_rules: AlertRulesTable;
  active_alerts: ActiveAlertsTable;
  control_operations: ControlOperationsTable;
  device_schedule_artifacts: DeviceScheduleArtifactsTable;
  scheduler_guards: SchedulerGuardsTable;
  alert_condition_states: AlertConditionStatesTable;
  notification_deliveries: NotificationDeliveriesTable;
  operator_concurrency: OperatorConcurrencyTable;
  state_revisions: StateRevisionsTable;
  state_outbox: StateOutboxTable;
  import_runs: ImportRunsTable;
  import_issues: ImportIssuesTable;
}

export type EventDirection = "inbound" | "outbound" | "internal";
export type EventOutcome =
  | "pending"
  | "succeeded"
  | "failed"
  | "timed_out"
  | "outcome_unknown"
  | "ignored";
export type RetentionClass =
  "critical" | "audit" | "operational" | "raw" | "aggregate";
export type EventSeverity = "debug" | "info" | "warning" | "error" | "critical";

export interface StateEventsTable {
  revision: number;
  occurred_at_ms: number;
  event_type: string;
  entity_type: string;
  entity_id: OptionalNullable<string>;
  retention_class: RetentionClass;
  payload_json: JsonText;
  payload_schema_version: number;
  byte_count: number;
}

export interface InteractionsTable {
  id: Generated<number>;
  occurred_at_ms: number;
  direction: EventDirection;
  kind: string;
  severity: EventSeverity;
  topic: OptionalNullable<string>;
  device_id: OptionalNullable<string>;
  correlation_id: OptionalNullable<string>;
  operation_id: OptionalNullable<string>;
  outcome: EventOutcome;
  duration_ms: OptionalNullable<number>;
  byte_count: number;
  retention_class: RetentionClass;
  payload_json: OptionalNullable<JsonText>;
  payload_schema_version: OptionalNullable<number>;
  payload_sha256: OptionalNullable<string>;
}

export interface EventAggregatesTable {
  id: Generated<number>;
  bucket_start_ms: number;
  bucket_end_ms: number;
  kind: string;
  device_id: OptionalNullable<string>;
  outcome: EventOutcome;
  event_count: number;
  error_count: number;
  byte_count: number;
  latency_total_ms: number;
  latency_min_ms: OptionalNullable<number>;
  latency_max_ms: OptionalNullable<number>;
  retention_class: RetentionClass;
  details_json: OptionalNullable<JsonText>;
  details_schema_version: OptionalNullable<number>;
}

export interface EventArchivesTable {
  id: string;
  range_start_ms: number;
  range_end_ms: number;
  created_at_ms: number;
  codec: "zstd";
  storage_path: string;
  sha256: string;
  event_count: number;
  uncompressed_bytes: number;
  compressed_bytes: number;
  status: "pending" | "complete" | "failed";
  metadata_json: OptionalNullable<JsonText>;
  metadata_schema_version: OptionalNullable<number>;
}

export interface RetentionPoliciesTable {
  retention_class: RetentionClass;
  retain_for_ms: number;
  byte_budget: number;
  archive_before_delete: SqliteBoolean;
  priority: number;
  enabled: InsertOptional<SqliteBoolean>;
  updated_at_ms: number;
}

export interface RetentionRunsTable {
  id: string;
  started_at_ms: number;
  completed_at_ms: OptionalNullable<number>;
  status: "running" | "succeeded" | "failed";
  bytes_before: number;
  bytes_after: OptionalNullable<number>;
  interactions_deleted: InsertOptional<number>;
  aggregates_deleted: InsertOptional<number>;
  state_events_deleted: InsertOptional<number>;
  archives_created: InsertOptional<number>;
  error_json: OptionalNullable<JsonText>;
  error_schema_version: OptionalNullable<number>;
}

export interface EventsDatabaseSchema {
  state_events: StateEventsTable;
  interactions: InteractionsTable;
  event_aggregates: EventAggregatesTable;
  event_archives: EventArchivesTable;
  retention_policies: RetentionPoliciesTable;
  retention_runs: RetentionRunsTable;
}
