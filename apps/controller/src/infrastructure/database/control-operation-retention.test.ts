import type { Kysely } from "kysely";
import { afterEach, describe, expect, it } from "vitest";

import { openStateDatabase } from "./connection.js";
import {
  ControlOperationRetentionRepository,
  DEFAULT_ROUTINE_CONTROL_OPERATION_RETENTION_MS,
} from "./control-operation-retention.js";
import type { StateDatabaseSchema } from "./types.js";

const openDatabases: Kysely<StateDatabaseSchema>[] = [];

afterEach(async () => {
  await Promise.all(
    openDatabases.splice(0).map((database) => database.destroy()),
  );
});

describe("routine control-operation retention", () => {
  it("prunes old successful PWM rows in bounded batches without deleting referenced or diagnostic history", async () => {
    const database = await openStateDatabase({ filename: ":memory:" });
    openDatabases.push(database);
    await database
      .insertInto("control_operations")
      .values([
        succeededOperation("old-a", "set_pwm", 100),
        succeededOperation("old-b", "set_pwm", 200),
        succeededOperation("old-c", "set_pwm", 300),
        succeededOperation("referenced", "set_pwm", 400),
        succeededOperation("at-cutoff", "set_pwm", 500),
        succeededOperation("old-ping", "ping", 100),
        {
          ...succeededOperation("old-failed", "set_pwm", 100),
          status: "failed",
          result_json: JSON.stringify({
            status: "failed",
            code: "unexpected_response",
            message: "response mismatch",
          }),
        },
        {
          id: "pending",
          device_id: null,
          kind: "set_pwm",
          status: "pending",
          requested_at_ms: 100,
          deadline_at_ms: 1_000,
          completed_at_ms: null,
          request_json: JSON.stringify({
            kind: "set_pwm",
            pin: 4,
            value: 128,
            overwrite: false,
          }),
          request_schema_version: 1,
          result_json: null,
          result_schema_version: null,
        },
      ])
      .execute();
    await database
      .insertInto("scheduler_guards")
      .values({
        job_key: "test-guard",
        scope_key: "global",
        last_started_utc_day_start_ms: 0,
        last_started_at_ms: 400,
        last_operation_id: "referenced",
        last_success_utc_day_start_ms: null,
        last_success_at_ms: null,
        created_at_ms: 400,
        updated_at_ms: 400,
      })
      .executeTakeFirstOrThrow();
    const repository = new ControlOperationRetentionRepository(database);

    await expect(
      repository.pruneRoutineSucceededOperations({
        nowMs: 1_000,
        retainForMs: 500,
        batchSize: 2,
      }),
    ).resolves.toEqual({ cutoffMs: 500, deletedCount: 3 });

    expect(
      await database
        .selectFrom("control_operations")
        .select("id")
        .orderBy("id")
        .execute(),
    ).toEqual([
      { id: "at-cutoff" },
      { id: "old-failed" },
      { id: "old-ping" },
      { id: "pending" },
      { id: "referenced" },
    ]);
  });

  it("uses a seven-day default and rejects unsafe maintenance bounds", async () => {
    const database = await openStateDatabase({ filename: ":memory:" });
    openDatabases.push(database);
    const repository = new ControlOperationRetentionRepository(database);

    await expect(
      repository.pruneRoutineSucceededOperations({ nowMs: 1_000 }),
    ).resolves.toEqual({ cutoffMs: 0, deletedCount: 0 });
    expect(DEFAULT_ROUTINE_CONTROL_OPERATION_RETENTION_MS).toBe(
      7 * 24 * 60 * 60 * 1_000,
    );
    await expect(
      repository.pruneRoutineSucceededOperations({
        nowMs: 1_000,
        retainForMs: 0,
      }),
    ).rejects.toThrow();
    await expect(
      repository.pruneRoutineSucceededOperations({
        nowMs: 1_000,
        batchSize: 10_001,
      }),
    ).rejects.toThrow();
  });
});

function succeededOperation(id: string, kind: string, completedAtMs: number) {
  return {
    id,
    device_id: null,
    kind,
    status: "succeeded" as const,
    requested_at_ms: 0,
    deadline_at_ms: completedAtMs,
    completed_at_ms: completedAtMs,
    request_json: JSON.stringify(
      kind === "set_pwm"
        ? { kind, pin: 4, value: 128, overwrite: false }
        : { kind },
    ),
    request_schema_version: 1,
    result_json: JSON.stringify({
      status: "succeeded",
      wireOperationId: `wire-${id}`,
      analogValue: null,
    }),
    result_schema_version: 1,
  };
}
