import type { DeviceOperationExecutionOptions } from "../operations/index.js";
import type { ScheduledDeviceOperationDispatcher } from "../scheduling/index.js";
import type {
  DeviceScheduleOperationPort,
  ScheduleDeliveryOperation,
} from "./types.js";

export interface ScheduleReconciledOutcomeAcknowledger {
  acknowledgeScheduleReconciledOutcome(operationId: string): Promise<void>;
}

/** Routes schedule delivery through the shared per-device command lane. */
export class ScheduleReconciliationCommandAdapter implements DeviceScheduleOperationPort {
  constructor(
    private readonly dispatcher: ScheduledDeviceOperationDispatcher,
    private readonly outcomeAcknowledger: ScheduleReconciledOutcomeAcknowledger,
  ) {}

  async executeDeviceOperation(
    deviceId: string,
    request: { readonly kind: "schedule"; readonly scheduleJson: string },
    options: DeviceOperationExecutionOptions = {},
  ): Promise<ScheduleDeliveryOperation> {
    const dispatch = await this.dispatcher.dispatch(deviceId, request, options);
    if (dispatch.kind === "blocked") {
      throw new Error(
        `Schedule delivery is blocked by ${dispatch.reason.replaceAll("_", " ")}`,
      );
    }
    return dispatch.operation;
  }

  async acknowledgeScheduleReconciledOutcome(
    operationId: string,
  ): Promise<void> {
    await this.outcomeAcknowledger.acknowledgeScheduleReconciledOutcome(
      operationId,
    );
  }
}
