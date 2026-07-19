import type { ScheduledDeviceOperationDispatcher } from "../scheduling/index.js";
import type {
  ManualOverrideDeviceCommandPort,
  ManualOverrideDeviceDispatchResult,
} from "./manual-override-types.js";

export interface UnknownDeviceOperationReconciler {
  acknowledgeReconciledOutcome(operationId: string): Promise<void>;
}

/** Bridges overrides into the scheduler's one serialized command lane. */
export class ManualOverrideCommandAdapter implements ManualOverrideDeviceCommandPort {
  constructor(
    private readonly dispatcher: ScheduledDeviceOperationDispatcher,
    private readonly operationReconciler: UnknownDeviceOperationReconciler,
  ) {}

  dispatch(
    deviceId: string,
    request: {
      readonly kind: "set_pwm";
      readonly pin: number;
      readonly value: number;
      readonly overwrite: boolean;
    },
  ): Promise<ManualOverrideDeviceDispatchResult> {
    return this.dispatcher.dispatch(deviceId, request);
  }

  async reconcileUnknownOutcome(operationId: string): Promise<void> {
    await this.operationReconciler.acknowledgeReconciledOutcome(operationId);
    await this.dispatcher.acknowledgeReconciledOutcome();
  }
}
