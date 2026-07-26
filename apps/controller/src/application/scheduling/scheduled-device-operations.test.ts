import { describe, expect, it } from "vitest";

import type { DeviceOperationExecutionOptions } from "../operations/index.js";
import {
  ScheduledDeviceOperationDispatcher,
  type ScheduledDeviceOperationCompletion,
  type ScheduledDeviceOperationPort,
  type ScheduledDeviceOperationRequest,
} from "./scheduled-device-operations.js";

describe("scheduled device operation dispatcher", () => {
  it("serializes each device while allowing other devices to continue", async () => {
    let settleFirst: (
      completion: ScheduledDeviceOperationCompletion,
    ) => void = () => undefined;
    const firstCompletion = new Promise<ScheduledDeviceOperationCompletion>(
      (resolve) => {
        settleFirst = resolve;
      },
    );
    const port = new RecordingOperationPort();
    port.results.push(
      firstCompletion,
      {
        id: "operation-other-device",
        status: "succeeded",
        result: null,
      },
      {
        id: "operation-same-device-second",
        status: "succeeded",
        result: null,
      },
    );
    const dispatcher = new ScheduledDeviceOperationDispatcher(port);

    const first = dispatcher.dispatch("device-a", pwm(1, 10), {
      priority: "background",
    });
    const sameDeviceSecond = dispatcher.dispatch("device-a", pwm(2, 20));
    const otherDevice = dispatcher.dispatch("device-b", pwm(3, 30));
    await Promise.resolve();
    expect(
      port.calls.map(({ deviceId, request, options }) => [
        deviceId,
        request.kind === "set_pwm" ? request.pin : null,
        options.priority ?? "interactive",
      ]),
    ).toEqual([
      ["device-a", 1, "background"],
      ["device-b", 3, "interactive"],
    ]);
    await expect(otherDevice).resolves.toMatchObject({
      kind: "completed",
      operation: { status: "succeeded" },
    });

    settleFirst({
      id: "operation-unknown",
      status: "outcome_unknown",
      result: null,
    });
    await expect(first).resolves.toMatchObject({
      kind: "completed",
      operation: { status: "outcome_unknown" },
    });
    await expect(sameDeviceSecond).resolves.toMatchObject({
      kind: "completed",
      operation: { status: "succeeded" },
    });
    expect(dispatcher.blockedReason).toBeNull();
    expect(
      port.calls.map(({ deviceId, request, options }) => [
        deviceId,
        request.kind === "set_pwm" ? request.pin : null,
        options.priority ?? "interactive",
      ]),
    ).toEqual([
      ["device-a", 1, "background"],
      ["device-b", 3, "interactive"],
      ["device-a", 2, "interactive"],
    ]);
  });

  it("drains every active device lane and its queued work", async () => {
    let settleDeviceA: (
      completion: ScheduledDeviceOperationCompletion,
    ) => void = () => undefined;
    const deviceACompletion = new Promise<ScheduledDeviceOperationCompletion>(
      (resolve) => {
        settleDeviceA = resolve;
      },
    );
    let settleDeviceB: (
      completion: ScheduledDeviceOperationCompletion,
    ) => void = () => undefined;
    const deviceBCompletion = new Promise<ScheduledDeviceOperationCompletion>(
      (resolve) => {
        settleDeviceB = resolve;
      },
    );
    const port = new RecordingOperationPort();
    port.results.push(deviceACompletion, deviceBCompletion, {
      id: "operation-device-a-second",
      status: "succeeded",
      result: null,
    });
    const dispatcher = new ScheduledDeviceOperationDispatcher(port);
    const firstDeviceA = dispatcher.dispatch("device-a", pwm(1, 10));
    const deviceB = dispatcher.dispatch("device-b", pwm(2, 20));
    const secondDeviceA = dispatcher.dispatch("device-a", pwm(3, 30));
    await Promise.resolve();

    let drained = false;
    const drain = dispatcher.drain().then(() => {
      drained = true;
    });
    settleDeviceA({
      id: "operation-device-a-first",
      status: "succeeded",
      result: null,
    });
    await firstDeviceA;
    await secondDeviceA;
    expect(drained).toBe(false);

    settleDeviceB({
      id: "operation-device-b",
      status: "succeeded",
      result: null,
    });
    await deviceB;
    await drain;
    expect(drained).toBe(true);
    expect(port.calls.map(({ deviceId }) => deviceId)).toEqual([
      "device-a",
      "device-b",
      "device-a",
    ]);
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
      throwingDispatcher.dispatch("device-b", pwm(1, 10)),
    ).resolves.toEqual({ kind: "blocked", reason: "command_error" });

    const earlyPort = new RecordingOperationPort();
    earlyPort.results.push({
      id: "operation-pending",
      status: "in_flight",
      result: null,
    });
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
    readonly options: DeviceOperationExecutionOptions;
  }[] = [];
  readonly results: (
    | ScheduledDeviceOperationCompletion
    | Promise<ScheduledDeviceOperationCompletion>
  )[] = [];

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

function pwm(pin: number, value: number): ScheduledDeviceOperationRequest {
  return { kind: "set_pwm", pin, value, overwrite: true };
}
