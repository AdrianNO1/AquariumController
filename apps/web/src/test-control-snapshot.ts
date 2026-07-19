import {
  controllerSnapshotSchema,
  type ControllerSnapshot,
} from "@aquarium/contracts";

import { createTestControllerSnapshot } from "./test-controller-snapshot.js";

const timestamp = "2026-07-13T10:00:00.000Z";

export function createTestControlSnapshot(revision = 8): ControllerSnapshot {
  return controllerSnapshotSchema.parse({
    ...createTestControllerSnapshot(revision),
    channels: [
      {
        id: "light-main",
        name: "Main light",
        typeKey: "light",
        throttleId: "throttle-light",
        displayOrder: 0,
        enabled: true,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
      {
        id: "pump-main",
        name: "Return pump",
        typeKey: "pump",
        throttleId: "throttle-pump",
        displayOrder: 0,
        enabled: true,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    ],
    schedules: [schedule("light-main"), schedule("pump-main")],
    throttles: [
      {
        id: "throttle-light",
        typeKey: "light",
        percentage: 80,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
      {
        id: "throttle-pump",
        typeKey: "pump",
        percentage: 100,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    ],
    outputs: [
      {
        id: "output-moonlight",
        name: "Moonlight output",
        typeKey: "light",
        displayOrder: 0,
        enabled: true,
        outputGain: 0.7,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    ],
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
            target: { kind: "channel", id: "light-main" },
          },
          {
            id: "mapping-pump",
            pin: 5,
            displayOrder: 1,
            enabled: true,
            target: { kind: "channel", id: "pump-main" },
          },
        ],
      },
    ],
    devices: [
      device("device-main", "stale", {
        name: "main-a",
        pwmFrequencyHz: 1_000,
        pwmResolutionBits: 8,
      }),
      device("device-backup", "offline", {
        name: null,
        pwmFrequencyHz: null,
        pwmResolutionBits: null,
      }),
    ],
    operations: {
      items: [
        {
          id: "operation-success",
          deviceId: "device-main",
          kind: "schedule",
          status: "succeeded",
          requestedAt: timestamp,
          deadlineAt: "2026-07-13T10:00:05.000Z",
          completedAt: "2026-07-13T10:00:01.000Z",
        },
        {
          id: "operation-unknown",
          deviceId: "device-backup",
          kind: "edit_configuration",
          status: "outcome_unknown",
          requestedAt: "2026-07-13T09:59:00.000Z",
          deadlineAt: "2026-07-13T09:59:05.000Z",
          completedAt: "2026-07-13T09:59:06.000Z",
        },
      ],
      limit: 100,
      truncated: false,
    },
    overrides: [
      {
        id: "override-light",
        targetType: "channel",
        targetId: "light-main",
        valuePercentage: 55,
        status: "active",
        requestedAt: "2026-07-13T09:58:00.000Z",
        startsAt: "2026-07-13T09:58:01.000Z",
        expiresAt: "2026-07-13T10:03:00.000Z",
        completedAt: null,
        operationId: "operation-success",
      },
    ],
  });
}

function schedule(channelId: string) {
  return {
    id: channelId,
    channelId,
    name: `${channelId} UTC schedule`,
    timezone: "UTC",
    enabled: true,
    graphRevision: 2,
    createdAt: timestamp,
    updatedAt: timestamp,
    points: [
      point(`${channelId}-start`, 0, 0, 0),
      point(`${channelId}-noon`, 1, 720, 60),
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

function device(
  id: string,
  status: "stale" | "offline",
  reportedConfiguration: {
    readonly name: string | null;
    readonly pwmFrequencyHz: number | null;
    readonly pwmResolutionBits: number | null;
  },
) {
  return {
    id,
    hardwareId: id.toUpperCase(),
    mappingProfileId: "profile-main",
    desired: { name: id, pwmFrequencyHz: 1_000, pwmResolutionBits: 8 },
    reported: {
      ...reportedConfiguration,
      firmwareVersion: "4.0.0",
      scheduleHash: "1234",
    },
    status,
    lastSeenAt: status === "offline" ? null : timestamp,
    lastError:
      status === "offline"
        ? { code: "device_offline", message: "Announcement is overdue" }
        : null,
    enabled: true,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}
