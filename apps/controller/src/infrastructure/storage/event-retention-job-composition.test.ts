import type { Kysely } from "kysely";
import { afterEach, describe, expect, it } from "vitest";

import {
  openEventsDatabase,
  type EventsDatabaseSchema,
} from "../database/index.js";
import { RunEventRetentionJob } from "./event-retention-job.js";

const openDatabases: Kysely<EventsDatabaseSchema>[] = [];

afterEach(async () => {
  await Promise.all(
    openDatabases.splice(0).map((database) => database.destroy()),
  );
});

describe("controller retention-job composition", () => {
  it("prunes state history in dependency order after event retention and records counts", async () => {
    const database = await openEventsDatabase({ filename: ":memory:" });
    openDatabases.push(database);
    const runTimes: number[] = [];
    const stages: string[] = [];
    const job = new RunEventRetentionJob({
      database,
      archiveDirectory: "test-archives",
      createRunId: () => "composed-retention-success",
      routineControlOperationRetention: {
        async pruneRoutineSucceededOperations({ nowMs }) {
          runTimes.push(nowMs);
          stages.push("operations");
          return { deletedCount: 3 };
        },
      },
      notificationDeliveryRetention: {
        async pruneHistoricalDeliveries({ nowMs }) {
          runTimes.push(nowMs);
          stages.push("deliveries");
          return { deletedCount: 7 };
        },
      },
      stateRevisionRetention: {
        async pruneOrphanedRevisions() {
          stages.push("revisions");
          return { deletedCount: 5 };
        },
      },
    });

    await expect(job.run({ runAtMs: 1_000 })).resolves.toMatchObject({
      runId: "composed-retention-success",
      status: "succeeded",
    });
    expect(runTimes).toEqual([1_000, 1_000]);
    expect(stages).toEqual(["operations", "deliveries", "revisions"]);
    expect(
      await database
        .selectFrom("interactions")
        .select(["kind", "outcome", "retention_class", "payload_json"])
        .executeTakeFirstOrThrow(),
    ).toMatchObject({
      kind: "maintenance.state-retention",
      outcome: "succeeded",
      retention_class: "operational",
      payload_json:
        '{"notificationDeliveriesDeleted":7,"revisionsDeleted":5,"routineOperationsDeleted":3}',
    });
  });

  it("persists a critical diagnostic and rejects when state-operation pruning fails", async () => {
    const database = await openEventsDatabase({ filename: ":memory:" });
    openDatabases.push(database);
    const job = new RunEventRetentionJob({
      database,
      archiveDirectory: "test-archives",
      createRunId: () => "composed-retention-failure",
      routineControlOperationRetention: {
        async pruneRoutineSucceededOperations() {
          throw new Error("simulated state retention failure");
        },
      },
    });

    await expect(job.run({ runAtMs: 2_000 })).rejects.toThrow(
      "simulated state retention failure",
    );
    expect(
      await database
        .selectFrom("retention_runs")
        .select("status")
        .where("id", "=", "composed-retention-failure")
        .executeTakeFirstOrThrow(),
    ).toEqual({ status: "succeeded" });
    expect(
      await database
        .selectFrom("interactions")
        .select([
          "kind",
          "severity",
          "outcome",
          "retention_class",
          "payload_json",
        ])
        .executeTakeFirstOrThrow(),
    ).toEqual({
      kind: "maintenance.state-retention",
      severity: "error",
      outcome: "failed",
      retention_class: "critical",
      payload_json:
        '{"errorClass":"Error","failedStage":"routine-control-operations","notificationDeliveriesDeleted":0,"revisionsDeleted":0,"routineOperationsDeleted":0}',
    });
    expect(
      (
        await database
          .selectFrom("interactions")
          .select("payload_json")
          .executeTakeFirstOrThrow()
      ).payload_json,
    ).not.toContain("simulated state retention failure");
  });

  it("reports sanitized partial counts and stops before revision pruning when delivery retention fails", async () => {
    const database = await openEventsDatabase({ filename: ":memory:" });
    openDatabases.push(database);
    let revisionsCalled = false;
    const job = new RunEventRetentionJob({
      database,
      archiveDirectory: "test-archives",
      createRunId: () => "composed-delivery-retention-failure",
      routineControlOperationRetention: {
        async pruneRoutineSucceededOperations() {
          return { deletedCount: 4 };
        },
      },
      notificationDeliveryRetention: {
        async pruneHistoricalDeliveries() {
          throw new Error("private notification retention detail");
        },
      },
      stateRevisionRetention: {
        async pruneOrphanedRevisions() {
          revisionsCalled = true;
          return { deletedCount: 1 };
        },
      },
    });

    await expect(job.run({ runAtMs: 3_000 })).rejects.toThrow(
      "private notification retention detail",
    );
    expect(revisionsCalled).toBe(false);
    const interaction = await database
      .selectFrom("interactions")
      .select(["outcome", "retention_class", "payload_json"])
      .executeTakeFirstOrThrow();
    expect(interaction).toEqual({
      outcome: "failed",
      retention_class: "critical",
      payload_json:
        '{"errorClass":"Error","failedStage":"notification-deliveries","notificationDeliveriesDeleted":0,"revisionsDeleted":0,"routineOperationsDeleted":4}',
    });
    expect(interaction.payload_json).not.toContain("private notification");
  });
});
