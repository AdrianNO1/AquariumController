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

export type ScheduledOperationBlockReason = "command_error";

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
 * operation service. Persistence/invariant failures stop the lane, while an
 * individual device's unknown wire outcome remains durable without blocking
 * commands for other devices.
 */
export class ScheduledDeviceOperationDispatcher {
  readonly #operations: ScheduledDeviceOperationPort;
  #tail: Promise<void> = Promise.resolve();
  #commandErrorLatched = false;

  constructor(operations: ScheduledDeviceOperationPort) {
    this.#operations = operations;
  }

  get blockedReason(): ScheduledOperationBlockReason | null {
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
    return { kind: "completed", operation };
  }
}
