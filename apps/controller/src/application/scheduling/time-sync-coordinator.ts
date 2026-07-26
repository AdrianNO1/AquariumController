import { identifierSchema } from "@aquarium/contracts";

import type {
  ScheduledDeviceOperationDispatcher,
  ScheduledDeviceOperationCompletion,
  ScheduledOperationDispatchResult,
} from "./scheduled-device-operations.js";
import {
  assertMonotonicTimestamp,
  readUtcTimestamp,
  type CancelScheduledTask,
  type SchedulingClock,
  type SchedulingTimer,
} from "./scheduling-time.js";

export const DEVICE_TIME_SYNC_JOB_KEY = "device-time-sync";
export const DAILY_TIME_SYNC_HOUR_UTC = 5;
const UTC_DAY_MS = 86_400_000;
const DAILY_TIME_SYNC_OFFSET_MS = DAILY_TIME_SYNC_HOUR_UTC * 60 * 60 * 1_000;
const MAX_LEGACY_SYNC_EPOCH_SECONDS = 2_147_483_647;

export interface OnlineDeviceReader {
  listOnlineDeviceIds(): Promise<readonly string[]>;
}

export interface DailySchedulerGuardPort {
  tryClaimDailyRun(input: {
    readonly jobKey: string;
    readonly scopeKey: string;
    readonly utcDayStartMs: number;
    readonly startedAtMs: number;
  }): Promise<boolean>;

  recordDailyRunResult(input: {
    readonly jobKey: string;
    readonly scopeKey: string;
    readonly utcDayStartMs: number;
    readonly completedAtMs: number;
    readonly operationId: string;
    readonly succeeded: boolean;
  }): Promise<boolean>;
}

export type TimeSyncDiagnostic =
  | {
      readonly code: "legacy_sync_epoch_out_of_range";
      readonly deviceId: string;
      readonly epochSeconds: number;
    }
  | {
      readonly code: "time_sync_operation_blocked";
      readonly deviceId: string;
      readonly reason: "command_error";
    }
  | {
      readonly code: "time_sync_operation_not_succeeded";
      readonly deviceId: string;
      readonly operationId: string;
      readonly status: Exclude<
        ScheduledDeviceOperationCompletion["status"],
        "succeeded"
      >;
    }
  | {
      readonly code: "daily_guard_result_superseded";
      readonly deviceId: string;
      readonly operationId: string;
      readonly utcDayStartMs: number;
    };

export interface TimeSyncCoordinatorOptions {
  readonly clock: SchedulingClock;
  readonly timer: SchedulingTimer;
  readonly onDiagnostic: (diagnostic: TimeSyncDiagnostic) => void;
  readonly onError: (error: Error) => void;
}

/**
 * Coordinates explicit announcement sync and one guarded sync per online
 * device at or after 05:00 UTC. Daily claims are persisted before publication.
 */
export class TimeSyncCoordinator {
  readonly #devices: OnlineDeviceReader;
  readonly #guards: DailySchedulerGuardPort;
  readonly #commands: ScheduledDeviceOperationDispatcher;
  readonly #clock: SchedulingClock;
  readonly #timer: SchedulingTimer;
  readonly #onDiagnostic: (diagnostic: TimeSyncDiagnostic) => void;
  readonly #onError: (error: Error) => void;
  readonly #announcementTasks = new Map<string, Promise<void>>();
  #cancelDailyTimer: CancelScheduledTask | null = null;
  #dailyTask: Promise<void> | null = null;
  #lastMonotonicMs: number | null = null;
  #fatalError: Error | null = null;
  #started = false;
  #accepting = false;
  #stopping = false;

  constructor(
    devices: OnlineDeviceReader,
    guards: DailySchedulerGuardPort,
    commands: ScheduledDeviceOperationDispatcher,
    options: TimeSyncCoordinatorOptions,
  ) {
    this.#devices = devices;
    this.#guards = guards;
    this.#commands = commands;
    this.#clock = options.clock;
    this.#timer = options.timer;
    this.#onDiagnostic = options.onDiagnostic;
    this.#onError = options.onError;
  }

  isReady(): boolean {
    return (
      this.#started &&
      this.#accepting &&
      !this.#stopping &&
      this.#fatalError === null
    );
  }

  async start(): Promise<void> {
    if (this.#started) {
      throw new Error("Time sync coordinator is already started");
    }
    if (this.#stopping) {
      throw new Error("Stopped time sync coordinator cannot be restarted");
    }
    this.#started = true;
    this.#accepting = true;
    this.#readMonotonicNow();
    const startupDailyTask = this.#runDailyIfDue();
    const trackedStartupDailyTask = startupDailyTask.catch((error) => {
      this.#fail(toError(error));
    });
    this.#dailyTask = trackedStartupDailyTask;
    try {
      await startupDailyTask;
      this.#armDailyTimer();
    } catch (error) {
      if (this.#fatalError === null) {
        this.#fail(toError(error));
      }
      throw (
        this.#fatalError ??
        new Error("Daily time-sync startup failed without an error")
      );
    } finally {
      if (this.#dailyTask === trackedStartupDailyTask) {
        this.#dailyTask = null;
      }
    }
  }

  signalAnnouncement(deviceId: string): Promise<void> {
    if (!this.#started || !this.#accepting) {
      throw new Error("Time sync coordinator is not accepting announcements");
    }
    const parsedDeviceId = identifierSchema.parse(deviceId);
    const existing = this.#announcementTasks.get(parsedDeviceId);
    if (existing !== undefined) {
      return existing;
    }

    const task = this.#runAnnouncementSync(parsedDeviceId).catch((error) => {
      this.#fail(toError(error));
    });
    this.#announcementTasks.set(parsedDeviceId, task);
    void task.then(() => {
      if (this.#announcementTasks.get(parsedDeviceId) === task) {
        this.#announcementTasks.delete(parsedDeviceId);
      }
    });
    return task;
  }

  async stop(): Promise<void> {
    if (!this.#started && !this.#stopping) {
      return;
    }
    this.#accepting = false;
    this.#stopping = true;
    this.#cancelDailyTimer?.();
    this.#cancelDailyTimer = null;
    await Promise.all([
      ...(this.#dailyTask === null ? [] : [this.#dailyTask]),
      ...this.#announcementTasks.values(),
    ]);
    this.#started = false;
    if (this.#fatalError !== null) {
      throw this.#fatalError;
    }
  }

  #armDailyTimer(): void {
    if (this.#stopping) {
      return;
    }
    this.#readMonotonicNow();
    const { date, epochMs } = readUtcTimestamp(this.#clock);
    const dayStartMs = utcDayStartMs(date);
    const todayTargetMs = dayStartMs + DAILY_TIME_SYNC_OFFSET_MS;
    const targetMs =
      epochMs < todayTargetMs ? todayTargetMs : todayTargetMs + UTC_DAY_MS;
    this.#cancelDailyTimer = this.#timer.schedule(
      Math.max(0, targetMs - epochMs),
      () => this.#dailyTimerFired(),
    );
  }

  #dailyTimerFired(): void {
    this.#cancelDailyTimer = null;
    if (this.#stopping || this.#dailyTask !== null) {
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
    this.#dailyTask = task;
    void task.then(() => {
      if (this.#dailyTask === task) {
        this.#dailyTask = null;
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
      await this.#runDailyIfDue();
    } catch (error) {
      this.#fail(toError(error));
    }
  }

  async #runDailyIfDue(): Promise<void> {
    const { date, epochMs } = readUtcTimestamp(this.#clock);
    const dayStartMs = utcDayStartMs(date);
    if (epochMs < dayStartMs + DAILY_TIME_SYNC_OFFSET_MS) {
      return;
    }

    const deviceIds = await this.#devices.listOnlineDeviceIds();
    const syncTasks: Promise<Error | null>[] = [];
    let traversalFailure: Error | null = null;
    try {
      for (const rawDeviceId of deviceIds) {
        if (this.#stopping) {
          break;
        }
        const deviceId = identifierSchema.parse(rawDeviceId);
        const claimed = await this.#guards.tryClaimDailyRun({
          jobKey: DEVICE_TIME_SYNC_JOB_KEY,
          scopeKey: deviceId,
          utcDayStartMs: dayStartMs,
          startedAtMs: epochMs,
        });
        if (!claimed) {
          continue;
        }
        syncTasks.push(
          this.#runClaimedDailySync(deviceId, dayStartMs).then(
            () => null,
            (error) => toError(error),
          ),
        );
      }
    } catch (error) {
      traversalFailure = toError(error);
    }
    const failures = (await Promise.all(syncTasks)).filter(
      (failure): failure is Error => failure !== null,
    );
    if (traversalFailure !== null) {
      if (syncTasks.length === 0) {
        throw traversalFailure;
      }
      failures.push(traversalFailure);
    }
    if (failures.length > 0) {
      throw new AggregateError(failures, "One or more daily time syncs failed");
    }
  }

  async #runClaimedDailySync(
    deviceId: string,
    utcDayStartMs: number,
  ): Promise<void> {
    const dispatch = await this.#syncDevice(deviceId);
    if (dispatch === null) {
      return;
    }
    if (dispatch.kind === "blocked") {
      this.#onDiagnostic({
        code: "time_sync_operation_blocked",
        deviceId,
        reason: dispatch.reason,
      });
      return;
    }
    const { operation } = dispatch;
    const completedAtMs = readUtcTimestamp(this.#clock).epochMs;
    const recorded = await this.#guards.recordDailyRunResult({
      jobKey: DEVICE_TIME_SYNC_JOB_KEY,
      scopeKey: deviceId,
      utcDayStartMs,
      completedAtMs,
      operationId: operation.id,
      succeeded: operation.status === "succeeded",
    });
    if (!recorded) {
      this.#onDiagnostic({
        code: "daily_guard_result_superseded",
        deviceId,
        operationId: operation.id,
        utcDayStartMs,
      });
    }
    if (operation.status !== "succeeded") {
      this.#onDiagnostic({
        code: "time_sync_operation_not_succeeded",
        deviceId,
        operationId: operation.id,
        status: operation.status,
      });
    }
  }

  async #runAnnouncementSync(deviceId: string): Promise<void> {
    const dispatch = await this.#syncDevice(deviceId);
    if (dispatch === null) {
      return;
    }
    if (dispatch.kind === "blocked") {
      this.#onDiagnostic({
        code: "time_sync_operation_blocked",
        deviceId,
        reason: dispatch.reason,
      });
      return;
    }
    if (dispatch.operation.status !== "succeeded") {
      this.#onDiagnostic({
        code: "time_sync_operation_not_succeeded",
        deviceId,
        operationId: dispatch.operation.id,
        status: dispatch.operation.status,
      });
    }
  }

  async #syncDevice(
    deviceId: string,
  ): Promise<ScheduledOperationDispatchResult | null> {
    const { epochMs } = readUtcTimestamp(this.#clock);
    const epochSeconds = Math.floor(epochMs / 1_000);
    if (epochSeconds < 1 || epochSeconds > MAX_LEGACY_SYNC_EPOCH_SECONDS) {
      this.#onDiagnostic({
        code: "legacy_sync_epoch_out_of_range",
        deviceId,
        epochSeconds,
      });
      return null;
    }
    return this.#commands.dispatch(
      deviceId,
      {
        kind: "sync_time",
        epochSeconds,
      },
      { priority: "background" },
    );
  }

  #readMonotonicNow(): number {
    const value = assertMonotonicTimestamp(this.#clock.monotonicNowMs());
    if (this.#lastMonotonicMs !== null && value < this.#lastMonotonicMs) {
      throw new RangeError("The time-sync monotonic clock regressed");
    }
    this.#lastMonotonicMs = value;
    return value;
  }

  #fail(error: Error): void {
    let fatalError = error;
    try {
      this.#onError(error);
    } catch (reporterError) {
      fatalError = new AggregateError(
        [error, toError(reporterError)],
        "Time-sync error reporter failed",
      );
    }
    this.#fatalError ??= fatalError;
    this.#accepting = false;
    this.#stopping = true;
    this.#cancelDailyTimer?.();
    this.#cancelDailyTimer = null;
  }
}

export function utcDayStartMs(date: Date): number {
  const epochMs = date.getTime();
  if (!Number.isSafeInteger(epochMs) || epochMs < 0) {
    throw new RangeError("UTC day calculation requires a valid timestamp");
  }
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate());
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
