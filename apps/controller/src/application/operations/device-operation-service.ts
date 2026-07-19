import { randomUUID } from "node:crypto";

import {
  mutationResultSchema,
  patchDeviceConfigurationRequestSchema,
  type MutationResult,
  type PatchDeviceConfigurationRequest,
} from "@aquarium/contracts";
import { utf8ByteLength } from "@aquarium/esp-protocol";

import {
  ConfigurationNotFoundError,
  ConfigurationRevisionConflictError,
  ConfigurationValidationError,
  type DeviceConfigurationCommandPort,
} from "../configuration/index.js";
import type { DeviceRegistry } from "../devices/index.js";
import type { MqttInteractionLogger } from "../runtime/mqtt-interaction-logger.js";
import {
  DeviceOperationDeviceNotFoundError,
  DeviceOperationRevisionConflictError,
  type ControlOperationRepository,
  type StoredDeviceOperation,
} from "../../infrastructure/database/control-operation-repository.js";
import {
  LegacyMqttOutcomeUnknownError,
  LegacyMqttUnavailableError,
  type LegacyCommandOutcome,
  type LegacyWireCommand,
  type LegacyWireOperationResult,
} from "../../infrastructure/mqtt/index.js";
import { buildLegacyWireCommand } from "./legacy-command-builders.js";
import {
  deviceOperationRequestSchema,
  type DeviceOperationRequest,
  type DeviceOperationResult,
} from "./device-operation-types.js";

const DEFAULT_OPERATION_TIMEOUT_MS = 5_000;

export interface LegacyDeviceCommandExecutor {
  executeCommands(
    commands: readonly LegacyWireCommand[],
  ): Promise<LegacyWireOperationResult>;
  acknowledgeUnknownOutcome(): void;
}

export interface DeviceOperationServiceOptions {
  readonly now?: () => number;
  readonly operationTimeoutMs?: number;
  readonly idGenerator?: () => string;
  readonly onBackgroundError: (error: Error) => void;
}

export class DeviceOperationService implements DeviceConfigurationCommandPort {
  readonly #repository: ControlOperationRepository;
  readonly #transport: LegacyDeviceCommandExecutor;
  readonly #deviceRegistry: DeviceRegistry;
  readonly #interactionLogger: MqttInteractionLogger;
  readonly #now: () => number;
  readonly #operationTimeoutMs: number;
  readonly #idGenerator: () => string;
  readonly #onBackgroundError: (error: Error) => void;
  readonly #activeAttempts = new Set<Promise<void>>();
  #fatalBackgroundError: Error | null = null;
  #started = false;
  #accepting = false;
  #outcomeUnknownLatched = false;

  constructor(
    repository: ControlOperationRepository,
    transport: LegacyDeviceCommandExecutor,
    deviceRegistry: DeviceRegistry,
    interactionLogger: MqttInteractionLogger,
    options: DeviceOperationServiceOptions,
  ) {
    this.#repository = repository;
    this.#transport = transport;
    this.#deviceRegistry = deviceRegistry;
    this.#interactionLogger = interactionLogger;
    this.#now = options.now ?? Date.now;
    this.#operationTimeoutMs =
      options.operationTimeoutMs ?? DEFAULT_OPERATION_TIMEOUT_MS;
    if (
      !Number.isSafeInteger(this.#operationTimeoutMs) ||
      this.#operationTimeoutMs <= 0
    ) {
      throw new RangeError(
        "operationTimeoutMs must be a positive safe integer",
      );
    }
    this.#idGenerator =
      options.idGenerator ?? (() => `operation-${randomUUID()}`);
    this.#onBackgroundError = options.onBackgroundError;
  }

  async start(): Promise<void> {
    if (this.#started) {
      return;
    }
    const recovery = await this.#repository.recoverInterrupted(this.#now());
    this.#outcomeUnknownLatched =
      recovery.unresolvedOutcomeUnknownIds.length > 0;
    this.#started = true;
    this.#accepting = true;
  }

  beginShutdown(): void {
    this.#accepting = false;
  }

  async drain(): Promise<void> {
    await Promise.all([...this.#activeAttempts]);
    if (this.#fatalBackgroundError !== null) {
      throw this.#fatalBackgroundError;
    }
  }

  async executeDeviceOperation(
    deviceId: string,
    request: DeviceOperationRequest,
  ): Promise<StoredDeviceOperation> {
    this.#assertCanCreateOperation();
    const parsedRequest = deviceOperationRequestSchema.parse(request);
    const device = await this.#repository.getDeviceById(deviceId);
    const command = buildLegacyWireCommand(
      { id: device.hardware_id },
      parsedRequest,
    );
    const requestedAtMs = this.#now();
    const operation = await this.#repository.createPending({
      id: this.#idGenerator(),
      deviceId: device.id,
      requestedAtMs,
      deadlineAtMs: safeAdd(requestedAtMs, this.#operationTimeoutMs),
      request: parsedRequest,
    });
    return this.#trackAttempt(operation, command);
  }

  async patchDeviceConfiguration(
    deviceId: string,
    request: PatchDeviceConfigurationRequest,
  ): Promise<MutationResult> {
    this.#assertCanCreateOperation();
    const parsedRequest = patchDeviceConfigurationRequestSchema.parse(request);
    let device;
    try {
      device = await this.#repository.getDeviceById(deviceId);
    } catch (error) {
      if (error instanceof DeviceOperationDeviceNotFoundError) {
        throw new ConfigurationNotFoundError("device", error.deviceId);
      }
      throw error;
    }
    const parsedOperationRequest = deviceOperationRequestSchema.safeParse({
      kind: "edit_configuration",
      name: parsedRequest.name ?? device.name,
      pwmFrequencyHz:
        parsedRequest.pwmFrequencyHz ?? device.desired_pwm_frequency_hz,
      pwmResolutionBits:
        parsedRequest.pwmResolutionBits ?? device.desired_pwm_resolution_bits,
    });
    if (!parsedOperationRequest.success) {
      const issue = parsedOperationRequest.error.issues[0];
      if (issue === undefined) {
        throw new Error("Device operation validation failed without an issue");
      }
      throw new ConfigurationValidationError([
        {
          path: issue.path.map((segment) =>
            typeof segment === "number" ? segment : String(segment),
          ),
          code: issue.code,
          message: issue.message,
        },
      ]);
    }
    const operationRequest = parsedOperationRequest.data;
    if (operationRequest.kind !== "edit_configuration") {
      throw new Error("Device configuration produced the wrong operation kind");
    }
    let command: LegacyWireCommand;
    try {
      command = buildLegacyWireCommand(
        { id: device.hardware_id },
        operationRequest,
      );
    } catch (error) {
      const normalized = toError(error);
      throw new ConfigurationValidationError([
        {
          path: ["name"],
          code: "invalid_wire_configuration",
          message: normalized.message,
        },
      ]);
    }
    const requestedAtMs = this.#now();
    let created;
    try {
      created = await this.#repository.createPendingUserConfiguration({
        id: this.#idGenerator(),
        deviceId: device.id,
        expectedRevision: parsedRequest.expectedRevision,
        requestedAtMs,
        deadlineAtMs: safeAdd(requestedAtMs, this.#operationTimeoutMs),
        request: operationRequest,
      });
    } catch (error) {
      if (error instanceof DeviceOperationRevisionConflictError) {
        throw new ConfigurationRevisionConflictError(
          error.expectedRevision,
          error.currentRevision,
        );
      }
      if (error instanceof DeviceOperationDeviceNotFoundError) {
        throw new ConfigurationNotFoundError("device", error.deviceId);
      }
      throw error;
    }
    if (created.changed) {
      this.#startBackgroundAttempt(created.operation, command);
    }
    return mutationResultSchema.parse(created.mutation);
  }

  async acknowledgeReconciledOutcome(operationId: string): Promise<void> {
    if (!this.#started) {
      throw new Error("Device operation service is not started");
    }
    const operation = await this.#repository.getById(operationId);
    const alreadyReconciled =
      operation.status === "outcome_unknown" &&
      operation.result?.status === "outcome_unknown" &&
      operation.result.reconciledAtMs !== null;
    if (!alreadyReconciled) {
      await this.#repository.markOutcomeReconciled(operationId, this.#now());
    }
    const unresolved = await this.#repository.listUnresolvedOutcomeUnknownIds();
    if (unresolved.length === 0 && this.#outcomeUnknownLatched) {
      this.#transport.acknowledgeUnknownOutcome();
      this.#outcomeUnknownLatched = false;
    }
  }

  async #trackAttempt(
    operation: StoredDeviceOperation,
    command: LegacyWireCommand,
  ): Promise<StoredDeviceOperation> {
    const attempt = this.#attempt(operation, command);
    const settlement = attempt.then(
      () => undefined,
      () => undefined,
    );
    this.#activeAttempts.add(settlement);
    try {
      return await attempt;
    } finally {
      this.#activeAttempts.delete(settlement);
    }
  }

  #startBackgroundAttempt(
    operation: StoredDeviceOperation,
    command: LegacyWireCommand,
  ): void {
    const task = this.#attempt(operation, command).then(
      () => undefined,
      (error) => {
        this.#reportBackgroundError(toError(error));
      },
    );
    this.#activeAttempts.add(task);
    void task.then(() => {
      this.#activeAttempts.delete(task);
    });
  }

  async #attempt(
    operation: StoredDeviceOperation,
    command: LegacyWireCommand,
  ): Promise<StoredDeviceOperation> {
    const attemptAtMs = this.#now();
    if (attemptAtMs < operation.requestedAtMs) {
      throw new RangeError(
        `Attempt time precedes request time for operation ${operation.id}`,
      );
    }
    if (attemptAtMs >= operation.deadlineAtMs) {
      const completed = await this.#repository.completePendingWithoutAttempt(
        operation.id,
        attemptAtMs,
        { status: "timed_out", reason: "deadline_before_attempt" },
      );
      await this.#runPostCompletionTasks(operation.id, [
        {
          description: "persistent operation logging",
          promise: this.#logOperation(completed, command, null, "timed_out"),
        },
      ]);
      return completed;
    }

    await this.#repository.markInFlight(operation.id, attemptAtMs);
    let wireResult: LegacyWireOperationResult;
    try {
      wireResult = await this.#transport.executeCommands([command]);
    } catch (error) {
      const normalized = toError(error);
      const definitelyNotAttempted =
        normalized instanceof LegacyMqttUnavailableError ||
        normalized instanceof LegacyMqttOutcomeUnknownError;
      if (normalized instanceof LegacyMqttOutcomeUnknownError) {
        this.#outcomeUnknownLatched = true;
      }
      const result: DeviceOperationResult = definitelyNotAttempted
        ? {
            status: "failed",
            wireOperationId: null,
            code: "transport_unavailable",
            message:
              "MQTT transport was unavailable before command publication",
          }
        : {
            status: "outcome_unknown",
            wireOperationId: null,
            reason: "transport_error_after_attempt",
            reconciledAtMs: null,
          };
      if (result.status === "outcome_unknown") {
        this.#outcomeUnknownLatched = true;
      }
      const completedAtMs = this.#now();
      if (completedAtMs < attemptAtMs) {
        this.#outcomeUnknownLatched = true;
        throw new RangeError(
          `Completion clock regressed after attempting operation ${operation.id}`,
          { cause: error },
        );
      }
      const completed = await this.#repository.completeInFlight(
        operation.id,
        completedAtMs,
        result,
      );
      await this.#runPostCompletionTasks(operation.id, [
        {
          description: "persistent operation logging",
          promise: this.#logOperation(
            completed,
            command,
            null,
            result.status === "failed" ? "failed" : "outcome_unknown",
          ),
        },
      ]);
      return completed;
    }

    if (
      wireResult.startedAtMs < attemptAtMs ||
      wireResult.completedAtMs < wireResult.startedAtMs
    ) {
      this.#outcomeUnknownLatched = true;
      const anomalyAtMs = this.#now();
      if (anomalyAtMs < attemptAtMs) {
        throw new RangeError(
          `Wire timeline and local clock regressed after operation ${operation.id}`,
        );
      }
      const completed = await this.#repository.completeInFlight(
        operation.id,
        anomalyAtMs,
        {
          status: "outcome_unknown",
          wireOperationId: wireResult.operationId,
          reason: "transport_error_after_attempt",
          reconciledAtMs: null,
        },
      );
      await this.#runPostCompletionTasks(operation.id, [
        {
          description: "persistent operation logging",
          promise: this.#logOperation(
            completed,
            command,
            wireResult.operationId,
            "outcome_unknown",
          ),
        },
      ]);
      return completed;
    }
    const outcome = wireResult.outcomes[0];
    if (outcome === undefined || wireResult.outcomes.length !== 1) {
      this.#outcomeUnknownLatched = true;
      const completed = await this.#repository.completeInFlight(
        operation.id,
        wireResult.completedAtMs,
        {
          status: "outcome_unknown",
          wireOperationId: wireResult.operationId,
          reason: "transport_error_after_attempt",
          reconciledAtMs: null,
        },
      );
      await this.#runPostCompletionTasks(operation.id, [
        {
          description: "persistent operation logging",
          promise: this.#logOperation(
            completed,
            command,
            wireResult.operationId,
            "outcome_unknown",
          ),
        },
      ]);
      return completed;
    }
    const result = operationResultFromOutcome(outcome, wireResult.operationId);
    if (result.status === "outcome_unknown") {
      this.#outcomeUnknownLatched = true;
    }
    let completed: StoredDeviceOperation;
    try {
      completed = await this.#repository.completeInFlight(
        operation.id,
        wireResult.completedAtMs,
        result,
      );
    } catch (error) {
      this.#outcomeUnknownLatched = true;
      throw error;
    }
    const postCompletionTasks: PostCompletionTask[] = [
      {
        description: "persistent operation logging",
        promise: this.#logOperation(
          completed,
          command,
          wireResult.operationId,
          result.status === "cancelled" ? "ignored" : result.status,
        ),
      },
    ];
    if (outcome.status === "succeeded" || outcome.status === "failed") {
      postCompletionTasks.push({
        description: "device response contact persistence",
        promise: this.#deviceRegistry
          .recordResponseContact(outcome.targetId, wireResult.completedAtMs)
          .then(() => undefined),
      });
    }
    await this.#runPostCompletionTasks(operation.id, postCompletionTasks);
    return completed;
  }

  async #runPostCompletionTasks(
    operationId: string,
    tasks: readonly PostCompletionTask[],
  ): Promise<void> {
    await Promise.all(
      tasks.map(async ({ description, promise }) => {
        try {
          await promise;
        } catch (error) {
          this.#reportBackgroundError(
            new Error(
              `${description} failed after operation ${operationId} reached a terminal state`,
              { cause: error },
            ),
          );
        }
      }),
    );
  }

  #reportBackgroundError(error: Error): void {
    try {
      this.#onBackgroundError(error);
    } catch (reporterError) {
      const failure = new AggregateError(
        [error, toError(reporterError)],
        "Device operation background error reporter failed",
      );
      this.#fatalBackgroundError =
        this.#fatalBackgroundError === null
          ? failure
          : new AggregateError(
              [this.#fatalBackgroundError, failure],
              "Multiple device operation background errors could not be reported",
            );
      this.#accepting = false;
    }
  }

  async #logOperation(
    operation: StoredDeviceOperation,
    command: LegacyWireCommand,
    correlationId: string | null,
    outcome:
      "succeeded" | "failed" | "timed_out" | "outcome_unknown" | "ignored",
  ): Promise<void> {
    if (operation.completedAtMs === null) {
      throw new Error(`Cannot log incomplete operation ${operation.id}`);
    }
    const completedAtMs = operation.completedAtMs;
    if (completedAtMs < operation.requestedAtMs) {
      throw new RangeError(
        `Completion time precedes request time for operation ${operation.id}`,
      );
    }
    await this.#interactionLogger.logPersistentOperation({
      occurredAtMs: completedAtMs,
      deviceId: operation.deviceId,
      correlationId,
      operationId: operation.id,
      request: operation.request,
      outcome,
      durationMs: completedAtMs - operation.requestedAtMs,
      commandBytes: utf8ByteLength(command.command),
    });
  }

  #assertCanCreateOperation(): void {
    if (this.#fatalBackgroundError !== null) {
      throw this.#fatalBackgroundError;
    }
    if (!this.#started || !this.#accepting) {
      throw new Error("Device operation service is not accepting operations");
    }
    if (this.#outcomeUnknownLatched) {
      throw new LegacyMqttOutcomeUnknownError();
    }
  }
}

interface PostCompletionTask {
  readonly description: string;
  readonly promise: Promise<void>;
}

function operationResultFromOutcome(
  outcome: LegacyCommandOutcome,
  wireOperationId: string,
): DeviceOperationResult {
  switch (outcome.status) {
    case "succeeded":
      return {
        status: "succeeded",
        wireOperationId,
        analogValue: outcome.analogValue,
      };
    case "failed":
      return {
        status: "failed",
        wireOperationId,
        code: "unexpected_response",
        message: "Device response did not match the expected response",
      };
    case "outcome_unknown":
      return {
        status: "outcome_unknown",
        wireOperationId,
        reason: outcome.reason,
        reconciledAtMs: null,
      };
    case "not_attempted":
      return {
        status: "failed",
        wireOperationId,
        code: "not_attempted",
        message: `Command was not attempted: ${outcome.reason}`,
      };
  }
}

function safeAdd(left: number, right: number): number {
  const result = left + right;
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new RangeError("Operation deadline exceeds the safe integer range");
  }
  return result;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
