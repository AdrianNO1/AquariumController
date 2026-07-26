import { controllerSnapshotSchema } from "@aquarium/contracts";
import { describe, expect, it } from "vitest";

import { projectControlArea } from "./control-area-model.js";
import { createTestControllerSnapshot } from "./test-controller-snapshot.js";

describe("projectControlArea", () => {
  it("isolates one typed area while retaining complete mapping profiles", () => {
    const snapshot = controlSnapshot();
    const model = projectControlArea(snapshot, "lights");
    expect(model).not.toBeNull();
    if (model === null) throw new Error("Missing lights control area");
    expect(model.channels.map(({ channel }) => channel.id)).toEqual([
      "light-a",
      "light-b",
    ]);
    expect(model.channels.map(({ schedule }) => schedule?.id ?? null)).toEqual([
      "light-a",
      null,
    ]);
    expect(model.throttle?.id).toBe("throttle-light");
    expect(model.mappingProfiles).toHaveLength(2);
    expect([...model.relevantProfileIds]).toEqual(["profile-main"]);
    expect(model.devices.map((device) => device.id)).toEqual(["device-main"]);
    expect(model.operations.map((operation) => operation.id)).toEqual([
      "operation-main",
      "operation-override",
    ]);
    expect(model.overrides.map((override) => override.id)).toEqual([
      "override-light",
    ]);
  });

  it("returns every declared area even when its retained collections are empty", () => {
    const model = projectControlArea(controlSnapshot(), "qt4");
    expect(model).toMatchObject({
      area: { slug: "qt4", typeKey: "qt4" },
      channels: [],
      devices: [],
    });
  });

  it("keeps an unmapped device visible so it can be excluded or recovered", () => {
    const snapshot = controlSnapshot();
    const model = projectControlArea(
      controllerSnapshotSchema.parse({
        ...snapshot,
        devices: [...snapshot.devices, device("device-unassigned", null)],
      }),
      "lights",
    );

    expect(model?.devices.map(({ id }) => id)).toEqual([
      "device-main",
      "device-unassigned",
    ]);
  });
});

function controlSnapshot() {
  const base = createTestControllerSnapshot(8);
  return controllerSnapshotSchema.parse({
    ...base,
    channels: [
      channel("light-b", "Backup light", "light", 2, "throttle-light"),
      channel("pump-a", "Return pump", "pump", 0, "throttle-pump"),
      channel("light-a", "Main light", "light", 0, "throttle-light"),
    ],
    schedules: [schedule("light-a")],
    throttles: [
      throttle("throttle-light", "light", 80),
      throttle("throttle-pump", "pump", 100),
    ],
    outputs: [],
    mappingProfiles: [
      {
        id: "profile-main",
        name: "Main rack",
        deviceNamePrefix: "main",
        outputGain: 1,
        createdAt: timestamp,
        updatedAt: timestamp,
        mappings: [
          {
            id: "mapping-light",
            pin: 4,
            displayOrder: 0,
            enabled: true,
            target: { kind: "channel", id: "light-a" },
          },
          {
            id: "mapping-pump",
            pin: 5,
            displayOrder: 1,
            enabled: true,
            target: { kind: "channel", id: "pump-a" },
          },
        ],
      },
      {
        id: "profile-pump",
        name: "Pump only",
        deviceNamePrefix: "pump",
        outputGain: 0.7,
        createdAt: timestamp,
        updatedAt: timestamp,
        mappings: [
          {
            id: "mapping-pump-only",
            pin: 6,
            displayOrder: 0,
            enabled: true,
            target: { kind: "channel", id: "pump-a" },
          },
        ],
      },
    ],
    devices: [
      device("device-main", "profile-main"),
      device("device-pump", "profile-pump"),
    ],
    operations: {
      items: [
        operation("operation-main", "device-main"),
        operation("operation-pump", "device-pump"),
        {
          ...operation("operation-override", "device-main"),
          deviceId: null,
          kind: "manual_override_start",
        },
      ],
      limit: 100,
      truncated: false,
    },
    overrides: [
      override("override-light", "light-a"),
      override("override-pump", "pump-a"),
    ],
  });
}

const timestamp = "2026-07-13T10:00:00.000Z";

function channel(
  id: string,
  name: string,
  typeKey: "light" | "pump",
  displayOrder: number,
  throttleId: string,
) {
  return {
    id,
    name,
    typeKey,
    throttleId,
    displayOrder,
    enabled: true,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function schedule(channelId: string) {
  return {
    id: channelId,
    channelId,
    name: `${channelId} schedule`,
    timezone: "UTC",
    enabled: true,
    graphRevision: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
    points: [
      point(`${channelId}-start`, 0, 0, 0),
      point(`${channelId}-middle`, 1, 720, 50),
      point(`${channelId}-end`, 2, 1_439, 0),
    ],
  };
}

function point(
  id: string,
  position: number,
  minuteOfDay: number,
  percentage: number,
) {
  return {
    id,
    position,
    minuteOfDay,
    percentage,
    editorX: null,
    editorY: null,
  };
}

function throttle(id: string, typeKey: "light" | "pump", percentage: number) {
  return {
    id,
    typeKey,
    percentage,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function device(id: string, mappingProfileId: string | null) {
  return {
    id,
    hardwareId: id.toUpperCase(),
    mappingProfileId,
    desired: { name: id, pwmFrequencyHz: 1_000, pwmResolutionBits: 8 },
    reported: {
      name: id,
      pwmFrequencyHz: 1_000,
      pwmResolutionBits: 8,
      firmwareVersion: "4.0.0",
      scheduleHash: "0",
    },
    status: "online",
    lastSeenAt: timestamp,
    lastError: null,
    enabled: true,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function operation(id: string, deviceId: string) {
  return {
    id,
    deviceId,
    kind: "schedule",
    status: "succeeded",
    requestedAt: timestamp,
    deadlineAt: "2026-07-13T10:00:05.000Z",
    completedAt: "2026-07-13T10:00:01.000Z",
  };
}

function override(id: string, targetId: string) {
  return {
    id,
    targetType: "channel",
    targetId,
    valuePercentage: 55,
    status: "active",
    requestedAt: "2026-07-13T09:58:00.000Z",
    startsAt: "2026-07-13T09:58:01.000Z",
    expiresAt: "2026-07-13T10:03:00.000Z",
    completedAt: null,
    operationId:
      targetId === "light-a" ? "operation-override" : "operation-main",
  };
}
