import { describe, expect, it } from "vitest";

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
    finish({ id: "announcement-sync", status: "succeeded" });
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
        ? { id: "sync-unknown", status: "outcome_unknown" }
        : { id: "sync-reconciled", status: "succeeded" },
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
    finish({ id: "sync-drained", status: "succeeded" });
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
