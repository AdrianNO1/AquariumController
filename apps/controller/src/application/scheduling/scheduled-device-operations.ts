import type {
  DeviceOperationExecutionOptions,
  DeviceOperationRequest,
  DeviceOperationResult,
  DeviceOperationTerminalStatus,
} from "../operations/device-operation-types.js";

export type ScheduledDeviceOperationRequest = Extract<
  DeviceOperationRequest,
  { readonly kind: "schedule" | "set_pwm" | "sync_time" }
>;

export type ScheduledDeviceOperationStatus =
  "pending" | "in_flight" | DeviceOperationTerminalStatus;

export interface ScheduledDeviceOperationCompletion {
  readonly id: string;
  readonly status: ScheduledDeviceOperationStatus;
  readonly result: DeviceOperationResult | null;
}

export interface ScheduledDeviceOperationPort {
  executeDeviceOperation(
    deviceId: string,
    request: ScheduledDeviceOperationRequest,
    options?: DeviceOperationExecutionOptions,
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
 * Serializes scheduler-owned commands per device before they reach the
 * persistent operation service. Persistence/invariant failures stop every
 * lane, while an individual device's unknown wire outcome remains durable
 * without blocking commands for other devices.
 */
export class ScheduledDeviceOperationDispatcher {
  readonly #operations: ScheduledDeviceOperationPort;
  readonly #deviceTails = new Map<string, Promise<void>>();
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
    options: DeviceOperationExecutionOptions = {},
  ): Promise<ScheduledOperationDispatchResult> {
    const prior = this.#deviceTails.get(deviceId) ?? Promise.resolve();
    const result = prior.then(() =>
      this.#dispatchExclusive(deviceId, request, options),
    );
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.#deviceTails.set(deviceId, tail);
    void tail.then(() => {
      if (this.#deviceTails.get(deviceId) === tail) {
        this.#deviceTails.delete(deviceId);
      }
    });
    return result;
  }

  async drain(): Promise<void> {
    await Promise.all(this.#deviceTails.values());
  }

  async #dispatchExclusive(
    deviceId: string,
    request: ScheduledDeviceOperationRequest,
    options: DeviceOperationExecutionOptions,
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
        options,
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
