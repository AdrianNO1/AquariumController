import {
  controllerSnapshotSchema,
  type ControllerSnapshot,
} from "@aquarium/contracts";

const generatedAt = "2026-07-13T10:00:00.000Z";

interface TestControllerSnapshotOptions {
  readonly alertRules?: ControllerSnapshot["alertRules"];
  readonly alerts?: ControllerSnapshot["alerts"];
}

export function createTestControllerSnapshot(
  revision: number,
  options: TestControllerSnapshotOptions = {},
): ControllerSnapshot {
  return controllerSnapshotSchema.parse({
    schemaVersion: 1,
    revision,
    committedAt: revision === 0 ? null : generatedAt,
    generatedAt,
    controlAreas: [
      { slug: "lights", typeKey: "light", label: "Lights" },
      { slug: "pumps", typeKey: "pump", label: "Pumps" },
      { slug: "testlights", typeKey: "testlight", label: "Test lights" },
      { slug: "bad", typeKey: "bad", label: "Bad" },
      { slug: "loft", typeKey: "loft", label: "Loft" },
      { slug: "biljard", typeKey: "biljard", label: "Biljard" },
      { slug: "frag", typeKey: "frag", label: "Frag" },
      { slug: "qt1", typeKey: "qt1", label: "Quarantine 1" },
      { slug: "qt2", typeKey: "qt2", label: "Quarantine 2" },
      { slug: "qt3", typeKey: "qt3", label: "Quarantine 3" },
      { slug: "qt4", typeKey: "qt4", label: "Quarantine 4" },
    ],
    channels: [],
    schedules: [],
    throttles: [],
    outputs: [],
    mappingProfiles: [],
    devices: [],
    operations: { items: [], limit: 100, truncated: false },
    unresolvedDeviceOperations: {
      items: [],
      limit: 100,
      truncated: false,
    },
    importRuns: [],
    overrides: [],
    alertRules: options.alertRules ?? [],
    alerts: options.alerts ?? [],
  });
}

export function createTestAlertsSnapshot(revision = 4): ControllerSnapshot {
  return createTestControllerSnapshot(revision, {
    alertRules: [
      {
        id: "rule-temperature",
        name: "Temperature high",
        source: { type: "sensor", id: "sensor-temperature" },
        condition: { kind: "above", threshold: 28 },
        delayMs: 60_000,
        severity: "critical",
        enabled: true,
        createdAt: "2026-07-13T08:00:00.000Z",
        updatedAt: "2026-07-13T08:00:00.000Z",
      },
    ],
    alerts: [
      {
        id: "alert-open",
        alertRuleId: "rule-temperature",
        deduplicationKey: "temperature-high",
        state: "open",
        openedAt: "2026-07-13T09:00:00.000Z",
        lastObservedAt: "2026-07-13T09:05:00.000Z",
        acknowledgedAt: null,
        recoveredAt: null,
        details: {
          schemaVersion: 1,
          observation: {
            sourceType: "sensor",
            sourceId: "sensor-temperature",
            value: 29.5,
          },
          note: "Temperature exceeded the configured threshold",
        },
        notificationDeliveries: [
          {
            id: 1,
            alertTransitionRevision: 2,
            transition: "opened",
            destinationKind: "webhook",
            destinationKey: "operator-webhook",
            status: "failed",
            attemptCount: 1,
            createdAt: "2026-07-13T09:00:00.000Z",
            attemptedAt: "2026-07-13T09:00:01.000Z",
            completedAt: "2026-07-13T09:00:02.000Z",
            lastError: {
              code: "http_503",
              message: "Destination unavailable",
            },
          },
        ],
      },
      {
        id: "alert-acknowledged",
        alertRuleId: "rule-temperature",
        deduplicationKey: "temperature-high-acknowledged",
        state: "acknowledged",
        openedAt: "2026-07-13T08:00:00.000Z",
        lastObservedAt: "2026-07-13T08:10:00.000Z",
        acknowledgedAt: "2026-07-13T08:11:00.000Z",
        recoveredAt: null,
        details: null,
        notificationDeliveries: [],
      },
      {
        id: "alert-recovered",
        alertRuleId: "rule-temperature",
        deduplicationKey: "temperature-high-recovered",
        state: "recovered",
        openedAt: "2026-07-13T07:00:00.000Z",
        lastObservedAt: "2026-07-13T07:10:00.000Z",
        acknowledgedAt: null,
        recoveredAt: "2026-07-13T07:20:00.000Z",
        details: null,
        notificationDeliveries: [],
      },
    ],
  });
}
