import {
  scheduleGraphFromPoints,
  validateScheduleGraph,
  type ValidatedScheduleGraph,
} from "@aquarium/domain";
import { describe, expect, it } from "vitest";

import {
  OutputRefreshScheduler,
  type ActiveOutputProjectionReader,
  type ActiveScheduledOutput,
  type OutputRefreshTickReport,
} from "./output-refresh-scheduler.js";
import {
  ScheduledDeviceOperationDispatcher,
  type ScheduledDeviceOperationCompletion,
  type ScheduledDeviceOperationPort,
  type ScheduledDeviceOperationRequest,
} from "./scheduled-device-operations.js";
import { ManualSchedulingTime } from "./test-scheduling-time.js";
import type { ManualOverrideOverlayOutput } from "../overrides/manual-override-types.js";

describe("five-second output refresh scheduler", () => {
  it("evaluates mapped outputs and resends normalized 8-bit PWM values", async () => {
    const time = new ManualSchedulingTime("2026-07-13T06:00:00.000Z");
    const reports: OutputRefreshTickReport[] = [];
    const port = new RecordingOperationPort(async (_deviceId, _request, call) =>
      succeeded(call),
    );
    const scheduler = createScheduler(
      time,
      [
        output({
          deviceId: "device-a",
          mappingId: "mapping-a",
          pin: 1,
          throttlePercent: 50,
          outputGain: 1,
          schedule: rampGraph(),
        }),
        output({
          deviceId: "device-b",
          mappingId: "mapping-b",
          pin: 2,
          throttlePercent: 100,
          outputGain: 0.7,
          schedule: flatGraph(100),
        }),
      ],
      port,
      reports,
    );

    scheduler.start();
    await time.advanceBy(4_999);
    expect(port.calls).toHaveLength(0);
    await time.advanceBy(1);
    expect(port.calls).toEqual([
      {
        deviceId: "device-a",
        request: { kind: "set_pwm", pin: 1, value: 64, overwrite: true },
      },
      {
        deviceId: "device-b",
        request: { kind: "set_pwm", pin: 2, value: 178, overwrite: true },
      },
    ]);
    expect(reports).toMatchObject([
      {
        evaluatedUtcMinute: 360,
        outputCount: 2,
        operationCount: 2,
        diagnostics: [],
      },
    ]);

    await time.advanceBy(5_000);
    expect(port.calls).toHaveLength(4);
    expect(port.calls.slice(2)).toEqual(port.calls.slice(0, 2));
    expect(reports).toHaveLength(2);
    await scheduler.stop();
  });

  it("skips every missed deadline without overlap or a catch-up burst", async () => {
    const time = new ManualSchedulingTime("2026-07-13T12:00:00.000Z");
    let finishFirst: (value: ScheduledDeviceOperationCompletion) => void = () =>
      undefined;
    const first = new Promise<ScheduledDeviceOperationCompletion>((resolve) => {
      finishFirst = resolve;
    });
    const port = new RecordingOperationPort(async (_device, _request, call) =>
      call === 1 ? first : succeeded(call),
    );
    const scheduler = createScheduler(
      time,
      [output({ schedule: flatGraph(50) })],
      port,
      [],
    );

    scheduler.start();
    await time.advanceBy(5_000);
    expect(port.calls).toHaveLength(1);
    await time.advanceBy(15_000);
    expect(port.calls).toHaveLength(1);

    finishFirst(succeeded(1));
    await time.advanceBy(0);
    await time.advanceBy(4_999);
    expect(port.calls).toHaveLength(1);
    await time.advanceBy(1);
    expect(port.calls).toHaveLength(2);
    await scheduler.stop();
  });

  it("refreshes scheduled and unscheduled override rows with overwrite enabled", async () => {
    const time = new ManualSchedulingTime("2026-07-13T12:00:00.000Z");
    const port = new RecordingOperationPort(async (_device, _request, call) =>
      succeeded(call),
    );
    const scheduler = createScheduler(
      time,
      [output({ mappingId: "mapping-scheduled", pin: 1 })],
      port,
      [],
      [
        {
          overrideId: "override-scheduled",
          deviceId: "device-a",
          mappingId: "mapping-scheduled",
          pin: 1,
          value: 200,
          overwrite: true,
          expiresAtMs: Date.parse("2026-07-13T12:02:00.000Z"),
        },
        {
          overrideId: "override-output",
          deviceId: "device-a",
          mappingId: "mapping-output",
          pin: 2,
          value: 180,
          overwrite: true,
          expiresAtMs: Date.parse("2026-07-13T12:02:00.000Z"),
        },
      ],
    );

    scheduler.start();
    await time.advanceBy(5_000);
    expect(port.calls).toEqual([
      {
        deviceId: "device-a",
        request: { kind: "set_pwm", pin: 1, value: 200, overwrite: true },
      },
      {
        deviceId: "device-a",
        request: { kind: "set_pwm", pin: 2, value: 180, overwrite: true },
      },
    ]);
    await scheduler.stop();
  });

  it("stops safely by draining the active command and starting no later outputs", async () => {
    const time = new ManualSchedulingTime("2026-07-13T12:00:00.000Z");
    let finish: (value: ScheduledDeviceOperationCompletion) => void = () =>
      undefined;
    const pending = new Promise<ScheduledDeviceOperationCompletion>(
      (resolve) => {
        finish = resolve;
      },
    );
    const port = new RecordingOperationPort(async () => pending);
    const scheduler = createScheduler(
      time,
      [
        output({ mappingId: "mapping-first", pin: 1 }),
        output({ mappingId: "mapping-second", pin: 2 }),
      ],
      port,
      [],
    );

    scheduler.start();
    await time.advanceBy(5_000);
    expect(port.calls).toHaveLength(1);
    const stopping = scheduler.stop();
    finish(succeeded(1));
    await stopping;
    await time.advanceBy(20_000);
    expect(port.calls).toHaveLength(1);
  });

  it("continues other devices and skips remaining mappings for the failed device", async () => {
    const time = new ManualSchedulingTime("2026-07-13T12:00:00.000Z");
    const reports: OutputRefreshTickReport[] = [];
    const port = new RecordingOperationPort(async (deviceId, _request, call) =>
      deviceId === "device-a"
        ? {
            id: `operation-unknown-${call}`,
            status: "outcome_unknown",
          }
        : succeeded(call),
    );
    const scheduler = createScheduler(
      time,
      [
        output({
          deviceId: "device-a",
          mappingId: "mapping-a-first",
          pin: 1,
        }),
        output({
          deviceId: "device-a",
          mappingId: "mapping-a-second",
          pin: 2,
        }),
        output({
          deviceId: "device-b",
          mappingId: "mapping-b",
          pin: 3,
        }),
      ],
      port,
      reports,
    );

    scheduler.start();
    await time.advanceBy(5_000);
    expect(
      port.calls.map(({ deviceId, request }) => [
        deviceId,
        request.kind === "set_pwm" ? request.pin : null,
      ]),
    ).toEqual([
      ["device-a", 1],
      ["device-b", 3],
    ]);
    expect(reports[0]?.diagnostics).toMatchObject([
      { code: "scheduled_operation_not_succeeded", status: "outcome_unknown" },
    ]);

    await time.advanceBy(5_000);
    expect(port.calls.map(({ deviceId }) => deviceId)).toEqual([
      "device-a",
      "device-b",
      "device-b",
    ]);
    scheduler.signalDeviceAvailable("device-a");
    await time.advanceBy(5_000);
    expect(port.calls.map(({ deviceId }) => deviceId)).toEqual([
      "device-a",
      "device-b",
      "device-b",
      "device-a",
      "device-b",
    ]);
    await scheduler.stop();
  });

  it("captures a throwing timer-task error reporter as fatal state", async () => {
    const time = new ManualSchedulingTime("2026-07-13T12:00:00.000Z");
    const scheduler = new OutputRefreshScheduler(
      {
        readActiveOutputs: async () => {
          throw new Error("projection unavailable");
        },
      },
      new ScheduledDeviceOperationDispatcher(
        new RecordingOperationPort(async () => succeeded(1)),
      ),
      {
        clock: time,
        timer: time,
        manualOverrideReader: {
          readActiveManualOverrideOutputs: async () => [],
        },
        onTick: () => undefined,
        onError: () => {
          throw new Error("reporter unavailable");
        },
      },
    );

    scheduler.start();
    await time.advanceBy(5_000);
    await expect(scheduler.stop()).rejects.toThrow(/error reporter failed/i);
  });
});

class StaticProjection implements ActiveOutputProjectionReader {
  constructor(readonly outputs: readonly ActiveScheduledOutput[]) {}

  async readActiveOutputs() {
    return { outputs: this.outputs, diagnostics: [] };
  }
}

class RecordingOperationPort implements ScheduledDeviceOperationPort {
  readonly calls: {
    readonly deviceId: string;
    readonly request: ScheduledDeviceOperationRequest;
  }[] = [];

  constructor(
    readonly handler: (
      deviceId: string,
      request: ScheduledDeviceOperationRequest,
      call: number,
    ) => Promise<ScheduledDeviceOperationCompletion>,
  ) {}

  async executeDeviceOperation(
    deviceId: string,
    request: ScheduledDeviceOperationRequest,
  ): Promise<ScheduledDeviceOperationCompletion> {
    this.calls.push({ deviceId, request });
    return this.handler(deviceId, request, this.calls.length);
  }
}

function createScheduler(
  time: ManualSchedulingTime,
  outputs: readonly ActiveScheduledOutput[],
  port: ScheduledDeviceOperationPort,
  reports: OutputRefreshTickReport[],
  manualOverrides: readonly ManualOverrideOverlayOutput[] = [],
): OutputRefreshScheduler {
  return new OutputRefreshScheduler(
    new StaticProjection(outputs),
    new ScheduledDeviceOperationDispatcher(port),
    {
      clock: time,
      timer: time,
      manualOverrideReader: {
        readActiveManualOverrideOutputs: async () => manualOverrides,
      },
      onTick: (report) => reports.push(report),
      onError: (error) => {
        throw error;
      },
    },
  );
}

function output(
  overrides: Partial<ActiveScheduledOutput> = {},
): ActiveScheduledOutput {
  return {
    deviceId: "device-a",
    mappingId: "mapping-a",
    channelId: "channel-a",
    pin: 1,
    throttlePercent: 100,
    outputGain: 1,
    schedule: flatGraph(100),
    ...overrides,
  };
}

function flatGraph(percent: number): ValidatedScheduleGraph {
  return requireValidGraph([
    { minute: 0, percent },
    { minute: 1_439, percent },
  ]);
}

function rampGraph(): ValidatedScheduleGraph {
  return requireValidGraph([
    { minute: 0, percent: 0 },
    { minute: 720, percent: 100 },
    { minute: 1_439, percent: 0 },
  ]);
}

function requireValidGraph(
  points: readonly { readonly minute: number; readonly percent: number }[],
): ValidatedScheduleGraph {
  const result = validateScheduleGraph(scheduleGraphFromPoints(points));
  if (!result.ok) {
    throw new Error(`Test graph is invalid: ${JSON.stringify(result.issues)}`);
  }
  return result.graph;
}

function succeeded(call: number): ScheduledDeviceOperationCompletion {
  return { id: `operation-${call}`, status: "succeeded" };
}
