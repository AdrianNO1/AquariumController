import type { Kysely } from "kysely";
import { afterEach, describe, expect, it } from "vitest";

import { openStateDatabase } from "./connection.js";
import {
  DEFAULT_STATE_REVISION_DELETE_BATCH_SIZE,
  MAX_STATE_REVISION_DELETE_BATCH_SIZE,
  StateRevisionRetentionRepository,
} from "./state-revision-retention.js";
import { commitStateChange } from "./state-outbox.js";
import type { StateDatabaseSchema } from "./types.js";

const openDatabases: Kysely<StateDatabaseSchema>[] = [];

afterEach(async () => {
  await Promise.all(
    openDatabases.splice(0).map((database) => database.destroy()),
  );
});

describe("state revision retention", () => {
  it("deletes orphan metadata in bounded batches without crossing live references or the current revision", async () => {
    const database = await openStateDatabase({ filename: ":memory:" });
    openDatabases.push(database);
    await createRevisions(database, 7);
    await createNotificationReference(database, 4);
    await database
      .updateTable("state_outbox")
      .set({ published_at_ms: 100 })
      .where("revision", "=", 5)
      .executeTakeFirstOrThrow();
    await database
      .deleteFrom("state_outbox")
      .where("revision", "in", [1, 2, 3, 4, 7])
      .executeTakeFirstOrThrow();
    const repository = new StateRevisionRetentionRepository(database);

    await expect(
      repository.pruneOrphanedRevisions({ batchSize: 2 }),
    ).resolves.toEqual({ deletedCount: 3 });

    await expect(readRevisions(database)).resolves.toEqual([4, 5, 6, 7]);
    await expect(
      database
        .selectFrom("state_outbox")
        .select(["revision", "published_at_ms"])
        .orderBy("revision")
        .execute(),
    ).resolves.toEqual([
      { revision: 5, published_at_ms: 100 },
      { revision: 6, published_at_ms: null },
    ]);
    await expect(
      database
        .selectFrom("notification_deliveries")
        .select("alert_transition_revision")
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ alert_transition_revision: 4 });

    const laterCommit = await createRevision(database, 8);
    expect(laterCommit).toBe(8);
    await expect(
      repository.pruneOrphanedRevisions({ batchSize: 2 }),
    ).resolves.toEqual({ deletedCount: 1 });
    await expect(readRevisions(database)).resolves.toEqual([4, 5, 6, 8]);
  });

  it("is a no-op for an empty database and strictly rejects unsafe batch sizes", async () => {
    const database = await openStateDatabase({ filename: ":memory:" });
    openDatabases.push(database);
    const repository = new StateRevisionRetentionRepository(database);

    await expect(repository.pruneOrphanedRevisions()).resolves.toEqual({
      deletedCount: 0,
    });
    expect(DEFAULT_STATE_REVISION_DELETE_BATCH_SIZE).toBe(1_000);
    expect(MAX_STATE_REVISION_DELETE_BATCH_SIZE).toBe(10_000);

    for (const batchSize of [0, -1, 1.5, 10_001, NaN, Infinity]) {
      await expect(
        repository.pruneOrphanedRevisions({ batchSize }),
      ).rejects.toThrow("batchSize");
    }
  });
});

async function createRevisions(
  database: Kysely<StateDatabaseSchema>,
  count: number,
): Promise<void> {
  for (let revision = 1; revision <= count; revision += 1) {
    expect(await createRevision(database, revision)).toBe(revision);
  }
}

async function createRevision(
  database: Kysely<StateDatabaseSchema>,
  index: number,
): Promise<number> {
  const committed = await commitStateChange(
    database,
    {
      actor: "test-suite",
      mutationType: "test.change",
      summary: `Test change ${index}`,
      eventType: "test.changed",
      entityType: "channel",
      entityId: String(index),
      occurredAtMs: index,
      retentionClass: "audit",
      payloadJson: JSON.stringify({ index }),
      payloadSchemaVersion: 1,
    },
    async () => undefined,
  );
  return committed.revision;
}

async function readRevisions(
  database: Kysely<StateDatabaseSchema>,
): Promise<number[]> {
  const rows = await database
    .selectFrom("state_revisions")
    .select("revision")
    .orderBy("revision")
    .execute();
  return rows.map(({ revision }) => revision);
}

async function createNotificationReference(
  database: Kysely<StateDatabaseSchema>,
  revision: number,
): Promise<void> {
  await database
    .insertInto("devices")
    .values({
      id: "device-main",
      hardware_id: "hardware-main",
      name: "Main device",
      desired_pwm_frequency_hz: 1_000,
      desired_pwm_resolution_bits: 8,
      created_at_ms: 0,
      updated_at_ms: 0,
    })
    .executeTakeFirstOrThrow();
  await database
    .insertInto("alert_rules")
    .values({
      id: "rule-main",
      name: "Main rule",
      source_type: "device",
      device_id: "device-main",
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
      id: "alert-main",
      alert_rule_id: "rule-main",
      deduplication_key: "device-main",
      state: "open",
      opened_at_ms: revision,
      last_observed_at_ms: revision,
    })
    .executeTakeFirstOrThrow();
  await database
    .insertInto("notification_deliveries")
    .values({
      alert_transition_revision: revision,
      alert_id: "alert-main",
      transition: "opened",
      destination_kind: "webhook",
      destination_key: "primary",
      deduplication_key: `${revision}:webhook:primary`,
      notification_json: JSON.stringify({ test: true }),
      notification_schema_version: 1,
      created_at_ms: revision,
      updated_at_ms: revision,
    })
    .executeTakeFirstOrThrow();
}
