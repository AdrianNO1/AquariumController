import { afterEach, describe, expect, it } from "vitest";

import { openControllerDatabases, type ControllerDatabases } from "./index.js";
import { RefreshProjectionRepository } from "./refresh-projection-repository.js";

let databases: ControllerDatabases | undefined;

afterEach(async () => {
  if (databases !== undefined) {
    await Promise.all([databases.state.destroy(), databases.events.destroy()]);
    databases = undefined;
  }
});

describe("refresh projection repository", () => {
  it("includes enabled retry candidates and reports their malformed graphs", async () => {
    databases = await openControllerDatabases({
      state: { filename: ":memory:" },
      events: { filename: ":memory:" },
    });
    await seedProjection(databases);

    const projection = await new RefreshProjectionRepository(
      databases.state,
    ).readActiveOutputs();

    expect(projection.outputs).toHaveLength(4);
    expect(projection.outputs).toMatchObject([
      {
        deviceId: "device-a",
        mappingId: "mapping-valid-a",
        channelId: "channel-valid",
        pin: 1,
        throttlePercent: 50,
        outputGain: 0.7,
      },
      {
        deviceId: "device-b",
        mappingId: "mapping-valid-b",
        channelId: "channel-valid",
        pin: 4,
        throttlePercent: 50,
        outputGain: 1,
      },
      {
        deviceId: "device-stale",
        mappingId: "mapping-valid-a",
        channelId: "channel-valid",
        pin: 1,
        throttlePercent: 50,
        outputGain: 0.7,
      },
      {
        deviceId: "device-offline",
        mappingId: "mapping-valid-a",
        channelId: "channel-valid",
        pin: 1,
        throttlePercent: 50,
        outputGain: 0.7,
      },
    ]);
    expect(projection.diagnostics).toMatchObject([
      {
        code: "invalid_schedule",
        deviceId: "device-a",
        mappingId: "mapping-invalid-a",
        channelId: "channel-invalid",
        issues: [{ code: "empty-schedule" }],
      },
      {
        code: "invalid_schedule",
        deviceId: "device-a",
        mappingId: "mapping-missing-schedule-a",
        channelId: "channel-missing-schedule",
        issues: [{ code: "empty-schedule" }],
      },
      {
        code: "invalid_schedule",
        deviceId: "device-stale",
        mappingId: "mapping-invalid-a",
        channelId: "channel-invalid",
        issues: [{ code: "empty-schedule" }],
      },
      {
        code: "invalid_schedule",
        deviceId: "device-stale",
        mappingId: "mapping-missing-schedule-a",
        channelId: "channel-missing-schedule",
        issues: [{ code: "empty-schedule" }],
      },
      {
        code: "invalid_schedule",
        deviceId: "device-offline",
        mappingId: "mapping-invalid-a",
        channelId: "channel-invalid",
        issues: [{ code: "empty-schedule" }],
      },
      {
        code: "invalid_schedule",
        deviceId: "device-offline",
        mappingId: "mapping-missing-schedule-a",
        channelId: "channel-missing-schedule",
        issues: [{ code: "empty-schedule" }],
      },
    ]);
  });
});

async function seedProjection(context: ControllerDatabases): Promise<void> {
  const now = 1_000;
  await context.state.deleteFrom("throttles").execute();
  await context.state
    .insertInto("throttles")
    .values({
      id: "throttle-half",
      type_key: "light",
      percentage: 50,
      created_at_ms: now,
      updated_at_ms: now,
    })
    .execute();
  await context.state
    .insertInto("channels")
    .values([
      channel("channel-valid", "Valid", "throttle-half", 0, now),
      channel("channel-invalid", "Invalid", "throttle-half", 1, now),
      channel(
        "channel-missing-schedule",
        "Missing schedule",
        "throttle-half",
        2,
        now,
      ),
    ])
    .execute();
  await context.state
    .insertInto("schedules")
    .values([
      schedule("schedule-valid", "channel-valid", now),
      schedule("schedule-invalid", "channel-invalid", now),
    ])
    .execute();
  await context.state
    .insertInto("schedule_points")
    .values([
      point("point-valid-0", "schedule-valid", 0, 0, 100, now),
      point("point-valid-1", "schedule-valid", 1, 1_439, 100, now),
      point("point-invalid", "schedule-invalid", 0, 0, 50, now),
    ])
    .execute();
  await context.state
    .insertInto("mapping_profiles")
    .values([
      profile("profile-a", "Profile A", "A", 0.7, now),
      profile("profile-b", "Profile B", "B", 1, now),
    ])
    .execute();
  await context.state
    .insertInto("outputs")
    .values({
      id: "standalone-output",
      name: "Standalone",
      kind: "light",
      display_order: 0,
      output_gain: 0.5,
      created_at_ms: now,
      updated_at_ms: now,
    })
    .execute();
  await context.state
    .insertInto("pin_mappings")
    .values([
      mapping("mapping-valid-a", "profile-a", "channel-valid", 1, 0, now),
      mapping("mapping-invalid-a", "profile-a", "channel-invalid", 2, 1, now),
      {
        id: "mapping-standalone-a",
        mapping_profile_id: "profile-a",
        output_id: "standalone-output",
        channel_id: null,
        pin: 3,
        display_order: 2,
        enabled: 1 as const,
        created_at_ms: now,
        updated_at_ms: now,
      },
      mapping(
        "mapping-missing-schedule-a",
        "profile-a",
        "channel-missing-schedule",
        5,
        3,
        now,
      ),
      mapping("mapping-valid-b", "profile-b", "channel-valid", 4, 0, now),
    ])
    .execute();
  await context.state
    .insertInto("devices")
    .values([
      device("device-a", "hardware-a", "profile-a", "online", 1, 8, 10, now),
      device("device-b", "hardware-b", "profile-b", "online", 1, 8, 8, now),
      device(
        "device-stale",
        "hardware-stale",
        "profile-a",
        "stale",
        1,
        8,
        8,
        now,
      ),
      device(
        "device-offline",
        "hardware-offline",
        "profile-a",
        "offline",
        1,
        8,
        8,
        now,
      ),
      device(
        "device-disabled",
        "hardware-disabled",
        "profile-a",
        "online",
        0,
        8,
        8,
        now,
      ),
    ])
    .execute();
}

function channel(
  id: string,
  name: string,
  throttleId: string,
  displayOrder: number,
  now: number,
) {
  return {
    id,
    name,
    kind: "light",
    throttle_id: throttleId,
    display_order: displayOrder,
    enabled: 1 as const,
    created_at_ms: now,
    updated_at_ms: now,
  };
}

function schedule(id: string, channelId: string, now: number) {
  return {
    id,
    channel_id: channelId,
    name: id,
    timezone: "UTC" as const,
    enabled: 1 as const,
    graph_revision: 1,
    created_at_ms: now,
    updated_at_ms: now,
  };
}

function point(
  id: string,
  scheduleId: string,
  position: number,
  minute: number,
  percentage: number,
  now: number,
) {
  return {
    id,
    schedule_id: scheduleId,
    position,
    minute_of_day: minute,
    percentage,
    editor_x: null,
    editor_y: null,
    created_at_ms: now,
    updated_at_ms: now,
  };
}

function profile(
  id: string,
  name: string,
  prefix: string,
  outputGain: number,
  now: number,
) {
  return {
    id,
    name,
    device_name_prefix: prefix,
    output_gain: outputGain,
    created_at_ms: now,
    updated_at_ms: now,
  };
}

function mapping(
  id: string,
  profileId: string,
  channelId: string,
  pin: number,
  displayOrder: number,
  now: number,
) {
  return {
    id,
    mapping_profile_id: profileId,
    output_id: null,
    channel_id: channelId,
    pin,
    display_order: displayOrder,
    enabled: 1 as const,
    created_at_ms: now,
    updated_at_ms: now,
  };
}

function device(
  id: string,
  hardwareId: string,
  profileId: string,
  status: "online" | "stale" | "offline",
  enabled: 0 | 1,
  desiredResolution: number,
  reportedResolution: number,
  now: number,
) {
  return {
    id,
    hardware_id: hardwareId,
    name: id,
    mapping_profile_id: profileId,
    reported_name: id,
    desired_pwm_frequency_hz: 5_000,
    desired_pwm_resolution_bits: desiredResolution,
    reported_pwm_frequency_hz: 5_000,
    reported_pwm_resolution_bits: reportedResolution,
    firmware_version: "4.0.0",
    reported_schedule_hash: "0",
    status,
    last_seen_at_ms: now,
    last_error_code: null,
    last_error_message: null,
    enabled,
    created_at_ms: now,
    updated_at_ms: now,
    metadata_json: null,
    metadata_schema_version: null,
  };
}
