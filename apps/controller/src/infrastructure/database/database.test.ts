import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, stat } from "node:fs/promises";
import { basename, join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";
import { sql, type Kysely } from "kysely";

import {
  closeControllerDatabases,
  DEFAULT_SQLITE_BUSY_TIMEOUT_MS,
  migrateEventsDatabase,
  migrateStateDatabase,
  openControllerDatabases,
  type ControllerDatabases,
} from "./index.js";

const requiredStateTables = [
  "active_alerts",
  "alert_rules",
  "channels",
  "control_operations",
  "devices",
  "dsl_program_revisions",
  "import_issues",
  "import_runs",
  "mapping_profiles",
  "outputs",
  "overrides",
  "pin_mappings",
  "pump_calibrations",
  "schedule_points",
  "schedules",
  "sensors",
  "state_outbox",
  "state_revisions",
  "switches",
  "throttles",
  "timers",
] as const;

const requiredEventsTables = [
  "event_aggregates",
  "event_archives",
  "interactions",
  "retention_policies",
  "retention_runs",
  "state_events",
] as const;

const temporaryDirectories = new Set<string>();

async function createDatabases(): Promise<{
  readonly databases: ControllerDatabases;
  readonly statePath: string;
  readonly eventsPath: string;
}> {
  const directory = await mkdtemp(join(tmpdir(), "aquarium-db-"));
  temporaryDirectories.add(directory);
  const statePath = join(directory, "state.db");
  const eventsPath = join(directory, "events.db");
  const databases = await openControllerDatabases({
    state: { filename: statePath },
    events: { filename: eventsPath },
  });
  return { databases, statePath, eventsPath };
}

afterEach(async () => {
  const temporaryRoot = `${resolve(tmpdir())}${sep}`;
  for (const directory of temporaryDirectories) {
    const resolvedDirectory = resolve(directory);
    if (
      !resolvedDirectory.startsWith(temporaryRoot) ||
      !basename(resolvedDirectory).startsWith("aquarium-db-")
    ) {
      throw new Error(
        `Refusing to remove unexpected test directory: ${resolvedDirectory}`,
      );
    }
    await rm(resolvedDirectory, { recursive: true, force: true });
    temporaryDirectories.delete(directory);
  }
});

async function readPragmas<DatabaseSchema>(
  database: Kysely<DatabaseSchema>,
): Promise<{
  readonly busyTimeout: number;
  readonly foreignKeys: number;
  readonly journalMode: string;
  readonly synchronous: number;
}> {
  const journalMode = await sql<{
    journal_mode: string;
  }>`PRAGMA journal_mode`.execute(database);
  const foreignKeys = await sql<{
    foreign_keys: number;
  }>`PRAGMA foreign_keys`.execute(database);
  const busyTimeout = await sql<{
    timeout: number;
  }>`PRAGMA busy_timeout`.execute(database);
  const synchronous = await sql<{
    synchronous: number;
  }>`PRAGMA synchronous`.execute(database);

  return {
    journalMode: journalMode.rows[0]?.journal_mode ?? "",
    foreignKeys: foreignKeys.rows[0]?.foreign_keys ?? 0,
    busyTimeout: busyTimeout.rows[0]?.timeout ?? 0,
    synchronous: synchronous.rows[0]?.synchronous ?? -1,
  };
}

async function readTables<DatabaseSchema>(
  database: Kysely<DatabaseSchema>,
): Promise<ReadonlyMap<string, number>> {
  const result = await sql<{ name: string; strict: number }>`
    SELECT name, strict
    FROM pragma_table_list
    WHERE schema = 'main'
  `.execute(database);
  return new Map(result.rows.map((row) => [row.name, row.strict]));
}

async function expectIntegrity<DatabaseSchema>(
  database: Kysely<DatabaseSchema>,
): Promise<void> {
  const result = await sql<{
    integrity_check: string;
  }>`PRAGMA integrity_check`.execute(database);
  expect(result.rows).toEqual([{ integrity_check: "ok" }]);
}

describe("SQLite persistence foundation", () => {
  it("migrates empty state and events databases with durable connection settings", async () => {
    const { databases, statePath, eventsPath } = await createDatabases();
    try {
      expect(await readPragmas(databases.state)).toEqual({
        journalMode: "wal",
        foreignKeys: 1,
        busyTimeout: DEFAULT_SQLITE_BUSY_TIMEOUT_MS,
        synchronous: 2,
      });
      expect(await readPragmas(databases.events)).toEqual({
        journalMode: "wal",
        foreignKeys: 1,
        busyTimeout: DEFAULT_SQLITE_BUSY_TIMEOUT_MS,
        synchronous: 1,
      });

      const stateTables = await readTables(databases.state);
      const eventsTables = await readTables(databases.events);
      for (const table of requiredStateTables) {
        expect(stateTables.get(table), `${table} should be STRICT`).toBe(1);
      }
      for (const table of requiredEventsTables) {
        expect(eventsTables.get(table), `${table} should be STRICT`).toBe(1);
      }

      await expect(
        migrateStateDatabase(databases.state),
      ).resolves.toBeDefined();
      await expect(
        migrateEventsDatabase(databases.events),
      ).resolves.toBeDefined();
      await expectIntegrity(databases.state);
      await expectIntegrity(databases.events);
      expect((await stat(statePath)).size).toBeGreaterThan(0);
      expect((await stat(eventsPath)).size).toBeGreaterThan(0);
    } finally {
      await closeControllerDatabases(databases);
    }
  });

  it("enforces relational, range, case-sensitive, and versioned JSON constraints", async () => {
    const { databases } = await createDatabases();
    try {
      await databases.state
        .insertInto("mapping_profiles")
        .values({
          id: "profile-main",
          name: "Main profile",
          device_name_prefix: "Main",
          created_at_ms: 1,
          updated_at_ms: 1,
        })
        .executeTakeFirstOrThrow();
      await databases.state
        .insertInto("devices")
        .values({
          id: "device-1",
          hardware_id: "ABC123",
          name: "Main",
          mapping_profile_id: "profile-main",
          desired_pwm_frequency_hz: 5_000,
          desired_pwm_resolution_bits: 8,
          created_at_ms: 1,
          updated_at_ms: 1,
        })
        .executeTakeFirstOrThrow();
      await databases.state
        .insertInto("throttles")
        .values({
          id: "throttle-light",
          type_key: "light",
          percentage: 100,
          created_at_ms: 1,
          updated_at_ms: 1,
        })
        .executeTakeFirstOrThrow();
      await databases.state
        .insertInto("channels")
        .values([
          {
            id: "channel-blue-upper",
            name: "Blue",
            kind: "light",
            throttle_id: "throttle-light",
            display_order: 0,
            created_at_ms: 1,
            updated_at_ms: 1,
          },
          {
            id: "channel-blue-lower",
            name: "blue",
            kind: "light",
            throttle_id: "throttle-light",
            display_order: 1,
            created_at_ms: 1,
            updated_at_ms: 1,
          },
        ])
        .execute();
      await databases.state
        .insertInto("schedules")
        .values({
          id: "schedule-blue",
          channel_id: "channel-blue-upper",
          name: "Blue schedule",
          created_at_ms: 1,
          updated_at_ms: 1,
        })
        .executeTakeFirstOrThrow();
      await databases.state
        .insertInto("schedule_points")
        .values({
          id: "point-1",
          schedule_id: "schedule-blue",
          position: 0,
          minute_of_day: 0,
          percentage: 0,
          created_at_ms: 1,
          updated_at_ms: 1,
        })
        .executeTakeFirstOrThrow();

      await expect(
        databases.state
          .insertInto("pin_mappings")
          .values({
            id: "missing-profile-mapping",
            mapping_profile_id: "missing-profile",
            channel_id: "channel-blue-upper",
            pin: 12,
            display_order: 0,
            created_at_ms: 1,
            updated_at_ms: 1,
          })
          .execute(),
      ).rejects.toThrow(/FOREIGN KEY/i);

      await expect(
        databases.state
          .insertInto("schedule_points")
          .values({
            id: "invalid-percentage",
            schedule_id: "schedule-blue",
            position: 1,
            minute_of_day: 1,
            percentage: 101,
            created_at_ms: 1,
            updated_at_ms: 1,
          })
          .execute(),
      ).rejects.toThrow(/CHECK constraint/i);

      await expect(
        databases.state
          .insertInto("schedule_points")
          .values({
            id: "duplicate-minute",
            schedule_id: "schedule-blue",
            position: 1,
            minute_of_day: 0,
            percentage: 50,
            created_at_ms: 1,
            updated_at_ms: 1,
          })
          .execute(),
      ).rejects.toThrow(/UNIQUE constraint/i);

      await expect(
        databases.state
          .insertInto("devices")
          .values({
            id: "invalid-json-version-pair",
            hardware_id: "DEF456",
            name: "Other",
            desired_pwm_frequency_hz: 5_000,
            desired_pwm_resolution_bits: 8,
            created_at_ms: 1,
            updated_at_ms: 1,
            metadata_json: "{}",
          })
          .execute(),
      ).rejects.toThrow(/CHECK constraint/i);

      await databases.events
        .insertInto("state_events")
        .values({
          revision: 1,
          occurred_at_ms: 1,
          event_type: "channel-created",
          entity_type: "channel",
          entity_id: "channel-blue-upper",
          retention_class: "audit",
          payload_json: "{}",
          payload_schema_version: 1,
          byte_count: 2,
        })
        .executeTakeFirstOrThrow();

      await expect(
        databases.events
          .insertInto("interactions")
          .values({
            occurred_at_ms: 1,
            direction: "internal",
            kind: "invalid-json",
            severity: "error",
            outcome: "failed",
            byte_count: 4,
            retention_class: "critical",
            payload_json: "nope",
            payload_schema_version: 1,
          })
          .execute(),
      ).rejects.toThrow(/CHECK constraint/i);

      await databases.state
        .insertInto("import_runs")
        .values([
          {
            id: "dry-run-1",
            source_kind: "legacy-json",
            source_fingerprint: "same-source",
            dry_run: 1,
            status: "failed",
            started_at_ms: 1,
          },
          {
            id: "dry-run-2",
            source_kind: "legacy-json",
            source_fingerprint: "same-source",
            dry_run: 1,
            status: "failed",
            started_at_ms: 2,
          },
          {
            id: "committed-import",
            source_kind: "legacy-json",
            source_fingerprint: "same-source",
            dry_run: 0,
            status: "succeeded",
            started_at_ms: 3,
          },
        ])
        .execute();
      await expect(
        databases.state
          .insertInto("import_runs")
          .values({
            id: "duplicate-committed-import",
            source_kind: "legacy-json",
            source_fingerprint: "same-source",
            dry_run: 0,
            status: "succeeded",
            started_at_ms: 4,
          })
          .execute(),
      ).rejects.toThrow(/UNIQUE constraint/i);

      await expectIntegrity(databases.state);
      await expectIntegrity(databases.events);
    } finally {
      await closeControllerDatabases(databases);
    }
  });
});
