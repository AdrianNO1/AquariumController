import { describe, expect, it } from "vitest";

import {
  ScheduledDeviceOperationDispatcher,
  type ScheduledDeviceOperationCompletion,
  type ScheduledDeviceOperationPort,
  type ScheduledDeviceOperationRequest,
} from "./scheduled-device-operations.js";

describe("scheduled device operation safety dispatcher", () => {
  it("serializes callers and blocks queued work after an outcome becomes unknown", async () => {
    let settleFirst: (
      completion: ScheduledDeviceOperationCompletion,
    ) => void = () => undefined;
    const firstCompletion = new Promise<ScheduledDeviceOperationCompletion>(
      (resolve) => {
        settleFirst = resolve;
      },
    );
    const port = new RecordingOperationPort();
    port.results.push(firstCompletion, {
      id: "operation-after-reconciliation",
      status: "succeeded",
    });
    const dispatcher = new ScheduledDeviceOperationDispatcher(port);

    const first = dispatcher.dispatch("device-a", pwm(1, 10));
    const queued = dispatcher.dispatch("device-b", pwm(2, 20));
    await Promise.resolve();
    expect(port.calls).toHaveLength(1);

    settleFirst({ id: "operation-unknown", status: "outcome_unknown" });
    await expect(first).resolves.toMatchObject({
      kind: "completed",
      operation: { status: "outcome_unknown" },
    });
    await expect(queued).resolves.toEqual({
      kind: "blocked",
      reason: "outcome_unknown",
    });
    expect(port.calls).toHaveLength(1);

    await dispatcher.acknowledgeReconciledOutcome();
    await expect(
      dispatcher.dispatch("device-b", pwm(2, 20)),
    ).resolves.toMatchObject({
      kind: "completed",
      operation: { status: "succeeded" },
    });
    expect(port.calls).toHaveLength(2);
  });

  it("fails closed when the persistent operation port throws or returns early", async () => {
    const throwingPort: ScheduledDeviceOperationPort = {
      executeDeviceOperation: async () => {
        throw new Error("state persistence failed");
      },
    };
    const throwingDispatcher = new ScheduledDeviceOperationDispatcher(
      throwingPort,
    );
    await expect(
      throwingDispatcher.dispatch("device-a", pwm(1, 10)),
    ).rejects.toThrow(/persistence failed/);
    await expect(
      throwingDispatcher.dispatch("device-a", pwm(1, 10)),
    ).resolves.toEqual({ kind: "blocked", reason: "command_error" });

    const earlyPort = new RecordingOperationPort();
    earlyPort.results.push({ id: "operation-pending", status: "in_flight" });
    const earlyDispatcher = new ScheduledDeviceOperationDispatcher(earlyPort);
    await expect(
      earlyDispatcher.dispatch("device-a", pwm(1, 10)),
    ).rejects.toThrow(/terminal state/);
    expect(earlyDispatcher.blockedReason).toBe("command_error");
  });
});

class RecordingOperationPort implements ScheduledDeviceOperationPort {
  readonly calls: {
    readonly deviceId: string;
    readonly request: ScheduledDeviceOperationRequest;
  }[] = [];
  readonly results: (
    | ScheduledDeviceOperationCompletion
    | Promise<ScheduledDeviceOperationCompletion>
  )[] = [];

  async executeDeviceOperation(
    deviceId: string,
    request: ScheduledDeviceOperationRequest,
  ): Promise<ScheduledDeviceOperationCompletion> {
    this.calls.push({ deviceId, request });
    const result = this.results.shift();
    if (result === undefined) {
      throw new Error("Test operation result is required");
    }
    return result;
  }
}

function pwm(pin: number, value: number): ScheduledDeviceOperationRequest {
  return { kind: "set_pwm", pin, value, overwrite: false };
}
