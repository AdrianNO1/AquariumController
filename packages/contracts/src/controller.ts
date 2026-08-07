import { z } from "zod";

import {
  alertSeveritySchema,
  alertStateSchema,
  boundedTextSchema,
  canonicalHexColorSchema,
  canonicalUint32HashSchema,
  controlAreaSlugSchema,
  controlTypeKeySchema,
  deviceStatusSchema,
  gainSchema,
  identifierSchema,
  isoTimestampSchema,
  nonnegativeSafeIntegerSchema,
  notificationDeliveryStatusSchema,
  operationStatusSchema,
  overrideStatusSchema,
  percentageSchema,
  positiveSafeIntegerSchema,
  retentionClassSchema,
} from "./primitives.js";
import {
  hardwareProfileById,
  hardwareProfileIdSchema,
  isAllowedPwmPin,
} from "./hardware-profiles.js";

export const controlAreaSchema = z.strictObject({
  slug: controlAreaSlugSchema,
  typeKey: controlTypeKeySchema,
  label: boundedTextSchema,
});

export const channelSchema = z.strictObject({
  id: identifierSchema,
  name: boundedTextSchema,
  color: canonicalHexColorSchema,
  typeKey: controlTypeKeySchema,
  throttleId: identifierSchema,
  displayOrder: nonnegativeSafeIntegerSchema,
  enabled: z.boolean(),
  createdAt: isoTimestampSchema,
  updatedAt: isoTimestampSchema,
});

export const schedulePointSchema = z.strictObject({
  id: identifierSchema,
  position: nonnegativeSafeIntegerSchema,
  minuteOfDay: z.number().int().min(0).max(1_439),
  percentage: percentageSchema,
  editorX: z.number().nullable(),
  editorY: z.number().nullable(),
});

export const scheduleGraphSchema = z
  .strictObject({
    id: identifierSchema,
    channelId: identifierSchema,
    name: boundedTextSchema,
    timezone: z.literal("UTC"),
    enabled: z.boolean(),
    graphRevision: nonnegativeSafeIntegerSchema,
    createdAt: isoTimestampSchema,
    updatedAt: isoTimestampSchema,
    points: z.array(schedulePointSchema).min(1).max(1_440),
  })
  .superRefine((schedule, context) => {
    const pointIds = new Set<string>();
    const positions = new Set<number>();
    const minutes = new Set<number>();
    let priorPosition = -1;

    for (const [index, point] of schedule.points.entries()) {
      if (pointIds.has(point.id)) {
        context.addIssue({
          code: "custom",
          path: ["points", index, "id"],
          message: "Schedule point identifiers must be unique",
        });
      }
      if (positions.has(point.position)) {
        context.addIssue({
          code: "custom",
          path: ["points", index, "position"],
          message: "Schedule point positions must be unique",
        });
      }
      if (minutes.has(point.minuteOfDay)) {
        context.addIssue({
          code: "custom",
          path: ["points", index, "minuteOfDay"],
          message: "Schedule point minutes must be unique",
        });
      }
      if (point.position <= priorPosition) {
        context.addIssue({
          code: "custom",
          path: ["points", index, "position"],
          message: "Schedule points must be ordered by position",
        });
      }

      pointIds.add(point.id);
      positions.add(point.position);
      minutes.add(point.minuteOfDay);
      priorPosition = point.position;
    }
  });

export const throttleSchema = z.strictObject({
  id: identifierSchema,
  typeKey: controlTypeKeySchema,
  percentage: percentageSchema,
  createdAt: isoTimestampSchema,
  updatedAt: isoTimestampSchema,
});

export const outputSchema = z.strictObject({
  id: identifierSchema,
  name: boundedTextSchema,
  typeKey: controlTypeKeySchema,
  displayOrder: nonnegativeSafeIntegerSchema,
  enabled: z.boolean(),
  outputGain: gainSchema,
  createdAt: isoTimestampSchema,
  updatedAt: isoTimestampSchema,
});

export const pinMappingTargetSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("channel"), id: identifierSchema }),
  z.strictObject({ kind: z.literal("output"), id: identifierSchema }),
]);

export const pinMappingSchema = z.strictObject({
  id: identifierSchema,
  pin: z.number().int().min(0).max(63),
  displayOrder: nonnegativeSafeIntegerSchema,
  enabled: z.boolean(),
  target: pinMappingTargetSchema,
});

export const mappingProfileSchema = z
  .strictObject({
    id: identifierSchema,
    name: boundedTextSchema,
    hardwareProfileId: hardwareProfileIdSchema,
    outputGain: gainSchema,
    createdAt: isoTimestampSchema,
    updatedAt: isoTimestampSchema,
    mappings: z.array(pinMappingSchema).max(64),
  })
  .superRefine((profile, context) => {
    const pins = new Set<number>();
    const targets = new Set<string>();
    for (const [index, mapping] of profile.mappings.entries()) {
      const targetKey = `${mapping.target.kind}:${mapping.target.id}`;
      if (pins.has(mapping.pin)) {
        context.addIssue({
          code: "custom",
          path: ["mappings", index, "pin"],
          message: "Mapping pins must be unique within a profile",
        });
      }
      if (targets.has(targetKey)) {
        context.addIssue({
          code: "custom",
          path: ["mappings", index, "target"],
          message: "Mapping targets must be unique within a profile",
        });
      }
      pins.add(mapping.pin);
      targets.add(targetKey);
      if (
        mapping.enabled &&
        !isAllowedPwmPin(profile.hardwareProfileId, mapping.pin)
      ) {
        context.addIssue({
          code: "custom",
          path: ["mappings", index, "pin"],
          message: `GPIO${mapping.pin} is not an allowed PWM output on ${hardwareProfileById(profile.hardwareProfileId).label}`,
        });
      }
    }
  });

export const ESP32_LEDC_SOURCE_CLOCK_HZ = 80_000_000;

export function isSupportedEsp32PwmConfiguration(
  pwmFrequencyHz: number,
  pwmResolutionBits: number,
): boolean {
  return (
    Number.isInteger(pwmFrequencyHz) &&
    pwmFrequencyHz >= 1 &&
    pwmFrequencyHz <= 40_000 &&
    Number.isInteger(pwmResolutionBits) &&
    pwmResolutionBits >= 1 &&
    pwmResolutionBits <= 16 &&
    pwmFrequencyHz * 2 ** pwmResolutionBits <= ESP32_LEDC_SOURCE_CLOCK_HZ
  );
}

const pwmFrequencyHzSchema = z.number().int().min(1).max(40_000);
const pwmResolutionBitsSchema = z.number().int().min(1).max(16);
const unsupportedPwmConfigurationMessage =
  "PWM frequency and resolution exceed the ESP32 LEDC source-clock limit";

// Read models remain independently bounded so a legacy persisted unsupported
// pair stays visible and can be repaired. Mutation and wire boundaries enforce
// pair compatibility before any new desired configuration is committed.
const deviceConfigurationSchema = z.strictObject({
  name: boundedTextSchema,
  pwmFrequencyHz: pwmFrequencyHzSchema,
  pwmResolutionBits: pwmResolutionBitsSchema,
});

export const firmwareUpdateModeSchema = z.enum(["immediate", "when_off"]);
export const otaTransitionSecondsSchema = z.number().int().min(0).max(60);
export const firmwareUpdateStatusSchema = z.enum([
  "pending",
  "waiting_for_device",
  "waiting_for_off",
  "accepted",
  "downloading",
  "verifying",
  "rebooting",
  "probation",
  "succeeded",
  "failed",
  "usb_required",
]);

const reportedOutputStateSchema = z.strictObject({
  pin: z.number().int().min(0).max(63),
  valuePercentage: percentageSchema,
});

const reportedOtaStateSchema = z.strictObject({
  status: z.enum([
    "idle",
    "accepted",
    "downloading",
    "verifying",
    "rebooting",
    "probation",
    "succeeded",
    "failed",
    "rolling_back",
  ]),
  targetVersion: z.string().max(31),
  progress: z.number().int().min(0).max(100),
  error: boundedTextSchema.nullable(),
});

const deviceFirmwareUpdateSchema = z.strictObject({
  targetVersion: boundedTextSchema,
  mode: firmwareUpdateModeSchema,
  transitionSeconds: otaTransitionSecondsSchema,
  status: firmwareUpdateStatusSchema,
  progress: z.number().int().min(0).max(100),
  operationId: identifierSchema.nullable(),
  error: boundedTextSchema.nullable(),
  requestedAt: isoTimestampSchema,
  updatedAt: isoTimestampSchema,
});

const reportedDeviceConfigurationSchema = z.strictObject({
  name: boundedTextSchema.nullable(),
  pwmFrequencyHz: pwmFrequencyHzSchema.nullable(),
  pwmResolutionBits: pwmResolutionBitsSchema.nullable(),
  firmwareVersion: boundedTextSchema.nullable(),
  scheduleHash: canonicalUint32HashSchema.nullable(),
  outputsOff: z.boolean().nullable(),
  outputs: z.array(reportedOutputStateSchema).max(64),
  ota: reportedOtaStateSchema.nullable(),
  hardwareProfileId: hardwareProfileIdSchema.nullable(),
  hardwareModel: boundedTextSchema.nullable(),
});

export const deviceSchema = z.strictObject({
  id: identifierSchema,
  hardwareId: boundedTextSchema,
  mappingProfileId: identifierSchema.nullable(),
  desired: deviceConfigurationSchema,
  reported: reportedDeviceConfigurationSchema,
  firmwareUpdate: deviceFirmwareUpdateSchema.nullable(),
  status: deviceStatusSchema,
  lastSeenAt: isoTimestampSchema.nullable(),
  lastError: z
    .strictObject({ code: boundedTextSchema, message: boundedTextSchema })
    .nullable(),
  enabled: z.boolean(),
  createdAt: isoTimestampSchema,
  updatedAt: isoTimestampSchema,
});

export const firmwareDeploymentSchema = z.strictObject({
  currentVersion: boundedTextSchema,
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
  sizeBytes: positiveSafeIntegerSchema,
  fleetPolicy: z
    .strictObject({
      targetVersion: boundedTextSchema,
      mode: firmwareUpdateModeSchema,
      transitionSeconds: otaTransitionSecondsSchema,
      requestedAt: isoTimestampSchema,
    })
    .nullable(),
});

export const operationSummarySchema = z
  .strictObject({
    id: identifierSchema,
    deviceId: identifierSchema.nullable(),
    kind: boundedTextSchema,
    status: operationStatusSchema,
    requestedAt: isoTimestampSchema,
    deadlineAt: isoTimestampSchema,
    completedAt: isoTimestampSchema.nullable(),
    outcomeUnresolved: z.boolean().optional(),
  })
  .superRefine((operation, context) => {
    const requestedAt = Date.parse(operation.requestedAt);
    const deadlineAt = Date.parse(operation.deadlineAt);
    const completedAt =
      operation.completedAt === null ? null : Date.parse(operation.completedAt);
    if (deadlineAt < requestedAt) {
      context.addIssue({
        code: "custom",
        path: ["deadlineAt"],
        message: "Operation deadline must not precede its request",
      });
    }
    const isTerminal = !["pending", "in_flight"].includes(operation.status);
    if (isTerminal !== (completedAt !== null)) {
      context.addIssue({
        code: "custom",
        path: ["completedAt"],
        message: "Operation completion time must match its terminal status",
      });
    }
    if (completedAt !== null && completedAt < requestedAt) {
      context.addIssue({
        code: "custom",
        path: ["completedAt"],
        message: "Operation completion must not precede its request",
      });
    }
    if (
      operation.outcomeUnresolved === true &&
      operation.status !== "outcome_unknown"
    ) {
      context.addIssue({
        code: "custom",
        path: ["outcomeUnresolved"],
        message: "Only outcome-unknown operations may remain unresolved",
      });
    }
  });

export const recentOperationsSchema = z
  .strictObject({
    items: z.array(operationSummarySchema).max(500),
    limit: z.number().int().min(1).max(500),
    truncated: z.boolean(),
  })
  .superRefine((window, context) => {
    if (window.items.length > window.limit) {
      context.addIssue({
        code: "custom",
        path: ["items"],
        message: "Recent operations exceed the declared window limit",
      });
    }
    if (window.truncated && window.items.length !== window.limit) {
      context.addIssue({
        code: "custom",
        path: ["truncated"],
        message: "A truncated operations window must fill its declared limit",
      });
    }
  });

export const unresolvedDeviceOperationsSchema = z
  .strictObject({
    items: z.array(operationSummarySchema).max(500),
    limit: z.number().int().min(1).max(500),
    truncated: z.boolean(),
  })
  .superRefine((window, context) => {
    if (window.items.length > window.limit) {
      context.addIssue({
        code: "custom",
        path: ["items"],
        message:
          "Unresolved device operations exceed the declared window limit",
      });
    }
    if (window.truncated && window.items.length !== window.limit) {
      context.addIssue({
        code: "custom",
        path: ["truncated"],
        message:
          "A truncated unresolved device operation window must fill its declared limit",
      });
    }
    for (const [index, operation] of window.items.entries()) {
      if (
        operation.deviceId === null ||
        operation.status !== "outcome_unknown"
      ) {
        context.addIssue({
          code: "custom",
          path: ["items", index],
          message:
            "Unresolved device operation entries must identify a device and have an unknown outcome",
        });
      }
    }
  });

export const importRunSummarySchema = z
  .strictObject({
    id: identifierSchema,
    sourceKind: boundedTextSchema,
    sourceFingerprint: boundedTextSchema,
    dryRun: z.boolean(),
    status: z.enum([
      "pending",
      "validating",
      "succeeded",
      "failed",
      "rolled_back",
    ]),
    startedAt: isoTimestampSchema,
    completedAt: isoTimestampSchema.nullable(),
  })
  .superRefine((run, context) => {
    const isTerminal = !["pending", "validating"].includes(run.status);
    if (isTerminal !== (run.completedAt !== null)) {
      context.addIssue({
        code: "custom",
        path: ["completedAt"],
        message: "Import completion time must match its terminal status",
      });
    }
    if (
      run.completedAt !== null &&
      Date.parse(run.completedAt) < Date.parse(run.startedAt)
    ) {
      context.addIssue({
        code: "custom",
        path: ["completedAt"],
        message: "Import completion must not precede its start",
      });
    }
  });

const overrideBaseShape = {
  id: identifierSchema,
  valuePercentage: percentageSchema,
  status: overrideStatusSchema,
  requestedAt: isoTimestampSchema,
  startsAt: isoTimestampSchema.nullable(),
  expiresAt: isoTimestampSchema,
  completedAt: isoTimestampSchema.nullable(),
  operationId: identifierSchema.nullable(),
} as const;

export const overrideSchema = z
  .discriminatedUnion("targetType", [
    z.strictObject({
      ...overrideBaseShape,
      targetType: z.literal("channel"),
      targetId: identifierSchema,
    }),
    z.strictObject({
      ...overrideBaseShape,
      targetType: z.literal("output"),
      targetId: identifierSchema,
    }),
  ])
  .superRefine((override, context) => {
    const requestedAt = Date.parse(override.requestedAt);
    const expiresAt = Date.parse(override.expiresAt);
    const startsAt =
      override.startsAt === null ? null : Date.parse(override.startsAt);
    const completedAt =
      override.completedAt === null ? null : Date.parse(override.completedAt);
    if (expiresAt <= requestedAt) {
      context.addIssue({
        code: "custom",
        path: ["expiresAt"],
        message: "Override expiry must follow its request",
      });
    }
    if (startsAt !== null && startsAt < requestedAt) {
      context.addIssue({
        code: "custom",
        path: ["startsAt"],
        message: "Override start must not precede its request",
      });
    }
    if (override.status === "active" && startsAt === null) {
      context.addIssue({
        code: "custom",
        path: ["startsAt"],
        message: "Active overrides require a start time",
      });
    }
    const isTerminal = ["expired", "cancelled", "failed"].includes(
      override.status,
    );
    if (isTerminal !== (completedAt !== null)) {
      context.addIssue({
        code: "custom",
        path: ["completedAt"],
        message: "Override completion time must match its terminal status",
      });
    }
    if (completedAt !== null && completedAt < requestedAt) {
      context.addIssue({
        code: "custom",
        path: ["completedAt"],
        message: "Override completion must not precede its request",
      });
    }
  });

export const alertObservationSchema = z.discriminatedUnion("sourceType", [
  z.strictObject({
    sourceType: z.literal("device"),
    sourceId: identifierSchema,
    deduplicationKey: boundedTextSchema.optional(),
    status: deviceStatusSchema,
  }),
  z.strictObject({
    sourceType: z.literal("output"),
    sourceId: identifierSchema,
    deduplicationKey: boundedTextSchema.optional(),
    valuePercentage: percentageSchema,
  }),
  z.strictObject({
    sourceType: z.literal("sensor"),
    sourceId: identifierSchema,
    deduplicationKey: boundedTextSchema.optional(),
    value: z.number(),
  }),
  z.strictObject({
    sourceType: z.literal("switch"),
    sourceId: identifierSchema,
    deduplicationKey: boundedTextSchema.optional(),
    isOpen: z.boolean(),
  }),
]);

export const alertLifecycleTransitionSchema = z.enum([
  "opened",
  "observed",
  "acknowledged",
  "recovered",
  "reopened",
]);

export const alertRuleSnapshotSchema = z.strictObject({
  id: identifierSchema,
  name: boundedTextSchema,
  sourceType: z.enum(["device", "output", "sensor", "switch"]),
  sourceId: identifierSchema,
  condition: boundedTextSchema,
  threshold: z.number().nullable(),
  delayMs: nonnegativeSafeIntegerSchema,
  severity: alertSeveritySchema,
});

export const alertSnapshotSchema = z
  .strictObject({
    id: identifierSchema,
    ruleId: identifierSchema,
    deduplicationKey: boundedTextSchema,
    state: alertStateSchema,
    openedAtMs: nonnegativeSafeIntegerSchema,
    lastObservedAtMs: nonnegativeSafeIntegerSchema,
    acknowledgedAtMs: nonnegativeSafeIntegerSchema.nullable(),
    recoveredAtMs: nonnegativeSafeIntegerSchema.nullable(),
  })
  .superRefine((alert, context) => {
    if (alert.lastObservedAtMs < alert.openedAtMs) {
      context.addIssue({
        code: "custom",
        path: ["lastObservedAtMs"],
        message: "Alert observation must not precede its opening",
      });
    }
    if (
      alert.acknowledgedAtMs !== null &&
      alert.acknowledgedAtMs < alert.openedAtMs
    ) {
      context.addIssue({
        code: "custom",
        path: ["acknowledgedAtMs"],
        message: "Alert acknowledgement must not precede its opening",
      });
    }
    if (
      alert.recoveredAtMs !== null &&
      (alert.recoveredAtMs < alert.lastObservedAtMs ||
        (alert.acknowledgedAtMs !== null &&
          alert.recoveredAtMs < alert.acknowledgedAtMs))
    ) {
      context.addIssue({
        code: "custom",
        path: ["recoveredAtMs"],
        message:
          "Alert recovery must not precede its observation or acknowledgement",
      });
    }
    if (alert.state === "open" && alert.acknowledgedAtMs !== null) {
      context.addIssue({
        code: "custom",
        path: ["acknowledgedAtMs"],
        message: "Open alerts must not have an acknowledgement time",
      });
    }
    if (alert.state === "acknowledged" && alert.acknowledgedAtMs === null) {
      context.addIssue({
        code: "custom",
        path: ["acknowledgedAtMs"],
        message: "Acknowledged alerts require an acknowledgement time",
      });
    }
    if ((alert.state === "recovered") !== (alert.recoveredAtMs !== null)) {
      context.addIssue({
        code: "custom",
        path: ["recoveredAtMs"],
        message: "Alert recovery time must match its recovered state",
      });
    }
  });

interface AlertEventRelationship {
  readonly transition:
    "opened" | "observed" | "acknowledged" | "recovered" | "reopened";
  readonly alert: {
    readonly ruleId: string;
    readonly state: "open" | "acknowledged" | "recovered";
  };
  readonly rule: {
    readonly id: string;
    readonly sourceType: "device" | "output" | "sensor" | "switch";
    readonly sourceId: string;
  };
  readonly observation: {
    readonly sourceType: "device" | "output" | "sensor" | "switch";
    readonly sourceId: string;
  } | null;
}

function refineAlertEventRelationship(
  event: AlertEventRelationship,
  context: z.RefinementCtx,
): void {
  const stateMatchesTransition =
    event.transition === "opened" || event.transition === "reopened"
      ? event.alert.state === "open"
      : event.transition === "observed"
        ? event.alert.state !== "recovered"
        : event.transition === "acknowledged"
          ? event.alert.state === "acknowledged"
          : event.alert.state === "recovered";
  if (!stateMatchesTransition) {
    context.addIssue({
      code: "custom",
      path: ["alert", "state"],
      message: `Alert state is incompatible with the ${event.transition} transition`,
    });
  }
  if (event.alert.ruleId !== event.rule.id) {
    context.addIssue({
      code: "custom",
      path: ["alert", "ruleId"],
      message: "Alert must reference the event rule",
    });
  }
  if (
    event.observation !== null &&
    (event.observation.sourceType !== event.rule.sourceType ||
      event.observation.sourceId !== event.rule.sourceId)
  ) {
    context.addIssue({
      code: "custom",
      path: ["observation"],
      message: "Alert observation must identify the event rule source",
    });
  }
}

export const alertStateEventPayloadV1Schema = z
  .strictObject({
    schemaVersion: z.literal(1),
    transition: alertLifecycleTransitionSchema,
    alert: alertSnapshotSchema,
    rule: alertRuleSnapshotSchema,
    observation: alertObservationSchema.nullable(),
    note: boundedTextSchema.nullable(),
  })
  .superRefine(refineAlertEventRelationship);

export const alertNotificationV1Schema = z
  .strictObject({
    schemaVersion: z.literal(1),
    kind: z.literal("aquarium.alert"),
    eventRevision: positiveSafeIntegerSchema,
    occurredAt: isoTimestampSchema,
    transition: z.enum(["opened", "acknowledged", "recovered", "reopened"]),
    alert: alertSnapshotSchema,
    rule: alertRuleSnapshotSchema,
    observation: alertObservationSchema.nullable(),
    note: boundedTextSchema.nullable(),
  })
  .superRefine(refineAlertEventRelationship);

const alertRuleBaseShape = {
  id: identifierSchema,
  name: boundedTextSchema,
  delayMs: nonnegativeSafeIntegerSchema,
  severity: alertSeveritySchema,
  enabled: z.boolean(),
  createdAt: isoTimestampSchema,
  updatedAt: isoTimestampSchema,
} as const;

const numericAlertConditionSchema = z.strictObject({
  kind: z.enum(["above", "at_or_above", "below", "at_or_below", "equal"]),
  threshold: z.number(),
});

export const alertRuleSchema = z.union([
  z.strictObject({
    ...alertRuleBaseShape,
    source: z.strictObject({
      type: z.literal("device"),
      id: identifierSchema,
    }),
    condition: z.strictObject({
      kind: z.enum(["offline", "stale", "error", "not_online"]),
    }),
  }),
  z.strictObject({
    ...alertRuleBaseShape,
    source: z.strictObject({
      type: z.literal("output"),
      id: identifierSchema,
    }),
    condition: numericAlertConditionSchema,
  }),
  z.strictObject({
    ...alertRuleBaseShape,
    source: z.strictObject({
      type: z.literal("sensor"),
      id: identifierSchema,
    }),
    condition: numericAlertConditionSchema,
  }),
  z.strictObject({
    ...alertRuleBaseShape,
    source: z.strictObject({
      type: z.literal("switch"),
      id: identifierSchema,
    }),
    condition: z.strictObject({ kind: z.enum(["open", "closed"]) }),
  }),
]);

export const alertDetailsSchema = z.strictObject({
  schemaVersion: z.literal(1),
  observation: alertObservationSchema.nullable(),
  note: boundedTextSchema.nullable(),
});

export const notificationDeliverySchema = z
  .strictObject({
    id: positiveSafeIntegerSchema,
    alertTransitionRevision: positiveSafeIntegerSchema,
    transition: z.enum(["opened", "acknowledged", "recovered", "reopened"]),
    destinationKind: z.literal("webhook"),
    destinationKey: identifierSchema,
    status: notificationDeliveryStatusSchema,
    attemptCount: z.number().int().min(0).max(1),
    createdAt: isoTimestampSchema,
    attemptedAt: isoTimestampSchema.nullable(),
    completedAt: isoTimestampSchema.nullable(),
    lastError: z
      .strictObject({ code: boundedTextSchema, message: boundedTextSchema })
      .nullable(),
  })
  .superRefine((delivery, context) => {
    const addStatusIssue = (message: string): void => {
      context.addIssue({ code: "custom", path: ["status"], message });
    };
    if (
      delivery.status === "pending" &&
      (delivery.attemptCount !== 0 ||
        delivery.attemptedAt !== null ||
        delivery.completedAt !== null ||
        delivery.lastError !== null)
    ) {
      addStatusIssue("Pending delivery must not contain attempt state");
    }
    if (
      delivery.status === "attempting" &&
      (delivery.attemptCount !== 1 ||
        delivery.attemptedAt === null ||
        delivery.completedAt !== null ||
        delivery.lastError !== null)
    ) {
      addStatusIssue("Attempting delivery must contain one unfinished attempt");
    }
    if (
      delivery.status === "delivered" &&
      (delivery.attemptCount !== 1 ||
        delivery.attemptedAt === null ||
        delivery.completedAt === null ||
        delivery.lastError !== null)
    ) {
      addStatusIssue(
        "Delivered notification must contain one successful attempt",
      );
    }
    if (
      (delivery.status === "failed" || delivery.status === "outcome_unknown") &&
      (delivery.attemptCount !== 1 ||
        delivery.attemptedAt === null ||
        delivery.completedAt === null ||
        delivery.lastError === null)
    ) {
      addStatusIssue(
        "Failed or unknown delivery must contain one terminal error",
      );
    }
    const createdAt = Date.parse(delivery.createdAt);
    const attemptedAt =
      delivery.attemptedAt === null ? null : Date.parse(delivery.attemptedAt);
    const completedAt =
      delivery.completedAt === null ? null : Date.parse(delivery.completedAt);
    if (attemptedAt !== null && attemptedAt < createdAt) {
      context.addIssue({
        code: "custom",
        path: ["attemptedAt"],
        message: "Notification attempt must not precede its creation",
      });
    }
    if (
      completedAt !== null &&
      (attemptedAt === null || completedAt < attemptedAt)
    ) {
      context.addIssue({
        code: "custom",
        path: ["completedAt"],
        message: "Notification completion must not precede its attempt",
      });
    }
  });

export const activeAlertSchema = z
  .strictObject({
    id: identifierSchema,
    alertRuleId: identifierSchema,
    deduplicationKey: boundedTextSchema,
    state: alertStateSchema,
    openedAt: isoTimestampSchema,
    lastObservedAt: isoTimestampSchema,
    acknowledgedAt: isoTimestampSchema.nullable(),
    recoveredAt: isoTimestampSchema.nullable(),
    details: alertDetailsSchema.nullable(),
    notificationDeliveries: z.array(notificationDeliverySchema).max(100),
  })
  .superRefine((alert, context) => {
    const openedAt = Date.parse(alert.openedAt);
    if (Date.parse(alert.lastObservedAt) < openedAt) {
      context.addIssue({
        code: "custom",
        path: ["lastObservedAt"],
        message: "Alert observation must not precede its opening",
      });
    }
    if (
      alert.acknowledgedAt !== null &&
      Date.parse(alert.acknowledgedAt) < openedAt
    ) {
      context.addIssue({
        code: "custom",
        path: ["acknowledgedAt"],
        message: "Alert acknowledgement must not precede its opening",
      });
    }
    if (
      alert.recoveredAt !== null &&
      (Date.parse(alert.recoveredAt) < Date.parse(alert.lastObservedAt) ||
        (alert.acknowledgedAt !== null &&
          Date.parse(alert.recoveredAt) < Date.parse(alert.acknowledgedAt)))
    ) {
      context.addIssue({
        code: "custom",
        path: ["recoveredAt"],
        message:
          "Alert recovery must not precede its observation or acknowledgement",
      });
    }
    if (alert.state === "open" && alert.acknowledgedAt !== null) {
      context.addIssue({
        code: "custom",
        path: ["acknowledgedAt"],
        message: "Open alerts must not have an acknowledgement time",
      });
    }
    if (alert.state === "acknowledged" && alert.acknowledgedAt === null) {
      context.addIssue({
        code: "custom",
        path: ["acknowledgedAt"],
        message: "Acknowledged alerts require an acknowledgement time",
      });
    }
    if (alert.state === "recovered" && alert.recoveredAt === null) {
      context.addIssue({
        code: "custom",
        path: ["recoveredAt"],
        message: "Recovered alerts require a recovery time",
      });
    }
    if (alert.state !== "recovered" && alert.recoveredAt !== null) {
      context.addIssue({
        code: "custom",
        path: ["recoveredAt"],
        message: "Only recovered alerts may have a recovery time",
      });
    }
  });

export const controllerSnapshotSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    revision: nonnegativeSafeIntegerSchema,
    committedAt: isoTimestampSchema.nullable(),
    generatedAt: isoTimestampSchema,
    controlAreas: z.array(controlAreaSchema).max(100),
    channels: z.array(channelSchema),
    schedules: z.array(scheduleGraphSchema),
    throttles: z.array(throttleSchema),
    outputs: z.array(outputSchema),
    mappingProfiles: z.array(mappingProfileSchema),
    devices: z.array(deviceSchema),
    firmware: firmwareDeploymentSchema,
    operations: recentOperationsSchema,
    unresolvedDeviceOperations: unresolvedDeviceOperationsSchema,
    importRuns: z.array(importRunSummarySchema).max(100),
    overrides: z.array(overrideSchema),
    alertRules: z.array(alertRuleSchema),
    alerts: z.array(activeAlertSchema),
  })
  .superRefine((snapshot, context) => {
    const identifiableCollections: readonly {
      readonly path: string;
      readonly items: readonly { readonly id: string }[];
    }[] = [
      { path: "channels", items: snapshot.channels },
      { path: "schedules", items: snapshot.schedules },
      { path: "throttles", items: snapshot.throttles },
      { path: "outputs", items: snapshot.outputs },
      { path: "mappingProfiles", items: snapshot.mappingProfiles },
      { path: "devices", items: snapshot.devices },
      { path: "operations.items", items: snapshot.operations.items },
      {
        path: "unresolvedDeviceOperations.items",
        items: snapshot.unresolvedDeviceOperations.items,
      },
      { path: "importRuns", items: snapshot.importRuns },
      { path: "overrides", items: snapshot.overrides },
      { path: "alertRules", items: snapshot.alertRules },
      { path: "alerts", items: snapshot.alerts },
    ];
    for (const collection of identifiableCollections) {
      const ids = new Set<string>();
      for (const [index, item] of collection.items.entries()) {
        if (ids.has(item.id)) {
          context.addIssue({
            code: "custom",
            path: [collection.path, index, "id"],
            message: `Snapshot ${collection.path} identifiers must be unique`,
          });
        }
        ids.add(item.id);
      }
    }

    const slugs = new Set(snapshot.controlAreas.map((area) => area.slug));
    if (slugs.size !== snapshot.controlAreas.length) {
      context.addIssue({
        code: "custom",
        path: ["controlAreas"],
        message: "Controller snapshot control areas must be unique",
      });
    }
    const typeKeys = new Set(snapshot.controlAreas.map((area) => area.typeKey));
    if (typeKeys.size !== snapshot.controlAreas.length) {
      context.addIssue({
        code: "custom",
        path: ["controlAreas"],
        message: "Controller snapshot control-area type keys must be unique",
      });
    }
    const channelById = new Map(
      snapshot.channels.map((channel) => [channel.id, channel]),
    );
    const throttleById = new Map(
      snapshot.throttles.map((throttle) => [throttle.id, throttle]),
    );
    const outputIds = new Set(snapshot.outputs.map((output) => output.id));
    const profileIds = new Set(
      snapshot.mappingProfiles.map((profile) => profile.id),
    );
    const deviceIds = new Set(snapshot.devices.map((device) => device.id));
    const ruleById = new Map(
      snapshot.alertRules.map((rule) => [rule.id, rule]),
    );

    for (const [index, channel] of snapshot.channels.entries()) {
      const throttle = throttleById.get(channel.throttleId);
      if (throttle === undefined || throttle.typeKey !== channel.typeKey) {
        context.addIssue({
          code: "custom",
          path: ["channels", index, "throttleId"],
          message: "Channel must reference a throttle with the same type key",
        });
      }
    }
    for (const [index, schedule] of snapshot.schedules.entries()) {
      if (!channelById.has(schedule.channelId)) {
        context.addIssue({
          code: "custom",
          path: ["schedules", index, "channelId"],
          message: "Schedule must reference a snapshot channel",
        });
      }
    }
    for (const [profileIndex, profile] of snapshot.mappingProfiles.entries()) {
      for (const [mappingIndex, mapping] of profile.mappings.entries()) {
        const targetExists =
          mapping.target.kind === "channel"
            ? channelById.has(mapping.target.id)
            : outputIds.has(mapping.target.id);
        if (!targetExists) {
          context.addIssue({
            code: "custom",
            path: [
              "mappingProfiles",
              profileIndex,
              "mappings",
              mappingIndex,
              "target",
            ],
            message: "Pin mapping target must exist in the snapshot",
          });
        }
      }
    }
    for (const [index, device] of snapshot.devices.entries()) {
      if (
        device.mappingProfileId !== null &&
        !profileIds.has(device.mappingProfileId)
      ) {
        context.addIssue({
          code: "custom",
          path: ["devices", index, "mappingProfileId"],
          message: "Device mapping profile must exist in the snapshot",
        });
      }
    }
    for (const [index, operation] of snapshot.operations.items.entries()) {
      if (operation.deviceId !== null && !deviceIds.has(operation.deviceId)) {
        context.addIssue({
          code: "custom",
          path: ["operations", "items", index, "deviceId"],
          message: "Operation device must exist in the snapshot",
        });
      }
    }
    for (const [
      index,
      operation,
    ] of snapshot.unresolvedDeviceOperations.items.entries()) {
      if (operation.deviceId !== null && !deviceIds.has(operation.deviceId)) {
        context.addIssue({
          code: "custom",
          path: ["unresolvedDeviceOperations", "items", index, "deviceId"],
          message: "Unresolved operation device must exist in the snapshot",
        });
      }
    }
    for (const [index, rule] of snapshot.alertRules.entries()) {
      if (rule.source.type === "device" && !deviceIds.has(rule.source.id)) {
        context.addIssue({
          code: "custom",
          path: ["alertRules", index, "source", "id"],
          message: "Device alert rule source must exist in the snapshot",
        });
      }
      if (rule.source.type === "output" && !outputIds.has(rule.source.id)) {
        context.addIssue({
          code: "custom",
          path: ["alertRules", index, "source", "id"],
          message: "Output alert rule source must exist in the snapshot",
        });
      }
      // Sensor and switch collections are outside the R4 snapshot contract, so
      // their validated identifiers intentionally remain opaque here.
    }
    for (const [index, override] of snapshot.overrides.entries()) {
      const targetExists =
        override.targetType === "channel"
          ? channelById.has(override.targetId)
          : outputIds.has(override.targetId);
      if (!targetExists) {
        context.addIssue({
          code: "custom",
          path: ["overrides", index, "targetId"],
          message: "Override target must exist in the snapshot",
        });
      }
    }
    for (const [index, alert] of snapshot.alerts.entries()) {
      const rule = ruleById.get(alert.alertRuleId);
      if (rule === undefined) {
        context.addIssue({
          code: "custom",
          path: ["alerts", index, "alertRuleId"],
          message: "Active alert rule must exist in the snapshot",
        });
      } else if (
        alert.details?.observation !== null &&
        alert.details?.observation !== undefined &&
        (alert.details.observation.sourceType !== rule.source.type ||
          alert.details.observation.sourceId !== rule.source.id)
      ) {
        context.addIssue({
          code: "custom",
          path: ["alerts", index, "details", "observation"],
          message: "Active alert observation must identify its rule source",
        });
      }
    }
    if ((snapshot.revision === 0) !== (snapshot.committedAt === null)) {
      context.addIssue({
        code: "custom",
        path: ["committedAt"],
        message: "Only revision zero may omit the commit time",
      });
    }
    if (
      snapshot.committedAt !== null &&
      Date.parse(snapshot.generatedAt) < Date.parse(snapshot.committedAt)
    ) {
      context.addIssue({
        code: "custom",
        path: ["generatedAt"],
        message: "Snapshot generation must not precede its commit",
      });
    }
  });

export const entityStateResourceSchema = z.enum([
  "control_area",
  "channel",
  "schedule",
  "throttle",
  "mapping_profile",
  "device",
  "operation",
  "override",
  "alert_rule",
  "alert",
  "output",
  "import_run",
]);

export const stateResourceSchema = z.union([
  z.literal("controller"),
  entityStateResourceSchema,
]);

export const stateInvalidationSchema = z.union([
  z.strictObject({ resource: z.literal("controller"), id: z.null() }),
  z.strictObject({
    resource: entityStateResourceSchema,
    id: identifierSchema,
  }),
]);

export const stateInvalidationsSchema = z
  .strictObject({
    invalidations: z.array(stateInvalidationSchema).min(1).max(100),
  })
  .superRefine((document, context) => {
    const keys = new Set<string>();
    for (const [index, invalidation] of document.invalidations.entries()) {
      const key = `${invalidation.resource}:${invalidation.id ?? ""}`;
      if (keys.has(key)) {
        context.addIssue({
          code: "custom",
          path: ["invalidations", index],
          message: "State invalidations must be unique",
        });
      }
      keys.add(key);
    }
  });

export const stateOutboxEnvelopeV1Schema = z
  .strictObject({
    schemaVersion: z.literal(1),
    invalidations: z.array(stateInvalidationSchema).min(1).max(100),
    details: z.strictObject({
      schemaVersion: positiveSafeIntegerSchema,
      data: z.json(),
    }),
  })
  .superRefine((envelope, context) => {
    const result = stateInvalidationsSchema.safeParse({
      invalidations: envelope.invalidations,
    });
    if (!result.success) {
      for (const issue of result.error.issues) {
        context.addIssue({
          code: "custom",
          path: issue.path,
          message: issue.message,
        });
      }
    }
  });

const committedStateEntitySchema = z.union([
  z.strictObject({ type: z.literal("controller"), id: z.null() }),
  z.strictObject({ type: entityStateResourceSchema, id: identifierSchema }),
]);

export const committedStateEventSchema = z
  .strictObject({
    revision: positiveSafeIntegerSchema,
    type: boundedTextSchema,
    occurredAt: isoTimestampSchema,
    entity: committedStateEntitySchema,
    schemaVersion: z.literal(1),
    data: stateInvalidationsSchema,
    retentionClass: retentionClassSchema,
  })
  .superRefine((event, context) => {
    const containsEntity = event.data.invalidations.some(
      (invalidation) =>
        invalidation.resource === event.entity.type &&
        invalidation.id === event.entity.id,
    );
    if (!containsEntity) {
      context.addIssue({
        code: "custom",
        path: ["data", "invalidations"],
        message: "Committed event must invalidate its primary entity",
      });
    }
  });

export const expectedRevisionSchema = z.strictObject({
  expectedRevision: nonnegativeSafeIntegerSchema,
});

export const controlAreaParamsSchema = z.strictObject({
  areaSlug: controlAreaSlugSchema,
});

export const createControlAreaRequestSchema = z.strictObject({
  expectedRevision: nonnegativeSafeIntegerSchema,
  label: boundedTextSchema,
});

export const renameControlAreaRequestSchema = z.strictObject({
  expectedRevision: nonnegativeSafeIntegerSchema,
  label: boundedTextSchema,
});

const controlAreaDraftSchema = z.strictObject({
  slug: controlAreaSlugSchema.nullable(),
  label: boundedTextSchema,
});

export const replaceControlAreasRequestSchema = z
  .strictObject({
    expectedRevision: nonnegativeSafeIntegerSchema,
    areas: z.array(controlAreaDraftSchema).max(64),
  })
  .superRefine((request, context) => {
    const slugs = new Set<string>();
    for (const [index, area] of request.areas.entries()) {
      if (area.slug === null) continue;
      if (slugs.has(area.slug)) {
        context.addIssue({
          code: "custom",
          path: ["areas", index, "slug"],
          message: "Control area identifiers must be unique",
        });
      }
      slugs.add(area.slug);
    }
  });

export const channelParamsSchema = z.strictObject({
  channelId: identifierSchema,
});

export const throttleParamsSchema = z.strictObject({
  typeKey: controlTypeKeySchema,
});

export const mappingProfileParamsSchema = z.strictObject({
  profileId: identifierSchema,
});

export const deviceParamsSchema = z.strictObject({
  deviceId: identifierSchema,
});

export const operationParamsSchema = z.strictObject({
  operationId: identifierSchema,
});

export const alertRuleParamsSchema = z.strictObject({
  alertRuleId: identifierSchema,
});

export const alertParamsSchema = z.strictObject({
  alertId: identifierSchema,
});

export const createChannelRequestSchema = z.strictObject({
  expectedRevision: nonnegativeSafeIntegerSchema,
  id: identifierSchema,
  name: boundedTextSchema,
  color: canonicalHexColorSchema,
  typeKey: controlTypeKeySchema,
  throttleId: identifierSchema,
  displayOrder: nonnegativeSafeIntegerSchema,
  enabled: z.boolean(),
});

export const renameChannelRequestSchema = z.strictObject({
  expectedRevision: nonnegativeSafeIntegerSchema,
  name: boundedTextSchema,
});

export const updateChannelRequestSchema = z.strictObject({
  expectedRevision: nonnegativeSafeIntegerSchema,
  name: boundedTextSchema,
  color: canonicalHexColorSchema.optional(),
});

const controlAreaChannelDraftSchema = z.strictObject({
  id: identifierSchema,
  name: boundedTextSchema,
  color: canonicalHexColorSchema,
});

export const replaceControlAreaChannelsRequestSchema = z
  .strictObject({
    expectedRevision: nonnegativeSafeIntegerSchema,
    channels: z.array(controlAreaChannelDraftSchema).max(64),
  })
  .superRefine((request, context) => {
    const identifiers = new Set<string>();
    const names = new Set<string>();
    for (const [index, channel] of request.channels.entries()) {
      if (identifiers.has(channel.id)) {
        context.addIssue({
          code: "custom",
          path: ["channels", index, "id"],
          message: "Channel identifiers must be unique",
        });
      }
      identifiers.add(channel.id);
      if (names.has(channel.name)) {
        context.addIssue({
          code: "custom",
          path: ["channels", index, "name"],
          message: "Channel names must be unique within a control area",
        });
      }
      names.add(channel.name);
    }
  });

export const replaceScheduleRequestSchema = z.strictObject({
  expectedRevision: nonnegativeSafeIntegerSchema,
  points: z.array(schedulePointSchema).min(2).max(1_440),
});

const controlAreaScheduleDraftSchema = z.strictObject({
  channelId: identifierSchema,
  points: z.array(schedulePointSchema).min(2).max(1_440),
});

export const replaceControlAreaScheduleConfigurationRequestSchema = z
  .strictObject({
    expectedRevision: nonnegativeSafeIntegerSchema,
    schedules: z.array(controlAreaScheduleDraftSchema).max(64),
    throttlePercentage: percentageSchema.optional(),
  })
  .superRefine((request, context) => {
    const channelIds = new Set<string>();
    const pointIds = new Set<string>();
    for (const [scheduleIndex, schedule] of request.schedules.entries()) {
      if (channelIds.has(schedule.channelId)) {
        context.addIssue({
          code: "custom",
          path: ["schedules", scheduleIndex, "channelId"],
          message: "Each channel schedule may appear only once",
        });
      }
      channelIds.add(schedule.channelId);
      for (const [pointIndex, point] of schedule.points.entries()) {
        if (pointIds.has(point.id)) {
          context.addIssue({
            code: "custom",
            path: ["schedules", scheduleIndex, "points", pointIndex, "id"],
            message: "Schedule point identifiers must be unique",
          });
        }
        pointIds.add(point.id);
      }
    }
  });

export const updateThrottleRequestSchema = z.strictObject({
  expectedRevision: nonnegativeSafeIntegerSchema,
  percentage: percentageSchema,
});

export const replaceMappingProfileRequestSchema = z
  .strictObject({
    expectedRevision: nonnegativeSafeIntegerSchema,
    name: boundedTextSchema,
    hardwareProfileId: hardwareProfileIdSchema,
    outputGain: gainSchema,
    mappings: z.array(pinMappingSchema).max(64),
  })
  .superRefine((request, context) => {
    const pins = new Set<number>();
    const targets = new Set<string>();
    for (const [index, mapping] of request.mappings.entries()) {
      const targetKey = `${mapping.target.kind}:${mapping.target.id}`;
      if (pins.has(mapping.pin)) {
        context.addIssue({
          code: "custom",
          path: ["mappings", index, "pin"],
          message: "Mapping pins must be unique within a profile",
        });
      }
      if (targets.has(targetKey)) {
        context.addIssue({
          code: "custom",
          path: ["mappings", index, "target"],
          message: "Mapping targets must be unique within a profile",
        });
      }
      pins.add(mapping.pin);
      targets.add(targetKey);
      if (!isAllowedPwmPin(request.hardwareProfileId, mapping.pin)) {
        context.addIssue({
          code: "custom",
          path: ["mappings", index, "pin"],
          message: `GPIO${mapping.pin} is not an allowed PWM output on ${hardwareProfileById(request.hardwareProfileId).label}`,
        });
      }
    }
  });

export const patchDeviceConfigurationRequestSchema = z
  .strictObject({
    expectedRevision: nonnegativeSafeIntegerSchema,
    name: z
      .string()
      .min(1)
      .max(31)
      .regex(/^[!-~]+$/u, {
        message: "Device name must be one printable ASCII token",
      })
      .optional(),
    pwmFrequencyHz: pwmFrequencyHzSchema.optional(),
    pwmResolutionBits: pwmResolutionBitsSchema.optional(),
    mappingProfileId: identifierSchema.nullable().optional(),
  })
  .superRefine((request, context) => {
    if (
      request.name === undefined &&
      request.pwmFrequencyHz === undefined &&
      request.pwmResolutionBits === undefined &&
      request.mappingProfileId === undefined
    ) {
      context.addIssue({
        code: "custom",
        path: [],
        message: "Device configuration patch must change at least one field",
      });
    }
    if (
      request.pwmFrequencyHz !== undefined &&
      request.pwmResolutionBits !== undefined &&
      !isSupportedEsp32PwmConfiguration(
        request.pwmFrequencyHz,
        request.pwmResolutionBits,
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["pwmResolutionBits"],
        message: unsupportedPwmConfigurationMessage,
      });
    }
  });

export const setDeviceEnabledRequestSchema = z.strictObject({
  expectedRevision: nonnegativeSafeIntegerSchema,
  enabled: z.boolean(),
});

export const requestFirmwareUpdateSchema = z.strictObject({
  expectedRevision: nonnegativeSafeIntegerSchema,
  mode: firmwareUpdateModeSchema,
  transitionSeconds: otaTransitionSecondsSchema.optional(),
});

export const alertRuleSourceSchema = z.discriminatedUnion("type", [
  z.strictObject({ type: z.literal("device"), id: identifierSchema }),
  z.strictObject({ type: z.literal("output"), id: identifierSchema }),
  z.strictObject({ type: z.literal("sensor"), id: identifierSchema }),
  z.strictObject({ type: z.literal("switch"), id: identifierSchema }),
]);

export const alertRuleConditionSchema = z.union([
  z.strictObject({
    kind: z.enum(["offline", "stale", "error", "not_online"]),
  }),
  numericAlertConditionSchema,
  z.strictObject({ kind: z.enum(["open", "closed"]) }),
]);

const alertRuleMutationBaseShape = {
  name: boundedTextSchema,
  delayMs: nonnegativeSafeIntegerSchema,
  severity: alertSeveritySchema,
  enabled: z.boolean(),
} as const;

export const alertRuleInputSchema = z.union([
  z.strictObject({
    ...alertRuleMutationBaseShape,
    source: z.strictObject({ type: z.literal("device"), id: identifierSchema }),
    condition: z.strictObject({
      kind: z.enum(["offline", "stale", "error", "not_online"]),
    }),
  }),
  z.strictObject({
    ...alertRuleMutationBaseShape,
    source: z.strictObject({ type: z.literal("output"), id: identifierSchema }),
    condition: numericAlertConditionSchema,
  }),
  z.strictObject({
    ...alertRuleMutationBaseShape,
    source: z.strictObject({ type: z.literal("sensor"), id: identifierSchema }),
    condition: numericAlertConditionSchema,
  }),
  z.strictObject({
    ...alertRuleMutationBaseShape,
    source: z.strictObject({ type: z.literal("switch"), id: identifierSchema }),
    condition: z.strictObject({ kind: z.enum(["open", "closed"]) }),
  }),
]);

export const createAlertRuleRequestSchema = z.strictObject({
  expectedRevision: nonnegativeSafeIntegerSchema,
  id: identifierSchema,
  rule: alertRuleInputSchema,
});

export const patchAlertRuleRequestSchema = z
  .strictObject({
    expectedRevision: nonnegativeSafeIntegerSchema,
    name: boundedTextSchema.optional(),
    source: alertRuleSourceSchema.optional(),
    condition: alertRuleConditionSchema.optional(),
    delayMs: nonnegativeSafeIntegerSchema.optional(),
    severity: alertSeveritySchema.optional(),
    enabled: z.boolean().optional(),
  })
  .superRefine((request, context) => {
    if (
      request.name === undefined &&
      request.source === undefined &&
      request.condition === undefined &&
      request.delayMs === undefined &&
      request.severity === undefined &&
      request.enabled === undefined
    ) {
      context.addIssue({
        code: "custom",
        path: [],
        message: "Alert rule patch must change at least one field",
      });
    }
  });

export const acknowledgeAlertRequestSchema = z.strictObject({
  expectedRevision: nonnegativeSafeIntegerSchema,
  note: boundedTextSchema.nullable(),
});

export const alertRulesResponseSchema = z.strictObject({
  items: z.array(alertRuleSchema).max(1_000),
});

export const alertHistoryStateFilterSchema = z.enum([
  "active",
  "open",
  "acknowledged",
  "recovered",
  "all",
]);

export const alertHistoryCursorSchema = z
  .string()
  .min(1)
  .max(512)
  .regex(/^[A-Za-z0-9_-]+$/u);

export const alertHistoryListRequestSchema = z.strictObject({
  state: alertHistoryStateFilterSchema.default("active"),
  cursor: alertHistoryCursorSchema.optional(),
  pageSize: z.number().int().min(1).max(50).default(25),
});

export const alertHistoryListResponseSchema = z
  .strictObject({
    schemaVersion: z.literal(1),
    items: z.array(activeAlertSchema).max(50),
    nextCursor: alertHistoryCursorSchema.nullable(),
    hasMore: z.boolean(),
    deliveriesTruncatedAlertIds: z.array(identifierSchema).max(50),
  })
  .superRefine((response, context) => {
    if (response.hasMore !== (response.nextCursor !== null)) {
      context.addIssue({
        code: "custom",
        path: ["nextCursor"],
        message: "Alert history requires a cursor exactly when more rows exist",
      });
    }
    const seenAlertIds = new Set<string>();
    for (const [index, item] of response.items.entries()) {
      if (seenAlertIds.has(item.id)) {
        context.addIssue({
          code: "custom",
          path: ["items", index, "id"],
          message: "Alert history items must have unique identifiers",
        });
      }
      seenAlertIds.add(item.id);
      const previous = response.items[index - 1];
      if (
        previous !== undefined &&
        (Date.parse(previous.lastObservedAt) <
          Date.parse(item.lastObservedAt) ||
          (previous.lastObservedAt === item.lastObservedAt &&
            previous.id <= item.id))
      ) {
        context.addIssue({
          code: "custom",
          path: ["items", index],
          message:
            "Alert history must use descending observation time and identifier order",
        });
      }
    }
    const seenTruncatedIds = new Set<string>();
    for (const [
      index,
      alertId,
    ] of response.deliveriesTruncatedAlertIds.entries()) {
      if (!seenAlertIds.has(alertId) || seenTruncatedIds.has(alertId)) {
        context.addIssue({
          code: "custom",
          path: ["deliveriesTruncatedAlertIds", index],
          message:
            "Truncated delivery identifiers must uniquely reference returned alerts",
        });
      }
      seenTruncatedIds.add(alertId);
    }
  });

export const operationDetailsResponseSchema = z.strictObject({
  operation: operationSummarySchema,
  request: z.strictObject({
    schemaVersion: positiveSafeIntegerSchema,
    data: z.json(),
  }),
  result: z
    .strictObject({
      schemaVersion: positiveSafeIntegerSchema,
      data: z.json(),
    })
    .nullable(),
});

export const configurationMutationEventV1Schema = z.strictObject({
  schemaVersion: z.literal(1),
  action: z.enum(["created", "updated", "deleted", "replaced"]),
  resource: entityStateResourceSchema,
  id: identifierSchema,
});

const controlAreaAuditThrottleSchema = z.strictObject({
  id: identifierSchema,
  percentage: percentageSchema,
});

export const controlAreaMutationEventV1Schema = z.strictObject({
  schemaVersion: z.literal(1),
  action: z.enum(["created", "updated", "deleted"]),
  resource: z.literal("control_area"),
  id: controlAreaSlugSchema,
  before: controlAreaSchema.nullable(),
  after: controlAreaSchema.nullable(),
  throttle: controlAreaAuditThrottleSchema.nullable(),
});

const changedMutationResultSchema = z
  .strictObject({
    changed: z.literal(true),
    revision: positiveSafeIntegerSchema,
    event: committedStateEventSchema,
  })
  .superRefine((result, context) => {
    if (result.event.revision !== result.revision) {
      context.addIssue({
        code: "custom",
        path: ["event", "revision"],
        message: "Mutation and event revisions must match",
      });
    }
  });

const unchangedMutationResultSchema = z.strictObject({
  changed: z.literal(false),
  revision: nonnegativeSafeIntegerSchema,
  event: z.null(),
});

export const mutationResultSchema = z.union([
  changedMutationResultSchema,
  unchangedMutationResultSchema,
]);

const validationIssueSchema = z.strictObject({
  path: z.array(z.union([boundedTextSchema, nonnegativeSafeIntegerSchema])),
  code: boundedTextSchema,
  message: boundedTextSchema,
});

const relationalConflictSchema = z.strictObject({
  resource: boundedTextSchema,
  id: identifierSchema.nullable(),
  relation: boundedTextSchema,
  message: boundedTextSchema,
});

export const apiErrorResponseSchema = z.discriminatedUnion("code", [
  z.strictObject({
    code: z.literal("invalid_request"),
    message: boundedTextSchema,
    issues: z.array(validationIssueSchema).min(1).max(100),
  }),
  z.strictObject({
    code: z.literal("not_found"),
    message: boundedTextSchema,
    resource: boundedTextSchema,
    id: identifierSchema,
  }),
  z.strictObject({
    code: z.literal("revision_conflict"),
    message: boundedTextSchema,
    expectedRevision: nonnegativeSafeIntegerSchema,
    currentRevision: nonnegativeSafeIntegerSchema,
  }),
  z.strictObject({
    code: z.literal("relational_conflict"),
    message: boundedTextSchema,
    conflicts: z.array(relationalConflictSchema).min(1).max(100),
  }),
  z.strictObject({
    code: z.literal("internal_error"),
    message: boundedTextSchema,
    requestId: identifierSchema,
  }),
  z.strictObject({
    code: z.literal("service_unavailable"),
    message: boundedTextSchema,
    service: boundedTextSchema,
  }),
]);

export type ControlArea = z.infer<typeof controlAreaSchema>;
export type Channel = z.infer<typeof channelSchema>;
export type SchedulePoint = z.infer<typeof schedulePointSchema>;
export type ScheduleGraph = z.infer<typeof scheduleGraphSchema>;
export type Throttle = z.infer<typeof throttleSchema>;
export type Output = z.infer<typeof outputSchema>;
export type PinMapping = z.infer<typeof pinMappingSchema>;
export type MappingProfile = z.infer<typeof mappingProfileSchema>;
export type Device = z.infer<typeof deviceSchema>;
export type FirmwareDeployment = z.infer<typeof firmwareDeploymentSchema>;
export type FirmwareUpdateMode = z.infer<typeof firmwareUpdateModeSchema>;
export type FirmwareUpdateStatus = z.infer<typeof firmwareUpdateStatusSchema>;
export type OperationSummary = z.infer<typeof operationSummarySchema>;
export type RecentOperations = z.infer<typeof recentOperationsSchema>;
export type UnresolvedDeviceOperations = z.infer<
  typeof unresolvedDeviceOperationsSchema
>;
export type ImportRunSummary = z.infer<typeof importRunSummarySchema>;
export type Override = z.infer<typeof overrideSchema>;
export type AlertObservation = z.infer<typeof alertObservationSchema>;
export type AlertLifecycleTransition = z.infer<
  typeof alertLifecycleTransitionSchema
>;
export type AlertRuleSnapshot = z.infer<typeof alertRuleSnapshotSchema>;
export type AlertSnapshot = z.infer<typeof alertSnapshotSchema>;
export type AlertStateEventPayloadV1 = z.infer<
  typeof alertStateEventPayloadV1Schema
>;
export type AlertNotificationV1 = z.infer<typeof alertNotificationV1Schema>;
export type AlertRule = z.infer<typeof alertRuleSchema>;
export type ActiveAlert = z.infer<typeof activeAlertSchema>;
export type NotificationDelivery = z.infer<typeof notificationDeliverySchema>;
export type ControllerSnapshot = z.infer<typeof controllerSnapshotSchema>;
export type CommittedStateEvent = z.infer<typeof committedStateEventSchema>;
export type StateResource = z.infer<typeof stateResourceSchema>;
export type EntityStateResource = z.infer<typeof entityStateResourceSchema>;
export type StateInvalidation = z.infer<typeof stateInvalidationSchema>;
export type StateOutboxEnvelopeV1 = z.infer<typeof stateOutboxEnvelopeV1Schema>;
export type MutationResult = z.infer<typeof mutationResultSchema>;
export type ApiErrorResponse = z.infer<typeof apiErrorResponseSchema>;
export type CreateControlAreaRequest = z.infer<
  typeof createControlAreaRequestSchema
>;
export type RenameControlAreaRequest = z.infer<
  typeof renameControlAreaRequestSchema
>;
export type ReplaceControlAreasRequest = z.infer<
  typeof replaceControlAreasRequestSchema
>;
export type CreateChannelRequest = z.infer<typeof createChannelRequestSchema>;
export type RenameChannelRequest = z.infer<typeof renameChannelRequestSchema>;
export type UpdateChannelRequest = z.infer<typeof updateChannelRequestSchema>;
export type ReplaceControlAreaChannelsRequest = z.infer<
  typeof replaceControlAreaChannelsRequestSchema
>;
export type ReplaceScheduleRequest = z.infer<
  typeof replaceScheduleRequestSchema
>;
export type ReplaceControlAreaScheduleConfigurationRequest = z.infer<
  typeof replaceControlAreaScheduleConfigurationRequestSchema
>;
export type UpdateThrottleRequest = z.infer<typeof updateThrottleRequestSchema>;
export type ReplaceMappingProfileRequest = z.infer<
  typeof replaceMappingProfileRequestSchema
>;
export type PatchDeviceConfigurationRequest = z.infer<
  typeof patchDeviceConfigurationRequestSchema
>;
export type SetDeviceEnabledRequest = z.infer<
  typeof setDeviceEnabledRequestSchema
>;
export type RequestFirmwareUpdate = z.infer<typeof requestFirmwareUpdateSchema>;
export type AlertRuleSource = z.infer<typeof alertRuleSourceSchema>;
export type AlertRuleCondition = z.infer<typeof alertRuleConditionSchema>;
export type AlertRuleInput = z.infer<typeof alertRuleInputSchema>;
export type CreateAlertRuleRequest = z.infer<
  typeof createAlertRuleRequestSchema
>;
export type PatchAlertRuleRequest = z.infer<typeof patchAlertRuleRequestSchema>;
export type AcknowledgeAlertRequest = z.infer<
  typeof acknowledgeAlertRequestSchema
>;
export type AlertRulesResponse = z.infer<typeof alertRulesResponseSchema>;
export type AlertHistoryStateFilter = z.infer<
  typeof alertHistoryStateFilterSchema
>;
export type AlertHistoryListRequest = z.infer<
  typeof alertHistoryListRequestSchema
>;
export type AlertHistoryListResponse = z.infer<
  typeof alertHistoryListResponseSchema
>;
export type OperationDetailsResponse = z.infer<
  typeof operationDetailsResponseSchema
>;
export type ConfigurationMutationEventV1 = z.infer<
  typeof configurationMutationEventV1Schema
>;
export type ControlAreaMutationEventV1 = z.infer<
  typeof controlAreaMutationEventV1Schema
>;
