import { createHash } from "node:crypto";

import { afterEach, describe, expect, it } from "vitest";
import { sql, type Kysely } from "kysely";

import {
  EVENTS_INITIAL_MIGRATION_NAME,
  EVENTS_NOTIFICATION_OUTCOME_MIGRATION_NAME,
  EVENTS_QUERY_MIGRATION_NAME,
  EVENTS_RETENTION_MIGRATION_NAME,
  migrateEventsDatabase,
  migrateEventsDatabaseTo,
  migrateStateDatabase,
  migrateStateDatabaseTo,
  openEventsDatabase,
  openStateDatabase,
  parseStoredStateOutboxEnvelope,
  STATE_CHANNEL_COLOR_MIGRATION_NAME,
  STATE_CONTROL_AREA_MIGRATION_NAME,
  STATE_CONTROL_AREA_THROTTLE_MIGRATION_NAME,
  STATE_FIRMWARE_UPDATE_MIGRATION_NAME,
  STATE_INITIAL_MIGRATION_NAME,
  STATE_NOTIFICATION_OUTCOME_AUDIT_MIGRATION_NAME,
  STATE_OPERATOR_CONCURRENCY_MIGRATION_NAME,
  STATE_RUNTIME_MIGRATION_NAME,
  type EventsDatabaseSchema,
  type StateDatabaseSchema,
} from "./index.js";

const openDatabases: Array<{ destroy(): Promise<void> }> = [];

afterEach(async () => {
  await Promise.all(
    openDatabases.splice(0).map((database) => database.destroy()),
  );
});

async function createStateDatabase(): Promise<Kysely<StateDatabaseSchema>> {
  const database = await openStateDatabase({
    filename: ":memory:",
    migrate: false,
  });
  openDatabases.push(database);
  return database;
}

async function createEventsDatabase(): Promise<Kysely<EventsDatabaseSchema>> {
  const database = await openEventsDatabase({
    filename: ":memory:",
    migrate: false,
  });
  openDatabases.push(database);
  return database;
}

async function readMigrationNames<DatabaseSchema>(
  database: Kysely<DatabaseSchema>,
): Promise<readonly string[]> {
  const result = await sql<{ name: string }>`
    SELECT name
    FROM kysely_migration
    ORDER BY name
  `.execute(database);
  return result.rows.map((row) => row.name);
}

async function readSchemaObjectNames<DatabaseSchema>(
  database: Kysely<DatabaseSchema>,
  type: "index" | "table",
): Promise<ReadonlySet<string>> {
  const result = await sql<{ name: string }>`
    SELECT name
    FROM sqlite_schema
    WHERE type = ${type}
  `.execute(database);
  return new Set(result.rows.map((row) => row.name));
}

describe("runtime migrations", () => {
  it("migrates empty databases to latest once with strict runtime tables and query indexes", async () => {
    const state = await createStateDatabase();
    const events = await createEventsDatabase();

    const stateResults = await migrateStateDatabase(state);
    const eventsResults = await migrateEventsDatabase(events);

    expect(stateResults.map((result) => result.migrationName)).toEqual([
      STATE_INITIAL_MIGRATION_NAME,
      STATE_RUNTIME_MIGRATION_NAME,
      STATE_NOTIFICATION_OUTCOME_AUDIT_MIGRATION_NAME,
      STATE_OPERATOR_CONCURRENCY_MIGRATION_NAME,
      STATE_CHANNEL_COLOR_MIGRATION_NAME,
      STATE_CONTROL_AREA_MIGRATION_NAME,
      STATE_FIRMWARE_UPDATE_MIGRATION_NAME,
      STATE_CONTROL_AREA_THROTTLE_MIGRATION_NAME,
    ]);
    expect(eventsResults.map((result) => result.migrationName)).toEqual([
      EVENTS_INITIAL_MIGRATION_NAME,
      EVENTS_QUERY_MIGRATION_NAME,
      EVENTS_RETENTION_MIGRATION_NAME,
      EVENTS_NOTIFICATION_OUTCOME_MIGRATION_NAME,
    ]);
    expect(await readMigrationNames(state)).toEqual([
      STATE_INITIAL_MIGRATION_NAME,
      STATE_RUNTIME_MIGRATION_NAME,
      STATE_NOTIFICATION_OUTCOME_AUDIT_MIGRATION_NAME,
      STATE_OPERATOR_CONCURRENCY_MIGRATION_NAME,
      STATE_CHANNEL_COLOR_MIGRATION_NAME,
      STATE_CONTROL_AREA_MIGRATION_NAME,
      STATE_FIRMWARE_UPDATE_MIGRATION_NAME,
      STATE_CONTROL_AREA_THROTTLE_MIGRATION_NAME,
    ]);
    expect(await readMigrationNames(events)).toEqual([
      EVENTS_INITIAL_MIGRATION_NAME,
      EVENTS_QUERY_MIGRATION_NAME,
      EVENTS_RETENTION_MIGRATION_NAME,
      EVENTS_NOTIFICATION_OUTCOME_MIGRATION_NAME,
    ]);

    const tableResult = await sql<{ name: string; strict: number }>`
      SELECT name, strict
      FROM pragma_table_list
      WHERE name IN (
        'device_schedule_artifacts',
        'scheduler_guards',
        'alert_condition_states',
        'notification_deliveries',
        'operator_concurrency',
        'firmware_rollout_policy',
        'firmware_update_requests'
      )
      ORDER BY name
    `.execute(state);
    expect(tableResult.rows).toEqual([
      { name: "alert_condition_states", strict: 1 },
      { name: "device_schedule_artifacts", strict: 1 },
      { name: "firmware_rollout_policy", strict: 1 },
      { name: "firmware_update_requests", strict: 1 },
      { name: "notification_deliveries", strict: 1 },
      { name: "operator_concurrency", strict: 1 },
      { name: "scheduler_guards", strict: 1 },
    ]);
    await expect(
      state
        .selectFrom("operator_concurrency")
        .selectAll()
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ singleton_key: 1, last_operator_revision: 0 });
    await expect(
      state
        .selectFrom("firmware_rollout_policy")
        .selectAll()
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({
      singleton_key: 1,
      target_version: "5.0.0",
      mode: "when_off",
      enabled: 0,
      requested_at_ms: 0,
      updated_at_ms: 0,
    });

    const eventIndexes = await readSchemaObjectNames(events, "index");
    for (const name of [
      "interactions_direction_cursor_idx",
      "interactions_severity_cursor_idx",
      "interactions_kind_cursor_idx",
      "interactions_outcome_cursor_idx",
      "interactions_device_cursor_idx",
      "interactions_operation_cursor_idx",
      "interactions_correlation_cursor_idx",
      "interactions_notification_delivery_operation_idx",
    ]) {
      expect(eventIndexes.has(name), `${name} should exist`).toBe(true);
    }

    await expect(migrateStateDatabase(state)).resolves.toEqual([]);
    await expect(migrateEventsDatabase(events)).resolves.toEqual([]);
  });

  it("repairs missing control-area multipliers without replacing existing values", async () => {
    const state = await createStateDatabase();
    await migrateStateDatabaseTo(state, STATE_FIRMWARE_UPDATE_MIGRATION_NAME);
    await state
      .insertInto("throttles")
      .values({
        id: "existing-light-multiplier",
        type_key: "light",
        percentage: 73,
        created_at_ms: 10,
        updated_at_ms: 11,
      })
      .executeTakeFirstOrThrow();

    await expect(migrateStateDatabase(state)).resolves.toMatchObject([
      {
        migrationName: STATE_CONTROL_AREA_THROTTLE_MIGRATION_NAME,
        direction: "Up",
        status: "Success",
      },
    ]);

    const areas = await state
      .selectFrom("control_areas")
      .select(["type_key", "display_order"])
      .orderBy("display_order")
      .execute();
    const multipliers = await state
      .selectFrom("throttles")
      .select(["id", "type_key", "percentage"])
      .execute();
    const multiplierByTypeKey = new Map(
      multipliers.map((multiplier) => [multiplier.type_key, multiplier]),
    );

    expect(multipliers).toHaveLength(areas.length);
    expect(multiplierByTypeKey.get("light")).toEqual({
      id: "existing-light-multiplier",
      type_key: "light",
      percentage: 73,
    });
    for (const area of areas) {
      const multiplier = multiplierByTypeKey.get(area.type_key);
      expect(
        multiplier,
        `${area.type_key} should have a multiplier`,
      ).toBeDefined();
      if (area.type_key !== "light") {
        expect(multiplier).toEqual({
          id: `throttle-${area.type_key}`,
          type_key: area.type_key,
          percentage: 100,
        });
      }
    }
  });

  it("seeds the operator concurrency floor from the latest existing state revision", async () => {
    const state = await createStateDatabase();
    await migrateStateDatabaseTo(
      state,
      STATE_NOTIFICATION_OUTCOME_AUDIT_MIGRATION_NAME,
    );
    await state
      .insertInto("state_revisions")
      .values([
        {
          committed_at_ms: 100,
          actor: "migration-seed",
          mutation_type: "background.one",
          summary: "First existing revision",
        },
        {
          committed_at_ms: 101,
          actor: "migration-seed",
          mutation_type: "background.two",
          summary: "Second existing revision",
        },
      ])
      .execute();

    await expect(migrateStateDatabase(state)).resolves.toMatchObject([
      {
        migrationName: STATE_OPERATOR_CONCURRENCY_MIGRATION_NAME,
        direction: "Up",
        status: "Success",
      },
      {
        migrationName: STATE_CHANNEL_COLOR_MIGRATION_NAME,
        direction: "Up",
        status: "Success",
      },
      {
        migrationName: STATE_CONTROL_AREA_MIGRATION_NAME,
        direction: "Up",
        status: "Success",
      },
      {
        migrationName: STATE_FIRMWARE_UPDATE_MIGRATION_NAME,
        direction: "Up",
        status: "Success",
      },
      {
        migrationName: STATE_CONTROL_AREA_THROTTLE_MIGRATION_NAME,
        direction: "Up",
        status: "Success",
      },
    ]);
    await expect(
      state
        .selectFrom("operator_concurrency")
        .selectAll()
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ singleton_key: 1, last_operator_revision: 2 });
  });

  it("backfills deterministic channel colors and enforces canonical values", async () => {
    const state = await createStateDatabase();
    await migrateStateDatabaseTo(
      state,
      STATE_OPERATOR_CONCURRENCY_MIGRATION_NAME,
    );
    await state
      .insertInto("throttles")
      .values({
        id: "throttle-light",
        type_key: "light",
        percentage: 100,
        created_at_ms: 0,
        updated_at_ms: 0,
      })
      .executeTakeFirstOrThrow();
    await state
      .insertInto("channels")
      .values([
        {
          id: "channel-b",
          name: "B",
          kind: "light",
          throttle_id: "throttle-light",
          display_order: 1,
          created_at_ms: 0,
          updated_at_ms: 0,
        },
        {
          id: "channel-a",
          name: "A",
          kind: "light",
          throttle_id: "throttle-light",
          display_order: 0,
          created_at_ms: 0,
          updated_at_ms: 0,
        },
        {
          id: "channel-c",
          name: "C",
          kind: "light",
          throttle_id: "throttle-light",
          display_order: 1,
          created_at_ms: 0,
          updated_at_ms: 0,
        },
      ])
      .execute();

    await expect(migrateStateDatabase(state)).resolves.toMatchObject([
      {
        migrationName: STATE_CHANNEL_COLOR_MIGRATION_NAME,
        direction: "Up",
        status: "Success",
      },
      {
        migrationName: STATE_CONTROL_AREA_MIGRATION_NAME,
        direction: "Up",
        status: "Success",
      },
      {
        migrationName: STATE_FIRMWARE_UPDATE_MIGRATION_NAME,
        direction: "Up",
        status: "Success",
      },
      {
        migrationName: STATE_CONTROL_AREA_THROTTLE_MIGRATION_NAME,
        direction: "Up",
        status: "Success",
      },
    ]);
    await expect(
      state
        .selectFrom("channels")
        .select(["id", "color"])
        .orderBy("display_order")
        .orderBy("id")
        .execute(),
    ).resolves.toEqual([
      { id: "channel-a", color: "#6f5bd5" },
      { id: "channel-b", color: "#a747a9" },
      { id: "channel-c", color: "#3c66db" },
    ]);
    await expect(
      state
        .updateTable("channels")
        .set({ color: "#13A4C7" })
        .where("id", "=", "channel-a")
        .executeTakeFirstOrThrow(),
    ).rejects.toThrow(/CHECK constraint/i);

    await expect(
      migrateStateDatabaseTo(state, STATE_OPERATOR_CONCURRENCY_MIGRATION_NAME),
    ).resolves.toMatchObject([
      {
        migrationName: STATE_CONTROL_AREA_THROTTLE_MIGRATION_NAME,
        direction: "Down",
        status: "Success",
      },
      {
        migrationName: STATE_FIRMWARE_UPDATE_MIGRATION_NAME,
        direction: "Down",
        status: "Success",
      },
      {
        migrationName: STATE_CONTROL_AREA_MIGRATION_NAME,
        direction: "Down",
        status: "Success",
      },
      {
        migrationName: STATE_CHANNEL_COLOR_MIGRATION_NAME,
        direction: "Down",
        status: "Success",
      },
    ]);
    const columns = await sql<{ name: string }>`
      SELECT name
      FROM pragma_table_info('channels')
      ORDER BY cid
    `.execute(state);
    expect(columns.rows.map(({ name }) => name)).not.toContain("color");
  });

  it("upgrades existing terminal deliveries as pending audit work", async () => {
    const state = await createStateDatabase();
    await migrateStateDatabaseTo(state, STATE_RUNTIME_MIGRATION_NAME);
    await state
      .insertInto("state_revisions")
      .values({
        committed_at_ms: 100,
        actor: "notification-migration-test",
        mutation_type: "alert.opened",
        summary: "Opened fixture alert",
      })
      .executeTakeFirstOrThrow();
    await state
      .insertInto("devices")
      .values({
        id: "device-notification-migration",
        hardware_id: "hardware-notification-migration",
        name: "Notification migration device",
        desired_pwm_frequency_hz: 1_000,
        desired_pwm_resolution_bits: 8,
        created_at_ms: 0,
        updated_at_ms: 0,
      })
      .executeTakeFirstOrThrow();
    await state
      .insertInto("alert_rules")
      .values({
        id: "rule-notification-migration",
        name: "Notification migration rule",
        source_type: "device",
        device_id: "device-notification-migration",
        condition: "offline",
        severity: "critical",
        created_at_ms: 0,
        updated_at_ms: 0,
      })
      .executeTakeFirstOrThrow();
    await state
      .insertInto("active_alerts")
      .values({
        id: "alert-notification-migration",
        alert_rule_id: "rule-notification-migration",
        deduplication_key: "notification-migration",
        state: "open",
        opened_at_ms: 100,
        last_observed_at_ms: 100,
      })
      .executeTakeFirstOrThrow();
    await state
      .insertInto("notification_deliveries")
      .values({
        alert_transition_revision: 1,
        alert_id: "alert-notification-migration",
        transition: "opened",
        destination_kind: "webhook",
        destination_key: "primary",
        deduplication_key: "notification-migration:primary",
        status: "delivered",
        attempt_count: 1,
        notification_json: "{}",
        notification_schema_version: 1,
        created_at_ms: 100,
        attempt_started_at_ms: 100,
        completed_at_ms: 100,
        updated_at_ms: 100,
      })
      .executeTakeFirstOrThrow();

    await expect(migrateStateDatabase(state)).resolves.toMatchObject([
      {
        migrationName: STATE_NOTIFICATION_OUTCOME_AUDIT_MIGRATION_NAME,
        direction: "Up",
        status: "Success",
      },
      {
        migrationName: STATE_OPERATOR_CONCURRENCY_MIGRATION_NAME,
        direction: "Up",
        status: "Success",
      },
      {
        migrationName: STATE_CHANNEL_COLOR_MIGRATION_NAME,
        direction: "Up",
        status: "Success",
      },
      {
        migrationName: STATE_CONTROL_AREA_MIGRATION_NAME,
        direction: "Up",
        status: "Success",
      },
      {
        migrationName: STATE_FIRMWARE_UPDATE_MIGRATION_NAME,
        direction: "Up",
        status: "Success",
      },
      {
        migrationName: STATE_CONTROL_AREA_THROTTLE_MIGRATION_NAME,
        direction: "Up",
        status: "Success",
      },
    ]);
    await expect(
      state
        .selectFrom("notification_deliveries")
        .select("outcome_audit_recorded_at_ms")
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ outcome_audit_recorded_at_ms: null });
    await state
      .updateTable("notification_deliveries")
      .set({ outcome_audit_recorded_at_ms: 101 })
      .executeTakeFirstOrThrow();
    await expect(
      state
        .updateTable("notification_deliveries")
        .set({ outcome_audit_recorded_at_ms: 99 })
        .executeTakeFirstOrThrow(),
    ).rejects.toThrow(/CHECK constraint/i);

    await expect(
      migrateStateDatabaseTo(state, STATE_RUNTIME_MIGRATION_NAME),
    ).resolves.toMatchObject([
      {
        migrationName: STATE_CONTROL_AREA_THROTTLE_MIGRATION_NAME,
        direction: "Down",
        status: "Success",
      },
      {
        migrationName: STATE_FIRMWARE_UPDATE_MIGRATION_NAME,
        direction: "Down",
        status: "Success",
      },
      {
        migrationName: STATE_CONTROL_AREA_MIGRATION_NAME,
        direction: "Down",
        status: "Success",
      },
      {
        migrationName: STATE_CHANNEL_COLOR_MIGRATION_NAME,
        direction: "Down",
        status: "Success",
      },
      {
        migrationName: STATE_OPERATOR_CONCURRENCY_MIGRATION_NAME,
        direction: "Down",
        status: "Success",
      },
      {
        migrationName: STATE_NOTIFICATION_OUTCOME_AUDIT_MIGRATION_NAME,
        direction: "Down",
        status: "Success",
      },
    ]);
    const columns = await sql<{ name: string }>`
      SELECT name
      FROM pragma_table_info('notification_deliveries')
      ORDER BY cid
    `.execute(state);
    expect(columns.rows.map(({ name }) => name)).not.toContain(
      "outcome_audit_recorded_at_ms",
    );
  });

  it("upgrades tracked 001 fixtures without data loss and downgrades only 002 assets", async () => {
    const state = await createStateDatabase();
    const events = await createEventsDatabase();
    await migrateStateDatabaseTo(state, STATE_INITIAL_MIGRATION_NAME);
    await migrateEventsDatabaseTo(events, EVENTS_INITIAL_MIGRATION_NAME);

    await state
      .insertInto("mapping_profiles")
      .values({
        id: "profile-001",
        name: "Original profile",
        device_name_prefix: "Original",
        created_at_ms: 100,
        updated_at_ms: 100,
      })
      .executeTakeFirstOrThrow();
    await events
      .insertInto("interactions")
      .values({
        occurred_at_ms: 100,
        direction: "internal",
        kind: "fixture",
        severity: "info",
        outcome: "succeeded",
        byte_count: 7,
        retention_class: "audit",
        payload_json: '{"fixture":true}',
        payload_schema_version: 1,
        payload_sha256: createHash("sha256")
          .update('{"fixture":true}', "utf8")
          .digest("hex"),
      })
      .executeTakeFirstOrThrow();
    await state
      .insertInto("state_revisions")
      .values({
        committed_at_ms: 100,
        actor: "001-fixture",
        mutation_type: "profile.created",
        summary: "Created profile fixture",
      })
      .executeTakeFirstOrThrow();
    await state
      .insertInto("state_outbox")
      .values({
        revision: 1,
        event_type: "configuration.mapping-profile-created",
        entity_type: "mapping_profile",
        entity_id: "profile-001",
        occurred_at_ms: 100,
        retention_class: "audit",
        payload_json: '{"name":"Original profile"}',
        payload_schema_version: 3,
        available_at_ms: 100,
      })
      .executeTakeFirstOrThrow();
    await events
      .insertInto("state_events")
      .values({
        revision: 1,
        occurred_at_ms: 100,
        event_type: "configuration.mapping-profile-created",
        entity_type: "mapping_profile",
        entity_id: "profile-001",
        retention_class: "audit",
        payload_json: '{"name":"Original profile"}',
        payload_schema_version: 3,
        byte_count: 27,
      })
      .executeTakeFirstOrThrow();

    const stateFixture = await state
      .selectFrom("mapping_profiles")
      .selectAll()
      .executeTakeFirstOrThrow();
    const eventsFixture = await events
      .selectFrom("interactions")
      .selectAll()
      .executeTakeFirstOrThrow();
    const outboxFixture = await state
      .selectFrom("state_outbox")
      .selectAll()
      .executeTakeFirstOrThrow();
    const stateEventFixture = await events
      .selectFrom("state_events")
      .selectAll()
      .executeTakeFirstOrThrow();

    await migrateStateDatabase(state);
    await migrateEventsDatabase(events);
    expect(
      await state.selectFrom("mapping_profiles").selectAll().executeTakeFirst(),
    ).toEqual(stateFixture);
    expect(
      await events.selectFrom("interactions").selectAll().executeTakeFirst(),
    ).toEqual(eventsFixture);
    const upgradedOutbox = await state
      .selectFrom("state_outbox")
      .selectAll()
      .executeTakeFirstOrThrow();
    expect(parseStoredStateOutboxEnvelope(upgradedOutbox)).toEqual({
      schemaVersion: 1,
      invalidations: [{ resource: "mapping_profile", id: "profile-001" }],
      details: {
        schemaVersion: 3,
        data: { name: "Original profile" },
      },
    });
    const upgradedStateEvent = await events
      .selectFrom("state_events")
      .selectAll()
      .executeTakeFirstOrThrow();
    expect(upgradedStateEvent.payload_json).toBe(upgradedOutbox.payload_json);
    expect(upgradedStateEvent.payload_schema_version).toBe(1);
    expect(upgradedStateEvent.byte_count).toBe(
      new TextEncoder().encode(upgradedStateEvent.payload_json).byteLength,
    );
    await state
      .insertInto("scheduler_guards")
      .values({
        job_key: "downgrade-fixture",
        scope_key: "global",
        created_at_ms: 101,
        updated_at_ms: 101,
      })
      .executeTakeFirstOrThrow();

    const stateDown = await migrateStateDatabaseTo(
      state,
      STATE_INITIAL_MIGRATION_NAME,
    );
    const eventsDown = await migrateEventsDatabaseTo(
      events,
      EVENTS_INITIAL_MIGRATION_NAME,
    );
    expect(stateDown).toMatchObject([
      {
        migrationName: STATE_CONTROL_AREA_THROTTLE_MIGRATION_NAME,
        direction: "Down",
        status: "Success",
      },
      {
        migrationName: STATE_FIRMWARE_UPDATE_MIGRATION_NAME,
        direction: "Down",
        status: "Success",
      },
      {
        migrationName: STATE_CONTROL_AREA_MIGRATION_NAME,
        direction: "Down",
        status: "Success",
      },
      {
        migrationName: STATE_CHANNEL_COLOR_MIGRATION_NAME,
        direction: "Down",
        status: "Success",
      },
      {
        migrationName: STATE_OPERATOR_CONCURRENCY_MIGRATION_NAME,
        direction: "Down",
        status: "Success",
      },
      {
        migrationName: STATE_NOTIFICATION_OUTCOME_AUDIT_MIGRATION_NAME,
        direction: "Down",
        status: "Success",
      },
      {
        migrationName: STATE_RUNTIME_MIGRATION_NAME,
        direction: "Down",
        status: "Success",
      },
    ]);
    expect(eventsDown).toMatchObject([
      {
        migrationName: EVENTS_NOTIFICATION_OUTCOME_MIGRATION_NAME,
        direction: "Down",
        status: "Success",
      },
      {
        migrationName: EVENTS_RETENTION_MIGRATION_NAME,
        direction: "Down",
        status: "Success",
      },
      {
        migrationName: EVENTS_QUERY_MIGRATION_NAME,
        direction: "Down",
        status: "Success",
      },
    ]);

    expect(
      await state.selectFrom("mapping_profiles").selectAll().executeTakeFirst(),
    ).toEqual(stateFixture);
    expect(
      await events.selectFrom("interactions").selectAll().executeTakeFirst(),
    ).toEqual(eventsFixture);
    expect(
      await state.selectFrom("state_outbox").selectAll().executeTakeFirst(),
    ).toEqual(outboxFixture);
    expect(
      await events.selectFrom("state_events").selectAll().executeTakeFirst(),
    ).toEqual(stateEventFixture);
    expect(await readMigrationNames(state)).toEqual([
      STATE_INITIAL_MIGRATION_NAME,
    ]);
    expect(await readMigrationNames(events)).toEqual([
      EVENTS_INITIAL_MIGRATION_NAME,
    ]);

    const stateTables = await readSchemaObjectNames(state, "table");
    expect(stateTables.has("device_schedule_artifacts")).toBe(false);
    expect(stateTables.has("scheduler_guards")).toBe(false);
    expect(stateTables.has("alert_condition_states")).toBe(false);
    expect(stateTables.has("notification_deliveries")).toBe(false);
    expect(stateTables.has("operator_concurrency")).toBe(false);

    const eventIndexes = await readSchemaObjectNames(events, "index");
    expect(eventIndexes.has("interactions_direction_cursor_idx")).toBe(false);
    expect(eventIndexes.has("interactions_correlation_cursor_idx")).toBe(false);

    const stateIntegrity = await sql<{
      integrity_check: string;
    }>`PRAGMA integrity_check`.execute(state);
    const eventsIntegrity = await sql<{
      integrity_check: string;
    }>`PRAGMA integrity_check`.execute(events);
    expect(stateIntegrity.rows).toEqual([{ integrity_check: "ok" }]);
    expect(eventsIntegrity.rows).toEqual([{ integrity_check: "ok" }]);
  });

  it("upgrades a tracked 002 retention run with a zero state-event delete count", async () => {
    const events = await createEventsDatabase();
    await migrateEventsDatabaseTo(events, EVENTS_QUERY_MIGRATION_NAME);
    await events
      .insertInto("retention_runs")
      .values({
        id: "002-retention-fixture",
        started_at_ms: 100,
        completed_at_ms: 101,
        status: "succeeded",
        bytes_before: 500,
        bytes_after: 400,
        interactions_deleted: 2,
        aggregates_deleted: 1,
        archives_created: 1,
      })
      .executeTakeFirstOrThrow();

    const results = await migrateEventsDatabase(events);
    expect(results).toMatchObject([
      {
        migrationName: EVENTS_RETENTION_MIGRATION_NAME,
        direction: "Up",
        status: "Success",
      },
      {
        migrationName: EVENTS_NOTIFICATION_OUTCOME_MIGRATION_NAME,
        direction: "Up",
        status: "Success",
      },
    ]);
    expect(
      await events
        .selectFrom("retention_runs")
        .select([
          "id",
          "interactions_deleted",
          "aggregates_deleted",
          "state_events_deleted",
          "archives_created",
        ])
        .where("id", "=", "002-retention-fixture")
        .executeTakeFirstOrThrow(),
    ).toEqual({
      id: "002-retention-fixture",
      interactions_deleted: 2,
      aggregates_deleted: 1,
      state_events_deleted: 0,
      archives_created: 1,
    });
    await expect(
      events
        .updateTable("retention_runs")
        .set({ state_events_deleted: -1 })
        .where("id", "=", "002-retention-fixture")
        .executeTakeFirstOrThrow(),
    ).rejects.toThrow();

    await expect(
      migrateEventsDatabaseTo(events, EVENTS_QUERY_MIGRATION_NAME),
    ).resolves.toMatchObject([
      {
        migrationName: EVENTS_NOTIFICATION_OUTCOME_MIGRATION_NAME,
        direction: "Down",
        status: "Success",
      },
      {
        migrationName: EVENTS_RETENTION_MIGRATION_NAME,
        direction: "Down",
        status: "Success",
      },
    ]);
    const columns = await sql<{ name: string }>`
      SELECT name
      FROM pragma_table_info('retention_runs')
      ORDER BY cid
    `.execute(events);
    expect(columns.rows.map((column) => column.name)).not.toContain(
      "state_events_deleted",
    );
  });

  it("refuses to upgrade 001 outbox metadata that cannot be replayed", async () => {
    const state = await createStateDatabase();
    await migrateStateDatabaseTo(state, STATE_INITIAL_MIGRATION_NAME);
    await state
      .insertInto("state_revisions")
      .values({
        committed_at_ms: 100,
        actor: "invalid-fixture",
        mutation_type: "invalid",
        summary: "Invalid replay metadata",
      })
      .executeTakeFirstOrThrow();
    await state
      .insertInto("state_outbox")
      .values({
        revision: 1,
        event_type: "invalid.event",
        entity_type: "not_a_wire_resource",
        entity_id: "entity-1",
        occurred_at_ms: 100,
        retention_class: "audit",
        payload_json: "{}",
        payload_schema_version: 1,
        available_at_ms: 100,
      })
      .executeTakeFirstOrThrow();

    await expect(migrateStateDatabase(state)).rejects.toThrow(
      /cannot be upgraded/i,
    );
    expect(await readMigrationNames(state)).toEqual([
      STATE_INITIAL_MIGRATION_NAME,
    ]);
  });

  it("refuses to upgrade stored interactions outside the public log boundary", async () => {
    const events = await createEventsDatabase();
    await migrateEventsDatabaseTo(events, EVENTS_INITIAL_MIGRATION_NAME);
    await events
      .insertInto("interactions")
      .values({
        occurred_at_ms: 100,
        direction: "internal",
        kind: "x".repeat(257),
        severity: "info",
        outcome: "succeeded",
        byte_count: 0,
        retention_class: "audit",
      })
      .executeTakeFirstOrThrow();

    await expect(migrateEventsDatabase(events)).rejects.toThrow(
      /outside the public log boundary/i,
    );
    expect(await readMigrationNames(events)).toEqual([
      EVENTS_INITIAL_MIGRATION_NAME,
    ]);
  });

  it("refuses duplicate-key, unsafe-version, and malformed-text state wire rows", async () => {
    const cases = [
      {
        eventType: "valid.event",
        payloadJson: '{"value":1,"value":2}',
        payloadSchemaVersion: 1,
      },
      {
        eventType: "valid.event",
        payloadJson: "{}",
        payloadSchemaVersion: Number.MAX_SAFE_INTEGER + 1,
      },
      {
        eventType: "invalid\nevent",
        payloadJson: "{}",
        payloadSchemaVersion: 1,
      },
    ] as const;

    for (const [index, fixture] of cases.entries()) {
      const state = await createStateDatabase();
      await migrateStateDatabaseTo(state, STATE_INITIAL_MIGRATION_NAME);
      await state
        .insertInto("state_revisions")
        .values({
          committed_at_ms: 100,
          actor: "invalid-fixture",
          mutation_type: "invalid",
          summary: "Invalid replay payload",
        })
        .executeTakeFirstOrThrow();
      await state
        .insertInto("state_outbox")
        .values({
          revision: 1,
          event_type: fixture.eventType,
          entity_type: "controller",
          entity_id: null,
          occurred_at_ms: 100,
          retention_class: "audit",
          payload_json: fixture.payloadJson,
          payload_schema_version: fixture.payloadSchemaVersion,
          available_at_ms: 100,
        })
        .executeTakeFirstOrThrow();

      await expect(
        migrateStateDatabase(state),
        `state fixture ${index} should fail`,
      ).rejects.toThrow(/cannot be upgraded/i);
      expect(await readMigrationNames(state)).toEqual([
        STATE_INITIAL_MIGRATION_NAME,
      ]);
    }

    for (const [index, fixture] of cases.entries()) {
      const events = await createEventsDatabase();
      await migrateEventsDatabaseTo(events, EVENTS_INITIAL_MIGRATION_NAME);
      await events
        .insertInto("state_events")
        .values({
          revision: 1,
          occurred_at_ms: 100,
          event_type: fixture.eventType,
          entity_type: "controller",
          entity_id: null,
          retention_class: "audit",
          payload_json: fixture.payloadJson,
          payload_schema_version: fixture.payloadSchemaVersion,
          byte_count: new TextEncoder().encode(fixture.payloadJson).byteLength,
        })
        .executeTakeFirstOrThrow();

      await expect(
        migrateEventsDatabase(events),
        `event fixture ${index} should fail`,
      ).rejects.toThrow(/cannot be upgraded/i);
      expect(await readMigrationNames(events)).toEqual([
        EVENTS_INITIAL_MIGRATION_NAME,
      ]);
    }
  });

  it("refuses legacy interaction payloads that cannot cross the public boundary losslessly", async () => {
    const payloadWithMissingHash = '{"valid":true}';
    const scalarPayload = "[]";
    const duplicatePayload = '{"value":1,"value":2}';
    const sha256 = (value: string): string =>
      createHash("sha256").update(value, "utf8").digest("hex");
    const cases = [
      {
        kind: "fixture",
        payload_json: payloadWithMissingHash,
        payload_schema_version: 1,
        payload_sha256: null,
      },
      {
        kind: "fixture",
        payload_json: scalarPayload,
        payload_schema_version: 1,
        payload_sha256: sha256(scalarPayload),
      },
      {
        kind: "fixture",
        payload_json: duplicatePayload,
        payload_schema_version: 1,
        payload_sha256: sha256(duplicatePayload),
      },
      {
        kind: "fixture",
        payload_json: payloadWithMissingHash,
        payload_schema_version: 1,
        payload_sha256: "0".repeat(64),
      },
      {
        kind: "invalid\nkind",
        payload_json: null,
        payload_schema_version: null,
        payload_sha256: null,
      },
    ] as const;

    for (const [index, fixture] of cases.entries()) {
      const events = await createEventsDatabase();
      await migrateEventsDatabaseTo(events, EVENTS_INITIAL_MIGRATION_NAME);
      await events
        .insertInto("interactions")
        .values({
          occurred_at_ms: 100,
          direction: "internal",
          kind: fixture.kind,
          severity: "info",
          outcome: "succeeded",
          byte_count: 0,
          retention_class: "audit",
          payload_json: fixture.payload_json,
          payload_schema_version: fixture.payload_schema_version,
          payload_sha256: fixture.payload_sha256,
        })
        .executeTakeFirstOrThrow();

      await expect(
        migrateEventsDatabase(events),
        `interaction fixture ${index} should fail`,
      ).rejects.toThrow(/outside the public log boundary/i);
      expect(await readMigrationNames(events)).toEqual([
        EVENTS_INITIAL_MIGRATION_NAME,
      ]);
    }
  });
});
