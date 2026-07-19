import { describe, expect, it } from "vitest";

import { ManualSchedulingTime } from "../scheduling/test-scheduling-time.js";
import {
  DAILY_CONTROLLER_BACKUP_HOUR_UTC,
  DailyControllerBackupCoordinator,
  type ControllerBackupMaintenancePort,
} from "./daily-controller-backup-coordinator.js";

const HOUR_MS = 3_600_000;
const DAY_MS = 86_400_000;
const FRESHNESS_THRESHOLD_MS = 36 * HOUR_MS;

interface BackupCall {
  readonly runAtMs: number;
  readonly trigger: "startup" | "scheduled";
}

class RecordingMaintenance implements ControllerBackupMaintenancePort {
  readonly calls: BackupCall[] = [];

  constructor(
    public latestVerifiedAtMs: number | null,
    private readonly runImplementation: (
      input: BackupCall,
    ) => Promise<object> = async () => ({}),
  ) {}

  async readLatestVerifiedBackupAtMs(): Promise<number | null> {
    return this.latestVerifiedAtMs;
  }

  async run(input: BackupCall): Promise<object> {
    this.calls.push(input);
    return this.runImplementation(input);
  }
}

describe("daily controller-backup coordinator", () => {
  it("runs promptly on startup with no success or a success older than the freshness threshold", async () => {
    const now = Date.parse("2026-07-15T12:00:00.000Z");
    for (const latestSuccessfulAtMs of [
      null,
      now - FRESHNESS_THRESHOLD_MS - 1,
    ]) {
      const time = new ManualSchedulingTime(now);
      const maintenance = new RecordingMaintenance(latestSuccessfulAtMs);
      const coordinator = createCoordinator(time, maintenance);

      await coordinator.start();
      expect(maintenance.calls).toEqual([{ runAtMs: now, trigger: "startup" }]);
      await coordinator.stop();
    }
  });

  it("accepts a success exactly at the freshness boundary and runs at 02:00 UTC", async () => {
    const initial = Date.parse("2026-07-15T01:59:59.000Z");
    const time = new ManualSchedulingTime(initial);
    const maintenance = new RecordingMaintenance(
      initial - FRESHNESS_THRESHOLD_MS,
    );
    const coordinator = createCoordinator(time, maintenance);

    await coordinator.start();
    expect(maintenance.calls).toEqual([]);
    await time.advanceBy(999);
    expect(maintenance.calls).toEqual([]);
    await time.advanceBy(1);
    expect(maintenance.calls).toEqual([
      {
        runAtMs: Date.parse("2026-07-15T02:00:00.000Z"),
        trigger: "scheduled",
      },
    ]);
    expect(DAILY_CONTROLLER_BACKUP_HOUR_UTC).toBe(2);
    await coordinator.stop();
  });

  it("never overlaps, skips catch-up bursts, and drains an in-flight backup during stop", async () => {
    const initial = Date.parse("2026-07-15T01:59:59.000Z");
    const time = new ManualSchedulingTime(initial);
    let finish: (result: object) => void = () => undefined;
    const pending = new Promise<object>((resolve) => {
      finish = resolve;
    });
    const maintenance = new RecordingMaintenance(initial, () => pending);
    const coordinator = createCoordinator(time, maintenance);

    await coordinator.start();
    await time.advanceBy(1_000);
    expect(maintenance.calls).toHaveLength(1);
    await time.advanceBy(2 * DAY_MS);
    expect(maintenance.calls).toHaveLength(1);

    let stopped = false;
    const stop = coordinator.stop().then(() => {
      stopped = true;
    });
    await Promise.resolve();
    expect(stopped).toBe(false);
    finish({});
    await stop;
    expect(stopped).toBe(true);
    expect(maintenance.calls).toHaveLength(1);
  });

  it("records a run failure through the reporter and remains scheduled", async () => {
    const initial = Date.parse("2026-07-15T12:00:00.000Z");
    const time = new ManualSchedulingTime(initial);
    const failures: Error[] = [];
    let attempts = 0;
    const maintenance = new RecordingMaintenance(null, async () => {
      attempts += 1;
      if (attempts === 1) {
        throw new Error("backup volume unavailable");
      }
      return {};
    });
    const coordinator = createCoordinator(time, maintenance, (error) =>
      failures.push(error),
    );

    await coordinator.start();
    expect(failures.map((error) => error.message)).toEqual([
      "backup volume unavailable",
    ]);
    await time.advanceBy(14 * HOUR_MS);
    expect(maintenance.calls.map((call) => call.trigger)).toEqual([
      "startup",
      "scheduled",
    ]);
    await coordinator.stop();
  });

  it("fails loudly on invalid thresholds and impossible durable history", async () => {
    const time = new ManualSchedulingTime("2026-07-15T12:00:00.000Z");
    const maintenance = new RecordingMaintenance(
      Date.parse("2026-07-15T12:00:00.001Z"),
    );
    expect(
      () =>
        new DailyControllerBackupCoordinator(maintenance, {
          clock: time,
          timer: time,
          freshnessThresholdMs: 0,
          onError: () => undefined,
        }),
    ).toThrow(/positive safe integer/u);

    const coordinator = createCoordinator(time, maintenance);
    await expect(coordinator.start()).rejects.toThrow(/future/u);
    await expect(coordinator.stop()).rejects.toThrow(/future/u);
  });
});

function createCoordinator(
  time: ManualSchedulingTime,
  maintenance: ControllerBackupMaintenancePort,
  onError: (error: Error) => void = () => undefined,
): DailyControllerBackupCoordinator {
  return new DailyControllerBackupCoordinator(maintenance, {
    clock: time,
    timer: time,
    freshnessThresholdMs: FRESHNESS_THRESHOLD_MS,
    onError,
  });
}
