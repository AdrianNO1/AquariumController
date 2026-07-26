import type { ScheduledDeviceOperationDispatcher } from "../scheduling/index.js";
import type {
  ManualOverrideDeviceCommandPort,
  ManualOverrideDeviceDispatchResult,
} from "./manual-override-types.js";

export interface UnknownDeviceOperationReconciler {
  acknowledgeReconciledOutcomes(operationIds: readonly string[]): Promise<void>;
}

/** Bridges overrides into the scheduler's per-device command lanes. */
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
    return this.dispatcher.dispatch(deviceId, request, {
      priority: "interactive",
    });
  }

  async reconcileUnknownOutcomes(
    operationIds: readonly string[],
  ): Promise<void> {
    await this.operationReconciler.acknowledgeReconciledOutcomes(operationIds);
  }
}
