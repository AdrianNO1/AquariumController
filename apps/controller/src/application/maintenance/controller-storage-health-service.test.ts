import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { AlertService } from "../alerts/alert-service.js";
import type {
  AlertClock,
  AlertEvaluationResult,
  AlertIdGenerator,
  SensorAlertObservation,
} from "../alerts/types.js";
import {
  ControllerSnapshotRepository,
  openStateDatabase,
  toCommittedStateEvent,
  type StateDatabaseSchema,
} from "../../infrastructure/database/index.js";
import { ControllerStorageHealthRepository } from "../../infrastructure/storage/controller-storage-health-repository.js";
import {
  CONTROLLER_STORAGE_HEALTH_DEVICE_ID,
  CONTROLLER_STORAGE_METRIC_DEFINITIONS,
  ControllerStorageHealthService,
  type ControllerStorageAlertEvaluatorPort,
  type ControllerStorageHealthStorePort,
  type ControllerStorageMetricReaderPort,
  type ControllerStorageMetrics,
} from "./controller-storage-health-service.js";

const HEALTHY_METRICS: ControllerStorageMetrics = {
  filesystemFreeBytes: 100,
  projectedUpperBoundStorageBytesAfterOneYear: 500,
  failedRetentionRunCount: 0,
  failedArchiveCount: 0,
  latestBackupOutcomeFailed: 0,
  successfulBackupMissingOrStale: 0,
};

class TestAlertClock implements AlertClock {
  value = 0;

  nowMs(): number {
    return this.value;
  }
}

class SequentialAlertIds implements AlertIdGenerator {
  #next = 1;

  nextAlertId(): string {
    const id = `storage-alert-${this.#next}`;
    this.#next += 1;
    return id;
  }
}

class MutableMetricReader implements ControllerStorageMetricReaderPort {
  constructor(public value: ControllerStorageMetrics) {}

  async read(): Promise<ControllerStorageMetrics> {
    return this.value;
  }
}

class TimestampedAlertEvaluator implements ControllerStorageAlertEvaluatorPort {
  constructor(
    private readonly alerts: AlertService,
    private readonly clock: TestAlertClock,
  ) {}

  async evaluate(input: {
    readonly observation: SensorAlertObservation;
    readonly observedAtMs: number;
    readonly actor: string;
  }): Promise<AlertEvaluationResult> {
    this.clock.value = input.observedAtMs;
    return this.alerts.evaluate(input.observation, input.actor);
  }
}

class NoopStore implements ControllerStorageHealthStorePort {
  async seedAndRecord(): Promise<void> {}
}

class NoopAlerts implements ControllerStorageAlertEvaluatorPort {
  async evaluate(input: {
    readonly observedAtMs: number;
  }): Promise<AlertEvaluationResult> {
    return { evaluatedAtMs: input.observedAtMs, decisions: [] };
  }
}

let database: Kysely<StateDatabaseSchema>;
let metrics: MutableMetricReader;
let service: ControllerStorageHealthService;

beforeEach(async () => {
  database = await openStateDatabase({ filename: ":memory:" });
  metrics = new MutableMetricReader(HEALTHY_METRICS);
  const clock = new TestAlertClock();
  service = new ControllerStorageHealthService(
    metrics,
    new ControllerStorageHealthRepository(database),
    new TimestampedAlertEvaluator(
      new AlertService(database, clock, new SequentialAlertIds()),
      clock,
    ),
    {
      minimumFilesystemFreeBytes: 100,
      maximumProjectedStorageBytesAfterOneYear: 500,
    },
  );
});

afterEach(async () => {
  await database.destroy();
});

describe("ControllerStorageHealthService", () => {
  it("commits the initial built-in definitions through one replayable state event", async () => {
    await service.evaluate({ observedAtMs: 100 });

    await expect(
      database
        .selectFrom("state_revisions")
        .select(["revision", "actor", "mutation_type"])
        .orderBy("revision")
        .execute(),
    ).resolves.toEqual([
      {
        revision: 1,
        actor: "controller-storage-health",
        mutation_type: "controller.storage-health-definitions",
      },
    ]);
    const outbox = await database
      .selectFrom("state_outbox")
      .selectAll()
      .executeTakeFirstOrThrow();
    expect(toCommittedStateEvent(outbox)).toMatchObject({
      revision: 1,
      type: "controller.storage-health-definitions-changed",
      entity: { type: "controller", id: null },
      data: {
        invalidations: [
          { resource: "controller", id: null },
          {
            resource: "device",
            id: CONTROLLER_STORAGE_HEALTH_DEVICE_ID,
          },
          ...CONTROLLER_STORAGE_METRIC_DEFINITIONS.map((definition) => ({
            resource: "alert_rule" as const,
            id: definition.alertRuleId,
          })),
        ],
      },
    });
  });

  it("records repeated metrics without rewriting definitions or changing the snapshot revision", async () => {
    const snapshotReader = new ControllerSnapshotRepository(database, {
      now: () => new Date(1_000),
    });
    await service.evaluate({ observedAtMs: 100 });
    const before = await snapshotReader.read();

    metrics.value = { ...HEALTHY_METRICS, filesystemFreeBytes: 200 };
    await service.evaluate({ observedAtMs: 200 });

    await expect(snapshotReader.read()).resolves.toEqual(before);
    await expect(
      database
        .selectFrom("state_revisions")
        .select(({ fn }) => fn.countAll<number>().as("count"))
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ count: 1 });
    await expect(
      database
        .selectFrom("sensors")
        .select(["latest_value", "latest_observed_at_ms"])
        .where("id", "=", "controller-storage-filesystem-free-bytes")
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({
      latest_value: 200,
      latest_observed_at_ms: 200,
    });
  });

  it("repairs changed definitions in one revision with precise invalidations", async () => {
    await service.evaluate({ observedAtMs: 100 });
    await database
      .updateTable("devices")
      .set({ name: "Changed storage device", updated_at_ms: 150 })
      .where("id", "=", CONTROLLER_STORAGE_HEALTH_DEVICE_ID)
      .executeTakeFirstOrThrow();
    await database
      .updateTable("alert_rules")
      .set({ threshold: 999, updated_at_ms: 150 })
      .where("id", "=", "controller-storage-low-filesystem-free-bytes")
      .executeTakeFirstOrThrow();

    await service.evaluate({ observedAtMs: 200 });

    await expect(
      database
        .selectFrom("devices")
        .select(["name", "updated_at_ms"])
        .where("id", "=", CONTROLLER_STORAGE_HEALTH_DEVICE_ID)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({
      name: "Controller storage health",
      updated_at_ms: 200,
    });
    await expect(
      database
        .selectFrom("alert_rules")
        .select(["threshold", "updated_at_ms"])
        .where("id", "=", "controller-storage-low-filesystem-free-bytes")
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ threshold: 100, updated_at_ms: 200 });
    await expect(
      database
        .selectFrom("alert_rules")
        .select("updated_at_ms")
        .where("id", "=", "controller-storage-failed-archives")
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ updated_at_ms: 100 });

    const repairedOutbox = await database
      .selectFrom("state_outbox")
      .selectAll()
      .where("revision", "=", 2)
      .executeTakeFirstOrThrow();
    expect(toCommittedStateEvent(repairedOutbox).data.invalidations).toEqual([
      { resource: "controller", id: null },
      { resource: "device", id: CONTROLLER_STORAGE_HEALTH_DEVICE_ID },
      {
        resource: "alert_rule",
        id: "controller-storage-low-filesystem-free-bytes",
      },
    ]);
  });

  it("opens all threshold alerts and recovers them at the exact boundaries", async () => {
    metrics.value = {
      filesystemFreeBytes: 99,
      projectedUpperBoundStorageBytesAfterOneYear: 501,
      failedRetentionRunCount: 1,
      failedArchiveCount: 2,
      latestBackupOutcomeFailed: 1,
      successfulBackupMissingOrStale: 1,
    };

    const opened = await service.evaluate({ observedAtMs: 100 });
    expect(
      opened.alertEvaluations.flatMap((evaluation) => evaluation.decisions),
    ).toHaveLength(6);
    expect(
      opened.alertEvaluations
        .flatMap((evaluation) => evaluation.decisions)
        .every(
          (decision) =>
            decision.kind === "transition" &&
            decision.transition.transition === "opened",
        ),
    ).toBe(true);

    metrics.value = HEALTHY_METRICS;
    const recovered = await service.evaluate({ observedAtMs: 200 });
    expect(
      recovered.alertEvaluations
        .flatMap((evaluation) => evaluation.decisions)
        .every(
          (decision) =>
            decision.kind === "transition" &&
            decision.transition.transition === "recovered",
        ),
    ).toBe(true);

    const alerts = await database
      .selectFrom("active_alerts")
      .select(["state", "recovered_at_ms"])
      .orderBy("alert_rule_id")
      .execute();
    expect(alerts).toHaveLength(6);
    expect(alerts.every((alert) => alert.state === "recovered")).toBe(true);
    expect(alerts.every((alert) => alert.recovered_at_ms === 200)).toBe(true);
  });

  it("idempotently seeds relational sources and keeps the virtual device ineligible", async () => {
    await service.evaluate({ observedAtMs: 100 });
    metrics.value = {
      ...HEALTHY_METRICS,
      filesystemFreeBytes: 200,
    };
    await service.evaluate({ observedAtMs: 200 });

    const device = await database
      .selectFrom("devices")
      .selectAll()
      .where("id", "=", CONTROLLER_STORAGE_HEALTH_DEVICE_ID)
      .executeTakeFirstOrThrow();
    expect(device).toMatchObject({
      mapping_profile_id: null,
      status: "unknown",
      enabled: 0,
      created_at_ms: 100,
      updated_at_ms: 100,
    });
    await expect(
      database
        .selectFrom("devices")
        .select("id")
        .where("id", "=", CONTROLLER_STORAGE_HEALTH_DEVICE_ID)
        .where("enabled", "=", 1)
        .executeTakeFirst(),
    ).resolves.toBeUndefined();

    const sensors = await database
      .selectFrom("sensors")
      .selectAll()
      .where("device_id", "=", CONTROLLER_STORAGE_HEALTH_DEVICE_ID)
      .orderBy("pin")
      .execute();
    expect(sensors).toHaveLength(6);
    expect(sensors.map((sensor) => sensor.id)).toEqual(
      CONTROLLER_STORAGE_METRIC_DEFINITIONS.map(
        (definition) => definition.sensorId,
      ),
    );
    expect(sensors.every((sensor) => sensor.created_at_ms === 100)).toBe(true);
    expect(sensors.every((sensor) => sensor.updated_at_ms === 200)).toBe(true);
    expect(sensors[0]?.latest_value).toBe(200);

    const rules = await database
      .selectFrom("alert_rules")
      .select(["id", "sensor_id", "condition", "threshold", "enabled"])
      .where("source_type", "=", "sensor")
      .orderBy("id")
      .execute();
    expect(rules).toHaveLength(6);
    expect(rules).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "controller-storage-low-filesystem-free-bytes",
          sensor_id: "controller-storage-filesystem-free-bytes",
          condition: "below",
          threshold: 100,
          enabled: 1,
        }),
        expect.objectContaining({
          id: "controller-storage-high-projected-one-year-bytes",
          sensor_id: "controller-storage-projected-one-year-bytes",
          condition: "above",
          threshold: 500,
          enabled: 1,
        }),
        expect.objectContaining({
          id: "controller-storage-failed-retention-runs",
          threshold: 0,
          enabled: 1,
        }),
        expect.objectContaining({
          id: "controller-storage-failed-archives",
          threshold: 0,
          enabled: 1,
        }),
        expect.objectContaining({
          id: "controller-storage-latest-backup-failed",
          threshold: 0,
          enabled: 1,
        }),
        expect.objectContaining({
          id: "controller-storage-successful-backup-missing-or-stale",
          threshold: 0,
          enabled: 1,
        }),
      ]),
    );
  });

  it("surfaces missing or stale success separately from the latest failed outcome", async () => {
    metrics.value = {
      ...HEALTHY_METRICS,
      successfulBackupMissingOrStale: 1,
    };
    const evaluation = await service.evaluate({ observedAtMs: 100 });

    const latestOutcomeEvaluation = evaluation.alertEvaluations.at(-2);
    expect(latestOutcomeEvaluation?.decisions).toEqual([
      {
        kind: "condition-clear",
        ruleId: "controller-storage-latest-backup-failed",
      },
    ]);
    expect(evaluation.alertEvaluations.at(-1)?.decisions).toEqual([
      expect.objectContaining({
        kind: "transition",
        transition: expect.objectContaining({ transition: "opened" }),
      }),
    ]);
    await expect(
      database
        .selectFrom("active_alerts")
        .select(["alert_rule_id", "state"])
        .where(
          "alert_rule_id",
          "=",
          "controller-storage-successful-backup-missing-or-stale",
        )
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({
      alert_rule_id: "controller-storage-successful-backup-missing-or-stale",
      state: "open",
    });
  });

  it("rejects invalid thresholds, timestamps, and metric values", async () => {
    expect(
      () =>
        new ControllerStorageHealthService(
          metrics,
          new NoopStore(),
          new NoopAlerts(),
          {
            minimumFilesystemFreeBytes: 0,
            maximumProjectedStorageBytesAfterOneYear: 500,
          },
        ),
    ).toThrow(/positive safe integer/u);
    expect(
      () =>
        new ControllerStorageHealthService(
          metrics,
          new NoopStore(),
          new NoopAlerts(),
          {
            minimumFilesystemFreeBytes: 100,
            maximumProjectedStorageBytesAfterOneYear:
              Number.MAX_SAFE_INTEGER + 1,
          },
        ),
    ).toThrow(/positive safe integer/u);
    await expect(service.evaluate({ observedAtMs: -1 })).rejects.toThrow(
      /non-negative safe integer/u,
    );

    metrics.value = { ...HEALTHY_METRICS, failedArchiveCount: -1 };
    await expect(service.evaluate({ observedAtMs: 100 })).rejects.toThrow(
      /failedArchiveCount/u,
    );

    metrics.value = {
      ...HEALTHY_METRICS,
      latestBackupOutcomeFailed: 2 as 0,
    };
    await expect(service.evaluate({ observedAtMs: 100 })).rejects.toThrow(
      /latestBackupOutcomeFailed must be either 0 or 1/u,
    );

    metrics.value = {
      ...HEALTHY_METRICS,
      successfulBackupMissingOrStale: 2 as 0,
    };
    await expect(service.evaluate({ observedAtMs: 100 })).rejects.toThrow(
      /successfulBackupMissingOrStale must be either 0 or 1/u,
    );
  });

  it("propagates measurement, store, and alert failures without fallback", async () => {
    const measurementError = new Error("measurement failed");
    const storeError = new Error("store failed");
    const alertError = new Error("alert failed");
    const throwingReader: ControllerStorageMetricReaderPort = {
      async read() {
        throw measurementError;
      },
    };
    const throwingStore: ControllerStorageHealthStorePort = {
      async seedAndRecord() {
        throw storeError;
      },
    };
    const throwingAlerts: ControllerStorageAlertEvaluatorPort = {
      async evaluate() {
        throw alertError;
      },
    };
    const thresholds = {
      minimumFilesystemFreeBytes: 100,
      maximumProjectedStorageBytesAfterOneYear: 500,
    };

    await expect(
      new ControllerStorageHealthService(
        throwingReader,
        new NoopStore(),
        new NoopAlerts(),
        thresholds,
      ).evaluate({ observedAtMs: 100 }),
    ).rejects.toBe(measurementError);
    await expect(
      new ControllerStorageHealthService(
        metrics,
        throwingStore,
        new NoopAlerts(),
        thresholds,
      ).evaluate({ observedAtMs: 100 }),
    ).rejects.toBe(storeError);
    await expect(
      new ControllerStorageHealthService(
        metrics,
        new NoopStore(),
        throwingAlerts,
        thresholds,
      ).evaluate({ observedAtMs: 100 }),
    ).rejects.toBe(alertError);
  });

  it("rejects concurrent or recursively triggered evaluations", async () => {
    const deferred: {
      resolve: ((value: ControllerStorageMetrics) => void) | null;
    } = { resolve: null };
    const pendingMetrics = new Promise<ControllerStorageMetrics>((resolve) => {
      deferred.resolve = resolve;
    });
    const blockingReader: ControllerStorageMetricReaderPort = {
      read() {
        return pendingMetrics;
      },
    };
    const guarded = new ControllerStorageHealthService(
      blockingReader,
      new NoopStore(),
      new NoopAlerts(),
      {
        minimumFilesystemFreeBytes: 100,
        maximumProjectedStorageBytesAfterOneYear: 500,
      },
    );

    const first = guarded.evaluate({ observedAtMs: 100 });
    await expect(guarded.evaluate({ observedAtMs: 100 })).rejects.toThrow(
      /already in progress/u,
    );
    const resolveMetrics = deferred.resolve;
    if (resolveMetrics === null) {
      throw new Error("Metric reader did not start");
    }
    resolveMetrics(HEALTHY_METRICS);
    await expect(first).resolves.toMatchObject({ observedAtMs: 100 });
  });
});
