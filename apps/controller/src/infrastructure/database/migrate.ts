import type { Kysely } from "kysely";
import {
  Migrator,
  type Migration,
  type MigrationProvider,
  type MigrationResult,
} from "kysely/migration";

import { eventsInitialMigration } from "./events-migrations.js";
import { stateInitialMigration } from "./state-migrations.js";
import type { EventsDatabaseSchema, StateDatabaseSchema } from "./types.js";

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
  "001_initial_state": stateInitialMigration,
});

const eventsMigrationProvider = new EmbeddedMigrationProvider({
  "001_initial_events": eventsInitialMigration,
});

async function migrateToLatest<DatabaseSchema>(
  database: Kysely<DatabaseSchema>,
  provider: MigrationProvider,
): Promise<readonly MigrationResult[]> {
  const migrator = new Migrator({
    db: database,
    provider,
  });
  const result = await migrator.migrateToLatest();

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
  return migrateToLatest(database, stateMigrationProvider);
}

export function migrateEventsDatabase(
  database: Kysely<EventsDatabaseSchema>,
): Promise<readonly MigrationResult[]> {
  return migrateToLatest(database, eventsMigrationProvider);
}
