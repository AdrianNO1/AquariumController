import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { sql, type Kysely } from "kysely";

import {
  openEventsDatabase,
  openStateDatabase,
  type EventsDatabaseSchema,
  type StateDatabaseSchema,
} from "./index.js";

let state: Kysely<StateDatabaseSchema>;
let events: Kysely<EventsDatabaseSchema>;

beforeEach(async () => {
  state = await openStateDatabase({ filename: ":memory:" });
  events = await openEventsDatabase({ filename: ":memory:" });
});

afterEach(async () => {
  await Promise.all([state.destroy(), events.destroy()]);
});

async function insertDevice(id: string): Promise<void> {
  await state
    .insertInto("devices")
    .values({
      id,
      hardware_id: `${id}-hardware`,
      name: id,
      desired_pwm_frequency_hz: 5_000,
      desired_pwm_resolution_bits: 8,
      created_at_ms: 100,
      updated_at_ms: 100,
    })
    .executeTakeFirstOrThrow();
}

async function insertAlertParents(): Promise<{
  readonly alertId: string;
  readonly revision: number;
  readonly ruleId: string;
}> {
  await insertDevice("device-alert");
  const ruleId = "rule-device-offline";
  await state
    .insertInto("alert_rules")
    .values({
      id: ruleId,
      name: "Device offline",
      source_type: "device",
      device_id: "device-alert",
      condition: "offline",
      severity: "critical",
      created_at_ms: 100,
      updated_at_ms: 100,
    })
    .executeTakeFirstOrThrow();
  const revision = await state
    .insertInto("state_revisions")
    .values({
      committed_at_ms: 100,
      actor: "schema-test",
      mutation_type: "alert.opened",
      summary: "Opened test alert",
    })
    .returning("revision")
    .executeTakeFirstOrThrow();
  const alertId = "alert-offline";
  await state
    .insertInto("active_alerts")
    .values({
      id: alertId,
      alert_rule_id: ruleId,
      deduplication_key: "device:device-alert",
      state: "open",
      opened_at_ms: 100,
      last_observed_at_ms: 100,
    })
    .executeTakeFirstOrThrow();
  return { alertId, revision: revision.revision, ruleId };
}

describe("002 runtime state constraints", () => {
  it("bounds compiled schedule artifacts and permits revision zero without a foreign key", async () => {
    await insertDevice("device-schedule");
    await state
      .insertInto("device_schedule_artifacts")
      .values({
        device_id: "device-schedule",
        source_state_revision: 0,
        compile_status: "succeeded",
        desired_schedule_hash: "4294967295",
        compiled_payload_json: '{"c":[]}',
        compiled_payload_schema_version: 1,
        byte_count: 8,
        delivery_status: "not_required",
        compiled_at_ms: 100,
        delivery_updated_at_ms: 100,
        created_at_ms: 100,
        updated_at_ms: 100,
      })
      .executeTakeFirstOrThrow();

    await state
      .updateTable("device_schedule_artifacts")
      .set({ byte_count: 4_095 })
      .where("device_id", "=", "device-schedule")
      .executeTakeFirstOrThrow();
    await expect(
      sql`UPDATE device_schedule_artifacts SET byte_count = 4096 WHERE device_id = 'device-schedule'`.execute(
        state,
      ),
    ).rejects.toThrow(/CHECK constraint/i);
    await expect(
      sql`UPDATE device_schedule_artifacts SET desired_schedule_hash = '4294967296' WHERE device_id = 'device-schedule'`.execute(
        state,
      ),
    ).rejects.toThrow(/CHECK constraint/i);
    await expect(
      sql`UPDATE device_schedule_artifacts SET desired_schedule_hash = '0001' WHERE device_id = 'device-schedule'`.execute(
        state,
      ),
    ).rejects.toThrow(/CHECK constraint/i);
    await expect(
      sql`UPDATE device_schedule_artifacts SET compiled_payload_json = 'invalid' WHERE device_id = 'device-schedule'`.execute(
        state,
      ),
    ).rejects.toThrow(/CHECK constraint/i);
    await expect(
      sql`UPDATE device_schedule_artifacts SET source_state_revision = -1 WHERE device_id = 'device-schedule'`.execute(
        state,
      ),
    ).rejects.toThrow(/CHECK constraint/i);
    await expect(
      sql`UPDATE device_schedule_artifacts SET delivery_status = 'pending' WHERE device_id = 'device-schedule'`.execute(
        state,
      ),
    ).rejects.toThrow(/CHECK constraint/i);
  });

  it("persists bounded daily guards and case-sensitive scoped keys", async () => {
    const dayStart = 1_728_000_000_000;
    await state
      .insertInto("scheduler_guards")
      .values([
        {
          job_key: "daily-sync",
          scope_key: "Device-A",
          last_started_utc_day_start_ms: dayStart,
          last_started_at_ms: dayStart + 1_000,
          last_success_utc_day_start_ms: dayStart,
          last_success_at_ms: dayStart + 2_000,
          created_at_ms: dayStart,
          updated_at_ms: dayStart + 2_000,
        },
        {
          job_key: "daily-sync",
          scope_key: "device-a",
          created_at_ms: dayStart,
          updated_at_ms: dayStart,
        },
      ])
      .execute();

    expect(
      await state
        .selectFrom("scheduler_guards")
        .select(({ fn }) => fn.countAll<number>().as("count"))
        .executeTakeFirstOrThrow(),
    ).toEqual({ count: 2 });
    await expect(
      sql`
        INSERT INTO scheduler_guards (
          job_key, scope_key, last_started_utc_day_start_ms,
          created_at_ms, updated_at_ms
        ) VALUES ('invalid-pair', 'global', ${dayStart}, ${dayStart}, ${dayStart})
      `.execute(state),
    ).rejects.toThrow(/CHECK constraint/i);
    await expect(
      sql`
        INSERT INTO scheduler_guards (
          job_key, scope_key, last_success_utc_day_start_ms,
          last_success_at_ms, created_at_ms, updated_at_ms
        ) VALUES (
          'invalid-day', 'global', ${dayStart + 1},
          ${dayStart + 2_000}, ${dayStart}, ${dayStart + 2_000}
        )
      `.execute(state),
    ).rejects.toThrow(/CHECK constraint/i);
  });

  it("enforces durable pending observation chronology, JSON versioning, and binary deduplication", async () => {
    const { ruleId } = await insertAlertParents();
    const observationJson = JSON.stringify({
      sourceType: "device",
      sourceId: "device-alert",
      status: "offline",
    });
    await state
      .insertInto("alert_condition_states")
      .values([
        {
          alert_rule_id: ruleId,
          deduplication_key: "Pending",
          source_type: "device",
          source_id: "device-alert",
          pending_since_ms: 100,
          last_observed_at_ms: 100,
          observation_json: observationJson,
          observation_schema_version: 1,
          created_at_ms: 100,
          updated_at_ms: 100,
        },
        {
          alert_rule_id: ruleId,
          deduplication_key: "pending",
          source_type: "device",
          source_id: "device-alert",
          pending_since_ms: 100,
          last_observed_at_ms: 101,
          observation_json: observationJson,
          observation_schema_version: 1,
          created_at_ms: 100,
          updated_at_ms: 101,
        },
      ])
      .execute();

    await expect(
      sql`
        UPDATE alert_condition_states
        SET last_observed_at_ms = 99
        WHERE alert_rule_id = ${ruleId} AND deduplication_key = 'Pending'
      `.execute(state),
    ).rejects.toThrow(/CHECK constraint/i);
    await expect(
      sql`
        UPDATE alert_condition_states
        SET observation_json = 'not-json'
        WHERE alert_rule_id = ${ruleId} AND deduplication_key = 'Pending'
      `.execute(state),
    ).rejects.toThrow(/CHECK constraint/i);
    await expect(
      sql`
        UPDATE alert_condition_states
        SET observation_schema_version = 0
        WHERE alert_rule_id = ${ruleId} AND deduplication_key = 'Pending'
      `.execute(state),
    ).rejects.toThrow(/CHECK constraint/i);
  });

  it("limits notification intents to one automatic attempt and one destination per transition", async () => {
    const { alertId, revision } = await insertAlertParents();
    const notificationJson = JSON.stringify({
      schemaVersion: 1,
      kind: "aquarium.alert",
      eventRevision: revision,
    });
    await state
      .insertInto("notification_deliveries")
      .values({
        alert_transition_revision: revision,
        alert_id: alertId,
        transition: "opened",
        destination_kind: "webhook",
        destination_key: "primary",
        deduplication_key: `${revision}:primary`,
        notification_json: notificationJson,
        notification_schema_version: 1,
        created_at_ms: 100,
        updated_at_ms: 100,
      })
      .executeTakeFirstOrThrow();

    await expect(
      state
        .insertInto("notification_deliveries")
        .values({
          alert_transition_revision: revision,
          alert_id: alertId,
          transition: "opened",
          destination_kind: "webhook",
          destination_key: "primary",
          deduplication_key: `${revision}:different-key`,
          notification_json: notificationJson,
          notification_schema_version: 1,
          created_at_ms: 100,
          updated_at_ms: 100,
        })
        .execute(),
    ).rejects.toThrow(/UNIQUE constraint/i);
    await expect(
      sql`
        UPDATE notification_deliveries
        SET status = 'attempting', attempt_count = 0,
            attempt_started_at_ms = 100
        WHERE deduplication_key = ${`${revision}:primary`}
      `.execute(state),
    ).rejects.toThrow(/CHECK constraint/i);
    await expect(
      sql`
        UPDATE notification_deliveries
        SET attempt_count = 2
        WHERE deduplication_key = ${`${revision}:primary`}
      `.execute(state),
    ).rejects.toThrow(/CHECK constraint/i);
    await expect(
      state
        .updateTable("notification_deliveries")
        .set({ outcome_audit_recorded_at_ms: 100 })
        .where("deduplication_key", "=", `${revision}:primary`)
        .executeTakeFirstOrThrow(),
    ).rejects.toThrow(/CHECK constraint/i);
    await expect(
      sql`
        UPDATE notification_deliveries
        SET notification_json = 'not-json'
        WHERE deduplication_key = ${`${revision}:primary`}
      `.execute(state),
    ).rejects.toThrow(/CHECK constraint/i);

    await state
      .updateTable("notification_deliveries")
      .set({
        status: "attempting",
        attempt_count: 1,
        attempt_started_at_ms: 101,
        updated_at_ms: 101,
      })
      .where("deduplication_key", "=", `${revision}:primary`)
      .executeTakeFirstOrThrow();
    await state
      .updateTable("notification_deliveries")
      .set({
        status: "outcome_unknown",
        completed_at_ms: 102,
        updated_at_ms: 102,
        last_error_code: "controller-restarted",
        last_error_message: "Delivery was in flight during restart",
      })
      .where("deduplication_key", "=", `${revision}:primary`)
      .executeTakeFirstOrThrow();
    await state
      .updateTable("notification_deliveries")
      .set({ outcome_audit_recorded_at_ms: 103 })
      .where("deduplication_key", "=", `${revision}:primary`)
      .executeTakeFirstOrThrow();
    expect(
      await state
        .selectFrom("notification_deliveries")
        .select(["status", "attempt_count", "outcome_audit_recorded_at_ms"])
        .executeTakeFirstOrThrow(),
    ).toEqual({
      status: "outcome_unknown",
      attempt_count: 1,
      outcome_audit_recorded_at_ms: 103,
    });
  });
});

interface IndexedColumn {
  readonly name: string;
  readonly descending: number;
}

async function readIndexedColumns<DatabaseSchema>(
  database: Kysely<DatabaseSchema>,
  indexName: string,
): Promise<readonly IndexedColumn[]> {
  const result = await sql<IndexedColumn>`
    SELECT name, "desc" AS descending
    FROM pragma_index_xinfo(${indexName})
    WHERE key = 1
    ORDER BY seqno
  `.execute(database);
  return result.rows;
}

describe("002 runtime query indexes", () => {
  it("uses stable state and log cursor columns in the declared order", async () => {
    await expect(
      readIndexedColumns(state, "device_schedule_artifacts_delivery_idx"),
    ).resolves.toEqual([
      { name: "delivery_status", descending: 0 },
      { name: "updated_at_ms", descending: 0 },
      { name: "device_id", descending: 0 },
    ]);
    await expect(
      readIndexedColumns(state, "notification_deliveries_alert_idx"),
    ).resolves.toEqual([
      { name: "alert_id", descending: 0 },
      { name: "created_at_ms", descending: 1 },
      { name: "id", descending: 1 },
    ]);
    await expect(
      readIndexedColumns(state, "notification_deliveries_pending_audit_idx"),
    ).resolves.toEqual([
      { name: "completed_at_ms", descending: 0 },
      { name: "id", descending: 0 },
    ]);
    await expect(
      readIndexedColumns(
        events,
        "interactions_notification_delivery_operation_idx",
      ),
    ).resolves.toEqual([{ name: "operation_id", descending: 0 }]);
    await expect(
      readIndexedColumns(events, "interactions_direction_cursor_idx"),
    ).resolves.toEqual([
      { name: "direction", descending: 0 },
      { name: "occurred_at_ms", descending: 1 },
      { name: "id", descending: 1 },
    ]);
    await expect(
      readIndexedColumns(events, "interactions_correlation_cursor_idx"),
    ).resolves.toEqual([
      { name: "correlation_id", descending: 0 },
      { name: "occurred_at_ms", descending: 1 },
      { name: "id", descending: 1 },
    ]);
  });
});
