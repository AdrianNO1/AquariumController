import type { DailySchedulerGuardPort } from "../scheduling/time-sync-coordinator.js";
import {
  assertMonotonicTimestamp,
  readUtcTimestamp,
  type CancelScheduledTask,
  type SchedulingClock,
  type SchedulingTimer,
} from "../scheduling/scheduling-time.js";
import { utcDayStartMs } from "../scheduling/time-sync-coordinator.js";

export const EVENT_RETENTION_JOB_KEY = "event-retention";
export const EVENT_RETENTION_SCOPE_KEY = "global";
export const DAILY_EVENT_RETENTION_HOUR_UTC = 3;

const UTC_DAY_MS = 86_400_000;
const DAILY_EVENT_RETENTION_OFFSET_MS =
  DAILY_EVENT_RETENTION_HOUR_UTC * 60 * 60 * 1_000;

export interface EventRetentionJobPort {
  run(input: { readonly runAtMs: number }): Promise<{
    readonly runId: string;
    readonly status: "succeeded";
  }>;
}

export interface EventRetentionRunRecoveryPort {
  recoverStaleRuns(input: {
    readonly recoveredAtMs: number;
    readonly staleBeforeMs: number;
  }): Promise<readonly string[]>;
}

export interface DailyEventRetentionCoordinatorOptions {
  readonly clock: SchedulingClock;
  readonly timer: SchedulingTimer;
  readonly staleRunAfterMs: number;
  readonly onError: (error: Error) => void;
}

/**
 * Runs retention once per UTC day at or after 03:00. The persisted guard claim
 * is the daily fence; authoritative outcomes remain in the events database's
 * retention_runs table rather than in control-operation scheduler results.
 */
export class DailyEventRetentionCoordinator {
  readonly #guards: DailySchedulerGuardPort;
  readonly #job: EventRetentionJobPort;
  readonly #recovery: EventRetentionRunRecoveryPort;
  readonly #clock: SchedulingClock;
  readonly #timer: SchedulingTimer;
  readonly #staleRunAfterMs: number;
  readonly #onError: (error: Error) => void;
  #cancelDailyTimer: CancelScheduledTask | null = null;
  #activeTask: Promise<void> | null = null;
  #lastMonotonicMs: number | null = null;
  #fatalError: Error | null = null;
  #started = false;
  #stopping = false;

  constructor(
    guards: DailySchedulerGuardPort,
    job: EventRetentionJobPort,
    recovery: EventRetentionRunRecoveryPort,
    options: DailyEventRetentionCoordinatorOptions,
  ) {
    if (
      !Number.isSafeInteger(options.staleRunAfterMs) ||
      options.staleRunAfterMs <= 0
    ) {
      throw new RangeError(
        "Retention stale-run age must be a positive safe integer",
      );
    }
    this.#guards = guards;
    this.#job = job;
    this.#recovery = recovery;
    this.#clock = options.clock;
    this.#timer = options.timer;
    this.#staleRunAfterMs = options.staleRunAfterMs;
    this.#onError = options.onError;
  }

  isReady(): boolean {
    return this.#started && !this.#stopping && this.#fatalError === null;
  }

  async start(): Promise<void> {
    if (this.#started) {
      throw new Error("Daily event-retention coordinator is already started");
    }
    if (this.#stopping) {
      throw new Error(
        "Stopped daily event-retention coordinator cannot be restarted",
      );
    }
    this.#started = true;
    this.#readMonotonicNow();

    const startupTask = this.#runStartup();
    this.#activeTask = startupTask;
    try {
      await startupTask;
    } catch (error) {
      this.#fail(toError(error));
    } finally {
      if (this.#activeTask === startupTask) {
        this.#activeTask = null;
      }
    }

    if (this.#fatalError !== null) {
      throw this.#fatalError;
    }
    if (!this.#stopping) {
      try {
        this.#armDailyTimer();
      } catch (error) {
        this.#fail(toError(error));
      }
    }
    if (this.#fatalError !== null) {
      throw this.#fatalError;
    }
  }

  async stop(): Promise<void> {
    if (!this.#started && !this.#stopping) {
      return;
    }
    this.#stopping = true;
    this.#cancelDailyTimer?.();
    this.#cancelDailyTimer = null;
    const activeTask = this.#activeTask;
    if (activeTask !== null) {
      try {
        await activeTask;
      } catch (error) {
        this.#fail(toError(error));
      }
    }
    this.#started = false;
    if (this.#fatalError !== null) {
      throw this.#fatalError;
    }
  }

  async #runStartup(): Promise<void> {
    await this.#recoverStaleRuns();
    if (!this.#stopping) {
      await this.#runDailyIfDue();
    }
  }

  async #recoverStaleRuns(): Promise<void> {
    const { epochMs } = readUtcTimestamp(this.#clock);
    if (epochMs >= this.#staleRunAfterMs) {
      await this.#recovery.recoverStaleRuns({
        recoveredAtMs: epochMs,
        staleBeforeMs: epochMs - this.#staleRunAfterMs,
      });
    }
  }

  #armDailyTimer(): void {
    if (this.#stopping) {
      return;
    }
    this.#readMonotonicNow();
    const { date, epochMs } = readUtcTimestamp(this.#clock);
    const dayStartMs = utcDayStartMs(date);
    const todayTargetMs = dayStartMs + DAILY_EVENT_RETENTION_OFFSET_MS;
    const targetMs =
      epochMs < todayTargetMs ? todayTargetMs : todayTargetMs + UTC_DAY_MS;
    this.#cancelDailyTimer = this.#timer.schedule(
      Math.max(0, targetMs - epochMs),
      () => this.#dailyTimerFired(),
    );
  }

  #dailyTimerFired(): void {
    this.#cancelDailyTimer = null;
    if (this.#stopping || this.#activeTask !== null) {
      return;
    }
    let task: Promise<void>;
    try {
      this.#readMonotonicNow();
      task = this.#runDailyCycle();
    } catch (error) {
      this.#fail(toError(error));
      return;
    }
    this.#activeTask = task;
    void task.then(() => {
      if (this.#activeTask === task) {
        this.#activeTask = null;
      }
      if (!this.#stopping) {
        try {
          this.#armDailyTimer();
        } catch (error) {
          this.#fail(toError(error));
        }
      }
    });
  }

  async #runDailyCycle(): Promise<void> {
    try {
      await this.#recoverStaleRuns();
      if (!this.#stopping) {
        await this.#runDailyIfDue();
      }
    } catch (error) {
      this.#fail(toError(error));
    }
  }

  async #runDailyIfDue(): Promise<void> {
    const { date, epochMs } = readUtcTimestamp(this.#clock);
    const dayStartMs = utcDayStartMs(date);
    if (epochMs < dayStartMs + DAILY_EVENT_RETENTION_OFFSET_MS) {
      return;
    }

    const claimed = await this.#guards.tryClaimDailyRun({
      jobKey: EVENT_RETENTION_JOB_KEY,
      scopeKey: EVENT_RETENTION_SCOPE_KEY,
      utcDayStartMs: dayStartMs,
      startedAtMs: epochMs,
    });
    if (!claimed) {
      return;
    }

    try {
      await this.#job.run({ runAtMs: epochMs });
    } catch (error) {
      this.#reportRunFailure(toError(error));
    }
  }

  #readMonotonicNow(): number {
    const value = assertMonotonicTimestamp(this.#clock.monotonicNowMs());
    if (this.#lastMonotonicMs !== null && value < this.#lastMonotonicMs) {
      throw new RangeError("The event-retention monotonic clock regressed");
    }
    this.#lastMonotonicMs = value;
    return value;
  }

  #reportRunFailure(error: Error): void {
    try {
      this.#onError(error);
    } catch (reporterError) {
      this.#setFatal(
        new AggregateError(
          [error, toError(reporterError)],
          "Event-retention error reporter failed",
        ),
      );
    }
  }

  #fail(error: Error): void {
    if (this.#fatalError !== null) {
      return;
    }
    let fatalError = error;
    try {
      this.#onError(error);
    } catch (reporterError) {
      fatalError = new AggregateError(
        [error, toError(reporterError)],
        "Event-retention error reporter failed",
      );
    }
    this.#setFatal(fatalError);
  }

  #setFatal(error: Error): void {
    this.#fatalError ??= error;
    this.#stopping = true;
    this.#cancelDailyTimer?.();
    this.#cancelDailyTimer = null;
  }
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
