import { readFile, writeFile } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve, sep } from "node:path";

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
    const compressed = await readFile(created.archive.storagePath);
    expect(decodeEventArchiveBytes(compressed)).toEqual(created.records);
    expect(
      (await verifyCompleteEventArchive(database, created.archive.id)).records,
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
      created.archive.id,
    );
    expect(deleted).toEqual({ interactionsDeleted: 1, aggregatesDeleted: 1 });
    expect(
      await database.selectFrom("interactions").selectAll().execute(),
    ).toEqual([]);
    expect(
      await database.selectFrom("event_aggregates").selectAll().execute(),
    ).toEqual([]);
    expect(
      await database.selectFrom("state_events").select("revision").execute(),
    ).toEqual([{ revision: 1 }]);
    expect(interaction.id).toBeGreaterThan(0);
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
    await writeFile(created.archive.storagePath, Buffer.from("corrupted"));

    await expect(
      verifyCompleteEventArchive(database, created.archive.id),
    ).rejects.toThrow(/byte count|checksum/i);
    await expect(
      deleteVerifiedEventArchiveRecords(database, created.archive.id),
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
        .select(["status", "interactions_deleted", "archives_created"])
        .where("id", "=", "retention-success")
        .executeTakeFirstOrThrow(),
    ).toEqual({
      status: "succeeded",
      interactions_deleted: 3,
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
        "error_json",
        "error_schema_version",
      ])
      .where("id", "=", "retention-failure")
      .executeTakeFirstOrThrow();
    expect(run.status).toBe("failed");
    expect(run.interactions_deleted).toBe(0);
    expect(run.aggregates_deleted).toBe(0);
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
