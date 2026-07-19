import type {
  AlertEvaluationResult,
  SensorAlertObservation,
} from "../alerts/types.js";

export const CONTROLLER_STORAGE_HEALTH_DEVICE_ID = "virtual-controller-storage";
export const CONTROLLER_STORAGE_HEALTH_ACTOR = "controller-storage-health";

export type ControllerStorageMetricKey =
  | "filesystemFreeBytes"
  | "projectedUpperBoundStorageBytesAfterOneYear"
  | "failedRetentionRunCount"
  | "failedArchiveCount"
  | "latestBackupOutcomeFailed"
  | "successfulBackupMissingOrStale";

export interface ControllerStorageMetrics {
  readonly filesystemFreeBytes: number;
  readonly projectedUpperBoundStorageBytesAfterOneYear: number;
  readonly failedRetentionRunCount: number;
  readonly failedArchiveCount: number;
  readonly latestBackupOutcomeFailed: 0 | 1;
  readonly successfulBackupMissingOrStale: 0 | 1;
}

export interface ControllerStorageHealthThresholds {
  readonly minimumFilesystemFreeBytes: number;
  readonly maximumProjectedStorageBytesAfterOneYear: number;
}

export interface ControllerStorageMetricDefinition {
  readonly key: ControllerStorageMetricKey;
  readonly sensorId: string;
  readonly sensorName: string;
  readonly pin: number;
  readonly alertRuleId: string;
  readonly alertRuleName: string;
  readonly condition: "above" | "below";
  readonly severity: "error" | "critical";
}

export const CONTROLLER_STORAGE_METRIC_DEFINITIONS = [
  {
    key: "filesystemFreeBytes",
    sensorId: "controller-storage-filesystem-free-bytes",
    sensorName: "Controller filesystem free bytes",
    pin: 0,
    alertRuleId: "controller-storage-low-filesystem-free-bytes",
    alertRuleName: "Controller filesystem free space is low",
    condition: "below",
    severity: "critical",
  },
  {
    key: "projectedUpperBoundStorageBytesAfterOneYear",
    sensorId: "controller-storage-projected-one-year-bytes",
    sensorName: "Controller projected one-year storage bytes",
    pin: 1,
    alertRuleId: "controller-storage-high-projected-one-year-bytes",
    alertRuleName: "Controller one-year storage projection is high",
    condition: "above",
    severity: "error",
  },
  {
    key: "failedRetentionRunCount",
    sensorId: "controller-storage-failed-retention-runs",
    sensorName: "Controller unresolved failed retention runs",
    pin: 2,
    alertRuleId: "controller-storage-failed-retention-runs",
    alertRuleName: "Controller retention has an unresolved failure",
    condition: "above",
    severity: "error",
  },
  {
    key: "failedArchiveCount",
    sensorId: "controller-storage-failed-archives",
    sensorName: "Controller unresolved failed archives",
    pin: 3,
    alertRuleId: "controller-storage-failed-archives",
    alertRuleName: "Controller event archiving has an unresolved failure",
    condition: "above",
    severity: "error",
  },
  {
    key: "latestBackupOutcomeFailed",
    sensorId: "controller-storage-latest-backup-failed",
    sensorName: "Controller latest backup outcome failed",
    pin: 4,
    alertRuleId: "controller-storage-latest-backup-failed",
    alertRuleName: "Controller backup has an unresolved failure",
    condition: "above",
    severity: "error",
  },
  {
    key: "successfulBackupMissingOrStale",
    sensorId: "controller-storage-successful-backup-missing-or-stale",
    sensorName: "Controller successful backup is missing or stale",
    pin: 5,
    alertRuleId: "controller-storage-successful-backup-missing-or-stale",
    alertRuleName: "Controller has no fresh successful backup",
    condition: "above",
    severity: "critical",
  },
] as const satisfies readonly ControllerStorageMetricDefinition[];

export interface ControllerStorageMetricReaderPort {
  read(input: {
    readonly observedAtMs: number;
  }): Promise<ControllerStorageMetrics>;
}

export interface ControllerStorageHealthStorePort {
  seedAndRecord(input: {
    readonly observedAtMs: number;
    readonly thresholds: ControllerStorageHealthThresholds;
    readonly metrics: ControllerStorageMetrics;
  }): Promise<void>;
}

export interface ControllerStorageAlertEvaluatorPort {
  evaluate(input: {
    readonly observation: SensorAlertObservation;
    readonly observedAtMs: number;
    readonly actor: string;
  }): Promise<AlertEvaluationResult>;
}

export interface ControllerStorageHealthEvaluation {
  readonly observedAtMs: number;
  readonly metrics: ControllerStorageMetrics;
  readonly alertEvaluations: readonly AlertEvaluationResult[];
}

/**
 * Measures and evaluates controller storage health on an explicit timestamp.
 * This service is intentionally non-reentrant: alert state transitions are
 * outputs of a check and never schedule another check. Startup and maintenance
 * schedulers are the only supported callers.
 */
export class ControllerStorageHealthService {
  readonly #thresholds: ControllerStorageHealthThresholds;
  #evaluationInProgress = false;

  constructor(
    private readonly metrics: ControllerStorageMetricReaderPort,
    private readonly store: ControllerStorageHealthStorePort,
    private readonly alerts: ControllerStorageAlertEvaluatorPort,
    thresholds: ControllerStorageHealthThresholds,
  ) {
    assertPositiveSafeInteger(
      thresholds.minimumFilesystemFreeBytes,
      "Minimum filesystem free bytes",
    );
    assertPositiveSafeInteger(
      thresholds.maximumProjectedStorageBytesAfterOneYear,
      "Maximum projected storage bytes after one year",
    );
    this.#thresholds = { ...thresholds };
  }

  async evaluate(input: {
    readonly observedAtMs: number;
  }): Promise<ControllerStorageHealthEvaluation> {
    assertTimestamp(input.observedAtMs);
    if (this.#evaluationInProgress) {
      throw new Error(
        "Controller storage-health evaluation is already in progress",
      );
    }
    this.#evaluationInProgress = true;
    try {
      const metrics = await this.metrics.read({
        observedAtMs: input.observedAtMs,
      });
      assertMetrics(metrics);
      await this.store.seedAndRecord({
        observedAtMs: input.observedAtMs,
        thresholds: this.#thresholds,
        metrics,
      });

      const alertEvaluations: AlertEvaluationResult[] = [];
      for (const definition of CONTROLLER_STORAGE_METRIC_DEFINITIONS) {
        alertEvaluations.push(
          await this.alerts.evaluate({
            observation: {
              sourceType: "sensor",
              sourceId: definition.sensorId,
              value: metrics[definition.key],
            },
            observedAtMs: input.observedAtMs,
            actor: CONTROLLER_STORAGE_HEALTH_ACTOR,
          }),
        );
      }
      return {
        observedAtMs: input.observedAtMs,
        metrics,
        alertEvaluations,
      };
    } finally {
      this.#evaluationInProgress = false;
    }
  }
}

function assertMetrics(metrics: ControllerStorageMetrics): void {
  for (const definition of CONTROLLER_STORAGE_METRIC_DEFINITIONS) {
    assertNonNegativeSafeInteger(
      metrics[definition.key],
      `Storage metric ${definition.key}`,
    );
  }
  if (
    metrics.latestBackupOutcomeFailed !== 0 &&
    metrics.latestBackupOutcomeFailed !== 1
  ) {
    throw new RangeError(
      "Storage metric latestBackupOutcomeFailed must be either 0 or 1",
    );
  }
  if (
    metrics.successfulBackupMissingOrStale !== 0 &&
    metrics.successfulBackupMissingOrStale !== 1
  ) {
    throw new RangeError(
      "Storage metric successfulBackupMissingOrStale must be either 0 or 1",
    );
  }
}

function assertTimestamp(value: number): void {
  assertNonNegativeSafeInteger(value, "Storage-health observation time");
  if (!Number.isFinite(new Date(value).getTime())) {
    throw new RangeError(
      "Storage-health observation time is not a representable timestamp",
    );
  }
}

function assertPositiveSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${label} must be a positive safe integer`);
  }
}

function assertNonNegativeSafeInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${label} must be a non-negative safe integer`);
  }
}
