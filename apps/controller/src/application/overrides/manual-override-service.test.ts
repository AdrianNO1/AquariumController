import type { Kysely } from "kysely";
import { afterEach, describe, expect, it, vi } from "vitest";

import { ManualSchedulingTime } from "../scheduling/test-scheduling-time.js";
import { openStateDatabase } from "../../infrastructure/database/connection.js";
import { ManualOverrideRepository } from "../../infrastructure/database/manual-override-repository.js";
import type { StateDatabaseSchema } from "../../infrastructure/database/types.js";
import { ManualOverrideService } from "./manual-override-service.js";
import type {
  ManualOverrideDeviceCommandPort,
  ManualOverrideDeviceDispatchResult,
} from "./manual-override-types.js";

const INITIAL_TIME_MS = 10_000;

let database: Kysely<StateDatabaseSchema> | undefined;
const services = new Set<ManualOverrideService>();

afterEach(async () => {
  await Promise.all([...services].map((service) => service.stop()));
  services.clear();
  await database?.destroy();
  database = undefined;
});

describe("manual override service", () => {
  it("starts, extends, and cancels using authoritative server time", async () => {
    const context = await createContext();
    const started = await context.service.startOverride({
      expectedRevision: 0,
      target: { targetType: "channel", targetId: "channel-blue" },
      valuePercentage: 80,
    });
    expect(started).toMatchObject({
      override: {
        id: "override-1",
        status: "pending",
        expiresAt: new Date(130_000).toISOString(),
      },
      operation: { id: "operation-2", status: "pending" },
      mutation: { revision: 1 },
    });
    await waitForOverrideStatus(context.repository, "override-1", "active");
    expect(context.commands.calls).toEqual([
      {
        deviceId: "device-a",
        pin: 4,
        value: 143,
        overwrite: true,
      },
    ]);

    await context.time.advanceBy(50_000);
    const extended = await context.service.extendOverride("override-1", {
      expectedRevision: 3,
    });
    expect(extended).toMatchObject({
      override: {
        status: "active",
        expiresAt: new Date(180_000).toISOString(),
      },
      mutation: { changed: true, revision: 4 },
    });

    const cancelled = await context.service.cancelOverride("override-1", {
      expectedRevision: 4,
    });
    expect(cancelled).toMatchObject({
      override: { status: "pending", operationId: "operation-3" },
      operation: { status: "pending" },
      mutation: { revision: 5 },
    });
    await waitForOverrideStatus(context.repository, "override-1", "cancelled");
    expect(context.commands.calls).toEqual([
      {
        deviceId: "device-a",
        pin: 4,
        value: 143,
        overwrite: true,
      },
      {
        deviceId: "device-a",
        pin: 4,
        value: 89,
        overwrite: false,
      },
    ]);
  });

  it("keeps the overlay through 119999 ms and expires it at exactly 120000 ms", async () => {
    const context = await createContext();
    await context.service.startOverride({
      expectedRevision: 0,
      target: { targetType: "output", targetId: "output-standalone" },
      valuePercentage: 100,
    });
    await waitForOverrideStatus(context.repository, "override-1", "active");

    await context.time.advanceBy(119_999);
    await expect(
      context.repository.readActiveManualOverrideOutputs(129_999),
    ).resolves.toMatchObject([{ overwrite: true, pin: 5, value: 89 }]);
    expect(context.commands.calls).toHaveLength(1);

    await context.time.advanceBy(1);
    await waitForOverrideStatus(context.repository, "override-1", "expired");
    await expect(
      context.repository.readActiveManualOverrideOutputs(130_000),
    ).resolves.toEqual([]);
    expect(context.commands.calls).toEqual([
      {
        deviceId: "device-a",
        pin: 5,
        value: 89,
        overwrite: true,
      },
      {
        deviceId: "device-a",
        pin: 5,
        value: 0,
        overwrite: false,
      },
    ]);
  });

  it("records a dropped response as unknown, never retries, and waits for firmware safety reconciliation", async () => {
    const context = await createContext([
      {
        kind: "completed",
        operation: { id: "child-unknown", status: "outcome_unknown" },
      },
    ]);
    await context.service.startOverride({
      expectedRevision: 0,
      target: { targetType: "channel", targetId: "channel-blue" },
      valuePercentage: 70,
    });
    await waitForOperationStatus(
      context.repository,
      "operation-2",
      "outcome_unknown",
    );
    expect(await context.repository.getOverride("override-1")).toMatchObject({
      status: "pending",
      startsAtMs: null,
    });
    await expect(
      context.repository.readActiveManualOverrideOutputs(20_000),
    ).resolves.toEqual([]);

    await context.time.advanceBy(119_999);
    expect(context.commands.calls).toHaveLength(1);
    expect(context.commands.reconciledOperationIds).toEqual([]);

    await context.time.advanceBy(1);
    await waitForOverrideStatus(context.repository, "override-1", "failed");
    expect(context.commands.calls).toHaveLength(1);
    expect(context.commands.reconciledOperationIds).toEqual(["child-unknown"]);
    await expect(
      context.repository.getManualOperation("operation-2"),
    ).resolves.toMatchObject({
      status: "outcome_unknown",
      result: { reconciledAtMs: 130_000 },
    });
  });

  it("keeps an unknown coordinator pending until its child latch is reconciled", async () => {
    const context = await createContext([
      {
        kind: "completed",
        operation: { id: "child-unknown", status: "outcome_unknown" },
      },
    ]);
    await context.service.startOverride({
      expectedRevision: 0,
      target: { targetType: "channel", targetId: "channel-blue" },
      valuePercentage: 70,
    });
    await waitForOperationStatus(
      context.repository,
      "operation-2",
      "outcome_unknown",
    );
    context.time.setUtc(130_000);
    context.commands.reconciliationError = new Error("latch unavailable");

    await expect(
      context.service.reconcileOverride("override-1", {
        expectedRevision: 3,
      }),
    ).rejects.toThrow("latch unavailable");
    await expect(
      context.repository.getManualOperation("operation-2"),
    ).resolves.toMatchObject({ result: { reconciledAtMs: null } });
    await expect(
      context.repository.getOverride("override-1"),
    ).resolves.toMatchObject({ status: "pending" });

    context.commands.reconciliationError = null;
    await expect(
      context.service.reconcileOverride("override-1", {
        expectedRevision: 3,
      }),
    ).resolves.toMatchObject({ override: { status: "failed" } });
    expect(context.commands.reconciledOperationIds).toEqual([
      "child-unknown",
      "child-unknown",
    ]);
  });

  it("resumes a persisted active override after controller restart without issuing a duplicate start", async () => {
    const context = await createContext();
    await context.service.startOverride({
      expectedRevision: 0,
      target: { targetType: "channel", targetId: "channel-blue" },
      valuePercentage: 40,
    });
    await waitForOverrideStatus(context.repository, "override-1", "active");
    expect(context.commands.calls).toHaveLength(1);
    await context.service.stop();
    services.delete(context.service);

    const restarted = new ManualOverrideService(
      new ManualOverrideRepository(requireDatabase()),
      context.commands,
      {
        clock: context.time,
        timer: context.time,
        idGenerator: deterministicIds(10),
        onBackgroundError: (error) => {
          throw error;
        },
      },
    );
    services.add(restarted);
    await restarted.initialize();

    await expect(
      context.repository.readActiveManualOverrideOutputs(INITIAL_TIME_MS),
    ).resolves.toHaveLength(1);
    expect(context.commands.calls).toHaveLength(1);

    await context.time.advanceBy(120_000);
    await waitForOverrideStatus(context.repository, "override-1", "expired");
    expect(context.commands.calls).toHaveLength(2);
    expect(context.commands.calls[1]).toMatchObject({ overwrite: false });
  });
});

class TestCommandPort implements ManualOverrideDeviceCommandPort {
  readonly calls: Array<{
    readonly deviceId: string;
    readonly pin: number;
    readonly value: number;
    readonly overwrite: boolean;
  }> = [];
  readonly reconciledOperationIds: string[] = [];
  reconciliationError: Error | null = null;
  readonly #results: ManualOverrideDeviceDispatchResult[];
  #sequence = 0;

  constructor(results: readonly ManualOverrideDeviceDispatchResult[] = []) {
    this.#results = [...results];
  }

  async dispatch(
    deviceId: string,
    request: {
      readonly kind: "set_pwm";
      readonly pin: number;
      readonly value: number;
      readonly overwrite: boolean;
    },
  ): Promise<ManualOverrideDeviceDispatchResult> {
    this.calls.push({
      deviceId,
      pin: request.pin,
      value: request.value,
      overwrite: request.overwrite,
    });
    return (
      this.#results.shift() ?? {
        kind: "completed",
        operation: { id: `child-${++this.#sequence}`, status: "succeeded" },
      }
    );
  }

  async reconcileUnknownOutcome(operationId: string): Promise<void> {
    this.reconciledOperationIds.push(operationId);
    if (this.reconciliationError !== null) {
      throw this.reconciliationError;
    }
  }
}

async function createContext(
  results: readonly ManualOverrideDeviceDispatchResult[] = [],
): Promise<{
  readonly repository: ManualOverrideRepository;
  readonly service: ManualOverrideService;
  readonly commands: TestCommandPort;
  readonly time: ManualSchedulingTime;
}> {
  database = await openStateDatabase({ filename: ":memory:" });
  await seed(database);
  const repository = new ManualOverrideRepository(database);
  const commands = new TestCommandPort(results);
  const time = new ManualSchedulingTime(INITIAL_TIME_MS);
  const service = new ManualOverrideService(repository, commands, {
    clock: time,
    timer: time,
    idGenerator: deterministicIds(),
    onBackgroundError: (error) => {
      throw error;
    },
  });
  services.add(service);
  await service.initialize();
  return { repository, service, commands, time };
}

function deterministicIds(
  initial = 0,
): (kind: "override" | "operation") => string {
  let sequence = initial;
  return (kind) => `${kind}-${++sequence}`;
}

function requireDatabase(): Kysely<StateDatabaseSchema> {
  if (database === undefined) {
    throw new Error("Test database has not been initialized");
  }
  return database;
}

async function waitForOverrideStatus(
  repository: ManualOverrideRepository,
  overrideId: string,
  status: "active" | "cancelled" | "expired" | "failed",
): Promise<void> {
  await vi.waitFor(async () => {
    expect((await repository.getOverride(overrideId)).status).toBe(status);
  });
}

async function waitForOperationStatus(
  repository: ManualOverrideRepository,
  operationId: string,
  status: "outcome_unknown",
): Promise<void> {
  await vi.waitFor(async () => {
    expect((await repository.getManualOperation(operationId)).status).toBe(
      status,
    );
  });
}

async function seed(state: Kysely<StateDatabaseSchema>): Promise<void> {
  const now = 1_000;
  await state
    .insertInto("throttles")
    .values({
      id: "throttle-half",
      type_key: "light",
      percentage: 50,
      created_at_ms: now,
      updated_at_ms: now,
    })
    .execute();
  await state
    .insertInto("channels")
    .values({
      id: "channel-blue",
      name: "Blue",
      kind: "light",
      throttle_id: "throttle-half",
      display_order: 0,
      enabled: 1,
      created_at_ms: now,
      updated_at_ms: now,
    })
    .execute();
  await state
    .insertInto("outputs")
    .values({
      id: "output-standalone",
      name: "Standalone",
      kind: "pump",
      display_order: 0,
      enabled: 1,
      output_gain: 0.5,
      created_at_ms: now,
      updated_at_ms: now,
    })
    .execute();
  await state
    .insertInto("schedules")
    .values({
      id: "schedule-blue",
      channel_id: "channel-blue",
      name: "Blue schedule",
      timezone: "UTC",
      enabled: 1,
      graph_revision: 1,
      created_at_ms: now,
      updated_at_ms: now,
    })
    .execute();
  await state
    .insertInto("schedule_points")
    .values([
      {
        id: "point-blue-0",
        schedule_id: "schedule-blue",
        position: 0,
        minute_of_day: 0,
        percentage: 100,
        editor_x: null,
        editor_y: null,
        created_at_ms: now,
        updated_at_ms: now,
      },
      {
        id: "point-blue-1",
        schedule_id: "schedule-blue",
        position: 1,
        minute_of_day: 1_439,
        percentage: 100,
        editor_x: null,
        editor_y: null,
        created_at_ms: now,
        updated_at_ms: now,
      },
    ])
    .execute();
  await state
    .insertInto("mapping_profiles")
    .values({
      id: "profile-a",
      name: "Profile A",
      device_name_prefix: "A",
      output_gain: 0.7,
      created_at_ms: now,
      updated_at_ms: now,
    })
    .execute();
  await state
    .insertInto("pin_mappings")
    .values([
      {
        id: "mapping-channel",
        mapping_profile_id: "profile-a",
        output_id: null,
        channel_id: "channel-blue",
        pin: 4,
        display_order: 0,
        enabled: 1,
        created_at_ms: now,
        updated_at_ms: now,
      },
      {
        id: "mapping-output",
        mapping_profile_id: "profile-a",
        output_id: "output-standalone",
        channel_id: null,
        pin: 5,
        display_order: 1,
        enabled: 1,
        created_at_ms: now,
        updated_at_ms: now,
      },
    ])
    .execute();
  await state
    .insertInto("devices")
    .values({
      id: "device-a",
      hardware_id: "hardware-a",
      name: "Alpha",
      mapping_profile_id: "profile-a",
      reported_name: "Alpha",
      desired_pwm_frequency_hz: 5_000,
      desired_pwm_resolution_bits: 8,
      reported_pwm_frequency_hz: 5_000,
      reported_pwm_resolution_bits: 8,
      firmware_version: "4.0.0",
      reported_schedule_hash: "0",
      status: "online",
      last_seen_at_ms: now,
      last_error_code: null,
      last_error_message: null,
      enabled: 1,
      created_at_ms: now,
      updated_at_ms: now,
      metadata_json: null,
      metadata_schema_version: null,
    })
    .execute();
}
