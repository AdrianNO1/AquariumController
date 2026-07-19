import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";

import type { Kysely } from "kysely";
import { afterEach, describe, expect, it } from "vitest";

import {
  openEventsDatabase,
  type EventsDatabaseSchema,
} from "../database/index.js";
import {
  createDailyEventArchive,
  createEventArchive,
  createSensitiveKeyRedactor,
  decodeEventArchiveBytes,
  deleteVerifiedEventArchiveRecords,
  InteractionRepository,
  readEventStorageUsage,
  runEventRetention,
  verifyCompleteEventArchive,
  type EventArchiveFileWriter,
} from "./index.js";

const DAY_MS = 24 * 60 * 60 * 1_000;

interface TestStorage {
  readonly database: Kysely<EventsDatabaseSchema>;
  readonly directory: string;
  readonly archiveDirectory: string;
}

const testStorages: TestStorage[] = [];

async function createTestStorage(): Promise<TestStorage> {
  const directory = await mkdtemp(join(tmpdir(), "aquarium-events-"));
  const storage = {
    database: await openEventsDatabase({
      filename: join(directory, "events.db"),
    }),
    directory,
    archiveDirectory: join(directory, "archives"),
  };
  testStorages.push(storage);
  return storage;
}

afterEach(async () => {
  const temporaryRoot = `${resolve(tmpdir())}${sep}`;
  while (testStorages.length > 0) {
    const storage = testStorages.pop();
    if (storage === undefined) continue;
    await storage.database.destroy();
    const resolvedDirectory = resolve(storage.directory);
    if (
      !resolvedDirectory.startsWith(temporaryRoot) ||
      !basename(resolvedDirectory).startsWith("aquarium-events-")
    ) {
      throw new Error(
        `Refusing to remove unexpected test directory: ${resolvedDirectory}`,
      );
    }
    await rm(resolvedDirectory, { recursive: true, force: true });
  }
});

describe("structured event storage", () => {
  it("validates, redacts, hashes, and validates structured payloads again on read", async () => {
    const { database } = await createTestStorage();
    const originalPayload = {
      command: "set",
      Authorization: "Bearer private",
      nested: {
        password: "fish-food",
        safe: true,
      },
    };
    const repository = new InteractionRepository(database, {
      redactPayload: createSensitiveKeyRedactor(),
    });
    const stored = await repository.log({
      occurredAtMs: 100,
      direction: "outbound",
      kind: "mqtt-command",
      severity: "info",
      topic: "test/aquarium/device/set",
      deviceId: "device-1",
      correlationId: "correlation-1",
      operationId: "operation-1",
      outcome: "succeeded",
      durationMs: 12,
      byteCount: 42,
      retentionClass: "operational",
      payload: originalPayload,
      payloadSchemaVersion: 1,
    });

    expect(stored.payload).toEqual({
      Authorization: "[REDACTED]",
      command: "set",
      nested: { password: "[REDACTED]", safe: true },
    });
    expect(stored.payloadSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(originalPayload.Authorization).toBe("Bearer private");
    expect(originalPayload.nested.password).toBe("fish-food");
    const persisted = await database
      .selectFrom("interactions")
      .select(["payload_json", "payload_sha256"])
      .where("id", "=", stored.id)
      .executeTakeFirstOrThrow();
    expect(persisted.payload_json).toBe(
      '{"Authorization":"[REDACTED]","command":"set","nested":{"password":"[REDACTED]","safe":true}}',
    );
    expect(persisted.payload_sha256).toBe(stored.payloadSha256);

    await database
      .updateTable("interactions")
      .set({ payload_json: "[]" })
      .where("id", "=", stored.id)
      .executeTakeFirstOrThrow();
    await expect(repository.getById(stored.id)).rejects.toThrow();
  });

  it("creates deterministic daily Zstandard NDJSON archives and round-trips every record type", async () => {
    const { database, archiveDirectory } = await createTestStorage();
    const repository = new InteractionRepository(database);
    const interaction = await repository.log({
      occurredAtMs: 1_000,
      direction: "inbound",
      kind: "mqtt-response",
      severity: "info",
      outcome: "succeeded",
      byteCount: 64,
      retentionClass: "raw",
      payload: { value: 42, device: "ESP-A" },
      payloadSchemaVersion: 1,
    });
    await database
      .insertInto("event_aggregates")
      .values({
        bucket_start_ms: 0,
        bucket_end_ms: 5_000,
        kind: "mqtt-response",
        device_id: "device-1",
        outcome: "succeeded",
        event_count: 3,
        error_count: 0,
        byte_count: 55,
        latency_total_ms: 9,
        latency_min_ms: 2,
        latency_max_ms: 4,
        retention_class: "aggregate",
        details_json: '{"schemaVersion":1}',
        details_schema_version: 1,
      })
      .executeTakeFirstOrThrow();
    await database
      .insertInto("state_events")
      .values({
        revision: 1,
        occurred_at_ms: 2_000,
        event_type: "schedule-updated",
        entity_type: "schedule",
        entity_id: "schedule-blue",
        retention_class: "audit",
        payload_json: '{"scheduleId":"schedule-blue"}',
        payload_schema_version: 1,
        byte_count: 31,
      })
      .executeTakeFirstOrThrow();

    const created = await createDailyEventArchive({
      database,
      archiveDirectory,
      utcDayMs: 123,
      nowMs: DAY_MS,
    });
    expect(created.archive.status).toBe("complete");
    expect(created.archive.eventCount).toBe(3);
    expect(created.records.map((record) => record.recordType)).toEqual([
      "interaction",
      "state-event",
      "aggregate",
    ]);
    const compressed = await readFile(
      join(archiveDirectory, created.archive.storagePath),
    );
    expect(decodeEventArchiveBytes(compressed)).toEqual(created.records);
    expect(
      (
        await verifyCompleteEventArchive(
          database,
          archiveDirectory,
          created.archive.id,
        )
      ).records,
    ).toEqual(created.records);

    const repeated = await createDailyEventArchive({
      database,
      archiveDirectory,
      utcDayMs: 123,
      nowMs: DAY_MS,
    });
    expect(repeated.created).toBe(false);
    expect(repeated.archive.id).toBe(created.archive.id);

    const deleted = await deleteVerifiedEventArchiveRecords(
      database,
      archiveDirectory,
      created.archive.id,
    );
    expect(deleted).toEqual({
      interactionsDeleted: 1,
      aggregatesDeleted: 1,
      stateEventsDeleted: 1,
    });
    expect(
      await database.selectFrom("interactions").selectAll().execute(),
    ).toEqual([]);
    expect(
      await database.selectFrom("event_aggregates").selectAll().execute(),
    ).toEqual([]);
    expect(
      await database.selectFrom("state_events").select("revision").execute(),
    ).toEqual([]);
    expect(interaction.id).toBeGreaterThan(0);
  });

  it("keeps a concurrent completed archive verified and consumable", async () => {
    const { database, archiveDirectory } = await createTestStorage();
    const repository = new InteractionRepository(database);
    const interaction = await repository.log({
      occurredAtMs: 10,
      direction: "internal",
      kind: "concurrent-archive-source",
      severity: "info",
      outcome: "succeeded",
      byteCount: 20,
      retentionClass: "audit",
      payload: { source: "same-content" },
      payloadSchemaVersion: 1,
    });
    let writerArrivals = 0;
    let releaseFirstWriter = (): void => {
      throw new Error("Archive writer barrier was not initialized");
    };
    const secondWriterFinished = new Promise<void>((resolveBarrier) => {
      releaseFirstWriter = resolveBarrier;
    });
    const coordinatedWriter: EventArchiveFileWriter = {
      async writeAtomically(filename, contents): Promise<void> {
        writerArrivals += 1;
        if (writerArrivals === 1) {
          await secondWriterFinished;
          return;
        }
        if (writerArrivals !== 2) {
          throw new Error(`Unexpected archive writer ${writerArrivals}`);
        }
        try {
          await mkdir(dirname(filename), { recursive: true });
          await writeFile(filename, contents, { flag: "wx" });
        } finally {
          releaseFirstWriter();
        }
      },
    };
    const createConcurrentArchive = () =>
      createEventArchive({
        database,
        archiveDirectory,
        rangeStartMs: 0,
        rangeEndMs: 100,
        nowMs: 100,
        selection: {
          interactionIds: [interaction.id],
          aggregateIds: [],
          stateEventRevisions: [],
        },
        fileWriter: coordinatedWriter,
      });

    const creations = await Promise.all([
      createConcurrentArchive(),
      createConcurrentArchive(),
    ]);

    expect(writerArrivals).toBe(2);
    expect(creations.filter((creation) => creation.created)).toHaveLength(1);
    expect(new Set(creations.map((creation) => creation.archive.id)).size).toBe(
      1,
    );
    const archiveId = creations[0]?.archive.id;
    expect(archiveId).toBeDefined();
    if (archiveId === undefined) {
      throw new Error("Concurrent archive creation returned no archive");
    }
    await expect(
      database
        .selectFrom("event_archives")
        .select("status")
        .where("id", "=", archiveId)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ status: "complete" });
    const verified = await verifyCompleteEventArchive(
      database,
      archiveDirectory,
      archiveId,
    );
    expect(verified.records).toHaveLength(1);
    await expect(
      database.selectFrom("interactions").select("id").execute(),
    ).resolves.toEqual([{ id: interaction.id }]);

    await expect(
      deleteVerifiedEventArchiveRecords(database, archiveDirectory, archiveId),
    ).resolves.toEqual({
      interactionsDeleted: 1,
      aggregatesDeleted: 0,
      stateEventsDeleted: 0,
    });
    await expect(
      database.selectFrom("interactions").select("id").execute(),
    ).resolves.toEqual([]);
  });

  it("marks a corrupted complete archive failed and refuses to delete its source rows", async () => {
    const { database, archiveDirectory } = await createTestStorage();
    const repository = new InteractionRepository(database);
    const interaction = await repository.log({
      occurredAtMs: 10,
      direction: "internal",
      kind: "health-sample",
      severity: "debug",
      outcome: "succeeded",
      byteCount: 20,
      retentionClass: "raw",
      payload: { online: true },
      payloadSchemaVersion: 1,
    });
    const created = await createEventArchive({
      database,
      archiveDirectory,
      rangeStartMs: 0,
      rangeEndMs: 100,
      nowMs: 100,
      selection: {
        interactionIds: [interaction.id],
        aggregateIds: [],
        stateEventRevisions: [],
      },
    });
    await writeFile(
      join(archiveDirectory, created.archive.storagePath),
      Buffer.from("corrupted"),
    );

    await expect(
      verifyCompleteEventArchive(
        database,
        archiveDirectory,
        created.archive.id,
      ),
    ).rejects.toThrow(/byte count|checksum/i);
    await expect(
      deleteVerifiedEventArchiveRecords(
        database,
        archiveDirectory,
        created.archive.id,
      ),
    ).rejects.toThrow(/status is failed/i);
    expect(
      await database
        .selectFrom("event_archives")
        .select("status")
        .where("id", "=", created.archive.id)
        .executeTakeFirstOrThrow(),
    ).toEqual({ status: "failed" });
    expect(
      await database.selectFrom("interactions").select("id").execute(),
    ).toEqual([{ id: interaction.id }]);
  });

  it("enforces age and byte budgets while aggregating raw traffic before deletion", async () => {
    const { database, archiveDirectory } = await createTestStorage();
    const nowMs = 10_000_000;
    const repository = new InteractionRepository(database);
    for (const [index, occurredAtMs] of [
      nowMs - 180_000,
      nowMs - 120_000,
      nowMs - 60_000,
    ].entries()) {
      await repository.log({
        occurredAtMs,
        direction: "inbound",
        kind: "pwm-sample",
        severity: "info",
        deviceId: "device-1",
        outcome: "succeeded",
        durationMs: index + 1,
        byteCount: 100,
        retentionClass: "raw",
        payload: { index },
        payloadSchemaVersion: 1,
      });
    }
    await repository.log({
      occurredAtMs: nowMs - 2_000,
      direction: "internal",
      kind: "old-operation",
      severity: "info",
      outcome: "succeeded",
      byteCount: 30,
      retentionClass: "operational",
    });
    await repository.log({
      occurredAtMs: nowMs - 100,
      direction: "internal",
      kind: "fresh-operation",
      severity: "info",
      outcome: "succeeded",
      byteCount: 30,
      retentionClass: "operational",
    });
    await database
      .insertInto("retention_policies")
      .values([
        {
          retention_class: "raw",
          retain_for_ms: 1_000_000,
          byte_budget: 150,
          archive_before_delete: 1,
          priority: 1,
          updated_at_ms: nowMs,
        },
        {
          retention_class: "operational",
          retain_for_ms: 1_000,
          byte_budget: 1_000,
          archive_before_delete: 0,
          priority: 2,
          updated_at_ms: nowMs,
        },
      ])
      .execute();

    const result = await runEventRetention({
      database,
      archiveDirectory,
      nowMs,
      runId: "retention-success",
      aggregateBucketMs: 60_000,
      projectionWindowMs: 300_000,
    });
    expect(result.status).toBe("succeeded");
    expect(result.interactionsDeleted).toBe(3);
    expect(result.stateEventsDeleted).toBe(0);
    expect(result.archivesCreated).toBe(1);
    const remaining = await database
      .selectFrom("interactions")
      .select(["kind", "retention_class", "byte_count"])
      .orderBy("occurred_at_ms")
      .execute();
    expect(remaining).toEqual([
      { kind: "pwm-sample", retention_class: "raw", byte_count: 100 },
      {
        kind: "fresh-operation",
        retention_class: "operational",
        byte_count: 30,
      },
    ]);
    const aggregates = await database
      .selectFrom("event_aggregates")
      .select(["event_count", "error_count", "retention_class", "details_json"])
      .orderBy("bucket_start_ms")
      .execute();
    expect(aggregates).toHaveLength(2);
    expect(aggregates.reduce((sum, row) => sum + row.event_count, 0)).toBe(2);
    expect(aggregates.every((row) => row.retention_class === "aggregate")).toBe(
      true,
    );
    expect(aggregates.every((row) => row.error_count === 0)).toBe(true);
    expect(
      aggregates.map((row) => JSON.parse(row.details_json ?? "null")),
    ).toEqual([
      { schemaVersion: 1, source: "raw-interactions", sourceByteCount: 100 },
      { schemaVersion: 1, source: "raw-interactions", sourceByteCount: 100 },
    ]);
    expect(
      await database
        .selectFrom("retention_runs")
        .select([
          "status",
          "interactions_deleted",
          "state_events_deleted",
          "archives_created",
        ])
        .where("id", "=", "retention-success")
        .executeTakeFirstOrThrow(),
    ).toEqual({
      status: "succeeded",
      interactions_deleted: 3,
      state_events_deleted: 0,
      archives_created: 1,
    });
    const usage = await readEventStorageUsage(database, {
      nowMs,
      projectionWindowMs: 300_000,
    });
    expect(usage.databaseAllocatedBytes).toBeGreaterThan(0);
    expect(usage.projectedAnnualIngestBytes).toBeGreaterThan(0);
    expect(usage.completeArchiveBytes).toBeGreaterThan(0);
    expect(usage.failedRetentionRunCount).toBe(0);
    expect(
      usage.retentionBudgets.find((budget) => budget.retentionClass === "raw"),
    ).toMatchObject({ currentBytes: 100, byteBudget: 150, overBudget: false });
  });

  it("processes deterministic retention candidates through bounded batches", async () => {
    const { database, archiveDirectory } = await createTestStorage();
    const nowMs = 10_000;
    const repository = new InteractionRepository(database);
    for (const [index, occurredAtMs] of [1_000, 2_000, 3_000].entries()) {
      await repository.log({
        occurredAtMs,
        direction: "inbound",
        kind: "bounded-raw-sample",
        severity: "info",
        outcome: "succeeded",
        byteCount: 10,
        retentionClass: "raw",
        payload: { index },
        payloadSchemaVersion: 1,
      });
    }
    await database
      .insertInto("retention_policies")
      .values({
        retention_class: "raw",
        retain_for_ms: 1_000,
        byte_budget: 1_000,
        archive_before_delete: 0,
        priority: 1,
        updated_at_ms: nowMs,
      })
      .executeTakeFirstOrThrow();

    const result = await runEventRetention({
      database,
      archiveDirectory,
      nowMs,
      runId: "bounded-retention",
      candidateBatchSize: 1,
      aggregateBucketMs: 60_000,
    });

    expect(result).toMatchObject({
      status: "succeeded",
      interactionsDeleted: 3,
      archivesCreated: 0,
    });
    await expect(
      database.selectFrom("interactions").select("id").execute(),
    ).resolves.toEqual([]);
    await expect(
      database
        .selectFrom("event_aggregates")
        .select(({ fn }) => fn.sum<number>("event_count").as("event_count"))
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ event_count: 3 });

    await expect(
      runEventRetention({
        database,
        archiveDirectory,
        nowMs,
        runId: "invalid-batch",
        candidateBatchSize: 0,
      }),
    ).rejects.toThrow(/batch size must be between/u);
  });

  it("retains the latest backup outcome while pruning older audit history", async () => {
    const { database, archiveDirectory } = await createTestStorage();
    const repository = new InteractionRepository(database);
    await repository.log({
      occurredAtMs: 1,
      direction: "internal",
      kind: "maintenance.backup",
      severity: "error",
      outcome: "failed",
      byteCount: 0,
      retentionClass: "audit",
    });
    const latest = await repository.log({
      occurredAtMs: 2,
      direction: "internal",
      kind: "maintenance.backup",
      severity: "info",
      outcome: "succeeded",
      byteCount: 0,
      retentionClass: "audit",
    });
    await repository.log({
      occurredAtMs: 3,
      direction: "internal",
      kind: "ordinary-audit",
      severity: "info",
      outcome: "succeeded",
      byteCount: 1,
      retentionClass: "audit",
    });
    await database
      .insertInto("retention_policies")
      .values({
        retention_class: "audit",
        retain_for_ms: 1,
        byte_budget: 1_000,
        archive_before_delete: 0,
        priority: 1,
        updated_at_ms: 10,
      })
      .executeTakeFirstOrThrow();

    const result = await runEventRetention({
      database,
      archiveDirectory,
      nowMs: 10,
      runId: "backup-outcome-retention",
      candidateBatchSize: 1,
    });

    expect(result.interactionsDeleted).toBe(2);
    await expect(
      database
        .selectFrom("interactions")
        .select(["id", "kind", "outcome"])
        .orderBy("id")
        .execute(),
    ).resolves.toEqual([
      {
        id: latest.id,
        kind: "maintenance.backup",
        outcome: "succeeded",
      },
    ]);
  });

  it("applies one retention-class budget across state events and archives the exact deterministic selection", async () => {
    const { database, archiveDirectory } = await createTestStorage();
    const nowMs = 10_000;
    await database
      .insertInto("state_events")
      .values([
        {
          revision: 1,
          occurred_at_ms: 5_000,
          event_type: "configuration.channel-updated",
          entity_type: "channel",
          entity_id: "channel-1",
          retention_class: "audit",
          payload_json: '{"revision":1}',
          payload_schema_version: 1,
          byte_count: 60,
        },
        {
          revision: 2,
          occurred_at_ms: 8_500,
          event_type: "configuration.channel-updated",
          entity_type: "channel",
          entity_id: "channel-1",
          retention_class: "audit",
          payload_json: '{"revision":2}',
          payload_schema_version: 1,
          byte_count: 60,
        },
        {
          revision: 3,
          occurred_at_ms: 9_000,
          event_type: "configuration.channel-updated",
          entity_type: "channel",
          entity_id: "channel-1",
          retention_class: "audit",
          payload_json: '{"revision":3}',
          payload_schema_version: 1,
          byte_count: 60,
        },
      ])
      .execute();
    await database
      .insertInto("retention_policies")
      .values({
        retention_class: "audit",
        retain_for_ms: 2_000,
        byte_budget: 100,
        archive_before_delete: 1,
        priority: 1,
        updated_at_ms: nowMs,
      })
      .executeTakeFirstOrThrow();

    const result = await runEventRetention({
      database,
      archiveDirectory,
      nowMs,
      runId: "state-event-retention",
      projectionWindowMs: 5_000,
    });

    expect(result).toMatchObject({
      status: "succeeded",
      interactionsDeleted: 0,
      aggregatesDeleted: 0,
      stateEventsDeleted: 2,
      archivesCreated: 1,
    });
    expect(
      await database
        .selectFrom("state_events")
        .select("revision")
        .orderBy("revision")
        .execute(),
    ).toEqual([{ revision: 3 }]);
    const archiveRow = await database
      .selectFrom("event_archives")
      .select("id")
      .executeTakeFirstOrThrow();
    const verified = await verifyCompleteEventArchive(
      database,
      archiveDirectory,
      archiveRow.id,
    );
    expect(
      verified.records.map((record) => ({
        recordType: record.recordType,
        revision:
          record.recordType === "state-event" ? record.data.revision : null,
      })),
    ).toEqual([
      { recordType: "state-event", revision: 1 },
      { recordType: "state-event", revision: 2 },
    ]);
    expect(
      await database
        .selectFrom("retention_runs")
        .select([
          "interactions_deleted",
          "aggregates_deleted",
          "state_events_deleted",
        ])
        .where("id", "=", "state-event-retention")
        .executeTakeFirstOrThrow(),
    ).toEqual({
      interactions_deleted: 0,
      aggregates_deleted: 0,
      state_events_deleted: 2,
    });
  });

  it("records archive and retention failures without deleting or aggregating source data", async () => {
    const { database, archiveDirectory } = await createTestStorage();
    const nowMs = 5_000;
    const repository = new InteractionRepository(database);
    const source = await repository.log({
      occurredAtMs: 1_000,
      direction: "inbound",
      kind: "raw-sample",
      severity: "info",
      outcome: "succeeded",
      byteCount: 200,
      retentionClass: "raw",
      payload: { sample: 1 },
      payloadSchemaVersion: 1,
    });
    await database
      .insertInto("state_events")
      .values({
        revision: 1,
        occurred_at_ms: 1_200,
        event_type: "configuration.channel-updated",
        entity_type: "channel",
        entity_id: "channel-1",
        retention_class: "raw",
        payload_json: '{"revision":1}',
        payload_schema_version: 1,
        byte_count: 125,
      })
      .executeTakeFirstOrThrow();
    await database
      .insertInto("retention_policies")
      .values({
        retention_class: "raw",
        retain_for_ms: 1_000,
        byte_budget: 10,
        archive_before_delete: 1,
        priority: 1,
        updated_at_ms: nowMs,
      })
      .executeTakeFirstOrThrow();
    const failingWriter: EventArchiveFileWriter = {
      async writeAtomically(): Promise<void> {
        throw new Error("simulated archive volume failure");
      },
    };

    await expect(
      runEventRetention({
        database,
        archiveDirectory,
        nowMs,
        runId: "retention-failure",
        archiveFileWriter: failingWriter,
      }),
    ).rejects.toThrow("simulated archive volume failure");
    expect(
      await database.selectFrom("interactions").select("id").execute(),
    ).toEqual([{ id: source.id }]);
    expect(
      await database.selectFrom("event_aggregates").selectAll().execute(),
    ).toEqual([]);
    expect(
      await database.selectFrom("state_events").select("revision").execute(),
    ).toEqual([{ revision: 1 }]);
    expect(
      await database
        .selectFrom("event_archives")
        .select("status")
        .executeTakeFirstOrThrow(),
    ).toEqual({ status: "failed" });
    const run = await database
      .selectFrom("retention_runs")
      .select([
        "status",
        "interactions_deleted",
        "aggregates_deleted",
        "state_events_deleted",
        "error_json",
        "error_schema_version",
      ])
      .where("id", "=", "retention-failure")
      .executeTakeFirstOrThrow();
    expect(run.status).toBe("failed");
    expect(run.interactions_deleted).toBe(0);
    expect(run.aggregates_deleted).toBe(0);
    expect(run.state_events_deleted).toBe(0);
    expect(run.error_schema_version).toBe(1);
    expect(run.error_json).toContain("simulated archive volume failure");
    const usage = await readEventStorageUsage(database, {
      nowMs,
      projectionWindowMs: 4_000,
    });
    expect(usage.failedArchiveCount).toBe(1);
    expect(usage.failedRetentionRunCount).toBe(1);
  });
});
