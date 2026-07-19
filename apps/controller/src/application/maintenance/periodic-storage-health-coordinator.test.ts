import { describe, expect, it } from "vitest";

import { ManualSchedulingTime } from "../scheduling/test-scheduling-time.js";
import {
  PeriodicStorageHealthCoordinator,
  type StorageHealthCheckPort,
} from "./periodic-storage-health-coordinator.js";

class RecordingStorageHealthCheck implements StorageHealthCheckPort {
  readonly observedAtMs: number[] = [];
  failure: Error | null = null;

  async evaluate(input: { readonly observedAtMs: number }): Promise<object> {
    this.observedAtMs.push(input.observedAtMs);
    if (this.failure !== null) {
      throw this.failure;
    }
    return {};
  }
}

describe("PeriodicStorageHealthCoordinator", () => {
  it("checks immediately and schedules one check after each interval", async () => {
    const time = new ManualSchedulingTime(1_000);
    const health = new RecordingStorageHealthCheck();
    const coordinator = new PeriodicStorageHealthCoordinator(health, {
      clock: time,
      timer: time,
      intervalMs: 500,
      onError: () => undefined,
    });

    await coordinator.start();
    expect(health.observedAtMs).toEqual([1_000]);
    await time.advanceBy(499);
    expect(health.observedAtMs).toEqual([1_000]);
    await time.advanceBy(1);
    expect(health.observedAtMs).toEqual([1_000, 1_500]);
    await time.advanceBy(500);
    expect(health.observedAtMs).toEqual([1_000, 1_500, 2_000]);

    await coordinator.stop();
    await time.advanceBy(1_000);
    expect(health.observedAtMs).toEqual([1_000, 1_500, 2_000]);
  });

  it("reports a scheduled failure and retries only at the next interval", async () => {
    const time = new ManualSchedulingTime(1_000);
    const health = new RecordingStorageHealthCheck();
    const reported: Error[] = [];
    const coordinator = new PeriodicStorageHealthCoordinator(health, {
      clock: time,
      timer: time,
      intervalMs: 500,
      onError: (error) => reported.push(error),
    });
    await coordinator.start();

    const failure = new Error("statfs failed");
    health.failure = failure;
    await time.advanceBy(500);
    expect(reported).toEqual([failure]);
    health.failure = null;
    await time.advanceBy(500);
    expect(health.observedAtMs).toEqual([1_000, 1_500, 2_000]);

    await coordinator.stop();
  });

  it("fails startup loudly and cannot be restarted", async () => {
    const time = new ManualSchedulingTime(1_000);
    const health = new RecordingStorageHealthCheck();
    const failure = new Error("storage check failed");
    health.failure = failure;
    const coordinator = new PeriodicStorageHealthCoordinator(health, {
      clock: time,
      timer: time,
      intervalMs: 500,
      onError: () => undefined,
    });

    await expect(coordinator.start()).rejects.toBe(failure);
    await expect(coordinator.stop()).rejects.toBe(failure);
    await expect(coordinator.start()).rejects.toThrow(/cannot be restarted/u);
  });

  it("rejects invalid intervals and duplicate starts", async () => {
    const time = new ManualSchedulingTime(1_000);
    const health = new RecordingStorageHealthCheck();
    expect(
      () =>
        new PeriodicStorageHealthCoordinator(health, {
          clock: time,
          timer: time,
          intervalMs: 0,
          onError: () => undefined,
        }),
    ).toThrow(/positive safe integer/u);

    const coordinator = new PeriodicStorageHealthCoordinator(health, {
      clock: time,
      timer: time,
      intervalMs: 500,
      onError: () => undefined,
    });
    await coordinator.start();
    await expect(coordinator.start()).rejects.toThrow(/already started/u);
    await coordinator.stop();
  });
});
