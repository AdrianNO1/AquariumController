import type { Kysely } from "kysely";
import { afterEach, describe, expect, it } from "vitest";

import {
  openEventsDatabase,
  type EventsDatabaseSchema,
} from "../../infrastructure/database/index.js";
import { InteractionRepository } from "../../infrastructure/storage/interaction-repository.js";
import type { OutputRefreshTickReport } from "../scheduling/index.js";
import { SchedulingInteractionLogger } from "./scheduling-interaction-logger.js";

const openDatabases: Kysely<EventsDatabaseSchema>[] = [];

afterEach(async () => {
  await Promise.all(
    openDatabases.splice(0).map((database) => database.destroy()),
  );
});

describe("scheduling interaction logger", () => {
  it("omits healthy ticks and persists actionable diagnostics at the right retention tier", async () => {
    const database = await openEventsDatabase({ filename: ":memory:" });
    openDatabases.push(database);
    const logger = new SchedulingInteractionLogger(
      new InteractionRepository(database),
    );
    const healthyReport: OutputRefreshTickReport = {
      startedAtMonotonicMs: 1,
      completedAtMonotonicMs: 2,
      evaluatedUtcMinute: 0,
      outputCount: 1,
      operationCount: 1,
      diagnostics: [],
    };

    await logger.logOutputRefresh(healthyReport, 100);
    await logger.logOutputRefresh(
      {
        ...healthyReport,
        diagnostics: [
          {
            code: "scheduled_operation_not_succeeded",
            deviceId: "A1",
            mappingId: "M1",
            operationId: "OP-unknown",
            status: "outcome_unknown",
          },
        ],
      },
      200,
    );
    await logger.logTimeSync(
      {
        code: "legacy_sync_epoch_out_of_range",
        deviceId: "A1",
        epochSeconds: 0,
      },
      300,
    );
    await logger.logScheduleReconciliation(
      {
        trigger: { kind: "startup" },
        devices: [
          {
            deviceId: "A1",
            outcome: "delivered",
            desiredScheduleHash: "1",
            operationId: "OP1",
          },
          {
            deviceId: "A2",
            outcome: "compile_failed",
            desiredScheduleHash: null,
            operationId: null,
          },
        ],
      },
      400,
    );

    const rows = await database
      .selectFrom("interactions")
      .select([
        "kind",
        "severity",
        "outcome",
        "retention_class",
        "payload_json",
      ])
      .orderBy("occurred_at_ms")
      .execute();
    expect(rows).toHaveLength(3);
    expect(rows.map(({ kind }) => kind)).toEqual([
      "scheduler.output-refresh-diagnostic",
      "scheduler.time-sync-diagnostic",
      "scheduler.schedule-reconciliation-diagnostic",
    ]);
    expect(rows[0]).toMatchObject({
      severity: "error",
      outcome: "outcome_unknown",
      retention_class: "critical",
    });
    expect(rows[1]).toMatchObject({
      severity: "warning",
      outcome: "failed",
      retention_class: "operational",
    });
    expect(rows[2]).toMatchObject({
      severity: "warning",
      outcome: "failed",
      retention_class: "operational",
    });
    expect(rows[2]?.payload_json).toContain("compile_failed");
    expect(rows[2]?.payload_json).not.toContain("delivered");
  });
});
