import type { Kysely } from "kysely";
import { afterEach, describe, expect, it } from "vitest";

import { openStateDatabase } from "../../infrastructure/database/connection.js";
import { SchedulerGuardRepository } from "../../infrastructure/database/scheduler-guard-repository.js";
import type { StateDatabaseSchema } from "../../infrastructure/database/types.js";
import { ManualSchedulingTime } from "../scheduling/test-scheduling-time.js";
import type { DailySchedulerGuardPort } from "../scheduling/time-sync-coordinator.js";
import {
  DAILY_EVENT_RETENTION_HOUR_UTC,
  DailyEventRetentionCoordinator,
  EVENT_RETENTION_JOB_KEY,
  EVENT_RETENTION_SCOPE_KEY,
  type EventRetentionJobPort,
  type EventRetentionRunRecoveryPort,
} from "./daily-event-retention-coordinator.js";

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const STALE_RUN_AFTER_MS = 6 * HOUR_MS;
const openDatabases: Kysely<StateDatabaseSchema>[] = [];

afterEach(async () => {
  await Promise.all(
    openDatabases.splice(0).map((database) => database.destroy()),
  );
});

describe("daily event-retention coordinator", () => {
  it("runs at 03:00 UTC and uses a persisted global once-per-day claim across restart", async () => {
    const database = await openStateDatabase({ filename: ":memory:" });
    openDatabases.push(database);
    const guards = new SchedulerGuardRepository(database);
    const calls: number[] = [];
    const job: EventRetentionJobPort = {
      async run({ runAtMs }) {
        calls.push(runAtMs);
        return { runId: `retention-${calls.length}`, status: "succeeded" };
      },
    };
    const recovery = new RecordingRecovery();
    const firstTime = new ManualSchedulingTime("2026-10-25T02:59:59.000Z");
    const first = createCoordinator(
      firstTime,
      guards,
      job,
      recovery,
      () => undefined,
    );
    await first.start();
    await firstTime.advanceBy(999);
    expect(calls).toEqual([]);
    await firstTime.advanceBy(1);
    await flushEventLoop();
    expect(calls).toEqual([Date.parse("2026-10-25T03:00:00.000Z")]);
    await first.stop();

    const restartedTime = new ManualSchedulingTime("2026-10-25T12:00:00.000Z");
    const restarted = createCoordinator(
      restartedTime,
      guards,
      job,
      recovery,
      () => undefined,
    );
    await restarted.start();
    expect(calls).toHaveLength(1);
    await restarted.stop();

    const nextDayTime = new ManualSchedulingTime("2026-10-26T12:00:00.000Z");
    const nextDay = createCoordinator(
      nextDayTime,
      guards,
      job,
      recovery,
      () => undefined,
    );
    await nextDay.start();
    expect(calls).toEqual([
      Date.parse("2026-10-25T03:00:00.000Z"),
      Date.parse("2026-10-26T12:00:00.000Z"),
    ]);
    await nextDay.stop();

    expect(
      await database
        .selectFrom("scheduler_guards")
        .select([
          "job_key",
          "scope_key",
          "last_started_utc_day_start_ms",
          "last_operation_id",
        ])
        .executeTakeFirstOrThrow(),
    ).toEqual({
      job_key: EVENT_RETENTION_JOB_KEY,
      scope_key: EVENT_RETENTION_SCOPE_KEY,
      last_started_utc_day_start_ms: Date.parse("2026-10-26T00:00:00.000Z"),
      last_operation_id: null,
    });
    expect(DAILY_EVENT_RETENTION_HOUR_UTC).toBe(3);
  });

  it("does not overlap or catch up and drains an in-flight run during stop", async () => {
    const time = new ManualSchedulingTime("2026-07-13T02:59:59.000Z");
    let finish: (completion: {
      readonly runId: string;
      readonly status: "succeeded";
    }) => void = () => undefined;
    const pending = new Promise<{
      readonly runId: string;
      readonly status: "succeeded";
    }>((resolve) => {
      finish = resolve;
    });
    const runTimes: number[] = [];
    const coordinator = createCoordinator(
      time,
      new MemoryDailyGuards(),
      {
        async run({ runAtMs }) {
          runTimes.push(runAtMs);
          return pending;
        },
      },
      new RecordingRecovery(),
      () => undefined,
    );
    await coordinator.start();
    await time.advanceBy(1_000);
    expect(runTimes).toEqual([Date.parse("2026-07-13T03:00:00.000Z")]);

    await time.advanceBy(2 * DAY_MS);
    expect(runTimes).toHaveLength(1);
    let stopped = false;
    const stop = coordinator.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    finish({ runId: "retention-drained", status: "succeeded" });
    await stop;
    expect(stopped).toBe(true);
    expect(runTimes).toHaveLength(1);
  });

  it("claims only the current UTC day after a multi-day wall-clock leap", async () => {
    const time = new ManualSchedulingTime("2026-07-13T02:59:59.000Z");
    const runTimes: number[] = [];
    const coordinator = createCoordinator(
      time,
      new MemoryDailyGuards(),
      {
        async run({ runAtMs }) {
          runTimes.push(runAtMs);
          return { runId: "retention-after-leap", status: "succeeded" };
        },
      },
      new RecordingRecovery(),
      () => undefined,
    );
    await coordinator.start();
    time.setUtc("2026-07-20T02:59:59.000Z");
    await time.advanceBy(1_000);

    expect(runTimes).toEqual([Date.parse("2026-07-20T03:00:00.000Z")]);
    await time.advanceBy(0);
    expect(runTimes).toHaveLength(1);
    await coordinator.stop();
  });

  it("reports a failed run once and resumes only on the next UTC day", async () => {
    const time = new ManualSchedulingTime("2026-07-13T12:00:00.000Z");
    const failures: Error[] = [];
    const runTimes: number[] = [];
    const recovery = new RecordingRecovery();
    const coordinator = createCoordinator(
      time,
      new MemoryDailyGuards(),
      {
        async run({ runAtMs }) {
          runTimes.push(runAtMs);
          if (runTimes.length === 1) {
            throw new Error("retention archive unavailable");
          }
          return { runId: "retention-next-day", status: "succeeded" };
        },
      },
      recovery,
      (error) => failures.push(error),
    );

    await coordinator.start();
    expect(runTimes).toEqual([Date.parse("2026-07-13T12:00:00.000Z")]);
    expect(failures.map(({ message }) => message)).toEqual([
      "retention archive unavailable",
    ]);
    expect(recovery.calls).toEqual([
      {
        recoveredAtMs: Date.parse("2026-07-13T12:00:00.000Z"),
        staleBeforeMs:
          Date.parse("2026-07-13T12:00:00.000Z") - STALE_RUN_AFTER_MS,
      },
    ]);

    await time.advanceBy(15 * HOUR_MS - 1);
    expect(runTimes).toHaveLength(1);
    await time.advanceBy(1);
    expect(runTimes).toEqual([
      Date.parse("2026-07-13T12:00:00.000Z"),
      Date.parse("2026-07-14T03:00:00.000Z"),
    ]);
    expect(recovery.calls.at(-1)).toEqual({
      recoveredAtMs: Date.parse("2026-07-14T03:00:00.000Z"),
      staleBeforeMs:
        Date.parse("2026-07-14T03:00:00.000Z") - STALE_RUN_AFTER_MS,
    });
    await coordinator.stop();
  });

  it("surfaces a throwing run-failure reporter on stop without an unhandled task", async () => {
    const time = new ManualSchedulingTime("2026-07-13T02:59:59.000Z");
    const coordinator = createCoordinator(
      time,
      new MemoryDailyGuards(),
      {
        async run() {
          throw new Error("retention failed");
        },
      },
      new RecordingRecovery(),
      () => {
        throw new Error("reporter unavailable");
      },
    );
    await coordinator.start();
    await time.advanceBy(1_000);

    await expect(coordinator.stop()).rejects.toThrow(
      "Event-retention error reporter failed",
    );
  });
});

class RecordingRecovery implements EventRetentionRunRecoveryPort {
  readonly calls: {
    readonly recoveredAtMs: number;
    readonly staleBeforeMs: number;
  }[] = [];

  async recoverStaleRuns(input: {
    readonly recoveredAtMs: number;
    readonly staleBeforeMs: number;
  }): Promise<readonly string[]> {
    this.calls.push(input);
    return [];
  }
}

class MemoryDailyGuards implements DailySchedulerGuardPort {
  readonly #startedDays = new Map<string, number>();

  async tryClaimDailyRun(input: {
    readonly jobKey: string;
    readonly scopeKey: string;
    readonly utcDayStartMs: number;
    readonly startedAtMs: number;
  }): Promise<boolean> {
    const key = `${input.jobKey}\0${input.scopeKey}`;
    if (this.#startedDays.get(key) === input.utcDayStartMs) {
      return false;
    }
    this.#startedDays.set(key, input.utcDayStartMs);
    return true;
  }

  async recordDailyRunResult(): Promise<boolean> {
    throw new Error(
      "Event retention must not write a control-operation guard result",
    );
  }
}

function createCoordinator(
  time: ManualSchedulingTime,
  guards: DailySchedulerGuardPort,
  job: EventRetentionJobPort,
  recovery: EventRetentionRunRecoveryPort,
  onError: (error: Error) => void,
): DailyEventRetentionCoordinator {
  return new DailyEventRetentionCoordinator(guards, job, recovery, {
    clock: time,
    timer: time,
    staleRunAfterMs: STALE_RUN_AFTER_MS,
    onError,
  });
}

function flushEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
