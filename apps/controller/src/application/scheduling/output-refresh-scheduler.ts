import { identifierSchema } from "@aquarium/contracts";
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
export const OUTPUT_RETRY_COOLDOWN_MS = 60_000;

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
      readonly reason: "command_error";
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

interface OutputRefreshDeviceReport {
  readonly operationCount: number;
  readonly diagnostics: readonly OutputRefreshDiagnostic[];
}

interface OutputRefreshDeviceBatch {
  readonly commands: readonly ScheduledOutputRefreshCommand[];
  readonly resolve: (report: OutputRefreshDeviceReport) => void;
  readonly reject: (error: Error) => void;
}

interface OutputRefreshDeviceWorker {
  pendingBatch: OutputRefreshDeviceBatch | null;
  task: Promise<void> | null;
}

type OutputRefreshDeviceOutcome =
  | {
      readonly kind: "completed";
      readonly report: OutputRefreshDeviceReport;
    }
  | {
      readonly kind: "failed";
      readonly error: Error;
    };

type OutputRefreshReportOutcome =
  | {
      readonly kind: "ready";
      readonly report: OutputRefreshTickReport;
    }
  | {
      readonly kind: "failed";
      readonly error: Error;
    };

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
  readonly #retryAfterByDevice = new Map<string, number>();
  readonly #deviceWorkers = new Map<string, OutputRefreshDeviceWorker>();
  readonly #reportTasks = new Set<Promise<void>>();
  #reportTail: Promise<void> = Promise.resolve();
  #cancelTimer: CancelScheduledTask | null = null;
  #activeTick: Promise<void> | null = null;
  #nextDeadlineMs: number | null = null;
  #lastMonotonicMs: number | null = null;
  #fatalError: Error | null = null;
  #fatalDrainPending = false;
  #refreshRequested = false;
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

  signalDeviceAvailable(deviceId: string): void {
    this.#retryAfterByDevice.delete(identifierSchema.parse(deviceId));
  }

  requestRefresh(): void {
    if (!this.#started || this.#stopping || this.#fatalError !== null) return;
    if (this.#activeTick !== null) {
      this.#refreshRequested = true;
      return;
    }
    this.#cancelTimer?.();
    this.#cancelTimer = null;
    this.#nextDeadlineMs = this.#readMonotonicNow();
    this.#armTimer();
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
    this.#discardPendingBatches();
    if (this.#activeTick !== null) {
      await this.#activeTick;
    }
    await this.#drainDeviceWorkers();
    await Promise.all([...this.#reportTasks]);
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
          if (this.#refreshRequested) {
            this.#refreshRequested = false;
            this.#nextDeadlineMs = this.#readMonotonicNow();
          } else {
            this.#advanceDeadline();
          }
          this.#armTimer();
        }
      } catch (error) {
        this.#fail(toError(error));
      }
    });
  }

  async #runTickCycle(): Promise<void> {
    try {
      await this.#executeTick();
    } catch (error) {
      this.#fail(toError(error));
    }
  }

  async #executeTick(): Promise<void> {
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
        overwrite: true,
      });
    }

    const effectiveCommands = applyManualOverrideOverlays(
      scheduledCommands,
      manualOverrides,
    );
    const commandsByDevice = new Map<string, ScheduledOutputRefreshCommand[]>();
    for (const command of effectiveCommands) {
      if (this.#stopping) {
        break;
      }
      const retryAfterMs = this.#retryAfterByDevice.get(command.deviceId);
      if (retryAfterMs !== undefined && retryAfterMs > startedAtMonotonicMs) {
        continue;
      }
      if (retryAfterMs !== undefined) {
        this.#retryAfterByDevice.delete(command.deviceId);
      }
      const deviceCommands = commandsByDevice.get(command.deviceId);
      if (deviceCommands === undefined) {
        commandsByDevice.set(command.deviceId, [command]);
      } else {
        deviceCommands.push(command);
      }
    }
    const deviceReports = [...commandsByDevice.entries()].map(
      ([deviceId, commands]) => this.#offerDeviceBatch(deviceId, commands),
    );
    this.#queueTickReport({
      startedAtMonotonicMs,
      evaluatedUtcMinute,
      outputCount: effectiveCommands.length,
      diagnostics,
      deviceReports,
    });
  }

  #offerDeviceBatch(
    deviceId: string,
    commands: readonly ScheduledOutputRefreshCommand[],
  ): Promise<OutputRefreshDeviceReport> {
    const result = new Promise<OutputRefreshDeviceReport>((resolve, reject) => {
      const worker = this.#deviceWorkers.get(deviceId) ?? {
        pendingBatch: null,
        task: null,
      };
      this.#deviceWorkers.set(deviceId, worker);
      worker.pendingBatch?.resolve(emptyDeviceReport());
      worker.pendingBatch = {
        commands,
        resolve,
        reject: (error) => reject(error),
      };
      if (worker.task === null) {
        this.#startDeviceWorker(deviceId, worker);
      }
    });
    return result;
  }

  #startDeviceWorker(
    deviceId: string,
    worker: OutputRefreshDeviceWorker,
  ): void {
    const running = this.#runDeviceWorker(deviceId, worker).then(
      () => undefined,
      () => this.#haltForFatalDrain(),
    );
    worker.task = running;
    void running.then(() => {
      if (worker.task !== running) {
        return;
      }
      worker.task = null;
      if (!this.#stopping && worker.pendingBatch !== null) {
        this.#startDeviceWorker(deviceId, worker);
      } else if (worker.pendingBatch === null) {
        this.#deviceWorkers.delete(deviceId);
      }
    });
  }

  async #runDeviceWorker(
    deviceId: string,
    worker: OutputRefreshDeviceWorker,
  ): Promise<void> {
    while (!this.#stopping && worker.pendingBatch !== null) {
      const batch = worker.pendingBatch;
      worker.pendingBatch = null;
      try {
        batch.resolve(
          await this.#executeDeviceCommands(deviceId, worker, batch.commands),
        );
      } catch (error) {
        const normalized = toError(error);
        batch.reject(normalized);
        throw normalized;
      }
    }
  }

  async #executeDeviceCommands(
    deviceId: string,
    worker: OutputRefreshDeviceWorker,
    commands: readonly ScheduledOutputRefreshCommand[],
  ): Promise<OutputRefreshDeviceReport> {
    const diagnostics: OutputRefreshDiagnostic[] = [];
    let operationCount = 0;
    const retryAfterMs = this.#retryAfterByDevice.get(deviceId);
    const nowMs = this.#readMonotonicNow();
    if (retryAfterMs !== undefined && retryAfterMs > nowMs) {
      return { operationCount, diagnostics };
    }
    if (retryAfterMs !== undefined) {
      this.#retryAfterByDevice.delete(deviceId);
    }
    for (const command of commands) {
      if (this.#stopping) {
        break;
      }
      const dispatch = await this.#commands.dispatch(
        command.deviceId,
        {
          kind: "set_pwm",
          pin: command.pin,
          value: command.value,
          overwrite: command.overwrite,
        },
        {
          priority: "background",
        },
      );
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
        this.#retryAfterByDevice.set(
          command.deviceId,
          this.#readMonotonicNow() + OUTPUT_RETRY_COOLDOWN_MS,
        );
        break;
      }
      if (worker.pendingBatch !== null) {
        break;
      }
    }
    return {
      operationCount,
      diagnostics,
    };
  }

  #queueTickReport(input: {
    readonly startedAtMonotonicMs: number;
    readonly evaluatedUtcMinute: number;
    readonly outputCount: number;
    readonly diagnostics: readonly OutputRefreshDiagnostic[];
    readonly deviceReports: readonly Promise<OutputRefreshDeviceReport>[];
  }): void {
    const deviceOutcomes = input.deviceReports.map((deviceReport) =>
      deviceReport.then(
        (report): OutputRefreshDeviceOutcome => ({
          kind: "completed",
          report,
        }),
        (error): OutputRefreshDeviceOutcome => ({
          kind: "failed",
          error: toError(error),
        }),
      ),
    );
    const outcome = Promise.all(deviceOutcomes).then(
      (
        settledDevices,
      ): OutputRefreshReportOutcome | Promise<OutputRefreshReportOutcome> => {
        const failures = settledDevices.flatMap((settled) =>
          settled.kind === "failed" ? [settled.error] : [],
        );
        if (failures.length > 0) {
          return this.#drainDeviceWorkers().then(
            (): OutputRefreshReportOutcome => ({
              kind: "failed",
              error: new AggregateError(
                failures,
                "One or more output refresh device workers failed",
              ),
            }),
          );
        }
        const diagnostics = [...input.diagnostics];
        let operationCount = 0;
        for (const settled of settledDevices) {
          if (settled.kind !== "completed") {
            continue;
          }
          const { report } = settled;
          operationCount += report.operationCount;
          diagnostics.push(...report.diagnostics);
        }
        try {
          return {
            kind: "ready",
            report: {
              startedAtMonotonicMs: input.startedAtMonotonicMs,
              completedAtMonotonicMs: this.#readMonotonicNow(),
              evaluatedUtcMinute: input.evaluatedUtcMinute,
              outputCount: input.outputCount,
              operationCount,
              diagnostics,
            },
          };
        } catch (error) {
          return { kind: "failed", error: toError(error) };
        }
      },
    );
    const reportTask = this.#reportTail
      .then(async () => {
        const settled = await outcome;
        if (settled.kind === "failed") {
          if (this.#fatalError === null) {
            this.#fail(settled.error);
          }
          return;
        }
        if (this.#fatalError === null && !this.#fatalDrainPending) {
          this.#onTick(settled.report);
        }
      })
      .catch((error) => this.#fail(toError(error)));
    this.#reportTail = reportTask;
    this.#reportTasks.add(reportTask);
    void reportTask.then(() => this.#reportTasks.delete(reportTask));
  }

  #discardPendingBatches(): void {
    for (const worker of this.#deviceWorkers.values()) {
      worker.pendingBatch?.resolve(emptyDeviceReport());
      worker.pendingBatch = null;
    }
  }

  async #drainDeviceWorkers(): Promise<void> {
    await Promise.all(
      [...this.#deviceWorkers.values()].flatMap(({ task }) =>
        task === null ? [] : [task],
      ),
    );
  }

  #haltForFatalDrain(): void {
    this.#fatalDrainPending = true;
    this.#stopping = true;
    this.#cancelTimer?.();
    this.#cancelTimer = null;
    this.#refreshRequested = false;
    this.#discardPendingBatches();
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
    this.#fatalDrainPending = false;
    this.#stopping = true;
    this.#cancelTimer?.();
    this.#cancelTimer = null;
    this.#discardPendingBatches();
  }
}

function emptyDeviceReport(): OutputRefreshDeviceReport {
  return { operationCount: 0, diagnostics: [] };
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
