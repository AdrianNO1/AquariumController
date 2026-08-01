import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  CURRENT_ESP_FIRMWARE_VERSION,
  type EspAnnouncement,
} from "@aquarium/esp-protocol";
import type { Kysely } from "kysely";
import { afterEach, describe, expect, it } from "vitest";

import {
  openStateDatabase,
  type StateDatabaseSchema,
} from "../../infrastructure/database/index.js";
import { DeviceRegistry } from "./device-registry.js";

const openDatabases: Kysely<StateDatabaseSchema>[] = [];

afterEach(async () => {
  await Promise.all(
    openDatabases.splice(0).map((database) => database.destroy()),
  );
});

describe("persistent device registry", () => {
  it("rejects an announcement with an unsupported PWM pair", async () => {
    const database = await openTestDatabase();
    const registry = createRegistry(database);

    await expect(
      registry.handleAnnouncement({
        announcement: announcement({ freq: 40_000, res: 11 }),
        receivedAtMs: 10_000,
      }),
    ).rejects.toThrow(/source-clock/);
    await expect(
      database.selectFrom("devices").selectAll().execute(),
    ).resolves.toEqual([]);
  });

  it("assigns a unique case-sensitive name prefix and preserves explicit assignments", async () => {
    const database = await openTestDatabase();
    await database
      .insertInto("mapping_profiles")
      .values([
        {
          id: "profile-main",
          name: "Main profile",
          device_name_prefix: "One",
          output_gain: 1,
          created_at_ms: 0,
          updated_at_ms: 0,
        },
        {
          id: "profile-explicit",
          name: "Explicit profile",
          device_name_prefix: "Explicit",
          output_gain: 1,
          created_at_ms: 0,
          updated_at_ms: 0,
        },
        {
          id: "profile-lowercase",
          name: "Lowercase profile",
          device_name_prefix: "one",
          output_gain: 1,
          created_at_ms: 0,
          updated_at_ms: 0,
        },
      ])
      .execute();
    const registry = createRegistry(database);

    await registry.handleAnnouncement({
      announcement: announcement(),
      receivedAtMs: 10_000,
    });
    expect(await readDevice(database)).toMatchObject({
      mapping_profile_id: "profile-main",
    });

    await database
      .updateTable("devices")
      .set({ mapping_profile_id: "profile-explicit" })
      .where("id", "=", "A1")
      .executeTakeFirstOrThrow();
    await registry.handleAnnouncement({
      announcement: announcement(),
      receivedAtMs: 11_000,
    });
    expect(await readDevice(database)).toMatchObject({
      mapping_profile_id: "profile-explicit",
    });
  });

  it("assigns a later matching profile only while the device remains unassigned", async () => {
    const database = await openTestDatabase();
    const registry = createRegistry(database);
    await registry.handleAnnouncement({
      announcement: announcement(),
      receivedAtMs: 10_000,
    });
    expect(await readDevice(database)).toMatchObject({
      mapping_profile_id: null,
    });

    await database
      .insertInto("mapping_profiles")
      .values({
        id: "profile-main",
        name: "Main profile",
        device_name_prefix: "One",
        output_gain: 1,
        created_at_ms: 0,
        updated_at_ms: 0,
      })
      .executeTakeFirstOrThrow();
    await expect(
      registry.handleAnnouncement({
        announcement: announcement(),
        receivedAtMs: 10_500,
      }),
    ).resolves.toMatchObject({
      changed: true,
      reason: "reported_state_changed",
    });
    expect(await readDevice(database)).toMatchObject({
      mapping_profile_id: "profile-main",
    });
  });

  it("fails loudly if persisted prefixes violate the unique-match invariant", async () => {
    const database = await openTestDatabase();
    await database
      .insertInto("mapping_profiles")
      .values([
        {
          id: "profile-short",
          name: "Short profile",
          device_name_prefix: "O",
          output_gain: 1,
          created_at_ms: 0,
          updated_at_ms: 0,
        },
        {
          id: "profile-long",
          name: "Long profile",
          device_name_prefix: "One",
          output_gain: 1,
          created_at_ms: 0,
          updated_at_ms: 0,
        },
      ])
      .execute();
    const registry = createRegistry(database);

    await expect(
      registry.handleAnnouncement({
        announcement: announcement(),
        receivedAtMs: 10_000,
      }),
    ).rejects.toThrow(/multiple mapping profile prefixes/u);
    await expect(
      database.selectFrom("devices").select("id").execute(),
    ).resolves.toEqual([]);
  });

  it("upserts by hardware ID, preserves desired config, and coalesces identical announcements", async () => {
    const database = await openTestDatabase();
    const registry = createRegistry(database);

    expect(
      await registry.handleAnnouncement({
        announcement: announcement(),
        receivedAtMs: 10_000,
      }),
    ).toMatchObject({ changed: true, reason: "registered", revision: 1 });
    expect(
      await registry.handleAnnouncement({
        announcement: announcement(),
        receivedAtMs: 10_500,
      }),
    ).toMatchObject({
      changed: false,
      reason: "repeated_announcement",
      revision: null,
    });
    expect(
      await registry.handleAnnouncement({
        announcement: announcement({ name: "Delayed" }),
        receivedAtMs: 9_999,
      }),
    ).toMatchObject({ changed: false, reason: "delayed_announcement" });
    expect(await revisionAndOutboxCounts(database)).toEqual([1, 1]);
    expect((await readDevice(database)).last_seen_at_ms).toBe(10_000);

    expect(
      await registry.handleAnnouncement({
        announcement: announcement(),
        receivedAtMs: 11_000,
      }),
    ).toMatchObject({
      changed: true,
      reason: "last_seen_coalesced",
      revision: 2,
    });

    await database
      .updateTable("devices")
      .set({ name: "Desired", updated_at_ms: 11_100 })
      .where("id", "=", "A1")
      .executeTakeFirstOrThrow();
    expect(
      await registry.handleAnnouncement({
        announcement: announcement(),
        receivedAtMs: 11_200,
      }),
    ).toMatchObject({
      changed: true,
      reason: "reported_state_changed",
      revision: 3,
    });
    const device = await readDevice(database);
    expect(device).toMatchObject({
      name: "Desired",
      reported_name: "One",
      last_error_code: "configuration_mismatch",
      status: "online",
      last_seen_at_ms: 11_200,
    });
    expect(await revisionAndOutboxCounts(database)).toEqual([3, 3]);
  });

  it("commits stale, offline, and recovery transitions exactly once", async () => {
    const database = await openTestDatabase();
    const registry = createRegistry(database);
    await registry.handleAnnouncement({
      announcement: announcement(),
      receivedAtMs: 10_000,
    });

    expect(await registry.refreshConnectionStatuses(11_999)).toEqual([]);
    expect(await registry.refreshConnectionStatuses(12_000)).toMatchObject([
      { deviceId: "A1", from: "online", to: "stale", revision: 2 },
    ]);
    expect(await registry.refreshConnectionStatuses(12_500)).toEqual([]);
    expect(await registry.refreshConnectionStatuses(14_000)).toMatchObject([
      { deviceId: "A1", from: "stale", to: "offline", revision: 3 },
    ]);
    expect(await registry.refreshConnectionStatuses(15_000)).toEqual([]);
    expect(
      await registry.handleAnnouncement({
        announcement: announcement(),
        receivedAtMs: 15_100,
      }),
    ).toMatchObject({
      changed: true,
      reason: "connection_recovered",
      revision: 4,
    });
    expect(await readDevice(database)).toMatchObject({
      status: "online",
      firmware_version: CURRENT_ESP_FIRMWARE_VERSION,
      last_seen_at_ms: 15_100,
    });
    expect(await revisionAndOutboxCounts(database)).toEqual([4, 4]);
  });

  it("accepts supported outdated firmware without turning the device into an error", async () => {
    const database = await openTestDatabase();
    const registry = createRegistry(database);

    await registry.handleAnnouncement({
      announcement: announcement({ version: "5.0.0" }),
      receivedAtMs: 10_000,
    });
    expect(await readDevice(database)).toMatchObject({
      status: "online",
      firmware_version: "5.0.0",
      last_error_code: null,
      last_error_message: null,
    });
  });

  it("marks firmware below 5.0.0 unsupported until supported firmware announces", async () => {
    const database = await openTestDatabase();
    const registry = createRegistry(database);

    await registry.handleAnnouncement({
      announcement: announcement({ version: "3.2w" }),
      receivedAtMs: 10_000,
    });
    expect(await readDevice(database)).toMatchObject({
      status: "error",
      firmware_version: "3.2w",
      last_error_code: "firmware_unsupported",
      last_error_message:
        "Firmware 3.2w is unsupported; install 5.0.0 or newer",
    });

    await expect(
      registry.handleAnnouncement({
        announcement: announcement(),
        receivedAtMs: 10_100,
      }),
    ).resolves.toMatchObject({
      changed: true,
      reason: "connection_recovered",
    });
    expect(await readDevice(database)).toMatchObject({
      status: "online",
      firmware_version: CURRENT_ESP_FIRMWARE_VERSION,
      last_error_code: null,
      last_error_message: null,
    });
  });

  it("uses a null-safe response-contact path without changing reported configuration", async () => {
    const database = await openTestDatabase();
    await database
      .insertInto("devices")
      .values({
        id: "A1",
        hardware_id: "A1",
        name: "Desired",
        mapping_profile_id: null,
        reported_name: "Reported",
        desired_pwm_frequency_hz: 6_000,
        desired_pwm_resolution_bits: 10,
        reported_pwm_frequency_hz: 5_000,
        reported_pwm_resolution_bits: 8,
        firmware_version: CURRENT_ESP_FIRMWARE_VERSION,
        reported_schedule_hash: "7",
        status: "unknown",
        last_seen_at_ms: null,
        last_error_code: "configuration_mismatch",
        last_error_message:
          "Reported configuration differs from desired configuration",
        enabled: 1,
        created_at_ms: 1,
        updated_at_ms: 1,
        metadata_json: null,
        metadata_schema_version: null,
      })
      .executeTakeFirstOrThrow();
    const registry = createRegistry(database);

    expect(await registry.recordResponseContact("A1", 10_000)).toMatchObject({
      changed: true,
      reason: "response_contact",
      revision: 1,
    });
    expect(await readDevice(database)).toMatchObject({
      status: "online",
      last_seen_at_ms: 10_000,
      reported_name: "Reported",
      reported_pwm_frequency_hz: 5_000,
      reported_pwm_resolution_bits: 8,
      last_error_code: "configuration_mismatch",
    });
    expect(await revisionAndOutboxCounts(database)).toEqual([1, 1]);
  });

  it("marks only a silent device offline and restores it on fresh contact", async () => {
    const database = await openTestDatabase();
    const registry = createRegistry(database);
    await registry.handleAnnouncement({
      announcement: announcement(),
      receivedAtMs: 10_000,
    });

    await expect(
      registry.recordResponseTimeout("A1", 10_100),
    ).resolves.toMatchObject({
      changed: true,
      deviceId: "A1",
      reason: "response_timeout",
      revision: 2,
    });
    expect(await readDevice(database)).toMatchObject({
      enabled: 1,
      status: "offline",
      last_seen_at_ms: 10_000,
    });
    await expect(
      registry.recordResponseTimeout("A1", 10_200),
    ).resolves.toMatchObject({
      changed: false,
      revision: null,
    });

    await expect(
      registry.handleAnnouncement({
        announcement: announcement(),
        receivedAtMs: 10_300,
      }),
    ).resolves.toMatchObject({
      changed: true,
      reason: "connection_recovered",
      revision: 3,
    });
    expect(await readDevice(database)).toMatchObject({
      enabled: 1,
      status: "online",
      last_seen_at_ms: 10_300,
    });
  });

  it("quarantines an attributable protocol fault until it is manually included", async () => {
    const database = await openTestDatabase();
    const registry = createRegistry(database);
    await registry.handleAnnouncement({
      announcement: announcement(),
      receivedAtMs: 10_000,
    });

    await expect(
      registry.recordProtocolFault("A1", 10_100, "Invalid correlated response"),
    ).resolves.toMatchObject({
      changed: true,
      deviceId: "A1",
      reason: "protocol_fault",
      revision: 2,
    });
    expect(await readDevice(database)).toMatchObject({
      enabled: 0,
      status: "error",
      last_error_code: "protocol_invalid_response",
      last_error_message: "Invalid correlated response",
    });

    await registry.handleAnnouncement({
      announcement: announcement(),
      receivedAtMs: 10_200,
    });
    expect(await readDevice(database)).toMatchObject({
      enabled: 0,
      status: "error",
      last_error_code: "protocol_invalid_response",
    });
    await expect(
      registry.recordProtocolFault(
        "unknown-responder",
        10_300,
        "Invalid correlated response",
      ),
    ).resolves.toBeNull();
  });

  it("automatically includes an operator-hidden device after it announces online", async () => {
    const database = await openTestDatabase();
    const registry = createRegistry(database);
    await registry.handleAnnouncement({
      announcement: announcement(),
      receivedAtMs: 10_000,
    });
    await database
      .updateTable("devices")
      .set({ enabled: 0, status: "offline" })
      .where("id", "=", "A1")
      .executeTakeFirstOrThrow();

    await expect(
      registry.handleAnnouncement({
        announcement: announcement(),
        receivedAtMs: 10_100,
      }),
    ).resolves.toMatchObject({
      changed: true,
      reason: "connection_recovered",
    });
    expect(await readDevice(database)).toMatchObject({
      enabled: 1,
      status: "online",
    });
  });

  it("surfaces and clears firmware diagnostics without taking the device offline", async () => {
    const database = await openTestDatabase();
    const registry = createRegistry(database);
    const diagnostic = {
      code: "schedule_pin_attach_failed",
      severity: "warning" as const,
      message: "Could not attach schedule pin 4",
      sequence: 1,
      active: true,
      at: 1_752_192_000,
    };

    await registry.handleAnnouncement({
      announcement: announcement({ lastError: diagnostic }),
      receivedAtMs: 10_000,
    });
    expect(await readDevice(database)).toMatchObject({
      status: "online",
      last_error_code: "firmware_schedule_pin_attach_failed",
      last_error_message: diagnostic.message,
    });

    await registry.handleAnnouncement({
      announcement: announcement({
        lastError: { ...diagnostic, sequence: 2, active: false },
      }),
      receivedAtMs: 11_000,
    });
    expect(await readDevice(database)).toMatchObject({
      status: "online",
      last_error_code: null,
      last_error_message: null,
    });
  });

  it("fails malformed announcements safely and continues with the next event", async () => {
    const database = await openTestDatabase();
    const registry = createRegistry(database);
    await expect(
      registry.handleAnnouncement({
        announcement: announcement({ id: "invalid hardware id" }),
        receivedAtMs: 1,
      }),
    ).rejects.toThrow(/invalid/i);
    await expect(
      registry.handleAnnouncement({
        announcement: announcement(),
        receivedAtMs: 2,
      }),
    ).resolves.toMatchObject({ changed: true, reason: "registered" });
  });

  it("preserves registry state when the database is reopened", async () => {
    const directory = await mkdtemp(join(tmpdir(), "aquarium-registry-"));
    const filename = join(directory, "state.db");
    try {
      const first = await openStateDatabase({ filename });
      const firstRegistry = createRegistry(first);
      await firstRegistry.handleAnnouncement({
        announcement: announcement(),
        receivedAtMs: 10_000,
      });
      await first.destroy();

      const reopened = await openStateDatabase({ filename });
      openDatabases.push(reopened);
      const reopenedRegistry = createRegistry(reopened);
      expect(
        await reopenedRegistry.refreshConnectionStatuses(12_000),
      ).toMatchObject([{ deviceId: "A1", to: "stale", revision: 2 }]);
      expect(await readDevice(reopened)).toMatchObject({
        hardware_id: "A1",
        reported_name: "One",
        status: "stale",
        last_seen_at_ms: 10_000,
      });
    } finally {
      await Promise.all(
        openDatabases.splice(0).map((database) => database.destroy()),
      );
      await rm(directory, { recursive: true, force: true });
    }
  });
});

function createRegistry(database: Kysely<StateDatabaseSchema>): DeviceRegistry {
  return new DeviceRegistry(database, {
    announcementPersistIntervalMs: 1_000,
    staleAfterMs: 2_000,
    offlineAfterMs: 4_000,
  });
}

async function openTestDatabase(): Promise<Kysely<StateDatabaseSchema>> {
  const database = await openStateDatabase({ filename: ":memory:" });
  openDatabases.push(database);
  return database;
}

function announcement(
  overrides: Partial<EspAnnouncement> = {},
): EspAnnouncement {
  return {
    id: "A1",
    name: "One",
    freq: 5_000,
    res: 8,
    status: "online",
    version: CURRENT_ESP_FIRMWARE_VERSION,
    scheduleHash: "0",
    ...overrides,
  };
}

async function readDevice(database: Kysely<StateDatabaseSchema>) {
  return database
    .selectFrom("devices")
    .selectAll()
    .where("id", "=", "A1")
    .executeTakeFirstOrThrow();
}

async function revisionAndOutboxCounts(
  database: Kysely<StateDatabaseSchema>,
): Promise<readonly [number, number]> {
  const revision = await database
    .selectFrom("state_revisions")
    .select(({ fn }) => fn.countAll<number>().as("count"))
    .executeTakeFirstOrThrow();
  const outbox = await database
    .selectFrom("state_outbox")
    .select(({ fn }) => fn.countAll<number>().as("count"))
    .executeTakeFirstOrThrow();
  return [Number(revision.count), Number(outbox.count)];
}
