import type {
  DeviceOperationRequest,
  DeviceOperationTerminalStatus,
} from "../operations/device-operation-types.js";

export type ScheduledDeviceOperationRequest = Extract<
  DeviceOperationRequest,
  { readonly kind: "set_pwm" | "sync_time" }
>;

export type ScheduledDeviceOperationStatus =
  "pending" | "in_flight" | DeviceOperationTerminalStatus;

export interface ScheduledDeviceOperationCompletion {
  readonly id: string;
  readonly status: ScheduledDeviceOperationStatus;
}

export interface ScheduledDeviceOperationPort {
  executeDeviceOperation(
    deviceId: string,
    request: ScheduledDeviceOperationRequest,
  ): Promise<ScheduledDeviceOperationCompletion>;
}

export type ScheduledOperationBlockReason = "outcome_unknown" | "command_error";

export type ScheduledOperationDispatchResult =
  | {
      readonly kind: "completed";
      readonly operation: ScheduledDeviceOperationCompletion;
    }
  | {
      readonly kind: "blocked";
      readonly reason: ScheduledOperationBlockReason;
    };

/**
 * Serializes scheduler-owned commands before they reach the persistent device
 * operation service. The extra safety latch prevents a second scheduler from
 * enqueuing work while an earlier command's actuator outcome is uncertain.
 */
export class ScheduledDeviceOperationDispatcher {
  readonly #operations: ScheduledDeviceOperationPort;
  #tail: Promise<void> = Promise.resolve();
  #commandErrorLatched = false;
  #outcomeUnknownLatched = false;
  #outcomeUnknownGeneration = 0n;

  constructor(operations: ScheduledDeviceOperationPort) {
    this.#operations = operations;
  }

  get blockedReason(): ScheduledOperationBlockReason | null {
    if (this.#outcomeUnknownLatched) {
      return "outcome_unknown";
    }
    return this.#commandErrorLatched ? "command_error" : null;
  }

  dispatch(
    deviceId: string,
    request: ScheduledDeviceOperationRequest,
  ): Promise<ScheduledOperationDispatchResult> {
    const result = this.#tail.then(() =>
      this.#dispatchExclusive(deviceId, request),
    );
    this.#tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  async acknowledgeReconciledOutcome(): Promise<void> {
    const acknowledgedGeneration = this.#outcomeUnknownGeneration;
    const acknowledgement = this.#tail.then(() => {
      if (this.#outcomeUnknownGeneration === acknowledgedGeneration) {
        this.#outcomeUnknownLatched = false;
      }
    });
    this.#tail = acknowledgement.then(
      () => undefined,
      () => undefined,
    );
    await acknowledgement;
  }

  async restoreUnknownOutcomeLatch(): Promise<void> {
    const restoration = this.#tail.then(() => {
      this.latchUnknownOutcome();
    });
    this.#tail = restoration.then(
      () => undefined,
      () => undefined,
    );
    await restoration;
  }

  latchUnknownOutcome(): void {
    this.#outcomeUnknownGeneration += 1n;
    this.#outcomeUnknownLatched = true;
  }

  async drain(): Promise<void> {
    await this.#tail;
  }

  async #dispatchExclusive(
    deviceId: string,
    request: ScheduledDeviceOperationRequest,
  ): Promise<ScheduledOperationDispatchResult> {
    const blockedReason = this.blockedReason;
    if (blockedReason !== null) {
      return { kind: "blocked", reason: blockedReason };
    }

    let operation: ScheduledDeviceOperationCompletion;
    try {
      operation = await this.#operations.executeDeviceOperation(
        deviceId,
        request,
      );
    } catch (error) {
      this.#commandErrorLatched = true;
      throw error;
    }

    if (operation.status === "pending" || operation.status === "in_flight") {
      this.#commandErrorLatched = true;
      throw new Error(
        `Scheduled operation ${operation.id} returned before reaching a terminal state`,
      );
    }
    if (
      operation.status === "outcome_unknown" &&
      !this.#outcomeUnknownLatched
    ) {
      // The concrete operation service notifies the runtime before returning.
      // This fallback covers other ports without double-latching that same
      // operation after reconciliation has already been queued.
      this.latchUnknownOutcome();
    }
    return { kind: "completed", operation };
  }
}
