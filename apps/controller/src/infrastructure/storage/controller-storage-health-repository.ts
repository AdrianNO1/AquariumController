import type { Kysely, Selectable, Transaction } from "kysely";

import {
  CONTROLLER_STORAGE_HEALTH_DEVICE_ID,
  CONTROLLER_STORAGE_HEALTH_ACTOR,
  CONTROLLER_STORAGE_METRIC_DEFINITIONS,
  type ControllerStorageHealthStorePort,
  type ControllerStorageHealthThresholds,
  type ControllerStorageMetricDefinition,
  type ControllerStorageMetricKey,
  type ControllerStorageMetricReaderPort,
  type ControllerStorageMetrics,
} from "../../application/maintenance/controller-storage-health-service.js";
import type { VerifiedControllerBackupReaderPort } from "../../application/maintenance/daily-controller-backup-coordinator.js";
import type {
  AlertRulesTable,
  DevicesTable,
  EventsDatabaseSchema,
  SensorsTable,
  StateDatabaseSchema,
} from "../database/types.js";
import { commitConditionalStateChange } from "../database/state-outbox.js";
import { readEventStorageUsage } from "./event-storage-usage.js";
import type { FilesystemFreeSpacePort } from "./node-filesystem-free-space.js";

const VIRTUAL_DEVICE_METADATA = JSON.stringify({
  kind: "virtual-controller-storage-health",
});

const BUILT_IN_RULE_CONFIGURATION = JSON.stringify({
  builtIn: true,
  owner: "controller-storage-health",
});

interface StorageDefinitionChanges {
  readonly deviceChanged: boolean;
  readonly sensorIds: readonly string[];
  readonly alertRuleIds: readonly string[];
}

export interface EventStorageHealthMetricReaderOptions {
  readonly storagePaths: readonly string[];
  readonly projectionWindowMs?: number;
  readonly backupFreshnessThresholdMs: number;
  readonly verifiedBackups: VerifiedControllerBackupReaderPort;
}

export class EventStorageHealthMetricReader implements ControllerStorageMetricReaderPort {
  readonly #storagePaths: readonly string[];
  readonly #projectionWindowMs: number | undefined;
  readonly #backupFreshnessThresholdMs: number;
  readonly #verifiedBackups: VerifiedControllerBackupReaderPort;

  constructor(
    private readonly database: Kysely<EventsDatabaseSchema>,
    private readonly filesystem: FilesystemFreeSpacePort,
    options: EventStorageHealthMetricReaderOptions,
  ) {
    if (options.storagePaths.length === 0) {
      throw new TypeError(
        "Storage health requires at least one filesystem path",
      );
    }
    const storagePaths = [...new Set(options.storagePaths)];
    if (storagePaths.some((path) => path.trim().length === 0)) {
      throw new TypeError("Storage-health filesystem paths must not be empty");
    }
    if (
      options.projectionWindowMs !== undefined &&
      (!Number.isSafeInteger(options.projectionWindowMs) ||
        options.projectionWindowMs <= 0)
    ) {
      throw new RangeError(
        "Storage-health projection window must be a positive safe integer",
      );
    }
    if (
      !Number.isSafeInteger(options.backupFreshnessThresholdMs) ||
      options.backupFreshnessThresholdMs <= 0
    ) {
      throw new RangeError(
        "Backup freshness threshold must be a positive safe integer",
      );
    }
    this.#storagePaths = storagePaths;
    this.#projectionWindowMs = options.projectionWindowMs;
    this.#backupFreshnessThresholdMs = options.backupFreshnessThresholdMs;
    this.#verifiedBackups = options.verifiedBackups;
  }

  async read(input: {
    readonly observedAtMs: number;
  }): Promise<ControllerStorageMetrics> {
    const usageOptions =
      this.#projectionWindowMs === undefined
        ? { nowMs: input.observedAtMs }
        : {
            nowMs: input.observedAtMs,
            projectionWindowMs: this.#projectionWindowMs,
          };
    const usageOptionsWithBackupFreshness = {
      ...usageOptions,
      backupFreshnessThresholdMs: this.#backupFreshnessThresholdMs,
    };
    const [filesystemFreeBytesByPath, latestVerifiedBackupAtMs] =
      await Promise.all([
        Promise.all(
          this.#storagePaths.map((path) =>
            this.filesystem.readAvailableBytes(path),
          ),
        ),
        this.#verifiedBackups.readLatestVerifiedBackupAtMs(),
      ]);
    const usage = await readEventStorageUsage(this.database, {
      ...usageOptionsWithBackupFreshness,
      latestVerifiedBackupAtMs,
    });
    return {
      filesystemFreeBytes: Math.min(...filesystemFreeBytesByPath),
      projectedUpperBoundStorageBytesAfterOneYear:
        usage.projectedUpperBoundStorageBytesAfterOneYear,
      failedRetentionRunCount: usage.failedRetentionRunCount,
      failedArchiveCount: usage.failedArchiveCount,
      latestBackupOutcomeFailed: usage.latestBackupOutcomeFailed,
      successfulBackupMissingOrStale: usage.successfulBackupMissingOrStale,
    };
  }
}

export class ControllerStorageHealthRepository implements ControllerStorageHealthStorePort {
  constructor(private readonly database: Kysely<StateDatabaseSchema>) {}

  async seedAndRecord(input: {
    readonly observedAtMs: number;
    readonly thresholds: ControllerStorageHealthThresholds;
    readonly metrics: ControllerStorageMetrics;
  }): Promise<void> {
    await this.seedDefinitions(input);
    await this.recordMetrics(input);
  }

  private async seedDefinitions(input: {
    readonly observedAtMs: number;
    readonly thresholds: ControllerStorageHealthThresholds;
  }): Promise<void> {
    await commitConditionalStateChange<{
      readonly changed: boolean;
      readonly result: StorageDefinitionChanges;
    }>(
      this.database,
      (changes) => ({
        actor: CONTROLLER_STORAGE_HEALTH_ACTOR,
        mutationType: "controller.storage-health-definitions",
        summary: "Reconciled built-in controller storage-health definitions",
        eventType: "controller.storage-health-definitions-changed",
        entityType: "controller",
        occurredAtMs: input.observedAtMs,
        retentionClass: "audit",
        payloadJson: JSON.stringify({
          schemaVersion: 1,
          deviceChanged: changes.deviceChanged,
          sensorIds: changes.sensorIds,
          alertRuleIds: changes.alertRuleIds,
        }),
        payloadSchemaVersion: 1,
        invalidations: [
          { resource: "controller", id: null },
          ...(changes.deviceChanged
            ? [
                {
                  resource: "device" as const,
                  id: CONTROLLER_STORAGE_HEALTH_DEVICE_ID,
                },
              ]
            : []),
          ...changes.alertRuleIds.map((id) => ({
            resource: "alert_rule" as const,
            id,
          })),
        ],
      }),
      async (transaction) => {
        const [device, sensors, rules] = await Promise.all([
          transaction
            .selectFrom("devices")
            .selectAll()
            .where("id", "=", CONTROLLER_STORAGE_HEALTH_DEVICE_ID)
            .executeTakeFirst(),
          transaction
            .selectFrom("sensors")
            .selectAll()
            .where(
              "id",
              "in",
              CONTROLLER_STORAGE_METRIC_DEFINITIONS.map(
                (definition) => definition.sensorId,
              ),
            )
            .execute(),
          transaction
            .selectFrom("alert_rules")
            .selectAll()
            .where(
              "id",
              "in",
              CONTROLLER_STORAGE_METRIC_DEFINITIONS.map(
                (definition) => definition.alertRuleId,
              ),
            )
            .execute(),
        ]);
        const sensorsById = new Map(sensors.map((row) => [row.id, row]));
        const rulesById = new Map(rules.map((row) => [row.id, row]));
        const deviceChanged =
          device === undefined || !virtualDeviceDefinitionMatches(device);
        const changedSensorDefinitions =
          CONTROLLER_STORAGE_METRIC_DEFINITIONS.filter((definition) => {
            const row = sensorsById.get(definition.sensorId);
            return (
              row === undefined || !sensorDefinitionMatches(row, definition)
            );
          });
        const changedRuleDefinitions =
          CONTROLLER_STORAGE_METRIC_DEFINITIONS.filter((definition) => {
            const row = rulesById.get(definition.alertRuleId);
            return (
              row === undefined ||
              !ruleDefinitionMatches(
                row,
                definition,
                thresholdFor(definition.key, input.thresholds),
              )
            );
          });
        const changes: StorageDefinitionChanges = {
          deviceChanged,
          sensorIds: changedSensorDefinitions.map(
            (definition) => definition.sensorId,
          ),
          alertRuleIds: changedRuleDefinitions.map(
            (definition) => definition.alertRuleId,
          ),
        };
        if (
          !deviceChanged &&
          changes.sensorIds.length === 0 &&
          changes.alertRuleIds.length === 0
        ) {
          return { changed: false as const, result: changes };
        }

        if (deviceChanged) {
          await this.upsertVirtualDevice(transaction, input.observedAtMs);
        }
        for (const definition of changedSensorDefinitions) {
          await this.upsertSensorDefinition(
            transaction,
            definition,
            input.observedAtMs,
          );
        }
        for (const definition of changedRuleDefinitions) {
          await this.upsertRule(
            transaction,
            definition,
            thresholdFor(definition.key, input.thresholds),
            input.observedAtMs,
          );
        }
        return { changed: true as const, result: changes };
      },
    );
  }

  private async recordMetrics(input: {
    readonly observedAtMs: number;
    readonly metrics: ControllerStorageMetrics;
  }): Promise<void> {
    await this.database.transaction().execute(async (transaction) => {
      for (const definition of CONTROLLER_STORAGE_METRIC_DEFINITIONS) {
        const updated = await transaction
          .updateTable("sensors")
          .set({
            latest_value: input.metrics[definition.key],
            latest_observed_at_ms: input.observedAtMs,
            updated_at_ms: input.observedAtMs,
          })
          .where("id", "=", definition.sensorId)
          .where("device_id", "=", CONTROLLER_STORAGE_HEALTH_DEVICE_ID)
          .executeTakeFirst();
        if (updated.numUpdatedRows !== 1n) {
          throw new Error(
            `Controller storage-health sensor ${definition.sensorId} is missing after definition reconciliation`,
          );
        }
      }
    });
  }

  private async upsertVirtualDevice(
    transaction: Transaction<StateDatabaseSchema>,
    observedAtMs: number,
  ): Promise<void> {
    await transaction
      .insertInto("devices")
      .values({
        id: CONTROLLER_STORAGE_HEALTH_DEVICE_ID,
        hardware_id: CONTROLLER_STORAGE_HEALTH_DEVICE_ID,
        name: "Controller storage health",
        mapping_profile_id: null,
        reported_name: null,
        desired_pwm_frequency_hz: 1_000,
        desired_pwm_resolution_bits: 8,
        status: "unknown",
        enabled: 0,
        created_at_ms: observedAtMs,
        updated_at_ms: observedAtMs,
        metadata_json: VIRTUAL_DEVICE_METADATA,
        metadata_schema_version: 1,
      })
      .onConflict((conflict) =>
        conflict.column("id").doUpdateSet({
          hardware_id: CONTROLLER_STORAGE_HEALTH_DEVICE_ID,
          name: "Controller storage health",
          mapping_profile_id: null,
          reported_name: null,
          desired_pwm_frequency_hz: 1_000,
          desired_pwm_resolution_bits: 8,
          reported_pwm_frequency_hz: null,
          reported_pwm_resolution_bits: null,
          firmware_version: null,
          reported_schedule_hash: null,
          status: "unknown",
          last_seen_at_ms: null,
          last_error_code: null,
          last_error_message: null,
          enabled: 0,
          updated_at_ms: observedAtMs,
          metadata_json: VIRTUAL_DEVICE_METADATA,
          metadata_schema_version: 1,
        }),
      )
      .executeTakeFirstOrThrow();
  }

  private async upsertSensorDefinition(
    transaction: Transaction<StateDatabaseSchema>,
    definition: ControllerStorageMetricDefinition,
    observedAtMs: number,
  ): Promise<void> {
    const metadataJson = JSON.stringify({ metric: definition.key });
    await transaction
      .insertInto("sensors")
      .values({
        id: definition.sensorId,
        device_id: CONTROLLER_STORAGE_HEALTH_DEVICE_ID,
        name: definition.sensorName,
        pin: definition.pin,
        read_type: "controller-storage-metric",
        enabled: 1,
        latest_value: null,
        latest_observed_at_ms: null,
        created_at_ms: observedAtMs,
        updated_at_ms: observedAtMs,
        metadata_json: metadataJson,
        metadata_schema_version: 1,
      })
      .onConflict((conflict) =>
        conflict.column("id").doUpdateSet({
          device_id: CONTROLLER_STORAGE_HEALTH_DEVICE_ID,
          name: definition.sensorName,
          pin: definition.pin,
          read_type: "controller-storage-metric",
          enabled: 1,
          updated_at_ms: observedAtMs,
          metadata_json: metadataJson,
          metadata_schema_version: 1,
        }),
      )
      .executeTakeFirstOrThrow();
  }

  private async upsertRule(
    transaction: Transaction<StateDatabaseSchema>,
    definition: ControllerStorageMetricDefinition,
    threshold: number,
    observedAtMs: number,
  ): Promise<void> {
    await transaction
      .insertInto("alert_rules")
      .values({
        id: definition.alertRuleId,
        name: definition.alertRuleName,
        source_type: "sensor",
        device_id: null,
        output_id: null,
        sensor_id: definition.sensorId,
        switch_id: null,
        condition: definition.condition,
        threshold,
        delay_ms: 0,
        severity: definition.severity,
        enabled: 1,
        created_at_ms: observedAtMs,
        updated_at_ms: observedAtMs,
        configuration_json: BUILT_IN_RULE_CONFIGURATION,
        configuration_schema_version: 1,
      })
      .onConflict((conflict) =>
        conflict.column("id").doUpdateSet({
          name: definition.alertRuleName,
          source_type: "sensor",
          device_id: null,
          output_id: null,
          sensor_id: definition.sensorId,
          switch_id: null,
          condition: definition.condition,
          threshold,
          delay_ms: 0,
          severity: definition.severity,
          enabled: 1,
          updated_at_ms: observedAtMs,
          configuration_json: BUILT_IN_RULE_CONFIGURATION,
          configuration_schema_version: 1,
        }),
      )
      .executeTakeFirstOrThrow();
  }
}

function virtualDeviceDefinitionMatches(
  row: Selectable<DevicesTable>,
): boolean {
  return (
    row.hardware_id === CONTROLLER_STORAGE_HEALTH_DEVICE_ID &&
    row.name === "Controller storage health" &&
    row.mapping_profile_id === null &&
    row.reported_name === null &&
    row.desired_pwm_frequency_hz === 1_000 &&
    row.desired_pwm_resolution_bits === 8 &&
    row.reported_pwm_frequency_hz === null &&
    row.reported_pwm_resolution_bits === null &&
    row.firmware_version === null &&
    row.reported_schedule_hash === null &&
    row.status === "unknown" &&
    row.last_seen_at_ms === null &&
    row.last_error_code === null &&
    row.last_error_message === null &&
    row.enabled === 0 &&
    row.metadata_json === VIRTUAL_DEVICE_METADATA &&
    row.metadata_schema_version === 1
  );
}

function sensorDefinitionMatches(
  row: Selectable<SensorsTable>,
  definition: ControllerStorageMetricDefinition,
): boolean {
  return (
    row.device_id === CONTROLLER_STORAGE_HEALTH_DEVICE_ID &&
    row.name === definition.sensorName &&
    row.pin === definition.pin &&
    row.read_type === "controller-storage-metric" &&
    row.enabled === 1 &&
    row.metadata_json === JSON.stringify({ metric: definition.key }) &&
    row.metadata_schema_version === 1
  );
}

function ruleDefinitionMatches(
  row: Selectable<AlertRulesTable>,
  definition: ControllerStorageMetricDefinition,
  threshold: number,
): boolean {
  return (
    row.name === definition.alertRuleName &&
    row.source_type === "sensor" &&
    row.device_id === null &&
    row.output_id === null &&
    row.sensor_id === definition.sensorId &&
    row.switch_id === null &&
    row.condition === definition.condition &&
    row.threshold === threshold &&
    row.delay_ms === 0 &&
    row.severity === definition.severity &&
    row.enabled === 1 &&
    row.configuration_json === BUILT_IN_RULE_CONFIGURATION &&
    row.configuration_schema_version === 1
  );
}

function thresholdFor(
  key: ControllerStorageMetricKey,
  thresholds: ControllerStorageHealthThresholds,
): number {
  switch (key) {
    case "filesystemFreeBytes":
      return thresholds.minimumFilesystemFreeBytes;
    case "projectedUpperBoundStorageBytesAfterOneYear":
      return thresholds.maximumProjectedStorageBytesAfterOneYear;
    case "failedRetentionRunCount":
    case "failedArchiveCount":
    case "latestBackupOutcomeFailed":
    case "successfulBackupMissingOrStale":
      return 0;
  }
}
