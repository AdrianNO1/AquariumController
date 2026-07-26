import { describe, expect, it, vi } from "vitest";

import {
  ScheduledDeviceOperationDispatcher,
  type ScheduledDeviceOperationCompletion,
  type ScheduledDeviceOperationPort,
  type ScheduledDeviceOperationRequest,
} from "./scheduled-device-operations.js";
import { ManualSchedulingTime } from "./test-scheduling-time.js";
import {
  DEVICE_TIME_SYNC_JOB_KEY,
  TimeSyncCoordinator,
  type DailySchedulerGuardPort,
  type TimeSyncDiagnostic,
} from "./time-sync-coordinator.js";

describe("time-sync coordinator", () => {
  it("coalesces announcement signals into the distinct legacy sync command", async () => {
    const time = new ManualSchedulingTime("2026-07-13T04:00:00.000Z");
    let finish: (completion: ScheduledDeviceOperationCompletion) => void = () =>
      undefined;
    const pending = new Promise<ScheduledDeviceOperationCompletion>(
      (resolve) => {
        finish = resolve;
      },
    );
    const port = new RecordingOperationPort(async () => pending);
    const coordinator = createCoordinator(
      time,
      new MemoryDailyGuards(),
      port,
      [],
    );
    await coordinator.start();

    const first = coordinator.signalAnnouncement("device-a");
    const duplicate = coordinator.signalAnnouncement("device-a");
    await Promise.resolve();
    expect(port.calls).toEqual([
      {
        deviceId: "device-a",
        request: {
          kind: "sync_time",
          epochSeconds: Math.floor(
            Date.parse("2026-07-13T04:00:00.000Z") / 1_000,
          ),
        },
      },
    ]);
    finish({ id: "announcement-sync", status: "succeeded", result: null });
    await Promise.all([first, duplicate]);
    expect(port.calls).toHaveLength(1);
    expect(port.calls[0]?.request.kind).not.toBe("schedule");
    await coordinator.stop();
  });

  it("runs at 05:00 UTC, persists once-per-day claims across restart, and ignores DST", async () => {
    const guards = new MemoryDailyGuards();
    const port = new RecordingOperationPort(
      async (_device, _request, call) => ({
        id: `daily-operation-${call}`,
        status: "succeeded",
        result: null,
      }),
    );
    const firstTime = new ManualSchedulingTime("2026-10-25T04:59:59.000Z");
    const first = createCoordinator(
      firstTime,
      guards,
      port,
      [],
      ["device-a", "device-b"],
    );
    await first.start();
    await firstTime.advanceBy(999);
    expect(port.calls).toHaveLength(0);
    await firstTime.advanceBy(1);
    expect(port.calls).toHaveLength(2);
    expect(port.calls.map(({ request }) => request.kind)).toEqual([
      "sync_time",
      "sync_time",
    ]);
    await first.stop();

    const restartedTime = new ManualSchedulingTime("2026-10-25T12:00:00.000Z");
    const restarted = createCoordinator(
      restartedTime,
      guards,
      port,
      [],
      ["device-a", "device-b"],
    );
    await restarted.start();
    expect(port.calls).toHaveLength(2);
    await restarted.stop();

    const nextUtcDay = new ManualSchedulingTime("2026-10-26T12:00:00.000Z");
    const nextDay = createCoordinator(
      nextUtcDay,
      guards,
      port,
      [],
      ["device-a", "device-b"],
    );
    await nextDay.start();
    expect(port.calls).toHaveLength(4);
    expect(
      new Set(guards.claims.map(({ utcDayStartMs }) => utcDayStartMs)),
    ).toEqual(new Set([Date.UTC(2026, 9, 25), Date.UTC(2026, 9, 26)]));
    expect(new Set(guards.claims.map(({ jobKey }) => jobKey))).toEqual(
      new Set([DEVICE_TIME_SYNC_JOB_KEY]),
    );
    await nextDay.stop();
  });

  it("continues syncing other devices after an unknown outcome", async () => {
    const time = new ManualSchedulingTime("2026-07-13T04:00:00.000Z");
    const diagnostics: TimeSyncDiagnostic[] = [];
    const port = new RecordingOperationPort(async (_device, _request, call) =>
      call === 1
        ? { id: "sync-unknown", status: "outcome_unknown", result: null }
        : { id: "sync-reconciled", status: "succeeded", result: null },
    );
    const dispatcher = new ScheduledDeviceOperationDispatcher(port);
    const coordinator = createCoordinator(
      time,
      new MemoryDailyGuards(),
      port,
      diagnostics,
      [],
      dispatcher,
    );
    await coordinator.start();

    await coordinator.signalAnnouncement("device-a");
    await coordinator.signalAnnouncement("device-b");
    expect(port.calls).toHaveLength(2);
    expect(diagnostics).toMatchObject([
      {
        code: "time_sync_operation_not_succeeded",
        deviceId: "device-a",
        status: "outcome_unknown",
      },
    ]);
    await coordinator.stop();
  });

  it("starts daily syncs for healthy devices while another device is pending", async () => {
    const time = new ManualSchedulingTime("2026-07-13T12:00:00.000Z");
    let finishDeviceA: (
      completion: ScheduledDeviceOperationCompletion,
    ) => void = () => undefined;
    const pendingDeviceA = new Promise<ScheduledDeviceOperationCompletion>(
      (resolve) => {
        finishDeviceA = resolve;
      },
    );
    const port = new RecordingOperationPort(async (deviceId, _request, call) =>
      deviceId === "device-a"
        ? pendingDeviceA
        : {
            id: `sync-${call}`,
            status: "succeeded",
            result: null,
          },
    );
    const coordinator = createCoordinator(
      time,
      new MemoryDailyGuards(),
      port,
      [],
      ["device-a", "device-b"],
    );

    const starting = coordinator.start();
    await vi.waitFor(() =>
      expect(port.calls.map(({ deviceId }) => deviceId)).toEqual([
        "device-a",
        "device-b",
      ]),
    );
    finishDeviceA({
      id: "sync-device-a",
      status: "outcome_unknown",
      result: null,
    });
    await starting;
    await coordinator.stop();
  });

  it("drains launched daily syncs before reporting a later guard failure", async () => {
    const time = new ManualSchedulingTime("2026-07-13T12:00:00.000Z");
    const guardFailure = new Error("device B guard failed");
    const claimedDeviceIds: string[] = [];
    const guards: DailySchedulerGuardPort = {
      tryClaimDailyRun: async (input) => {
        claimedDeviceIds.push(input.scopeKey);
        if (input.scopeKey === "device-b") {
          throw guardFailure;
        }
        return true;
      },
      recordDailyRunResult: async () => true,
    };
    let rejectDeviceA: (error: Error) => void = () => undefined;
    const pendingDeviceA = new Promise<ScheduledDeviceOperationCompletion>(
      (_resolve, reject) => {
        rejectDeviceA = reject;
      },
    );
    const operationFailure = new Error("device A sync failed");
    const port = new RecordingOperationPort(async () => pendingDeviceA);
    const reportedErrors: Error[] = [];
    const coordinator = new TimeSyncCoordinator(
      {
        listOnlineDeviceIds: async () => ["device-a", "device-b"],
      },
      guards,
      new ScheduledDeviceOperationDispatcher(port),
      {
        clock: time,
        timer: time,
        onDiagnostic: () => undefined,
        onError: (error) => {
          reportedErrors.push(error);
        },
      },
    );

    let startSettled = false;
    const startResult = coordinator.start().then(
      () => {
        startSettled = true;
        return null;
      },
      (error: Error) => {
        startSettled = true;
        return error;
      },
    );
    await vi.waitFor(() => {
      expect(claimedDeviceIds).toEqual(["device-a", "device-b"]);
      expect(port.calls.map(({ deviceId }) => deviceId)).toEqual(["device-a"]);
    });
    expect(startSettled).toBe(false);

    let stopSettled = false;
    const stopResult = coordinator.stop().then(
      () => {
        stopSettled = true;
        return null;
      },
      (error: Error) => {
        stopSettled = true;
        return error;
      },
    );
    await Promise.resolve();
    expect(startSettled).toBe(false);
    expect(stopSettled).toBe(false);

    rejectDeviceA(operationFailure);
    const [startError, stopError] = await Promise.all([
      startResult,
      stopResult,
    ]);
    expect(startError).toBeInstanceOf(AggregateError);
    expect(startError).toMatchObject({
      errors: [
        { message: "device A sync failed" },
        { message: "device B guard failed" },
      ],
    });
    expect(stopError).toBe(startError);
    expect(reportedErrors).toEqual([startError]);
  });

  it("drains an in-flight announcement sync during stop", async () => {
    const time = new ManualSchedulingTime("2026-07-13T04:00:00.000Z");
    let finish: (completion: ScheduledDeviceOperationCompletion) => void = () =>
      undefined;
    const pending = new Promise<ScheduledDeviceOperationCompletion>(
      (resolve) => {
        finish = resolve;
      },
    );
    const port = new RecordingOperationPort(async () => pending);
    const coordinator = createCoordinator(
      time,
      new MemoryDailyGuards(),
      port,
      [],
    );
    await coordinator.start();
    void coordinator.signalAnnouncement("device-a");
    await Promise.resolve();

    let stopped = false;
    const stop = coordinator.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    expect(() => coordinator.signalAnnouncement("device-b")).toThrow(
      /not accepting/,
    );
    finish({ id: "sync-drained", status: "succeeded", result: null });
    await stop;
    expect(stopped).toBe(true);
  });

  it("surfaces a throwing startup error reporter without an unhandled task", async () => {
    const time = new ManualSchedulingTime("2026-07-13T12:00:00.000Z");
    const coordinator = new TimeSyncCoordinator(
      {
        listOnlineDeviceIds: async () => {
          throw new Error("device projection unavailable");
        },
      },
      new MemoryDailyGuards(),
      new ScheduledDeviceOperationDispatcher(
        new RecordingOperationPort(async () => ({
          id: "unused-operation",
          status: "succeeded",
          result: null,
        })),
      ),
      {
        clock: time,
        timer: time,
        onDiagnostic: () => undefined,
        onError: () => {
          throw new Error("reporter unavailable");
        },
      },
    );

    await expect(coordinator.start()).rejects.toThrow(/error reporter failed/i);
    await expect(coordinator.stop()).rejects.toThrow(/error reporter failed/i);
  });
});

class MemoryDailyGuards implements DailySchedulerGuardPort {
  readonly claims: {
    readonly jobKey: string;
    readonly scopeKey: string;
    readonly utcDayStartMs: number;
    readonly startedAtMs: number;
  }[] = [];
  readonly results: {
    readonly scopeKey: string;
    readonly utcDayStartMs: number;
    readonly operationId: string;
    readonly succeeded: boolean;
  }[] = [];
  readonly #startedDays = new Map<string, number>();

  async tryClaimDailyRun(input: {
    readonly jobKey: string;
    readonly scopeKey: string;
    readonly utcDayStartMs: number;
    readonly startedAtMs: number;
  }): Promise<boolean> {
    const key = `${input.jobKey}\0${input.scopeKey}`;
    if (this.#startedDays.get(key) === input.utcDayStartMs) {
      return false;
    }
    this.#startedDays.set(key, input.utcDayStartMs);
    this.claims.push(input);
    return true;
  }

  async recordDailyRunResult(input: {
    readonly jobKey: string;
    readonly scopeKey: string;
    readonly utcDayStartMs: number;
    readonly completedAtMs: number;
    readonly operationId: string;
    readonly succeeded: boolean;
  }): Promise<boolean> {
    const key = `${input.jobKey}\0${input.scopeKey}`;
    if (this.#startedDays.get(key) !== input.utcDayStartMs) {
      return false;
    }
    this.results.push({
      scopeKey: input.scopeKey,
      utcDayStartMs: input.utcDayStartMs,
      operationId: input.operationId,
      succeeded: input.succeeded,
    });
    return true;
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

function createCoordinator(
  time: ManualSchedulingTime,
  guards: DailySchedulerGuardPort,
  port: ScheduledDeviceOperationPort,
  diagnostics: TimeSyncDiagnostic[],
  deviceIds: readonly string[] = [],
  dispatcher = new ScheduledDeviceOperationDispatcher(port),
): TimeSyncCoordinator {
  return new TimeSyncCoordinator(
    { listOnlineDeviceIds: async () => deviceIds },
    guards,
    dispatcher,
    {
      clock: time,
      timer: time,
      onDiagnostic: (diagnostic) => diagnostics.push(diagnostic),
      onError: (error) => {
        throw error;
      },
    },
  );
}
