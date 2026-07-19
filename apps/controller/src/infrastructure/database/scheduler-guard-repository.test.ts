import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  closeControllerDatabases,
  openControllerDatabases,
  type ControllerDatabases,
} from "./index.js";
import {
  OnlineDeviceRepository,
  SchedulerGuardRepository,
} from "./scheduler-guard-repository.js";

let databases: ControllerDatabases | undefined;

afterEach(async () => {
  if (databases !== undefined) {
    await closeControllerDatabases(databases);
    databases = undefined;
  }
});

describe("scheduler guard repository", () => {
  it("claims at most once per UTC day and records the terminal operation", async () => {
    databases = await openControllerDatabases({
      state: { filename: ":memory:" },
      events: { filename: ":memory:" },
    });
    const dayStartMs = Date.UTC(2026, 6, 13);
    await insertDeviceAndOperation(databases, "operation-day-one", dayStartMs);
    await insertOperation(
      databases,
      "operation-day-two",
      dayStartMs + 86_400_000,
    );
    const repository = new SchedulerGuardRepository(databases.state);

    await expect(
      repository.tryClaimDailyRun({
        jobKey: "device-time-sync",
        scopeKey: "device-a",
        utcDayStartMs: dayStartMs,
        startedAtMs: dayStartMs + 18_000_000,
      }),
    ).resolves.toBe(true);
    await expect(
      repository.tryClaimDailyRun({
        jobKey: "device-time-sync",
        scopeKey: "device-a",
        utcDayStartMs: dayStartMs,
        startedAtMs: dayStartMs + 18_001_000,
      }),
    ).resolves.toBe(false);
    await expect(
      repository.recordDailyRunResult({
        jobKey: "device-time-sync",
        scopeKey: "device-a",
        utcDayStartMs: dayStartMs,
        completedAtMs: dayStartMs + 18_002_000,
        operationId: "operation-day-one",
        succeeded: true,
      }),
    ).resolves.toBe(true);

    const nextDayStartMs = dayStartMs + 86_400_000;
    await expect(
      repository.tryClaimDailyRun({
        jobKey: "device-time-sync",
        scopeKey: "device-a",
        utcDayStartMs: nextDayStartMs,
        startedAtMs: nextDayStartMs + 18_000_000,
      }),
    ).resolves.toBe(true);
    await expect(
      repository.recordDailyRunResult({
        jobKey: "device-time-sync",
        scopeKey: "device-a",
        utcDayStartMs: dayStartMs,
        completedAtMs: dayStartMs + 18_003_000,
        operationId: "operation-day-one",
        succeeded: true,
      }),
    ).resolves.toBe(false);
    expect(
      await databases.state
        .selectFrom("scheduler_guards")
        .selectAll()
        .executeTakeFirstOrThrow(),
    ).toMatchObject({
      last_started_utc_day_start_ms: nextDayStartMs,
      last_started_at_ms: nextDayStartMs + 18_000_000,
      last_operation_id: null,
      last_success_utc_day_start_ms: dayStartMs,
      last_success_at_ms: dayStartMs + 18_002_000,
    });
  });

  it("retains the daily claim across a database reopen and lists only online enabled devices", async () => {
    const directory = await mkdtemp(
      join(tmpdir(), "aquarium-scheduler-guard-"),
    );
    const stateFilename = join(directory, "state.db");
    const eventsFilename = join(directory, "events.db");
    const dayStartMs = Date.UTC(2026, 9, 25);
    try {
      databases = await openControllerDatabases({
        state: { filename: stateFilename },
        events: { filename: eventsFilename },
      });
      await insertDeviceAndOperation(databases, "operation-reopen", dayStartMs);
      await insertDevice(databases, "device-offline", "offline", 1, dayStartMs);
      await insertDevice(databases, "device-disabled", "online", 0, dayStartMs);
      await expect(
        new SchedulerGuardRepository(databases.state).tryClaimDailyRun({
          jobKey: "device-time-sync",
          scopeKey: "device-a",
          utcDayStartMs: dayStartMs,
          startedAtMs: dayStartMs + 18_000_000,
        }),
      ).resolves.toBe(true);
      await closeControllerDatabases(databases);
      databases = undefined;

      databases = await openControllerDatabases({
        state: { filename: stateFilename },
        events: { filename: eventsFilename },
      });
      await expect(
        new SchedulerGuardRepository(databases.state).tryClaimDailyRun({
          jobKey: "device-time-sync",
          scopeKey: "device-a",
          utcDayStartMs: dayStartMs,
          startedAtMs: dayStartMs + 18_100_000,
        }),
      ).resolves.toBe(false);
      await expect(
        new OnlineDeviceRepository(databases.state).listOnlineDeviceIds(),
      ).resolves.toEqual(["device-a"]);
    } finally {
      if (databases !== undefined) {
        await closeControllerDatabases(databases);
        databases = undefined;
      }
      await rm(directory, { recursive: true, force: true });
    }
  });
});

async function insertDeviceAndOperation(
  context: ControllerDatabases,
  operationId: string,
  nowMs: number,
): Promise<void> {
  await insertDevice(context, "device-a", "online", 1, nowMs);
  await insertOperation(context, operationId, nowMs);
}

async function insertDevice(
  context: ControllerDatabases,
  id: string,
  status: "online" | "offline",
  enabled: 0 | 1,
  nowMs: number,
): Promise<void> {
  await context.state
    .insertInto("devices")
    .values({
      id,
      hardware_id: `hardware-${id}`,
      name: id,
      mapping_profile_id: null,
      reported_name: id,
      desired_pwm_frequency_hz: 5_000,
      desired_pwm_resolution_bits: 8,
      reported_pwm_frequency_hz: 5_000,
      reported_pwm_resolution_bits: 8,
      firmware_version: "4.0.0",
      reported_schedule_hash: "0",
      status,
      last_seen_at_ms: nowMs,
      last_error_code: null,
      last_error_message: null,
      enabled,
      created_at_ms: nowMs,
      updated_at_ms: nowMs,
      metadata_json: null,
      metadata_schema_version: null,
    })
    .execute();
}

async function insertOperation(
  context: ControllerDatabases,
  operationId: string,
  nowMs: number,
): Promise<void> {
  await context.state
    .insertInto("control_operations")
    .values({
      id: operationId,
      device_id: "device-a",
      kind: "sync_time",
      status: "succeeded",
      requested_at_ms: nowMs,
      deadline_at_ms: nowMs + 5_000,
      completed_at_ms: nowMs + 1,
      request_json: JSON.stringify({ kind: "sync_time", epochSeconds: 1 }),
      request_schema_version: 1,
      result_json: JSON.stringify({
        status: "succeeded",
        wireOperationId: `wire-${operationId}`,
        analogValue: null,
      }),
      result_schema_version: 1,
    })
    .execute();
}
