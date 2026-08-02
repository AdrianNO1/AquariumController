import { randomUUID } from "node:crypto";

import {
  identifierSchema,
  mutationResultSchema,
  patchDeviceConfigurationRequestSchema,
  type MutationResult,
  type PatchDeviceConfigurationRequest,
} from "@aquarium/contracts";
import { utf8ByteLength } from "@aquarium/esp-protocol";

import {
  ConfigurationNotFoundError,
  ConfigurationRelationalConflictError,
  ConfigurationRevisionConflictError,
  ConfigurationValidationError,
  type DeviceConfigurationCommandPort,
} from "../configuration/index.js";
import type { DeviceRegistry } from "../devices/index.js";
import type { MqttInteractionLogger } from "../runtime/mqtt-interaction-logger.js";
import {
  DeviceOperationDeviceNotFoundError,
  DeviceOperationHardwareProfileMismatchError,
  DeviceOperationMappingProfileNotFoundError,
  DeviceOperationNotFoundError,
  DeviceOperationReconciliationConflictError,
  DeviceOperationRevisionConflictError,
  type ControlOperationRepository,
  type DeviceOperationLifecycleOptions,
  type StoredDeviceOperation,
} from "../../infrastructure/database/control-operation-repository.js";
import {
  LegacyMqttUnavailableError,
  type LegacyCommandOutcome,
  type LegacyExpectedResponse,
  type LegacyWireCommand,
  type LegacyWireOperationResult,
} from "../../infrastructure/mqtt/index.js";
import { buildLegacyWireCommand } from "./legacy-command-builders.js";
import {
  deviceOperationRequestSchema,
  type DeviceOperationExecutionOptions,
  type DeviceOperationRequest,
  type DeviceOperationResult,
} from "./device-operation-types.js";

const DEFAULT_OPERATION_TIMEOUT_MS = 5_000;
export const DEVICE_RESPONSE_TIMEOUT_COOLDOWN_MS = 60_000;
const MAX_PROTOCOL_FAULT_MESSAGE_CHARACTERS = 256;

export interface LegacyDeviceCommandExecutor {
  executeCommands(
    commands: readonly LegacyWireCommand[],
    options?: DeviceOperationExecutionOptions,
  ): Promise<LegacyWireOperationResult>;
}

export interface DeviceOperationServiceOptions {
  readonly now?: () => number;
  readonly operationTimeoutMs?: number;
  readonly idGenerator?: () => string;
  readonly onBackgroundError: (error: Error) => void;
  readonly onDeviceContact?: (contact: {
    readonly deviceId: string;
    readonly observedAtMs: number;
  }) => void;
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
  readonly #onDeviceContact:
    | ((contact: {
        readonly deviceId: string;
        readonly observedAtMs: number;
      }) => void)
    | undefined;
  readonly #activeAttempts = new Set<Promise<void>>();
  readonly #activeDeviceAttempts = new Set<string>();
  readonly #responseCooldownUntilByDevice = new Map<string, number>();
  readonly #routineReconciliationCheckedAtByDevice = new Map<string, number>();
  #fatalBackgroundError: Error | null = null;
  #started = false;
  #accepting = false;

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
    this.#onDeviceContact = options.onDeviceContact;
  }

  async start(): Promise<void> {
    if (this.#started) {
      return;
    }
    await this.#repository.recoverInterrupted(this.#now());
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
    options: DeviceOperationExecutionOptions = {},
  ): Promise<StoredDeviceOperation> {
    this.#assertCanCreateOperation();
    const parsedRequest = deviceOperationRequestSchema.parse(request);
    const device = await this.#repository.getDeviceById(deviceId);
    const requestedAtMs = this.#now();
    if (parsedRequest.kind === "set_pwm") {
      await this.#reconcileExpiredRoutinePwmOutcomes(device.id, requestedAtMs);
    }
    const lifecycleOptions = operationLifecycleOptions(parsedRequest, options);
    const operation = await this.#repository.createPending(
      {
        id: this.#idGenerator(),
        deviceId: device.id,
        requestedAtMs,
        deadlineAtMs: safeAdd(requestedAtMs, this.#operationTimeoutMs),
        request: parsedRequest,
      },
      lifecycleOptions,
    );
    if (
      !isCommandEligibleDevice(device) &&
      !(parsedRequest.kind === "firmware_update" && device.enabled === 1)
    ) {
      return this.#repository.completePendingWithoutAttempt(
        operation.id,
        this.#now(),
        {
          status: "cancelled",
          reason: "cancelled_by_owner",
        },
      );
    }
    const command = buildLegacyWireCommand(
      { id: device.hardware_id },
      parsedRequest,
    );
    const gateReason = this.#reserveDeviceAttempt(device.id, this.#now());
    if (gateReason !== null) {
      return this.#repository.completePendingWithoutAttempt(
        operation.id,
        this.#now(),
        {
          status: "cancelled",
          reason: gateReason,
        },
      );
    }
    try {
      return await this.#trackAttempt(operation, command, options);
    } finally {
      this.#activeDeviceAttempts.delete(device.id);
    }
  }

  signalDeviceAvailable(deviceId: string): void {
    this.#responseCooldownUntilByDevice.delete(
      identifierSchema.parse(deviceId),
    );
  }

  async patchDeviceConfiguration(
    deviceId: string,
    request: PatchDeviceConfigurationRequest,
  ): Promise<MutationResult> {
    this.#assertCanPatchDeviceConfiguration();
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
    if (!isCommandEligibleDevice(device)) {
      throw new ConfigurationRelationalConflictError([
        {
          resource: "device",
          id: device.id,
          relation: device.enabled === 1 ? "unavailable" : "disabled",
          message:
            device.enabled === 1
              ? `Device ${device.id} is not available for controller commands`
              : `Device ${device.id} is excluded from controller commands`,
        },
      ]);
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
        mappingProfileId:
          parsedRequest.mappingProfileId === undefined
            ? device.mapping_profile_id
            : parsedRequest.mappingProfileId,
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
      if (error instanceof DeviceOperationMappingProfileNotFoundError) {
        throw new ConfigurationNotFoundError(
          "mapping_profile",
          error.mappingProfileId,
        );
      }
      if (error instanceof DeviceOperationHardwareProfileMismatchError) {
        throw new ConfigurationRelationalConflictError([
          {
            resource: "mapping_profile",
            id: error.mappingProfileId,
            relation: "hardware_profile",
            message: error.message,
          },
        ]);
      }
      throw error;
    }
    if (created.changed) {
      this.#startBackgroundAttempt(created.operation, command, {
        priority: "interactive",
      });
    }
    return mutationResultSchema.parse(created.mutation);
  }

  async reconcileDeviceOperation(
    operationId: string,
    expectedRevision: number,
  ): Promise<MutationResult> {
    this.#assertServiceAccepting();
    try {
      return await this.#reconcileOutcome(
        operationId,
        expectedRevision,
        "operator",
      );
    } catch (error) {
      if (error instanceof DeviceOperationRevisionConflictError) {
        throw new ConfigurationRevisionConflictError(
          error.expectedRevision,
          error.currentRevision,
        );
      }
      if (error instanceof DeviceOperationNotFoundError) {
        throw new ConfigurationNotFoundError("operation", error.operationId);
      }
      if (error instanceof DeviceOperationReconciliationConflictError) {
        throw new ConfigurationRelationalConflictError([
          {
            resource: "operation",
            id: error.operationId,
            relation: error.relation,
            message: error.message,
          },
        ]);
      }
      throw error;
    }
  }

  async acknowledgeReconciledOutcome(operationId: string): Promise<void> {
    this.#assertServiceAccepting();
    await this.#reconcileOutcome(operationId, null, "manual_override");
  }

  async acknowledgeScheduleReconciledOutcome(
    operationId: string,
  ): Promise<void> {
    this.#assertServiceAccepting();
    await this.#reconcileOutcome(operationId, null, "schedule_reconciliation");
  }

  async acknowledgeReconciledOutcomes(
    operationIds: readonly string[],
  ): Promise<void> {
    for (const operationId of new Set(operationIds)) {
      await this.acknowledgeReconciledOutcome(operationId);
    }
  }

  async #reconcileOutcome(
    operationId: string,
    expectedRevision: number | null,
    origin: "manual_override" | "schedule_reconciliation" | "operator",
  ): Promise<MutationResult> {
    const mutation = await this.#repository.reconcileOutcome({
      operationId,
      expectedRevision,
      origin,
      reconciledAtMs: this.#now(),
    });
    return mutationResultSchema.parse(mutation);
  }

  async #trackAttempt(
    operation: StoredDeviceOperation,
    command: LegacyWireCommand,
    options: DeviceOperationExecutionOptions,
  ): Promise<StoredDeviceOperation> {
    const attempt = this.#attempt(operation, command, options);
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
    options: DeviceOperationExecutionOptions,
  ): void {
    const task = this.#attempt(operation, command, options).then(
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
    options: DeviceOperationExecutionOptions,
  ): Promise<StoredDeviceOperation> {
    const lifecycleOptions = operationLifecycleOptions(
      operation.request,
      options,
    );
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
          promise: this.#logOperation(
            completed,
            command,
            null,
            "timed_out",
            options,
          ),
        },
      ]);
      return completed;
    }

    await this.#repository.markInFlight(
      operation.id,
      attemptAtMs,
      lifecycleOptions,
    );
    let wireResult: LegacyWireOperationResult;
    try {
      wireResult = await this.#transport.executeCommands([command], options);
    } catch (error) {
      const normalized = toError(error);
      const result: DeviceOperationResult =
        normalized instanceof LegacyMqttUnavailableError
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
      const completedAtMs = this.#now();
      if (completedAtMs < attemptAtMs) {
        throw new RangeError(
          `Completion clock regressed after attempting operation ${operation.id}`,
          { cause: error },
        );
      }
      const completed = await this.#repository.completeInFlight(
        operation.id,
        completedAtMs,
        result,
        lifecycleOptions,
      );
      await this.#runPostCompletionTasks(operation.id, [
        {
          description: "persistent operation logging",
          promise: this.#logOperation(
            completed,
            command,
            null,
            result.status === "failed" ? "failed" : "outcome_unknown",
            options,
          ),
        },
      ]);
      return completed;
    }

    if (
      wireResult.startedAtMs < attemptAtMs ||
      wireResult.completedAtMs < wireResult.startedAtMs
    ) {
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
        lifecycleOptions,
      );
      await this.#runPostCompletionTasks(operation.id, [
        {
          description: "persistent operation logging",
          promise: this.#logOperation(
            completed,
            command,
            wireResult.operationId,
            "outcome_unknown",
            options,
          ),
        },
      ]);
      return completed;
    }
    const outcome = wireResult.outcomes[0];
    if (outcome === undefined || wireResult.outcomes.length !== 1) {
      const completed = await this.#repository.completeInFlight(
        operation.id,
        wireResult.completedAtMs,
        {
          status: "outcome_unknown",
          wireOperationId: wireResult.operationId,
          reason: "transport_error_after_attempt",
          reconciledAtMs: null,
        },
        lifecycleOptions,
      );
      await this.#runPostCompletionTasks(operation.id, [
        {
          description: "persistent operation logging",
          promise: this.#logOperation(
            completed,
            command,
            wireResult.operationId,
            "outcome_unknown",
            options,
          ),
        },
      ]);
      return completed;
    }
    const result = operationResultFromOutcome(outcome, wireResult.operationId);
    const completed = await this.#repository.completeInFlight(
      operation.id,
      wireResult.completedAtMs,
      result,
      lifecycleOptions,
    );
    const postCompletionTasks: PostCompletionTask[] = [
      {
        description: "persistent operation logging",
        promise: this.#logOperation(
          completed,
          command,
          wireResult.operationId,
          result.status === "cancelled" ? "ignored" : result.status,
          options,
        ),
      },
    ];
    if (outcome.status === "succeeded") {
      this.#responseCooldownUntilByDevice.delete(operation.deviceId);
      postCompletionTasks.push({
        description: "live device contact publication",
        promise: Promise.resolve().then(() =>
          this.#onDeviceContact?.({
            deviceId: operation.deviceId,
            observedAtMs: wireResult.completedAtMs,
          }),
        ),
      });
      postCompletionTasks.push({
        description: "device response contact persistence",
        promise: this.#deviceRegistry
          .recordResponseContact(outcome.targetId, wireResult.completedAtMs)
          .then(() => undefined),
      });
    } else if (outcome.status === "failed") {
      postCompletionTasks.push({
        description: "device protocol fault persistence",
        promise: this.#deviceRegistry
          .recordProtocolFault(
            outcome.targetId,
            wireResult.completedAtMs,
            describeProtocolFault(outcome.expectedResponse, outcome.response),
          )
          .then(() => undefined),
      });
    } else if (
      outcome.status === "outcome_unknown" &&
      outcome.reason === "timeout"
    ) {
      this.#responseCooldownUntilByDevice.set(
        operation.deviceId,
        Math.min(
          Number.MAX_SAFE_INTEGER,
          wireResult.completedAtMs + DEVICE_RESPONSE_TIMEOUT_COOLDOWN_MS,
        ),
      );
      postCompletionTasks.push({
        description: "device response timeout persistence",
        promise: this.#deviceRegistry
          .recordResponseTimeout(outcome.targetId, wireResult.completedAtMs)
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
    options: DeviceOperationExecutionOptions,
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
      priority: options.priority ?? "interactive",
    });
  }

  #assertCanCreateOperation(): void {
    this.#assertServiceAccepting();
  }

  #reserveDeviceAttempt(
    deviceId: string,
    atMs: number,
  ): "device_command_cooldown" | "device_command_in_flight" | null {
    if (this.#activeDeviceAttempts.has(deviceId)) {
      return "device_command_in_flight";
    }
    const cooldownUntilMs = this.#responseCooldownUntilByDevice.get(deviceId);
    if (cooldownUntilMs !== undefined && cooldownUntilMs > atMs) {
      return "device_command_cooldown";
    }
    if (cooldownUntilMs !== undefined) {
      this.#responseCooldownUntilByDevice.delete(deviceId);
    }
    this.#activeDeviceAttempts.add(deviceId);
    return null;
  }

  async #reconcileExpiredRoutinePwmOutcomes(
    deviceId: string,
    nowMs: number,
  ): Promise<void> {
    const lastCheckedAtMs =
      this.#routineReconciliationCheckedAtByDevice.get(deviceId);
    if (
      lastCheckedAtMs !== undefined &&
      nowMs - lastCheckedAtMs < DEVICE_RESPONSE_TIMEOUT_COOLDOWN_MS
    ) {
      return;
    }
    await this.#repository.reconcileExpiredRoutinePwmOutcomes(deviceId, nowMs);
    this.#routineReconciliationCheckedAtByDevice.set(deviceId, nowMs);
  }

  #assertCanPatchDeviceConfiguration(): void {
    this.#assertServiceAccepting();
  }

  #assertServiceAccepting(): void {
    if (this.#fatalBackgroundError !== null) {
      throw this.#fatalBackgroundError;
    }
    if (!this.#started || !this.#accepting) {
      throw new Error("Device operation service is not accepting operations");
    }
  }
}

function operationLifecycleOptions(
  request: DeviceOperationRequest,
  options: DeviceOperationExecutionOptions,
): DeviceOperationLifecycleOptions {
  return request.kind === "set_pwm" && options.priority === "background"
    ? { visibility: "internal" }
    : {};
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

function describeExpectedResponse(expected: LegacyExpectedResponse): string {
  return expected.kind === "exact"
    ? JSON.stringify(expected.value)
    : `an analog-read value for pin ${expected.pin}`;
}

function describeProtocolFault(
  expected: LegacyExpectedResponse,
  response: string,
): string {
  const detail = `Expected ${describeExpectedResponse(expected)}, received ${JSON.stringify(response)}`;
  if (detail.length <= MAX_PROTOCOL_FAULT_MESSAGE_CHARACTERS) {
    return detail;
  }
  return `${detail.slice(0, MAX_PROTOCOL_FAULT_MESSAGE_CHARACTERS - 3)}...`;
}

function isCommandEligibleDevice(device: {
  readonly enabled: number;
  readonly status: string;
}): boolean {
  return (
    device.enabled === 1 &&
    ["online", "stale", "offline"].includes(device.status)
  );
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
