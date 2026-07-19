import {
  assertMonotonicTimestamp,
  readUtcTimestamp,
  type CancelScheduledTask,
  type SchedulingClock,
  type SchedulingTimer,
} from "../scheduling/scheduling-time.js";
import { utcDayStartMs } from "../scheduling/time-sync-coordinator.js";

export const DAILY_CONTROLLER_BACKUP_HOUR_UTC = 2;

const UTC_DAY_MS = 86_400_000;
const DAILY_CONTROLLER_BACKUP_OFFSET_MS =
  DAILY_CONTROLLER_BACKUP_HOUR_UTC * 60 * 60 * 1_000;

export interface VerifiedControllerBackupReaderPort {
  readLatestVerifiedBackupAtMs(): Promise<number | null>;
}

export interface ControllerBackupMaintenancePort extends VerifiedControllerBackupReaderPort {
  run(input: {
    readonly runAtMs: number;
    readonly trigger: "startup" | "scheduled";
  }): Promise<object>;
}

export interface DailyControllerBackupCoordinatorOptions {
  readonly clock: SchedulingClock;
  readonly timer: SchedulingTimer;
  readonly freshnessThresholdMs: number;
  readonly onError: (error: Error) => void;
}

/**
 * Runs verified controller backups daily at 02:00 UTC. Startup immediately
 * backs up when durable history has no successful outcome or its latest
 * success is older than the configured threshold. Timers are armed only after
 * work settles, preventing overlap and catch-up bursts.
 */
export class DailyControllerBackupCoordinator {
  readonly #maintenance: ControllerBackupMaintenancePort;
  readonly #clock: SchedulingClock;
  readonly #timer: SchedulingTimer;
  readonly #freshnessThresholdMs: number;
  readonly #onError: (error: Error) => void;
  #cancelDailyTimer: CancelScheduledTask | null = null;
  #activeTask: Promise<void> | null = null;
  #lastMonotonicMs: number | null = null;
  #fatalError: Error | null = null;
  #started = false;
  #stopping = false;

  constructor(
    maintenance: ControllerBackupMaintenancePort,
    options: DailyControllerBackupCoordinatorOptions,
  ) {
    if (
      !Number.isSafeInteger(options.freshnessThresholdMs) ||
      options.freshnessThresholdMs <= 0
    ) {
      throw new RangeError(
        "Backup freshness threshold must be a positive safe integer",
      );
    }
    this.#maintenance = maintenance;
    this.#clock = options.clock;
    this.#timer = options.timer;
    this.#freshnessThresholdMs = options.freshnessThresholdMs;
    this.#onError = options.onError;
  }

  isReady(): boolean {
    return this.#started && !this.#stopping && this.#fatalError === null;
  }

  async start(): Promise<void> {
    if (this.#started) {
      throw new Error("Daily controller-backup coordinator is already started");
    }
    if (this.#stopping) {
      throw new Error(
        "Stopped daily controller-backup coordinator cannot be restarted",
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
    const { epochMs } = readUtcTimestamp(this.#clock);
    const latestSuccessAtMs =
      await this.#maintenance.readLatestVerifiedBackupAtMs();
    if (latestSuccessAtMs !== null) {
      assertTimestamp(latestSuccessAtMs, "Latest successful backup time");
      if (latestSuccessAtMs > epochMs) {
        throw new RangeError(
          "Latest successful backup time cannot be in the future",
        );
      }
    }
    if (
      latestSuccessAtMs === null ||
      epochMs - latestSuccessAtMs > this.#freshnessThresholdMs
    ) {
      await this.#runBackup(epochMs, "startup");
    }
  }

  #armDailyTimer(): void {
    if (this.#stopping) {
      return;
    }
    this.#readMonotonicNow();
    const { date, epochMs } = readUtcTimestamp(this.#clock);
    const dayStartMs = utcDayStartMs(date);
    const todayTargetMs = dayStartMs + DAILY_CONTROLLER_BACKUP_OFFSET_MS;
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
      if (!this.#stopping && this.#fatalError === null) {
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
      const { epochMs } = readUtcTimestamp(this.#clock);
      await this.#runBackup(epochMs, "scheduled");
    } catch (error) {
      this.#fail(toError(error));
    }
  }

  async #runBackup(
    runAtMs: number,
    trigger: "startup" | "scheduled",
  ): Promise<void> {
    try {
      await this.#maintenance.run({ runAtMs, trigger });
    } catch (error) {
      this.#reportRunFailure(toError(error));
    }
  }

  #readMonotonicNow(): number {
    const value = assertMonotonicTimestamp(this.#clock.monotonicNowMs());
    if (this.#lastMonotonicMs !== null && value < this.#lastMonotonicMs) {
      throw new RangeError("The controller-backup monotonic clock regressed");
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
          "Controller-backup error reporter failed",
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
        "Controller-backup error reporter failed",
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

function assertTimestamp(value: number, label: string): void {
  if (
    !Number.isSafeInteger(value) ||
    value < 0 ||
    !Number.isFinite(new Date(value).getTime())
  ) {
    throw new RangeError(`${label} must be a valid non-negative timestamp`);
  }
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
