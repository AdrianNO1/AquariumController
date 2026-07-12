import BetterSqlite3 from "better-sqlite3";
import { Kysely, SqliteDialect } from "kysely";

import { migrateEventsDatabase, migrateStateDatabase } from "./migrate.js";
import type { EventsDatabaseSchema, StateDatabaseSchema } from "./types.js";

export const DEFAULT_SQLITE_BUSY_TIMEOUT_MS = 5_000;
export const DEFAULT_SQLITE_JOURNAL_SIZE_LIMIT_BYTES = 64 * 1024 * 1024;

export interface DatabaseConnectionOptions {
  readonly filename: string;
  readonly busyTimeoutMs?: number;
  readonly migrate?: boolean;
}

export interface ControllerDatabases {
  readonly state: Kysely<StateDatabaseSchema>;
  readonly events: Kysely<EventsDatabaseSchema>;
}

export interface ControllerDatabaseOptions {
  readonly state: DatabaseConnectionOptions;
  readonly events: DatabaseConnectionOptions;
}

function assertConnectionOptions(options: DatabaseConnectionOptions): number {
  if (options.filename.trim().length === 0) {
    throw new TypeError("SQLite filename must not be empty");
  }

  const busyTimeoutMs = options.busyTimeoutMs ?? DEFAULT_SQLITE_BUSY_TIMEOUT_MS;
  if (
    !Number.isSafeInteger(busyTimeoutMs) ||
    busyTimeoutMs <= 0 ||
    busyTimeoutMs > 60_000
  ) {
    throw new RangeError(
      "SQLite busy timeout must be an integer between 1 and 60000 milliseconds",
    );
  }
  return busyTimeoutMs;
}

function openDatabase<DatabaseSchema>(
  options: DatabaseConnectionOptions,
  synchronous: "FULL" | "NORMAL",
): Kysely<DatabaseSchema> {
  const busyTimeoutMs = assertConnectionOptions(options);
  const sqlite = new BetterSqlite3(options.filename, {
    timeout: busyTimeoutMs,
  });

  try {
    sqlite.pragma("foreign_keys = ON");
    sqlite.pragma(`busy_timeout = ${busyTimeoutMs}`);
    sqlite.pragma("journal_mode = WAL");
    sqlite.pragma(`synchronous = ${synchronous}`);
    sqlite.pragma("wal_autocheckpoint = 1000");
    sqlite.pragma(
      `journal_size_limit = ${DEFAULT_SQLITE_JOURNAL_SIZE_LIMIT_BYTES}`,
    );
  } catch (error) {
    sqlite.close();
    throw error;
  }

  return new Kysely<DatabaseSchema>({
    dialect: new SqliteDialect({ database: sqlite }),
  });
}

export async function openStateDatabase(
  options: DatabaseConnectionOptions,
): Promise<Kysely<StateDatabaseSchema>> {
  const database = openDatabase<StateDatabaseSchema>(options, "FULL");
  try {
    if (options.migrate !== false) {
      await migrateStateDatabase(database);
    }
    return database;
  } catch (error) {
    await database.destroy();
    throw error;
  }
}

export async function openEventsDatabase(
  options: DatabaseConnectionOptions,
): Promise<Kysely<EventsDatabaseSchema>> {
  const database = openDatabase<EventsDatabaseSchema>(options, "NORMAL");
  try {
    if (options.migrate !== false) {
      await migrateEventsDatabase(database);
    }
    return database;
  } catch (error) {
    await database.destroy();
    throw error;
  }
}

export async function openControllerDatabases(
  options: ControllerDatabaseOptions,
): Promise<ControllerDatabases> {
  const state = await openStateDatabase(options.state);
  try {
    const events = await openEventsDatabase(options.events);
    return { state, events };
  } catch (error) {
    await state.destroy();
    throw error;
  }
}

export async function closeControllerDatabases(
  databases: ControllerDatabases,
): Promise<void> {
  await Promise.all([databases.state.destroy(), databases.events.destroy()]);
}
