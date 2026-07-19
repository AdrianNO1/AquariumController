import type { Kysely } from "kysely";
import { z } from "zod";
import { afterEach, describe, expect, it } from "vitest";

import { openEventsDatabase } from "../database/connection.js";
import type { EventsDatabaseSchema } from "../database/types.js";
import { parseJsonDocument } from "../import/strict-json.js";
import type { EventArchiveFileWriter } from "./event-archive.js";
import { RunEventRetentionJob } from "./event-retention-job.js";
import {
  EventRetentionRunRecovery,
  STALE_RETENTION_RUN_FAILURE_MESSAGE,
} from "./event-retention-run-recovery.js";
import { InteractionRepository } from "./interaction-repository.js";

const retentionFailureSchema = z.strictObject({
  schemaVersion: z.literal(1),
  message: z.string().min(1),
});

const recoveredFailureSchema = z.strictObject({
  schemaVersion: z.literal(1),
  message: z.literal(STALE_RETENTION_RUN_FAILURE_MESSAGE),
});

const openDatabases: Kysely<EventsDatabaseSchema>[] = [];

afterEach(async () => {
  await Promise.all(
    openDatabases.splice(0).map((database) => database.destroy()),
  );
});

describe("event-retention maintenance adapters", () => {
  it("keeps a failed primitive run and its untouched source data visible", async () => {
    const database = await createEventsDatabase();
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
        updated_at_ms: 5_000,
      })
      .executeTakeFirstOrThrow();
    const failingWriter: EventArchiveFileWriter = {
      async writeAtomically(): Promise<void> {
        throw new Error("simulated retention archive failure");
      },
    };
    const job = new RunEventRetentionJob({
      database,
      archiveDirectory: "test-event-archives",
      createRunId: () => "daily-retention-failure",
      archiveFileWriter: failingWriter,
    });

    await expect(job.run({ runAtMs: 5_000 })).rejects.toThrow(
      "simulated retention archive failure",
    );
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
      .where("id", "=", "daily-retention-failure")
      .executeTakeFirstOrThrow();
    expect(run.status).toBe("failed");
    expect(run.interactions_deleted).toBe(0);
    expect(run.aggregates_deleted).toBe(0);
    expect(run.error_schema_version).toBe(1);
    expect(
      retentionFailureSchema.parse(
        parseJsonDocument(run.error_json ?? "null").value,
      ),
    ).toEqual({
      schemaVersion: 1,
      message: "simulated retention archive failure",
    });
  });

  it("atomically marks only stale running rows failed with strict error JSON", async () => {
    const database = await createEventsDatabase();
    const repository = new InteractionRepository(database);
    const source = await repository.log({
      occurredAtMs: 100,
      direction: "internal",
      kind: "source-record",
      severity: "info",
      outcome: "succeeded",
      byteCount: 10,
      retentionClass: "operational",
    });
    await database
      .insertInto("retention_runs")
      .values([
        {
          id: "stale-b",
          started_at_ms: 100,
          status: "running",
          bytes_before: 30,
        },
        {
          id: "stale-a",
          started_at_ms: 500,
          status: "running",
          bytes_before: 20,
        },
        {
          id: "fresh",
          started_at_ms: 501,
          status: "running",
          bytes_before: 10,
        },
      ])
      .execute();
    const recovery = new EventRetentionRunRecovery(database);

    await expect(
      recovery.recoverStaleRuns({
        recoveredAtMs: 1_000,
        staleBeforeMs: 500,
      }),
    ).resolves.toEqual(["stale-a", "stale-b"]);

    const rows = await database
      .selectFrom("retention_runs")
      .selectAll()
      .orderBy("id")
      .execute();
    const fresh = rows.find(({ id }) => id === "fresh");
    expect(fresh).toMatchObject({
      status: "running",
      completed_at_ms: null,
      error_json: null,
      error_schema_version: null,
    });
    for (const row of rows.filter(({ id }) => id.startsWith("stale-"))) {
      expect(row).toMatchObject({
        status: "failed",
        completed_at_ms: 1_000,
        bytes_after: null,
        interactions_deleted: 0,
        aggregates_deleted: 0,
        archives_created: 0,
        error_schema_version: 1,
      });
      expect(
        recoveredFailureSchema.parse(
          parseJsonDocument(row.error_json ?? "null").value,
        ),
      ).toEqual({
        schemaVersion: 1,
        message: STALE_RETENTION_RUN_FAILURE_MESSAGE,
      });
    }
    expect(
      await database.selectFrom("interactions").select("id").execute(),
    ).toEqual([{ id: source.id }]);
  });
});

async function createEventsDatabase(): Promise<Kysely<EventsDatabaseSchema>> {
  const database = await openEventsDatabase({ filename: ":memory:" });
  openDatabases.push(database);
  return database;
}
