import { describe, expect, it, vi } from "vitest";

import type {
  DeviceOperationExecutionOptions,
  DeviceOperationResult,
} from "../operations/index.js";
import {
  ScheduledDeviceOperationDispatcher,
  type ScheduledDeviceOperationCompletion,
  type ScheduledDeviceOperationPort,
  type ScheduledDeviceOperationRequest,
} from "../scheduling/index.js";
import { ScheduleReconciliationCommandAdapter } from "./schedule-reconciliation-command-adapter.js";

describe("ScheduleReconciliationCommandAdapter", () => {
  it("queues schedule delivery behind active same-device work", async () => {
    let finishRefresh: (
      completion: ScheduledDeviceOperationCompletion,
    ) => void = () => undefined;
    const refreshCompletion = new Promise<ScheduledDeviceOperationCompletion>(
      (resolve) => {
        finishRefresh = resolve;
      },
    );
    const scheduleResult: DeviceOperationResult = {
      status: "succeeded",
      wireOperationId: "wire-schedule",
      analogValue: null,
    };
    const port = new RecordingOperationPort([
      refreshCompletion,
      {
        id: "operation-schedule",
        status: "succeeded",
        result: scheduleResult,
      },
    ]);
    const reconciledOperationIds: string[] = [];
    const dispatcher = new ScheduledDeviceOperationDispatcher(port);
    const adapter = new ScheduleReconciliationCommandAdapter(dispatcher, {
      acknowledgeScheduleReconciledOutcome: async (operationId) => {
        reconciledOperationIds.push(operationId);
      },
    });

    const refresh = dispatcher.dispatch("device-a", {
      kind: "set_pwm",
      pin: 1,
      value: 100,
      overwrite: true,
    });
    await vi.waitFor(() => expect(port.calls).toHaveLength(1));
    const schedule = adapter.executeDeviceOperation(
      "device-a",
      {
        kind: "schedule",
        scheduleJson: '{"c":[],"syncTime":1}',
      },
      { priority: "background" },
    );
    await Promise.resolve();
    expect(port.calls.map(({ request }) => request.kind)).toEqual(["set_pwm"]);

    finishRefresh({
      id: "operation-refresh",
      status: "succeeded",
      result: null,
    });
    await expect(refresh).resolves.toMatchObject({
      kind: "completed",
      operation: { id: "operation-refresh" },
    });
    await expect(schedule).resolves.toEqual({
      id: "operation-schedule",
      status: "succeeded",
      result: scheduleResult,
    });
    expect(
      port.calls.map(({ request, options }) => [
        request.kind,
        options.priority ?? "interactive",
      ]),
    ).toEqual([
      ["set_pwm", "interactive"],
      ["schedule", "background"],
    ]);

    await adapter.acknowledgeScheduleReconciledOutcome("operation-unknown");
    expect(reconciledOperationIds).toEqual(["operation-unknown"]);
  });
});

class RecordingOperationPort implements ScheduledDeviceOperationPort {
  readonly calls: {
    readonly deviceId: string;
    readonly request: ScheduledDeviceOperationRequest;
    readonly options: DeviceOperationExecutionOptions;
  }[] = [];

  constructor(
    private readonly results: (
      | ScheduledDeviceOperationCompletion
      | Promise<ScheduledDeviceOperationCompletion>
    )[],
  ) {}

  async executeDeviceOperation(
    deviceId: string,
    request: ScheduledDeviceOperationRequest,
    options: DeviceOperationExecutionOptions = {},
  ): Promise<ScheduledDeviceOperationCompletion> {
    this.calls.push({ deviceId, request, options });
    const result = this.results.shift();
    if (result === undefined) {
      throw new Error("Test operation result is required");
    }
    return result;
  }
}
