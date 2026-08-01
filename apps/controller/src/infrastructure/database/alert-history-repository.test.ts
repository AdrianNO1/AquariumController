import type { Kysely } from "kysely";
import { afterEach, describe, expect, it } from "vitest";

import { CONTROLLER_STORAGE_HEALTH_DEVICE_ID } from "../../application/maintenance/controller-storage-health-service.js";
import {
  ALERT_HISTORY_DELIVERY_LIMIT,
  AlertHistoryRepository,
  InvalidAlertHistoryCursorError,
  InvalidPersistedAlertHistoryError,
  openStateDatabase,
  type StateDatabaseSchema,
} from "./index.js";

const openDatabases: Kysely<StateDatabaseSchema>[] = [];

async function createDatabase(): Promise<Kysely<StateDatabaseSchema>> {
  const database = await openStateDatabase({ filename: ":memory:" });
  openDatabases.push(database);
  await database
    .insertInto("devices")
    .values({
      id: "device-main",
      hardware_id: "hardware-main",
      name: "Main",
      desired_pwm_frequency_hz: 1_000,
      desired_pwm_resolution_bits: 8,
      created_at_ms: 0,
      updated_at_ms: 0,
    })
    .executeTakeFirstOrThrow();
  await database
    .insertInto("alert_rules")
    .values({
      id: "rule-offline",
      name: "Device offline",
      source_type: "device",
      device_id: "device-main",
      condition: "offline",
      threshold: null,
      delay_ms: 0,
      severity: "critical",
      created_at_ms: 0,
      updated_at_ms: 0,
      configuration_json: '{"schemaVersion":1}',
      configuration_schema_version: 1,
    })
    .executeTakeFirstOrThrow();
  await database
    .insertInto("state_revisions")
    .values({
      revision: 1,
      committed_at_ms: 1_000,
      actor: "test-suite",
      mutation_type: "alert.open",
      summary: "Open test alert",
    })
    .executeTakeFirstOrThrow();
  await database
    .insertInto("active_alerts")
    .values([
      {
        id: "alert-open",
        alert_rule_id: "rule-offline",
        deduplication_key: "device:open",
        state: "open",
        opened_at_ms: 1_000,
        last_observed_at_ms: 3_000,
      },
      {
        id: "alert-acknowledged",
        alert_rule_id: "rule-offline",
        deduplication_key: "device:acknowledged",
        state: "acknowledged",
        opened_at_ms: 1_000,
        last_observed_at_ms: 2_000,
        acknowledged_at_ms: 2_500,
      },
      {
        id: "alert-recovered",
        alert_rule_id: "rule-offline",
        deduplication_key: "device:recovered",
        state: "recovered",
        opened_at_ms: 500,
        last_observed_at_ms: 1_000,
        recovered_at_ms: 1_500,
      },
    ])
    .executeTakeFirstOrThrow();
  return database;
}

afterEach(async () => {
  await Promise.all(
    openDatabases.splice(0).map((database) => database.destroy()),
  );
});

describe("AlertHistoryRepository", () => {
  it("does not expose alerts attached to the internal storage-health owner", async () => {
    const database = await createDatabase();
    await database
      .insertInto("devices")
      .values({
        id: CONTROLLER_STORAGE_HEALTH_DEVICE_ID,
        hardware_id: CONTROLLER_STORAGE_HEALTH_DEVICE_ID,
        name: "Controller storage health",
        desired_pwm_frequency_hz: 1_000,
        desired_pwm_resolution_bits: 8,
        created_at_ms: 0,
        updated_at_ms: 0,
      })
      .executeTakeFirstOrThrow();
    await database
      .insertInto("alert_rules")
      .values({
        id: "rule-internal-device-health",
        name: "Internal storage owner health",
        source_type: "device",
        device_id: CONTROLLER_STORAGE_HEALTH_DEVICE_ID,
        condition: "not_online",
        threshold: null,
        delay_ms: 0,
        severity: "error",
        created_at_ms: 0,
        updated_at_ms: 0,
      })
      .executeTakeFirstOrThrow();
    await database
      .insertInto("active_alerts")
      .values({
        id: "alert-internal-device-health",
        alert_rule_id: "rule-internal-device-health",
        deduplication_key: "device:virtual-controller-storage",
        state: "open",
        opened_at_ms: 4_000,
        last_observed_at_ms: 4_000,
      })
      .executeTakeFirstOrThrow();

    const result = await new AlertHistoryRepository(database).list({
      state: "all",
      pageSize: 50,
    });

    expect(result.items.map((alert) => alert.id)).not.toContain(
      "alert-internal-device-health",
    );
  });

  it("filters active and recovered alerts and paginates in stable descending order", async () => {
    const repository = new AlertHistoryRepository(await createDatabase());

    const active = await repository.list({ state: "active", pageSize: 50 });
    expect(active.items.map((alert) => alert.id)).toEqual([
      "alert-open",
      "alert-acknowledged",
    ]);

    const first = await repository.list({ state: "all", pageSize: 2 });
    expect(first.items.map((alert) => alert.id)).toEqual([
      "alert-open",
      "alert-acknowledged",
    ]);
    expect(first.hasMore).toBe(true);
    expect(first.nextCursor).not.toBeNull();
    const second = await repository.list({
      state: "all",
      pageSize: 2,
      cursor: first.nextCursor ?? undefined,
    });
    expect(second.items.map((alert) => alert.id)).toEqual(["alert-recovered"]);
    expect(second.hasMore).toBe(false);

    const recovered = await repository.list({
      state: "recovered",
      pageSize: 50,
    });
    expect(recovered.items.map((alert) => alert.id)).toEqual([
      "alert-recovered",
    ]);
  });

  it("binds cursors to their filter and canonical encoding", async () => {
    const repository = new AlertHistoryRepository(await createDatabase());
    const first = await repository.list({ state: "all", pageSize: 1 });

    await expect(
      repository.list({
        state: "active",
        pageSize: 1,
        cursor: first.nextCursor ?? undefined,
      }),
    ).rejects.toBeInstanceOf(InvalidAlertHistoryCursorError);
    await expect(
      repository.list({ state: "all", pageSize: 1, cursor: "bm90LWpzb24" }),
    ).rejects.toBeInstanceOf(InvalidAlertHistoryCursorError);
  });

  it("bounds notification delivery history per alert and reports truncation", async () => {
    const database = await createDatabase();
    const notification = JSON.stringify({
      schemaVersion: 1,
      kind: "aquarium.alert",
      eventRevision: 1,
      occurredAt: new Date(1_000).toISOString(),
      transition: "opened",
      alert: {
        id: "alert-open",
        ruleId: "rule-offline",
        deduplicationKey: "device:open",
        state: "open",
        openedAtMs: 1_000,
        lastObservedAtMs: 3_000,
        acknowledgedAtMs: null,
        recoveredAtMs: null,
      },
      rule: {
        id: "rule-offline",
        name: "Device offline",
        sourceType: "device",
        sourceId: "device-main",
        condition: "offline",
        threshold: null,
        delayMs: 0,
        severity: "critical",
      },
      observation: {
        sourceType: "device",
        sourceId: "device-main",
        status: "offline",
      },
      note: null,
    });
    await database
      .insertInto("notification_deliveries")
      .values(
        Array.from(
          { length: ALERT_HISTORY_DELIVERY_LIMIT + 1 },
          (_, index) => ({
            alert_transition_revision: 1,
            alert_id: "alert-open",
            transition: "opened" as const,
            destination_kind: "webhook" as const,
            destination_key: `destination-${index}`,
            deduplication_key: `alert-open:opened:${index}`,
            status: "delivered" as const,
            attempt_count: 1,
            notification_json: notification,
            notification_schema_version: 1,
            created_at_ms: 4_000 + index * 3,
            attempt_started_at_ms: 4_001 + index * 3,
            completed_at_ms: 4_002 + index * 3,
            updated_at_ms: 4_002 + index * 3,
          }),
        ),
      )
      .executeTakeFirstOrThrow();

    const result = await new AlertHistoryRepository(database).list({
      state: "open",
      pageSize: 10,
    });

    expect(result.items[0]?.notificationDeliveries).toHaveLength(
      ALERT_HISTORY_DELIVERY_LIMIT,
    );
    expect(result.deliveriesTruncatedAlertIds).toEqual(["alert-open"]);
  });

  it("fails loudly without leaking malformed persisted detail documents", async () => {
    const database = await createDatabase();
    await database
      .updateTable("active_alerts")
      .set({
        details_json:
          '{"schemaVersion":1,"observation":null,"note":null,"note":"duplicate"}',
        details_schema_version: 1,
      })
      .where("id", "=", "alert-open")
      .executeTakeFirstOrThrow();

    await expect(
      new AlertHistoryRepository(database).list({
        state: "open",
        pageSize: 10,
      }),
    ).rejects.toBeInstanceOf(InvalidPersistedAlertHistoryError);
  });
});
