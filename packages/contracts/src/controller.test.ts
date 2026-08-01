import { describe, expect, it } from "vitest";

import {
  activeAlertSchema,
  acknowledgeAlertRequestSchema,
  alertNotificationV1Schema,
  alertRuleSchema,
  alertStateEventPayloadV1Schema,
  apiErrorResponseSchema,
  committedStateEventSchema,
  channelSchema,
  controllerSnapshotSchema,
  controlAreaSchema,
  deviceSchema,
  expectedRevisionSchema,
  isSupportedEsp32PwmConfiguration,
  createAlertRuleRequestSchema,
  createChannelRequestSchema,
  mappingProfileSchema,
  mutationResultSchema,
  notificationDeliverySchema,
  operationSummarySchema,
  overrideSchema,
  patchDeviceConfigurationRequestSchema,
  replaceMappingProfileRequestSchema,
  replaceScheduleRequestSchema,
  scheduleGraphSchema,
  setDeviceEnabledRequestSchema,
  unresolvedDeviceOperationsSchema,
  updateChannelRequestSchema,
} from "./index.js";

const now = "2026-07-13T08:00:00.000Z";
const later = "2026-07-13T08:02:00.000Z";
const firmware = {
  currentVersion: "5.0.2",
  sha256: "bb78b1f6eed36a5bedc08557f328b9875f940f39be993394545a734f09035787",
  sizeBytes: 1_174_576,
  fleetPolicy: null,
} as const;

const controlAreas = [
  { slug: "lights", typeKey: "light", label: "Lights" },
  { slug: "pumps", typeKey: "pump", label: "Pumps" },
  { slug: "testlights", typeKey: "testlight", label: "Test lights" },
  { slug: "bad", typeKey: "bad", label: "Bad" },
  { slug: "loft", typeKey: "loft", label: "Loft" },
  { slug: "biljard", typeKey: "biljard", label: "Biljard" },
  { slug: "frag", typeKey: "frag", label: "Frag" },
  { slug: "qt1", typeKey: "qt1", label: "QT1" },
  { slug: "qt2", typeKey: "qt2", label: "QT2" },
  { slug: "qt3", typeKey: "qt3", label: "QT3" },
  { slug: "qt4", typeKey: "qt4", label: "QT4" },
] as const;

describe("channel colors", () => {
  const channel = {
    id: "channel_blue",
    name: "Blue",
    color: "#13a4c7",
    typeKey: "light",
    throttleId: "throttle-light",
    displayOrder: 0,
    enabled: true,
    createdAt: now,
    updatedAt: now,
  } as const;

  it("requires canonical lowercase six-digit colors in snapshots and mutations", () => {
    expect(channelSchema.parse(channel).color).toBe("#13a4c7");
    expect(
      createChannelRequestSchema.parse({
        expectedRevision: 0,
        id: channel.id,
        name: channel.name,
        color: channel.color,
        typeKey: channel.typeKey,
        throttleId: channel.throttleId,
        displayOrder: channel.displayOrder,
        enabled: channel.enabled,
      }).color,
    ).toBe(channel.color);
    expect(
      updateChannelRequestSchema.parse({
        expectedRevision: 1,
        name: "Ocean blue",
        color: "#3c66db",
      }),
    ).toEqual({
      expectedRevision: 1,
      name: "Ocean blue",
      color: "#3c66db",
    });

    for (const color of ["#13A4C7", "13a4c7", "#13a4c", "#13a4c70"]) {
      expect(channelSchema.safeParse({ ...channel, color }).success).toBe(
        false,
      );
    }
  });
});

const validEvent = {
  revision: 9,
  type: "channel.updated",
  occurredAt: now,
  entity: { type: "channel", id: "channel_blue" },
  schemaVersion: 1,
  data: {
    invalidations: [{ resource: "channel", id: "channel_blue" }],
  },
  retentionClass: "audit",
} as const;

describe("controller contracts", () => {
  it("accepts persisted and dynamically named control areas", () => {
    for (const area of controlAreas) {
      expect(controlAreaSchema.parse(area)).toEqual(area);
    }

    expect(
      controlAreaSchema.parse({
        slug: "anemone-tank",
        typeKey: "anemone-tank",
        label: "Anemone tank",
      }),
    ).toEqual({
      slug: "anemone-tank",
      typeKey: "anemone-tank",
      label: "Anemone tank",
    });
  });

  it("accepts a strict empty controller snapshot with all retained areas", () => {
    const snapshot = {
      schemaVersion: 1,
      revision: 0,
      committedAt: null,
      generatedAt: now,
      controlAreas,
      channels: [],
      schedules: [],
      throttles: [],
      outputs: [],
      mappingProfiles: [],
      devices: [],
      firmware,
      operations: { items: [], limit: 100, truncated: false },
      unresolvedDeviceOperations: {
        items: [],
        limit: 100,
        truncated: false,
      },
      importRuns: [],
      overrides: [],
      alertRules: [],
      alerts: [],
    };

    expect(controllerSnapshotSchema.parse(snapshot)).toEqual(snapshot);
    expect(
      controllerSnapshotSchema.safeParse({ ...snapshot, unexpected: true })
        .success,
    ).toBe(false);
    expect(
      controllerSnapshotSchema.safeParse({
        ...snapshot,
        controlAreas: [...controlAreas.slice(0, 10), controlAreas[0]],
      }).success,
    ).toBe(false);
  });

  it("rejects duplicate, unordered, nonfinite, and excess schedule data", () => {
    const schedule = {
      id: "schedule_blue",
      channelId: "channel_blue",
      name: "Blue",
      timezone: "UTC",
      enabled: true,
      graphRevision: 2,
      createdAt: now,
      updatedAt: now,
      points: [
        {
          id: "point_1",
          position: 0,
          minuteOfDay: 0,
          percentage: 0,
          editorX: null,
          editorY: null,
        },
        {
          id: "point_2",
          position: 1,
          minuteOfDay: 600,
          percentage: 75,
          editorX: 1,
          editorY: 2,
        },
      ],
    };

    expect(scheduleGraphSchema.parse(schedule)).toEqual(schedule);
    expect(
      scheduleGraphSchema.safeParse({
        ...schedule,
        points: [schedule.points[1], schedule.points[0]],
      }).success,
    ).toBe(false);
    expect(
      scheduleGraphSchema.safeParse({
        ...schedule,
        points: [schedule.points[0], { ...schedule.points[1], minuteOfDay: 0 }],
      }).success,
    ).toBe(false);
    expect(
      scheduleGraphSchema.safeParse({
        ...schedule,
        points: [{ ...schedule.points[0], percentage: Number.NaN }],
      }).success,
    ).toBe(false);
    expect(
      scheduleGraphSchema.safeParse({
        ...schedule,
        points: [{ ...schedule.points[0], extra: true }],
      }).success,
    ).toBe(false);
  });

  it("requires unique mapping pins and targets", () => {
    const profile = {
      id: "profile_main",
      name: "Main",
      deviceNamePrefix: "Main",
      outputGain: 0.7,
      createdAt: now,
      updatedAt: now,
      mappings: [
        {
          id: "mapping_1",
          pin: 12,
          displayOrder: 0,
          enabled: true,
          target: { kind: "channel", id: "channel_blue" },
        },
      ],
    };

    expect(mappingProfileSchema.parse(profile)).toEqual(profile);
    expect(
      mappingProfileSchema.safeParse({
        ...profile,
        mappings: [
          profile.mappings[0],
          { ...profile.mappings[0], id: "mapping_2" },
        ],
      }).success,
    ).toBe(false);
    expect(
      mappingProfileSchema.safeParse({
        ...profile,
        mappings: [
          profile.mappings[0],
          {
            ...profile.mappings[0],
            id: "mapping_2",
            pin: 13,
          },
        ],
      }).success,
    ).toBe(false);
  });

  it("keeps alert source and condition families structurally matched", () => {
    const numericRule = {
      id: "rule_temperature",
      name: "Temperature high",
      source: { type: "sensor", id: "sensor_temperature" },
      condition: { kind: "above", threshold: 28.5 },
      delayMs: 60_000,
      severity: "warning",
      enabled: true,
      createdAt: now,
      updatedAt: now,
    };

    expect(alertRuleSchema.parse(numericRule)).toEqual(numericRule);
    expect(
      alertRuleSchema.safeParse({
        ...numericRule,
        source: { type: "switch", id: "switch_leak" },
      }).success,
    ).toBe(false);
    expect(
      alertRuleSchema.safeParse({
        ...numericRule,
        condition: { kind: "above", threshold: Number.POSITIVE_INFINITY },
      }).success,
    ).toBe(false);
  });

  it("uses one strict invalidation envelope for mutations and SSE", () => {
    expect(committedStateEventSchema.parse(validEvent)).toEqual(validEvent);
    expect(
      mutationResultSchema.parse({
        changed: true,
        revision: 9,
        event: validEvent,
      }),
    ).toEqual({ changed: true, revision: 9, event: validEvent });
    expect(
      mutationResultSchema.safeParse({
        changed: true,
        revision: 10,
        event: validEvent,
      }).success,
    ).toBe(false);
    expect(
      mutationResultSchema.parse({ changed: false, revision: 9, event: null }),
    ).toEqual({ changed: false, revision: 9, event: null });
  });

  it("validates device, operation, and override state without loose fields", () => {
    const device = {
      id: "device_1",
      hardwareId: "ABC123",
      mappingProfileId: "profile_main",
      desired: {
        name: "Main light",
        pwmFrequencyHz: 5_000,
        pwmResolutionBits: 8,
      },
      reported: {
        name: "Main light",
        pwmFrequencyHz: 5_000,
        pwmResolutionBits: 8,
        firmwareVersion: "4.0.0",
        scheduleHash: "4294967295",
        outputsOff: false,
        outputs: [{ pin: 16, valuePercentage: 40 }],
        ota: null,
      },
      firmwareUpdate: null,
      status: "online",
      lastSeenAt: now,
      lastError: null,
      enabled: true,
      createdAt: now,
      updatedAt: now,
    };
    const operation = {
      id: "operation_1",
      deviceId: "device_1",
      kind: "device.configure",
      status: "pending",
      requestedAt: now,
      deadlineAt: now,
      completedAt: null,
    };
    const override = {
      id: "override_1",
      targetType: "channel",
      targetId: "channel_blue",
      valuePercentage: 50,
      status: "active",
      requestedAt: now,
      startsAt: now,
      expiresAt: later,
      completedAt: null,
      operationId: "operation_1",
    };

    expect(deviceSchema.parse(device)).toEqual(device);
    expect(operationSummarySchema.parse(operation)).toEqual(operation);
    expect(overrideSchema.parse(override)).toEqual(override);
    expect(
      deviceSchema.safeParse({
        ...device,
        desired: { ...device.desired, unsafe: true },
      }).success,
    ).toBe(false);
    expect(
      operationSummarySchema.safeParse({ ...operation, status: "maybe" })
        .success,
    ).toBe(false);
    expect(
      operationSummarySchema.safeParse({
        ...operation,
        outcomeUnresolved: true,
      }).success,
    ).toBe(false);
    expect(
      overrideSchema.safeParse({
        ...override,
        targetType: "channel",
        outputId: "output_1",
      }).success,
    ).toBe(false);
  });

  it("keeps unresolved device operations in a separate bounded window", () => {
    const operation = {
      id: "operation_unknown",
      deviceId: "device_1",
      kind: "ping",
      status: "outcome_unknown",
      requestedAt: now,
      deadlineAt: later,
      completedAt: later,
      outcomeUnresolved: true,
    } as const;
    const window = {
      items: [operation],
      limit: 100,
      truncated: false,
    };

    expect(unresolvedDeviceOperationsSchema.parse(window)).toEqual(window);
    expect(
      unresolvedDeviceOperationsSchema.safeParse({
        ...window,
        items: [{ ...operation, deviceId: null }],
      }).success,
    ).toBe(false);
    expect(
      unresolvedDeviceOperationsSchema.safeParse({
        ...window,
        items: [{ ...operation, status: "succeeded" }],
      }).success,
    ).toBe(false);
    expect(
      unresolvedDeviceOperationsSchema.safeParse({
        items: [operation],
        limit: 2,
        truncated: true,
      }).success,
    ).toBe(false);
  });

  it("enforces alert and notification lifecycle matrices", () => {
    const pendingDelivery = {
      id: 1,
      alertTransitionRevision: 4,
      transition: "opened",
      destinationKind: "webhook",
      destinationKey: "primary",
      status: "pending",
      attemptCount: 0,
      createdAt: now,
      attemptedAt: null,
      completedAt: null,
      lastError: null,
    };
    const alert = {
      id: "alert_1",
      alertRuleId: "rule_1",
      deduplicationKey: "rule_1:device_1",
      state: "open",
      openedAt: now,
      lastObservedAt: now,
      acknowledgedAt: null,
      recoveredAt: null,
      details: null,
      notificationDeliveries: [pendingDelivery],
    };

    expect(notificationDeliverySchema.parse(pendingDelivery)).toEqual(
      pendingDelivery,
    );
    expect(activeAlertSchema.parse(alert)).toEqual(alert);
    expect(
      notificationDeliverySchema.safeParse({
        ...pendingDelivery,
        attemptCount: 1,
      }).success,
    ).toBe(false);
    expect(
      activeAlertSchema.safeParse({
        ...alert,
        state: "recovered",
        recoveredAt: null,
      }).success,
    ).toBe(false);
  });

  it("ties durable alert transitions, lifecycle times, rules, and observations together", () => {
    const rule = {
      id: "rule_1",
      name: "Device offline",
      sourceType: "device",
      sourceId: "device_1",
      condition: "offline",
      threshold: null,
      delayMs: 0,
      severity: "critical",
    } as const;
    const observation = {
      sourceType: "device",
      sourceId: "device_1",
      status: "offline",
    } as const;
    const alertByTransition = {
      opened: {
        id: "alert_1",
        ruleId: "rule_1",
        deduplicationKey: "rule_1:device_1",
        state: "open",
        openedAtMs: 100,
        lastObservedAtMs: 100,
        acknowledgedAtMs: null,
        recoveredAtMs: null,
      },
      observed: {
        id: "alert_1",
        ruleId: "rule_1",
        deduplicationKey: "rule_1:device_1",
        state: "acknowledged",
        openedAtMs: 100,
        lastObservedAtMs: 300,
        acknowledgedAtMs: 200,
        recoveredAtMs: null,
      },
      acknowledged: {
        id: "alert_1",
        ruleId: "rule_1",
        deduplicationKey: "rule_1:device_1",
        state: "acknowledged",
        openedAtMs: 100,
        lastObservedAtMs: 100,
        acknowledgedAtMs: 200,
        recoveredAtMs: null,
      },
      recovered: {
        id: "alert_1",
        ruleId: "rule_1",
        deduplicationKey: "rule_1:device_1",
        state: "recovered",
        openedAtMs: 100,
        lastObservedAtMs: 300,
        acknowledgedAtMs: 200,
        recoveredAtMs: 300,
      },
      reopened: {
        id: "alert_1",
        ruleId: "rule_1",
        deduplicationKey: "rule_1:device_1",
        state: "open",
        openedAtMs: 400,
        lastObservedAtMs: 400,
        acknowledgedAtMs: null,
        recoveredAtMs: null,
      },
    } as const;

    for (const transition of [
      "opened",
      "observed",
      "acknowledged",
      "recovered",
      "reopened",
    ] as const) {
      expect(
        alertStateEventPayloadV1Schema.safeParse({
          schemaVersion: 1,
          transition,
          alert: alertByTransition[transition],
          rule,
          observation,
          note: null,
        }).success,
      ).toBe(true);
    }

    expect(
      alertStateEventPayloadV1Schema.safeParse({
        schemaVersion: 1,
        transition: "recovered",
        alert: alertByTransition.opened,
        rule,
        observation,
        note: null,
      }).success,
    ).toBe(false);
    expect(
      alertStateEventPayloadV1Schema.safeParse({
        schemaVersion: 1,
        transition: "opened",
        alert: alertByTransition.opened,
        rule,
        observation: { ...observation, sourceId: "device_2" },
        note: null,
      }).success,
    ).toBe(false);
    expect(
      alertNotificationV1Schema.safeParse({
        schemaVersion: 1,
        kind: "aquarium.alert",
        eventRevision: 1,
        occurredAt: now,
        transition: "acknowledged",
        alert: alertByTransition.opened,
        rule,
        observation,
        note: null,
      }).success,
    ).toBe(false);
    expect(
      alertStateEventPayloadV1Schema.safeParse({
        schemaVersion: 1,
        transition: "recovered",
        alert: {
          ...alertByTransition.recovered,
          recoveredAtMs: 250,
        },
        rule,
        observation,
        note: null,
      }).success,
    ).toBe(false);
  });

  it("validates representable alert-rule sources while keeping deferred sources opaque", () => {
    const device = {
      id: "device_1",
      hardwareId: "ABC123",
      mappingProfileId: null,
      desired: {
        name: "Main light",
        pwmFrequencyHz: 5_000,
        pwmResolutionBits: 8,
      },
      reported: {
        name: null,
        pwmFrequencyHz: null,
        pwmResolutionBits: null,
        firmwareVersion: null,
        scheduleHash: null,
        outputsOff: null,
        outputs: [],
        ota: null,
      },
      firmwareUpdate: null,
      status: "unknown",
      lastSeenAt: null,
      lastError: null,
      enabled: true,
      createdAt: now,
      updatedAt: now,
    } as const;
    const deviceRule = {
      id: "rule_device",
      name: "Device offline",
      source: { type: "device", id: device.id },
      condition: { kind: "offline" },
      delayMs: 0,
      severity: "critical",
      enabled: true,
      createdAt: now,
      updatedAt: now,
    } as const;
    const snapshot = {
      schemaVersion: 1,
      revision: 0,
      committedAt: null,
      generatedAt: now,
      controlAreas,
      channels: [],
      schedules: [],
      throttles: [],
      outputs: [],
      mappingProfiles: [],
      devices: [device],
      firmware,
      operations: { items: [], limit: 100, truncated: false },
      unresolvedDeviceOperations: {
        items: [],
        limit: 100,
        truncated: false,
      },
      importRuns: [],
      overrides: [],
      alertRules: [deviceRule],
      alerts: [],
    };

    expect(controllerSnapshotSchema.safeParse(snapshot).success).toBe(true);
    expect(
      controllerSnapshotSchema.safeParse({ ...snapshot, devices: [] }).success,
    ).toBe(false);
    expect(
      controllerSnapshotSchema.safeParse({
        ...snapshot,
        devices: [],
        alertRules: [
          {
            ...deviceRule,
            id: "rule_sensor",
            source: { type: "sensor", id: "sensor_temperature" },
            condition: { kind: "above", threshold: 28 },
          },
        ],
      }).success,
    ).toBe(true);
  });

  it("rejects missing and unsafe expected revisions", () => {
    expect(expectedRevisionSchema.parse({ expectedRevision: 0 })).toEqual({
      expectedRevision: 0,
    });
    expect(expectedRevisionSchema.safeParse({}).success).toBe(false);
    expect(
      expectedRevisionSchema.safeParse({
        expectedRevision: 0,
        retry: true,
      }).success,
    ).toBe(false);
    expect(
      expectedRevisionSchema.safeParse({
        expectedRevision: Number.MAX_SAFE_INTEGER + 1,
      }).success,
    ).toBe(false);
  });

  it("rejects malformed and unsafe typed API errors", () => {
    expect(
      apiErrorResponseSchema.parse({
        code: "revision_conflict",
        message: "The state changed",
        expectedRevision: 4,
        currentRevision: 5,
      }),
    ).toBeDefined();
    expect(
      apiErrorResponseSchema.safeParse({
        code: "revision_conflict",
        message: "The state changed",
        expectedRevision: Number.MAX_SAFE_INTEGER + 1,
        currentRevision: 5,
      }).success,
    ).toBe(false);
    expect(
      apiErrorResponseSchema.safeParse({
        code: "internal_error",
        message: "Failed",
        requestId: "request_1",
        sql: "secret",
      }).success,
    ).toBe(false);
  });

  it("keeps configuration mutation requests strict and wire-safe", () => {
    expect(
      patchDeviceConfigurationRequestSchema.parse({
        expectedRevision: 2,
        name: "Tank-A:1",
      }),
    ).toEqual({ expectedRevision: 2, name: "Tank-A:1" });
    for (const name of ["Tank A", "Tank;A", "Blå", "a".repeat(32)]) {
      expect(
        patchDeviceConfigurationRequestSchema.safeParse({
          expectedRevision: 2,
          name,
        }).success,
      ).toBe(false);
    }
    expect(
      patchDeviceConfigurationRequestSchema.safeParse({ expectedRevision: 2 })
        .success,
    ).toBe(false);
    expect(isSupportedEsp32PwmConfiguration(40_000, 10)).toBe(true);
    expect(isSupportedEsp32PwmConfiguration(40_000, 11)).toBe(false);
    expect(
      patchDeviceConfigurationRequestSchema.safeParse({
        expectedRevision: 2,
        pwmFrequencyHz: 40_000,
        pwmResolutionBits: 11,
      }).success,
    ).toBe(false);
    expect(
      patchDeviceConfigurationRequestSchema.safeParse({
        expectedRevision: 2,
        pwmResolutionBits: 16,
      }).success,
    ).toBe(true);
    expect(
      setDeviceEnabledRequestSchema.safeParse({
        expectedRevision: 2,
        enabled: false,
      }).success,
    ).toBe(true);
    expect(
      setDeviceEnabledRequestSchema.safeParse({
        expectedRevision: 2,
        enabled: false,
        extra: true,
      }).success,
    ).toBe(false);
    const device = {
      id: "device_1",
      hardwareId: "A1",
      mappingProfileId: null,
      desired: {
        name: "Main",
        pwmFrequencyHz: 40_000,
        pwmResolutionBits: 10,
      },
      reported: {
        name: "Main",
        pwmFrequencyHz: 40_000,
        pwmResolutionBits: 10,
        firmwareVersion: "4.0.0",
        scheduleHash: "0",
        outputsOff: true,
        outputs: [],
        ota: null,
      },
      firmwareUpdate: null,
      status: "online",
      lastSeenAt: now,
      lastError: null,
      enabled: true,
      createdAt: now,
      updatedAt: now,
    } as const;
    expect(deviceSchema.safeParse(device).success).toBe(true);
    expect(
      deviceSchema.safeParse({
        ...device,
        desired: { ...device.desired, pwmResolutionBits: 11 },
        reported: { ...device.reported, pwmResolutionBits: 11 },
      }).success,
    ).toBe(true);
    expect(
      acknowledgeAlertRequestSchema.safeParse({
        expectedRevision: 2,
        note: null,
        extra: true,
      }).success,
    ).toBe(false);
    expect(
      replaceScheduleRequestSchema.safeParse({
        expectedRevision: 2,
        points: [{ id: "point_1", position: 0, minuteOfDay: 0, percentage: 0 }],
      }).success,
    ).toBe(false);
  });

  it("rejects incompatible alert conditions and duplicate mapping pins or targets", () => {
    expect(
      createAlertRuleRequestSchema.safeParse({
        expectedRevision: 0,
        id: "rule_1",
        rule: {
          name: "Invalid device threshold",
          source: { type: "device", id: "device_1" },
          condition: { kind: "above", threshold: 10 },
          delayMs: 0,
          severity: "warning",
          enabled: true,
        },
      }).success,
    ).toBe(false);

    const mappingRequest = {
      expectedRevision: 0,
      name: "Primary",
      deviceNamePrefix: "Tank",
      outputGain: 1,
      mappings: [
        {
          id: "mapping_1",
          pin: 1,
          displayOrder: 0,
          enabled: true,
          target: { kind: "channel", id: "channel_1" },
        },
        {
          id: "mapping_2",
          pin: 1,
          displayOrder: 1,
          enabled: true,
          target: { kind: "channel", id: "channel_1" },
        },
      ],
    } as const;
    const parsed = replaceMappingProfileRequestSchema.safeParse(mappingRequest);
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.map((issue) => issue.path)).toEqual([
        ["mappings", 1, "pin"],
        ["mappings", 1, "target"],
      ]);
    }

    expect(
      apiErrorResponseSchema.parse({
        code: "service_unavailable",
        message: "Device commands are not configured",
        service: "device configuration command service",
      }),
    ).toBeDefined();
  });
});
