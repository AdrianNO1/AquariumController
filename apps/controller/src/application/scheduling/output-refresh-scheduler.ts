import {
  evaluateSchedulePercent,
  toHostPwm,
  utcMinuteOfDay,
  type ScheduleValidationIssue,
  type ValidatedScheduleGraph,
} from "@aquarium/domain";

import {
  applyManualOverrideOverlays,
  type ScheduledOutputRefreshCommand,
} from "../overrides/manual-override-overlay.js";
import type { ManualOverrideOverlayReader } from "../overrides/manual-override-types.js";
import type {
  ScheduledDeviceOperationDispatcher,
  ScheduledDeviceOperationStatus,
} from "./scheduled-device-operations.js";
import {
  assertMonotonicTimestamp,
  readUtcTimestamp,
  type CancelScheduledTask,
  type SchedulingClock,
  type SchedulingTimer,
} from "./scheduling-time.js";

export const OUTPUT_REFRESH_INTERVAL_MS = 5_000;

export interface ActiveScheduledOutput {
  readonly deviceId: string;
  readonly mappingId: string;
  readonly channelId: string;
  readonly pin: number;
  readonly throttlePercent: number;
  readonly outputGain: number;
  readonly schedule: ValidatedScheduleGraph;
}

export interface InvalidScheduledOutputDiagnostic {
  readonly code: "invalid_schedule";
  readonly deviceId: string;
  readonly mappingId: string;
  readonly channelId: string;
  readonly issues: readonly ScheduleValidationIssue[];
}

export interface ActiveOutputProjection {
  readonly outputs: readonly ActiveScheduledOutput[];
  readonly diagnostics: readonly InvalidScheduledOutputDiagnostic[];
}

export interface ActiveOutputProjectionReader {
  readActiveOutputs(): Promise<ActiveOutputProjection>;
}

export type OutputRefreshDiagnostic =
  | InvalidScheduledOutputDiagnostic
  | {
      readonly code: "scheduled_operation_blocked";
      readonly deviceId: string;
      readonly mappingId: string;
      readonly reason: "outcome_unknown" | "command_error";
    }
  | {
      readonly code: "scheduled_operation_not_succeeded";
      readonly deviceId: string;
      readonly mappingId: string;
      readonly operationId: string;
      readonly status: Exclude<ScheduledDeviceOperationStatus, "succeeded">;
    };

export interface OutputRefreshTickReport {
  readonly startedAtMonotonicMs: number;
  readonly completedAtMonotonicMs: number;
  readonly evaluatedUtcMinute: number;
  readonly outputCount: number;
  readonly operationCount: number;
  readonly diagnostics: readonly OutputRefreshDiagnostic[];
}

export interface OutputRefreshSchedulerOptions {
  readonly clock: SchedulingClock;
  readonly timer: SchedulingTimer;
  readonly manualOverrideReader: ManualOverrideOverlayReader;
  readonly onTick: (report: OutputRefreshTickReport) => void;
  readonly onError: (error: Error) => void;
}

/**
 * Resends every active schedule-backed output on an anchored five-second
 * monotonic cadence. Missed deadlines are skipped, never replayed as bursts.
 */
export class OutputRefreshScheduler {
  readonly #projection: ActiveOutputProjectionReader;
  readonly #commands: ScheduledDeviceOperationDispatcher;
  readonly #clock: SchedulingClock;
  readonly #timer: SchedulingTimer;
  readonly #manualOverrideReader: ManualOverrideOverlayReader;
  readonly #onTick: (report: OutputRefreshTickReport) => void;
  readonly #onError: (error: Error) => void;
  #cancelTimer: CancelScheduledTask | null = null;
  #activeTick: Promise<void> | null = null;
  #nextDeadlineMs: number | null = null;
  #lastMonotonicMs: number | null = null;
  #fatalError: Error | null = null;
  #started = false;
  #stopping = false;

  constructor(
    projection: ActiveOutputProjectionReader,
    commands: ScheduledDeviceOperationDispatcher,
    options: OutputRefreshSchedulerOptions,
  ) {
    this.#projection = projection;
    this.#commands = commands;
    this.#clock = options.clock;
    this.#timer = options.timer;
    this.#manualOverrideReader = options.manualOverrideReader;
    this.#onTick = options.onTick;
    this.#onError = options.onError;
  }

  isReady(): boolean {
    return this.#started && !this.#stopping && this.#fatalError === null;
  }

  start(): void {
    if (this.#started) {
      throw new Error("Output refresh scheduler is already started");
    }
    if (this.#stopping) {
      throw new Error("Stopped output refresh scheduler cannot be restarted");
    }
    this.#started = true;
    const nowMs = this.#readMonotonicNow();
    this.#nextDeadlineMs = nowMs + OUTPUT_REFRESH_INTERVAL_MS;
    this.#armTimer();
  }

  async stop(): Promise<void> {
    if (!this.#started && !this.#stopping) {
      return;
    }
    this.#stopping = true;
    this.#cancelTimer?.();
    this.#cancelTimer = null;
    if (this.#activeTick !== null) {
      await this.#activeTick;
    }
    this.#started = false;
    if (this.#fatalError !== null) {
      throw this.#fatalError;
    }
  }

  #armTimer(): void {
    const deadlineMs = this.#nextDeadlineMs;
    if (this.#stopping || deadlineMs === null) {
      return;
    }
    const delayMs = Math.max(0, deadlineMs - this.#readMonotonicNow());
    this.#cancelTimer = this.#timer.schedule(delayMs, () => this.#timerFired());
  }

  #timerFired(): void {
    try {
      this.#handleTimerFired();
    } catch (error) {
      this.#fail(toError(error));
    }
  }

  #handleTimerFired(): void {
    this.#cancelTimer = null;
    if (this.#stopping || this.#activeTick !== null) {
      return;
    }
    const deadlineMs = this.#nextDeadlineMs;
    if (deadlineMs === null) {
      this.#fail(new Error("Output refresh deadline was not initialized"));
      return;
    }
    const nowMs = this.#readMonotonicNow();
    if (nowMs < deadlineMs) {
      this.#armTimer();
      return;
    }

    const tick = this.#runTickCycle();
    this.#activeTick = tick;
    void tick.then(() => {
      try {
        if (this.#activeTick === tick) {
          this.#activeTick = null;
        }
        if (!this.#stopping) {
          this.#advanceDeadline();
          this.#armTimer();
        }
      } catch (error) {
        this.#fail(toError(error));
      }
    });
  }

  async #runTickCycle(): Promise<void> {
    try {
      const report = await this.#executeTick();
      this.#onTick(report);
    } catch (error) {
      this.#fail(toError(error));
    }
  }

  async #executeTick(): Promise<OutputRefreshTickReport> {
    const startedAtMonotonicMs = this.#readMonotonicNow();
    const { date, epochMs } = readUtcTimestamp(this.#clock);
    const evaluatedUtcMinute = utcMinuteOfDay(date);
    const [projection, manualOverrides] = await Promise.all([
      this.#projection.readActiveOutputs(),
      this.#manualOverrideReader.readActiveManualOverrideOutputs(epochMs),
    ]);
    const diagnostics: OutputRefreshDiagnostic[] = [...projection.diagnostics];
    const scheduledCommands: ScheduledOutputRefreshCommand[] = [];

    for (const output of projection.outputs) {
      const percent = evaluateSchedulePercent(
        output.schedule,
        evaluatedUtcMinute,
      );
      const value = toHostPwm(
        percent,
        output.throttlePercent,
        output.outputGain,
      );
      scheduledCommands.push({
        deviceId: output.deviceId,
        mappingId: output.mappingId,
        pin: output.pin,
        value,
        overwrite: false,
      });
    }

    const effectiveCommands = applyManualOverrideOverlays(
      scheduledCommands,
      manualOverrides,
    );
    let operationCount = 0;
    for (const command of effectiveCommands) {
      if (this.#stopping) {
        break;
      }
      const dispatch = await this.#commands.dispatch(command.deviceId, {
        kind: "set_pwm",
        pin: command.pin,
        value: command.value,
        overwrite: command.overwrite,
      });
      if (dispatch.kind === "blocked") {
        diagnostics.push({
          code: "scheduled_operation_blocked",
          deviceId: command.deviceId,
          mappingId: command.mappingId,
          reason: dispatch.reason,
        });
        break;
      }
      operationCount += 1;
      if (dispatch.operation.status !== "succeeded") {
        diagnostics.push({
          code: "scheduled_operation_not_succeeded",
          deviceId: command.deviceId,
          mappingId: command.mappingId,
          operationId: dispatch.operation.id,
          status: dispatch.operation.status,
        });
        if (dispatch.operation.status === "outcome_unknown") {
          break;
        }
      }
    }

    return {
      startedAtMonotonicMs,
      completedAtMonotonicMs: this.#readMonotonicNow(),
      evaluatedUtcMinute,
      outputCount: effectiveCommands.length,
      operationCount,
      diagnostics,
    };
  }

  #advanceDeadline(): void {
    const priorDeadlineMs = this.#nextDeadlineMs;
    if (priorDeadlineMs === null) {
      this.#fail(new Error("Output refresh deadline was not initialized"));
      return;
    }
    const nowMs = this.#readMonotonicNow();
    let nextDeadlineMs = priorDeadlineMs + OUTPUT_REFRESH_INTERVAL_MS;
    if (nextDeadlineMs <= nowMs) {
      const missedIntervals =
        Math.floor((nowMs - nextDeadlineMs) / OUTPUT_REFRESH_INTERVAL_MS) + 1;
      nextDeadlineMs += missedIntervals * OUTPUT_REFRESH_INTERVAL_MS;
    }
    this.#nextDeadlineMs = nextDeadlineMs;
  }

  #readMonotonicNow(): number {
    const value = assertMonotonicTimestamp(this.#clock.monotonicNowMs());
    if (this.#lastMonotonicMs !== null && value < this.#lastMonotonicMs) {
      throw new RangeError("The scheduling monotonic clock regressed");
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
        "Output refresh error reporter failed",
      );
    }
    this.#fatalError ??= fatalError;
    this.#stopping = true;
    this.#cancelTimer?.();
    this.#cancelTimer = null;
  }
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
