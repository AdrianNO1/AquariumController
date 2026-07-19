import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { openStateDatabase } from "./connection.js";
import {
  DEFAULT_NOTIFICATION_DELIVERY_DELETE_BATCH_SIZE,
  DEFAULT_NOTIFICATION_DELIVERY_RETENTION_MS,
  MAX_NOTIFICATION_DELIVERY_DELETE_BATCH_SIZE,
  NotificationDeliveryRetentionRepository,
} from "./notification-delivery-retention.js";
import { StateRevisionRetentionRepository } from "./state-revision-retention.js";
import { commitStateChange } from "./state-outbox.js";
import type {
  AlertNotificationTransition,
  NotificationDeliveryStatus,
  StateDatabaseSchema,
} from "./types.js";

const DAY_MS = 24 * 60 * 60 * 1_000;
const NOW_MS = 200 * DAY_MS;
const CUTOFF_MS = 20 * DAY_MS;

let database: Kysely<StateDatabaseSchema>;
let retention: NotificationDeliveryRetentionRepository;

beforeEach(async () => {
  database = await openStateDatabase({ filename: ":memory:" });
  retention = new NotificationDeliveryRetentionRepository(database);
  await seedAlertParents("alert-main");
});

afterEach(async () => {
  await database.destroy();
});

describe("notification delivery retention", () => {
  it("prunes old terminal flap history while preserving the newest terminal outcome", async () => {
    const oldIds = [
      await insertDelivery({
        alertId: "alert-main",
        transition: "opened",
        status: "delivered",
        completedAtMs: 1,
      }),
      await insertDelivery({
        alertId: "alert-main",
        transition: "recovered",
        status: "failed",
        completedAtMs: 2,
      }),
      await insertDelivery({
        alertId: "alert-main",
        transition: "reopened",
        status: "outcome_unknown",
        completedAtMs: 3,
      }),
    ];
    const newestId = await insertDelivery({
      alertId: "alert-main",
      transition: "recovered",
      status: "delivered",
      completedAtMs: 4,
    });

    await expect(
      retention.pruneHistoricalDeliveries({ nowMs: NOW_MS }),
    ).resolves.toEqual({ cutoffMs: CUTOFF_MS, deletedCount: 3 });
    await expect(readDeliveryIds()).resolves.toEqual([newestId]);
    expect(oldIds).not.toContain(newestId);
  });

  it("uses a strict age boundary", async () => {
    const olderId = await insertDelivery({
      alertId: "alert-main",
      transition: "opened",
      status: "delivered",
      completedAtMs: CUTOFF_MS - 1,
    });
    const boundaryId = await insertDelivery({
      alertId: "alert-main",
      transition: "acknowledged",
      status: "failed",
      completedAtMs: CUTOFF_MS,
    });
    const newestId = await insertDelivery({
      alertId: "alert-main",
      transition: "recovered",
      status: "delivered",
      completedAtMs: CUTOFF_MS + 1,
    });

    await expect(
      retention.pruneHistoricalDeliveries({ nowMs: NOW_MS }),
    ).resolves.toEqual({ cutoffMs: CUTOFF_MS, deletedCount: 1 });
    await expect(readDeliveryIds()).resolves.toEqual([boundaryId, newestId]);
    expect(olderId).not.toBe(boundaryId);
  });

  it("never removes pending or attempting deliveries regardless of age", async () => {
    const pendingId = await insertDelivery({
      alertId: "alert-main",
      transition: "opened",
      status: "pending",
      completedAtMs: null,
    });
    const attemptingId = await insertDelivery({
      alertId: "alert-main",
      transition: "acknowledged",
      status: "attempting",
      completedAtMs: null,
    });
    const oldTerminalId = await insertDelivery({
      alertId: "alert-main",
      transition: "recovered",
      status: "failed",
      completedAtMs: 2,
    });
    const newestTerminalId = await insertDelivery({
      alertId: "alert-main",
      transition: "reopened",
      status: "delivered",
      completedAtMs: 3,
    });

    await expect(
      retention.pruneHistoricalDeliveries({ nowMs: NOW_MS }),
    ).resolves.toMatchObject({ deletedCount: 1 });
    await expect(readDeliveryIds()).resolves.toEqual([
      pendingId,
      attemptingId,
      newestTerminalId,
    ]);
    expect(oldTerminalId).not.toBe(newestTerminalId);
  });

  it("never removes a terminal delivery whose audit outcome is still pending", async () => {
    const unauditedId = await insertDelivery({
      alertId: "alert-main",
      transition: "opened",
      status: "failed",
      completedAtMs: 1,
      outcomeAuditRecordedAtMs: null,
    });
    const newestId = await insertDelivery({
      alertId: "alert-main",
      transition: "recovered",
      status: "delivered",
      completedAtMs: 2,
    });

    await expect(
      retention.pruneHistoricalDeliveries({ nowMs: NOW_MS }),
    ).resolves.toMatchObject({ deletedCount: 0 });
    await expect(readDeliveryIds()).resolves.toEqual([unauditedId, newestId]);
  });

  it("preserves the newest terminal outcome independently per alert and destination", async () => {
    await seedAlertParents("alert-secondary");
    const expectedIds: number[] = [];
    for (const alertId of ["alert-main", "alert-secondary"] as const) {
      for (const destinationKey of ["primary", "backup"] as const) {
        await insertDelivery({
          alertId,
          destinationKey,
          transition: "opened",
          status: "failed",
          completedAtMs: 1,
        });
        expectedIds.push(
          await insertDelivery({
            alertId,
            destinationKey,
            transition: "recovered",
            status: "delivered",
            completedAtMs: 2,
          }),
        );
      }
    }

    await expect(
      retention.pruneHistoricalDeliveries({ nowMs: NOW_MS }),
    ).resolves.toMatchObject({ deletedCount: 4 });
    await expect(readDeliveryIds()).resolves.toEqual(expectedIds);
  });

  it("drains deterministic bounded batches and is idempotent", async () => {
    for (let index = 1; index <= 7; index += 1) {
      await insertDelivery({
        alertId: "alert-main",
        transition: index % 2 === 0 ? "recovered" : "reopened",
        status: index % 2 === 0 ? "failed" : "delivered",
        completedAtMs: index,
      });
    }
    const newestId = await insertDelivery({
      alertId: "alert-main",
      transition: "recovered",
      status: "delivered",
      completedAtMs: 8,
    });

    await expect(
      retention.pruneHistoricalDeliveries({
        nowMs: NOW_MS,
        batchSize: 2,
      }),
    ).resolves.toEqual({ cutoffMs: CUTOFF_MS, deletedCount: 7 });
    await expect(readDeliveryIds()).resolves.toEqual([newestId]);
    await expect(
      retention.pruneHistoricalDeliveries({
        nowMs: NOW_MS,
        batchSize: 2,
      }),
    ).resolves.toEqual({ cutoffMs: CUTOFF_MS, deletedCount: 0 });

    expect(DEFAULT_NOTIFICATION_DELIVERY_RETENTION_MS).toBe(180 * DAY_MS);
    expect(DEFAULT_NOTIFICATION_DELIVERY_DELETE_BATCH_SIZE).toBe(1_000);
    expect(MAX_NOTIFICATION_DELIVERY_DELETE_BATCH_SIZE).toBe(10_000);
    for (const batchSize of [0, -1, 1.5, 10_001, NaN, Infinity]) {
      await expect(
        retention.pruneHistoricalDeliveries({ nowMs: NOW_MS, batchSize }),
      ).rejects.toThrow();
    }
  });

  it("allows orphan revision retention to remove revisions released by delivery pruning", async () => {
    const oldId = await insertDelivery({
      alertId: "alert-main",
      transition: "opened",
      status: "failed",
      completedAtMs: 1,
    });
    const newestId = await insertDelivery({
      alertId: "alert-main",
      transition: "recovered",
      status: "delivered",
      completedAtMs: 2,
    });
    const deliveries = await database
      .selectFrom("notification_deliveries")
      .select(["id", "alert_transition_revision"])
      .orderBy("id")
      .execute();
    const oldRevision = deliveries.find(
      ({ id }) => id === oldId,
    )?.alert_transition_revision;
    const newestRevision = deliveries.find(
      ({ id }) => id === newestId,
    )?.alert_transition_revision;
    if (oldRevision === undefined || newestRevision === undefined) {
      throw new Error("Expected both notification delivery revisions");
    }
    await database.deleteFrom("state_outbox").execute();
    const revisionRetention = new StateRevisionRetentionRepository(database);

    await expect(revisionRetention.pruneOrphanedRevisions()).resolves.toEqual({
      deletedCount: 0,
    });
    await expect(
      retention.pruneHistoricalDeliveries({ nowMs: NOW_MS }),
    ).resolves.toMatchObject({ deletedCount: 1 });
    await expect(revisionRetention.pruneOrphanedRevisions()).resolves.toEqual({
      deletedCount: 1,
    });
    await expect(readRevisions()).resolves.toEqual([newestRevision]);
    expect(oldRevision).not.toBe(newestRevision);
  });
});

async function seedAlertParents(alertId: string): Promise<void> {
  const deviceId = `device-${alertId}`;
  const ruleId = `rule-${alertId}`;
  await database
    .insertInto("devices")
    .values({
      id: deviceId,
      hardware_id: `hardware-${alertId}`,
      name: alertId,
      desired_pwm_frequency_hz: 1_000,
      desired_pwm_resolution_bits: 8,
      created_at_ms: 0,
      updated_at_ms: 0,
    })
    .executeTakeFirstOrThrow();
  await database
    .insertInto("alert_rules")
    .values({
      id: ruleId,
      name: alertId,
      source_type: "device",
      device_id: deviceId,
      output_id: null,
      sensor_id: null,
      switch_id: null,
      condition: "offline",
      threshold: null,
      severity: "critical",
      created_at_ms: 0,
      updated_at_ms: 0,
    })
    .executeTakeFirstOrThrow();
  await database
    .insertInto("active_alerts")
    .values({
      id: alertId,
      alert_rule_id: ruleId,
      deduplication_key: alertId,
      state: "recovered",
      opened_at_ms: 0,
      last_observed_at_ms: NOW_MS,
      recovered_at_ms: NOW_MS,
    })
    .executeTakeFirstOrThrow();
}

async function insertDelivery(input: {
  readonly alertId: string;
  readonly destinationKey?: string;
  readonly transition: AlertNotificationTransition;
  readonly status: NotificationDeliveryStatus;
  readonly completedAtMs: number | null;
  readonly outcomeAuditRecordedAtMs?: number | null;
}): Promise<number> {
  const revision = await createRevision();
  const destinationKey = input.destinationKey ?? "primary";
  const createdAtMs = input.completedAtMs ?? 1;
  const terminal = ["delivered", "failed", "outcome_unknown"].includes(
    input.status,
  );
  const failed =
    input.status === "failed" || input.status === "outcome_unknown";
  const result = await database
    .insertInto("notification_deliveries")
    .values({
      alert_transition_revision: revision,
      alert_id: input.alertId,
      transition: input.transition,
      destination_kind: "webhook",
      destination_key: destinationKey,
      deduplication_key: `${revision}:webhook:${destinationKey}`,
      status: input.status,
      attempt_count: input.status === "pending" ? 0 : 1,
      notification_json: JSON.stringify({ revision }),
      notification_schema_version: 1,
      created_at_ms: createdAtMs,
      attempt_started_at_ms: input.status === "pending" ? null : createdAtMs,
      completed_at_ms: terminal ? input.completedAtMs : null,
      updated_at_ms: input.completedAtMs ?? createdAtMs,
      last_error_code: failed ? "test-error" : null,
      last_error_message: failed ? "Sanitized test failure" : null,
      outcome_audit_recorded_at_ms:
        input.outcomeAuditRecordedAtMs === undefined
          ? terminal
            ? input.completedAtMs
            : null
          : input.outcomeAuditRecordedAtMs,
    })
    .executeTakeFirstOrThrow();
  const id = Number(result.insertId);
  if (!Number.isSafeInteger(id) || id < 1) {
    throw new Error("Expected a positive notification delivery identifier");
  }
  return id;
}

async function createRevision(): Promise<number> {
  const revision =
    (
      await database
        .selectFrom("state_revisions")
        .select(({ fn }) => fn.max<number>("revision").as("revision"))
        .executeTakeFirstOrThrow()
    ).revision ?? 0;
  const nextRevision = revision + 1;
  const committed = await commitStateChange(
    database,
    {
      actor: "notification-retention-test",
      mutationType: "alert.transitioned",
      summary: `Alert transition ${nextRevision}`,
      eventType: "alert.transitioned",
      entityType: "alert",
      entityId: "alert-main",
      occurredAtMs: nextRevision,
      retentionClass: "audit",
      payloadJson: JSON.stringify({ revision: nextRevision }),
      payloadSchemaVersion: 1,
    },
    async () => undefined,
  );
  return committed.revision;
}

async function readDeliveryIds(): Promise<number[]> {
  return (
    await database
      .selectFrom("notification_deliveries")
      .select("id")
      .orderBy("id")
      .execute()
  ).map(({ id }) => id);
}

async function readRevisions(): Promise<number[]> {
  return (
    await database
      .selectFrom("state_revisions")
      .select("revision")
      .orderBy("revision")
      .execute()
  ).map(({ revision }) => revision);
}
