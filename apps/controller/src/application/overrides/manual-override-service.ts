import { randomUUID } from "node:crypto";

import {
  cancelManualOverrideRequestSchema,
  extendManualOverrideRequestSchema,
  manualOverrideCommandResponseSchema,
  manualOverrideStateResponseSchema,
  reconcileManualOverrideRequestSchema,
  startManualOverrideRequestSchema,
  type CancelManualOverrideRequest,
  type ExtendManualOverrideRequest,
  type ManualOverrideCommandResponse,
  type ManualOverrideStateResponse,
  type ReconcileManualOverrideRequest,
  type StartManualOverrideRequest,
} from "@aquarium/contracts";

import {
  InvalidManualOverrideTransitionError,
  ManualOverrideConflictError,
  ManualOverrideUnavailableError,
} from "./manual-override-errors.js";
import {
  MANUAL_OVERRIDE_DURATION_MS,
  MANUAL_OVERRIDE_OPERATION_TIMEOUT_MS,
  toOperationSummary,
  toOverrideContract,
  type ManualOverrideDeviceCommandPort,
  type ManualOverrideOperationResult,
  type ManualOverrideRepositoryPort,
  type PreparedManualOverrideOperation,
  type StoredManualOverrideStateMutation,
} from "./manual-override-types.js";

export type CancelManualOverrideTimer = () => void;

export interface ManualOverrideClock {
  utcNow(): Date;
}

export interface ManualOverrideTimer {
  schedule(delayMs: number, task: () => void): CancelManualOverrideTimer;
}

export interface ManualOverrideCommandService {
  startOverride(
    request: StartManualOverrideRequest,
  ): Promise<ManualOverrideCommandResponse>;
  extendOverride(
    overrideId: string,
    request: ExtendManualOverrideRequest,
  ): Promise<ManualOverrideStateResponse>;
  cancelOverride(
    overrideId: string,
    request: CancelManualOverrideRequest,
  ): Promise<ManualOverrideCommandResponse>;
  reconcileOverride(
    overrideId: string,
    request: ReconcileManualOverrideRequest,
  ): Promise<ManualOverrideStateResponse>;
}

export interface ManualOverrideServiceOptions {
  readonly clock?: ManualOverrideClock;
  readonly timer?: ManualOverrideTimer;
  readonly idGenerator?: (kind: "override" | "operation") => string;
  readonly operationTimeoutMs?: number;
  readonly onBackgroundError: (error: Error) => void;
}

const systemClock: ManualOverrideClock = {
  utcNow: () => new Date(),
};

const systemTimer: ManualOverrideTimer = {
  schedule: (delayMs, task) => {
    assertTimerDelay(delayMs);
    const timeout = setTimeout(task, delayMs);
    timeout.unref();
    return () => clearTimeout(timeout);
  },
};

/**
 * Owns the durable manual-override lifecycle. Pin writes are delegated to the
 * same serialized operation dispatcher as scheduler refreshes. Device-level
 * failures are retained as child outcomes while commands for other devices
 * continue through the wire lane.
 */
export class ManualOverrideService implements ManualOverrideCommandService {
  readonly #repository: ManualOverrideRepositoryPort;
  readonly #commands: ManualOverrideDeviceCommandPort;
  readonly #clock: ManualOverrideClock;
  readonly #timer: ManualOverrideTimer;
  readonly #idGenerator: (kind: "override" | "operation") => string;
  readonly #operationTimeoutMs: number;
  readonly #onBackgroundError: (error: Error) => void;
  readonly #activeTasks = new Set<Promise<void>>();
  #cancelTimer: CancelManualOverrideTimer | null = null;
  #dueTask: Promise<void> | null = null;
  #timerGeneration = 0;
  #fatalBackgroundError: Error | null = null;
  #initialized = false;
  #accepting = false;
  #stopping = false;

  constructor(
    repository: ManualOverrideRepositoryPort,
    commands: ManualOverrideDeviceCommandPort,
    options: ManualOverrideServiceOptions,
  ) {
    this.#repository = repository;
    this.#commands = commands;
    this.#clock = options.clock ?? systemClock;
    this.#timer = options.timer ?? systemTimer;
    this.#idGenerator =
      options.idGenerator ?? ((kind) => `${kind}-${randomUUID()}`);
    this.#operationTimeoutMs =
      options.operationTimeoutMs ?? MANUAL_OVERRIDE_OPERATION_TIMEOUT_MS;
    if (
      !Number.isSafeInteger(this.#operationTimeoutMs) ||
      this.#operationTimeoutMs <= 0
    ) {
      throw new RangeError(
        "Manual override operation timeout must be a positive safe integer",
      );
    }
    this.#onBackgroundError = options.onBackgroundError;
  }

  isReady(): boolean {
    return (
      this.#initialized &&
      this.#accepting &&
      !this.#stopping &&
      this.#fatalBackgroundError === null
    );
  }

  async initialize(): Promise<void> {
    if (this.#initialized) {
      return;
    }
    if (this.#stopping) {
      throw new Error("Stopped manual override service cannot be initialized");
    }
    await this.#repository.recoverInterrupted(this.#readNowMs());
    this.#initialized = true;
    await this.#processDue();
    this.#accepting = true;
    await this.#rearmTimer();
  }

  async stop(): Promise<void> {
    if (!this.#initialized && !this.#stopping) {
      return;
    }
    this.#stopping = true;
    this.#accepting = false;
    this.#timerGeneration += 1;
    this.#cancelTimer?.();
    this.#cancelTimer = null;
    await Promise.all([...this.#activeTasks]);
    if (this.#dueTask !== null) {
      await this.#dueTask;
    }
    if (this.#fatalBackgroundError !== null) {
      throw this.#fatalBackgroundError;
    }
  }

  async startOverride(
    request: StartManualOverrideRequest,
  ): Promise<ManualOverrideCommandResponse> {
    this.#assertAccepting();
    const parsed = startManualOverrideRequestSchema.parse(request);
    const requestedAtMs = this.#readNowMs();
    const prepared = await this.#repository.createStart({
      overrideId: this.#idGenerator("override"),
      operationId: this.#idGenerator("operation"),
      expectedRevision: parsed.expectedRevision,
      target: parsed.target,
      valuePercentage: parsed.valuePercentage,
      requestedAtMs,
      expiresAtMs: safeAdd(requestedAtMs, MANUAL_OVERRIDE_DURATION_MS),
      deadlineAtMs: safeAdd(requestedAtMs, this.#operationTimeoutMs),
    });
    this.#startBackgroundAttempt(prepared);
    return commandResponse(prepared);
  }

  async extendOverride(
    overrideId: string,
    request: ExtendManualOverrideRequest,
  ): Promise<ManualOverrideStateResponse> {
    this.#assertAccepting();
    const parsed = extendManualOverrideRequestSchema.parse(request);
    const atMs = this.#readNowMs();
    const result = await this.#repository.extend({
      overrideId,
      expectedRevision: parsed.expectedRevision,
      atMs,
      expiresAtMs: safeAdd(atMs, MANUAL_OVERRIDE_DURATION_MS),
    });
    await this.#rearmTimer();
    return stateResponse(result);
  }

  async cancelOverride(
    overrideId: string,
    request: CancelManualOverrideRequest,
  ): Promise<ManualOverrideCommandResponse> {
    this.#assertAccepting();
    const parsed = cancelManualOverrideRequestSchema.parse(request);
    const requestedAtMs = this.#readNowMs();
    const prepared = await this.#repository.createRelease({
      overrideId,
      operationId: this.#idGenerator("operation"),
      action: "cancel",
      expectedRevision: parsed.expectedRevision,
      requestedAtMs,
      deadlineAtMs: safeAdd(requestedAtMs, this.#operationTimeoutMs),
      utcMinuteOfDay: utcMinuteOfDay(requestedAtMs),
    });
    if (prepared === null) {
      throw new InvalidManualOverrideTransitionError(
        `Active override ${overrideId} disappeared before cancellation`,
      );
    }
    this.#startBackgroundAttempt(prepared);
    return commandResponse(prepared);
  }

  async reconcileOverride(
    overrideId: string,
    request: ReconcileManualOverrideRequest,
  ): Promise<ManualOverrideStateResponse> {
    this.#assertAccepting();
    const parsed = reconcileManualOverrideRequestSchema.parse(request);
    const override = await this.#repository.getOverride(overrideId);
    if (override.operationId === null) {
      throw new InvalidManualOverrideTransitionError(
        `Override ${overrideId} has no operation to reconcile`,
      );
    }
    const result = await this.#reconcileOperation(
      override.operationId,
      parsed.expectedRevision,
      this.#readNowMs(),
    );
    await this.#rearmTimer();
    return stateResponse(result);
  }

  #startBackgroundAttempt(prepared: PreparedManualOverrideOperation): void {
    const task = this.#attempt(prepared).then(
      () => undefined,
      (error) => this.#reportBackgroundError(toError(error)),
    );
    this.#activeTasks.add(task);
    void task.then(() => {
      this.#activeTasks.delete(task);
      void this.#rearmTimer().catch((error) =>
        this.#reportBackgroundError(toError(error)),
      );
    });
  }

  async #attempt(prepared: PreparedManualOverrideOperation): Promise<void> {
    const operation = await this.#repository.markInFlight(
      prepared.operation.id,
      this.#readNowMs(),
    );
    const childOperationIds: string[] = [];
    const unknownChildOperationIds: string[] = [];
    const failedDeviceIds = new Set<string>();
    let childOutcomeNotSucceeded = false;
    if (this.#readNowMs() >= operation.deadlineAtMs) {
      if (operation.request.kind === "manual_override_start") {
        await this.#repository.completeFailed({
          operationId: operation.id,
          completedAtMs: this.#readNowMs(),
          childOperationIds,
          status: "timed_out",
          code: "deadline_before_attempt",
          message: "Manual override deadline elapsed before dispatch",
        });
      } else {
        await this.#recordUnknown(
          operation.id,
          childOperationIds,
          "command_dispatch_blocked",
          unknownChildOperationIds,
        );
      }
      return;
    }

    for (const command of operation.request.commands) {
      if (failedDeviceIds.has(command.deviceId)) {
        continue;
      }
      let dispatch;
      try {
        dispatch = await this.#commands.dispatch(command.deviceId, {
          kind: "set_pwm",
          pin: command.pin,
          value: command.value,
          overwrite: command.overwrite,
        });
      } catch (error) {
        await this.#recordUnknown(
          operation.id,
          childOperationIds,
          "command_dispatch_failed",
          unknownChildOperationIds,
        );
        throw new Error(
          `Manual override child dispatch failed for operation ${operation.id}`,
          { cause: error },
        );
      }
      if (dispatch.kind === "blocked") {
        if (
          operation.request.kind === "manual_override_start" &&
          childOperationIds.length === 0
        ) {
          await this.#repository.completeFailed({
            operationId: operation.id,
            completedAtMs: this.#readNowMs(),
            childOperationIds,
            status: "failed",
            code: "command_dispatch_blocked",
            message: `Manual override command dispatch is blocked by ${dispatch.reason}`,
          });
        } else {
          await this.#recordUnknown(
            operation.id,
            childOperationIds,
            "command_dispatch_blocked",
            unknownChildOperationIds,
          );
        }
        return;
      }
      childOperationIds.push(dispatch.operation.id);
      if (dispatch.operation.status !== "succeeded") {
        childOutcomeNotSucceeded = true;
        failedDeviceIds.add(command.deviceId);
        if (dispatch.operation.status === "outcome_unknown") {
          unknownChildOperationIds.push(dispatch.operation.id);
        }
      }
    }

    const completedAtMs = this.#readNowMs();
    if (childOutcomeNotSucceeded) {
      await this.#recordUnknown(
        operation.id,
        childOperationIds,
        "child_outcome_not_succeeded",
        unknownChildOperationIds,
      );
      return;
    }
    if (
      operation.request.kind === "manual_override_start" &&
      completedAtMs >= operation.request.expiresAtMs
    ) {
      await this.#repository.completeOutcomeUnknown({
        operationId: operation.id,
        completedAtMs,
        childOperationIds,
        reason: "completed_after_expiry",
        unknownChildOperationIds: [],
        safetyReconcileAtMs: completedAtMs,
      });
      return;
    }
    await this.#repository.completeSucceeded(
      operation.id,
      completedAtMs,
      childOperationIds,
    );
  }

  async #recordUnknown(
    operationId: string,
    childOperationIds: readonly string[],
    reason: Extract<
      ManualOverrideOperationResult,
      { readonly status: "outcome_unknown" }
    >["reason"],
    unknownChildOperationIds: readonly string[],
  ): Promise<void> {
    const completedAtMs = this.#readNowMs();
    await this.#repository.completeOutcomeUnknown({
      operationId,
      completedAtMs,
      childOperationIds,
      reason,
      unknownChildOperationIds,
      safetyReconcileAtMs:
        unknownChildOperationIds.length === 0
          ? completedAtMs
          : safeAdd(completedAtMs, MANUAL_OVERRIDE_DURATION_MS),
    });
  }

  #processDue(): Promise<void> {
    if (this.#dueTask !== null) {
      return this.#dueTask;
    }
    const task = this.#runDue();
    this.#dueTask = task;
    const clear = (): void => {
      if (this.#dueTask === task) {
        this.#dueTask = null;
      }
    };
    void task.then(clear, clear);
    return task;
  }

  async #runDue(): Promise<void> {
    if (this.#stopping) {
      return;
    }
    const nowMs = this.#readNowMs();
    const unknownOperationIds =
      await this.#repository.listDueUnknownOperationIds(nowMs);
    for (const operationId of unknownOperationIds) {
      if (this.#stopping) {
        return;
      }
      await this.#reconcileDueOperation(operationId, nowMs);
    }

    const activeOverrideIds =
      await this.#repository.listDueActiveOverrideIds(nowMs);
    for (const overrideId of activeOverrideIds) {
      if (this.#stopping) {
        return;
      }
      const prepared = await this.#repository.createRelease({
        overrideId,
        operationId: this.#idGenerator("operation"),
        action: "expire",
        expectedRevision: null,
        requestedAtMs: nowMs,
        deadlineAtMs: safeAdd(nowMs, this.#operationTimeoutMs),
        utcMinuteOfDay: utcMinuteOfDay(nowMs),
      });
      if (prepared !== null) {
        await this.#attempt(prepared);
      }
    }
  }

  async #reconcileDueOperation(
    operationId: string,
    reconciledAtMs: number,
  ): Promise<void> {
    const operation = await this.#repository.getManualOperation(operationId);
    if (
      operation.status !== "outcome_unknown" ||
      operation.result?.status !== "outcome_unknown" ||
      operation.result.reconciledAtMs !== null
    ) {
      return;
    }
    try {
      await this.#reconcileOperation(operationId, null, reconciledAtMs);
    } catch (error) {
      if (!(error instanceof InvalidManualOverrideTransitionError)) {
        throw error;
      }
      const refreshed = await this.#repository.getManualOperation(operationId);
      if (
        refreshed.status === "outcome_unknown" &&
        refreshed.result?.status === "outcome_unknown" &&
        refreshed.result.reconciledAtMs !== null
      ) {
        return;
      }
      throw error;
    }
  }

  async #reconcileOperation(
    operationId: string,
    expectedRevision: number | null,
    reconciledAtMs: number,
  ): Promise<StoredManualOverrideStateMutation> {
    const operation = await this.#repository.getManualOperation(operationId);
    if (
      operation.status !== "outcome_unknown" ||
      operation.result?.status !== "outcome_unknown" ||
      operation.result.reconciledAtMs !== null
    ) {
      throw new InvalidManualOverrideTransitionError(
        `Manual override operation ${operationId} has no unresolved unknown outcome`,
      );
    }
    if (reconciledAtMs < operation.result.safetyReconcileAtMs) {
      throw new ManualOverrideConflictError(
        "override",
        operation.request.overrideId,
        "firmware_safety_window",
        `Override ${operation.request.overrideId} cannot be reconciled before the firmware safety window ends`,
      );
    }
    await this.#commands.reconcileUnknownOutcomes(
      operation.result.unknownChildOperationIds,
    );
    return this.#repository.finalizeReconciledOutcome({
      operationId,
      expectedRevision,
      reconciledAtMs,
    });
  }

  async #rearmTimer(): Promise<void> {
    const generation = ++this.#timerGeneration;
    this.#cancelTimer?.();
    this.#cancelTimer = null;
    if (!this.#initialized || this.#stopping) {
      return;
    }
    const deadlineMs = await this.#repository.nextDeadlineMs();
    if (
      generation !== this.#timerGeneration ||
      deadlineMs === null ||
      this.#stopping
    ) {
      return;
    }
    const delayMs = Math.max(0, deadlineMs - this.#readNowMs());
    this.#cancelTimer = this.#timer.schedule(delayMs, () => {
      this.#cancelTimer = null;
      if (this.#stopping) {
        return;
      }
      const due = this.#processDue();
      void due.then(
        () => {
          void this.#rearmTimer().catch((error) =>
            this.#reportBackgroundError(toError(error)),
          );
        },
        (error) => {
          this.#reportBackgroundError(toError(error));
        },
      );
    });
  }

  #readNowMs(): number {
    const nowMs = this.#clock.utcNow().getTime();
    if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
      throw new RangeError(
        "Manual override clock must return a valid non-negative timestamp",
      );
    }
    return nowMs;
  }

  #assertAccepting(): void {
    if (this.#fatalBackgroundError !== null) {
      throw this.#fatalBackgroundError;
    }
    if (!this.#initialized || !this.#accepting || this.#stopping) {
      throw new ManualOverrideUnavailableError();
    }
  }

  #reportBackgroundError(error: Error): void {
    this.#fatalBackgroundError =
      this.#fatalBackgroundError === null
        ? error
        : new AggregateError(
            [this.#fatalBackgroundError, error],
            "Multiple manual override background errors occurred",
          );
    this.#accepting = false;
    try {
      this.#onBackgroundError(error);
    } catch (reporterError) {
      const failure = new AggregateError(
        [error, toError(reporterError)],
        "Manual override background error reporter failed",
      );
      this.#fatalBackgroundError = new AggregateError(
        [this.#fatalBackgroundError, failure],
        "Manual override background error could not be reported",
      );
    }
  }
}

function commandResponse(
  prepared: PreparedManualOverrideOperation,
): ManualOverrideCommandResponse {
  return manualOverrideCommandResponseSchema.parse({
    override: toOverrideContract(prepared.override),
    operation: toOperationSummary(prepared.operation),
    mutation: prepared.mutation,
  });
}

function stateResponse(
  result: StoredManualOverrideStateMutation,
): ManualOverrideStateResponse {
  return manualOverrideStateResponseSchema.parse({
    override: toOverrideContract(result.override),
    mutation: result.mutation,
  });
}

function utcMinuteOfDay(epochMs: number): number {
  const date = new Date(epochMs);
  return date.getUTCHours() * 60 + date.getUTCMinutes();
}

function safeAdd(left: number, right: number): number {
  const result = left + right;
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new RangeError("Manual override timestamp exceeds safe range");
  }
  return result;
}

function assertTimerDelay(delayMs: number): void {
  if (!Number.isFinite(delayMs) || delayMs < 0) {
    throw new RangeError(
      "Manual override timer delay must be finite and non-negative",
    );
  }
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
