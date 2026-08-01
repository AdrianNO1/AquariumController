import type { Kysely } from "kysely";
import {
  Migrator,
  type Migration,
  type MigrationProvider,
  type MigrationResult,
} from "kysely/migration";

import { channelColorMigration } from "./channel-color-migration.js";
import { controlAreaMigration } from "./control-area-migration.js";
import { controlAreaThrottleMigration } from "./control-area-throttle-migration.js";
import { eventsQueryMigration } from "./events-query-migration.js";
import { eventsRetentionMigration } from "./events-retention-migration.js";
import { eventsNotificationOutcomeMigration } from "./events-notification-outcome-migration.js";
import { eventsInitialMigration } from "./events-migrations.js";
import { firmwareUpdateMigration } from "./firmware-update-migration.js";
import { notificationOutcomeAuditMigration } from "./notification-outcome-audit-migration.js";
import { operatorConcurrencyMigration } from "./operator-concurrency-migration.js";
import { stateRuntimeMigration } from "./state-runtime-migration.js";
import { stateInitialMigration } from "./state-migrations.js";
import type { EventsDatabaseSchema, StateDatabaseSchema } from "./types.js";

export const STATE_INITIAL_MIGRATION_NAME = "001_initial_state";
export const STATE_RUNTIME_MIGRATION_NAME = "002_runtime_state";
export const STATE_NOTIFICATION_OUTCOME_AUDIT_MIGRATION_NAME =
  "003_notification_outcome_audit";
export const STATE_OPERATOR_CONCURRENCY_MIGRATION_NAME =
  "004_operator_concurrency";
export const STATE_CHANNEL_COLOR_MIGRATION_NAME = "005_channel_color";
export const STATE_CONTROL_AREA_MIGRATION_NAME = "006_control_areas";
export const STATE_FIRMWARE_UPDATE_MIGRATION_NAME = "007_firmware_updates";
export const STATE_CONTROL_AREA_THROTTLE_MIGRATION_NAME =
  "008_control_area_throttles";
export const EVENTS_INITIAL_MIGRATION_NAME = "001_initial_events";
export const EVENTS_QUERY_MIGRATION_NAME = "002_log_query_indexes";
export const EVENTS_RETENTION_MIGRATION_NAME =
  "003_retention_state_event_count";
export const EVENTS_NOTIFICATION_OUTCOME_MIGRATION_NAME =
  "004_notification_outcome_idempotency";

export type StateMigrationTarget =
  | typeof STATE_INITIAL_MIGRATION_NAME
  | typeof STATE_RUNTIME_MIGRATION_NAME
  | typeof STATE_NOTIFICATION_OUTCOME_AUDIT_MIGRATION_NAME
  | typeof STATE_OPERATOR_CONCURRENCY_MIGRATION_NAME
  | typeof STATE_CHANNEL_COLOR_MIGRATION_NAME
  | typeof STATE_CONTROL_AREA_MIGRATION_NAME
  | typeof STATE_FIRMWARE_UPDATE_MIGRATION_NAME
  | typeof STATE_CONTROL_AREA_THROTTLE_MIGRATION_NAME;
export type EventsMigrationTarget =
  | typeof EVENTS_INITIAL_MIGRATION_NAME
  | typeof EVENTS_QUERY_MIGRATION_NAME
  | typeof EVENTS_RETENTION_MIGRATION_NAME
  | typeof EVENTS_NOTIFICATION_OUTCOME_MIGRATION_NAME;

class EmbeddedMigrationProvider implements MigrationProvider {
  readonly #migrations: Readonly<Record<string, Migration>>;

  constructor(migrations: Readonly<Record<string, Migration>>) {
    this.#migrations = migrations;
  }

  async getMigrations(): Promise<Record<string, Migration>> {
    return { ...this.#migrations };
  }
}

const stateMigrationProvider = new EmbeddedMigrationProvider({
  [STATE_INITIAL_MIGRATION_NAME]: stateInitialMigration,
  [STATE_RUNTIME_MIGRATION_NAME]: stateRuntimeMigration,
  [STATE_NOTIFICATION_OUTCOME_AUDIT_MIGRATION_NAME]:
    notificationOutcomeAuditMigration,
  [STATE_OPERATOR_CONCURRENCY_MIGRATION_NAME]: operatorConcurrencyMigration,
  [STATE_CHANNEL_COLOR_MIGRATION_NAME]: channelColorMigration,
  [STATE_CONTROL_AREA_MIGRATION_NAME]: controlAreaMigration,
  [STATE_FIRMWARE_UPDATE_MIGRATION_NAME]: firmwareUpdateMigration,
  [STATE_CONTROL_AREA_THROTTLE_MIGRATION_NAME]: controlAreaThrottleMigration,
});

const eventsMigrationProvider = new EmbeddedMigrationProvider({
  [EVENTS_INITIAL_MIGRATION_NAME]: eventsInitialMigration,
  [EVENTS_QUERY_MIGRATION_NAME]: eventsQueryMigration,
  [EVENTS_RETENTION_MIGRATION_NAME]: eventsRetentionMigration,
  [EVENTS_NOTIFICATION_OUTCOME_MIGRATION_NAME]:
    eventsNotificationOutcomeMigration,
});

async function migrate<DatabaseSchema>(
  database: Kysely<DatabaseSchema>,
  provider: MigrationProvider,
  target?: string,
): Promise<readonly MigrationResult[]> {
  const migrator = new Migrator({
    db: database,
    provider,
  });
  const result =
    target === undefined
      ? await migrator.migrateToLatest()
      : await migrator.migrateTo(target);

  if (result.error !== undefined) {
    if (result.error instanceof Error) {
      throw result.error;
    }
    throw new Error("Database migration failed", { cause: result.error });
  }

  return result.results ?? [];
}

export function migrateStateDatabase(
  database: Kysely<StateDatabaseSchema>,
): Promise<readonly MigrationResult[]> {
  return migrate(database, stateMigrationProvider);
}

export function migrateEventsDatabase(
  database: Kysely<EventsDatabaseSchema>,
): Promise<readonly MigrationResult[]> {
  return migrate(database, eventsMigrationProvider);
}

/**
 * Moves a state schema to a known migration for controlled tests and recovery
 * tooling. Moving backward drops data owned by later migrations and is not a
 * production data-recovery mechanism.
 */
export function migrateStateDatabaseTo(
  database: Kysely<StateDatabaseSchema>,
  target: StateMigrationTarget,
): Promise<readonly MigrationResult[]> {
  return migrate(database, stateMigrationProvider, target);
}

/**
 * Moves an events schema to a known migration for controlled tests and
 * recovery tooling. Moving backward drops later schema assets and is not a
 * production data-recovery mechanism.
 */
export function migrateEventsDatabaseTo(
  database: Kysely<EventsDatabaseSchema>,
  target: EventsMigrationTarget,
): Promise<readonly MigrationResult[]> {
  return migrate(database, eventsMigrationProvider, target);
}
