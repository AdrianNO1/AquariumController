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
  #blockedReason: ScheduledOperationBlockReason | null = null;

  constructor(operations: ScheduledDeviceOperationPort) {
    this.#operations = operations;
  }

  get blockedReason(): ScheduledOperationBlockReason | null {
    return this.#blockedReason;
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
    const acknowledgement = this.#tail.then(() => {
      this.#blockedReason = null;
    });
    this.#tail = acknowledgement.then(
      () => undefined,
      () => undefined,
    );
    await acknowledgement;
  }

  async drain(): Promise<void> {
    await this.#tail;
  }

  async #dispatchExclusive(
    deviceId: string,
    request: ScheduledDeviceOperationRequest,
  ): Promise<ScheduledOperationDispatchResult> {
    if (this.#blockedReason !== null) {
      return { kind: "blocked", reason: this.#blockedReason };
    }

    let operation: ScheduledDeviceOperationCompletion;
    try {
      operation = await this.#operations.executeDeviceOperation(
        deviceId,
        request,
      );
    } catch (error) {
      this.#blockedReason = "command_error";
      throw error;
    }

    if (operation.status === "pending" || operation.status === "in_flight") {
      this.#blockedReason = "command_error";
      throw new Error(
        `Scheduled operation ${operation.id} returned before reaching a terminal state`,
      );
    }
    if (operation.status === "outcome_unknown") {
      this.#blockedReason = "outcome_unknown";
    }
    return { kind: "completed", operation };
  }
}
