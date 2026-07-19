import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";

import type { CommittedStateEvent } from "@aquarium/contracts";
import { sql } from "kysely";

import { buildApp } from "./app.js";
import {
  AlertAcknowledgementService,
  AlertNotificationDispatcher,
  AlertNotificationRuntime,
  AlertService,
  DeviceAlertEvaluator,
  RandomAlertIdGenerator,
  SystemAlertClock,
  type AlertNotificationBinding,
} from "./application/alerts/index.js";
import { LogsService } from "./application/logs/index.js";
import {
  ControllerStorageHealthService,
  DailyControllerBackupCoordinator,
  DailyEventRetentionCoordinator,
  PeriodicStorageHealthCoordinator,
} from "./application/maintenance/index.js";
import {
  AlertNotificationInteractionLogger,
  composeControllerRuntime,
  ControllerInteractionLogger,
} from "./application/runtime/index.js";
import type { ScheduleReconciliationTrigger } from "./application/schedule-artifacts/index.js";
import { SystemSchedulingTime } from "./application/scheduling/index.js";
import { parseControllerConfiguration } from "./configuration.js";
import {
  AlertHistoryRepository,
  closeControllerDatabases,
  ControlOperationRetentionRepository,
  ControllerConfigurationRepository,
  ControllerSnapshotRepository,
  mirrorPendingStateEvents,
  NotificationDeliveryRetentionRepository,
  openControllerDatabases,
  prunePublishedStateOutbox,
  SchedulerGuardRepository,
  StateRevisionRetentionRepository,
  toCommittedStateEvent,
} from "./infrastructure/database/index.js";
import {
  ControllerStorageHealthRepository,
  ControllerBackupMaintenance,
  EventRetentionRunRecovery,
  EventStorageHealthMetricReader,
  InteractionRepository,
  LogQueryRepository,
  NodeFilesystemFreeSpace,
  RunEventRetentionJob,
  seedDefaultRetentionPolicies,
} from "./infrastructure/storage/index.js";
import { WebhookAlertNotifier } from "./infrastructure/notifications/index.js";
import { StateEventStreamHub } from "./realtime/state-event-stream.js";
import { runSignalShutdown } from "./signal-shutdown.js";

const configuration = parseControllerConfiguration(process.env);

await Promise.all([
  mkdir(dirname(configuration.storage.stateDatabaseFile), { recursive: true }),
  mkdir(dirname(configuration.storage.eventsDatabaseFile), { recursive: true }),
  mkdir(configuration.storage.archiveDirectory, { recursive: true }),
  mkdir(configuration.storage.backupDirectory, { recursive: true }),
]);
const databases = await openControllerDatabases({
  state: { filename: configuration.storage.stateDatabaseFile },
  events: { filename: configuration.storage.eventsDatabaseFile },
});
await seedDefaultRetentionPolicies(databases.events, Date.now());
const snapshotReader = new ControllerSnapshotRepository(databases.state);
const configurationService = new ControllerConfigurationRepository(
  databases.state,
);
const alertClock = new SystemAlertClock();
const alertNotificationBindings: readonly AlertNotificationBinding[] =
  configuration.alerting.webhook === null
    ? []
    : [
        {
          kind: "webhook",
          key: configuration.alerting.webhook.destinationKey,
          notifier: new WebhookAlertNotifier({
            url: configuration.alerting.webhook.url,
            runtime: configuration.runtimeMode,
            timeoutMs: configuration.alerting.webhook.timeoutMs,
            ...(configuration.alerting.webhook.authHeader === undefined
              ? {}
              : { authHeader: configuration.alerting.webhook.authHeader }),
          }),
        },
      ];
const alertService = new AlertService(
  databases.state,
  alertClock,
  new RandomAlertIdGenerator(),
  {
    notificationDestinations: alertNotificationBindings.map(
      ({ kind, key }) => ({ kind, key }),
    ),
  },
);
const alertAcknowledgementCommands = new AlertAcknowledgementService(
  alertService,
);
const logsService = new LogsService(new LogQueryRepository(databases.events));
const alertHistoryReader = new AlertHistoryRepository(databases.state);
const runtimeErrorTarget: {
  app: ReturnType<typeof buildApp> | null;
} = { app: null };
const controllerInteractionLogger = new ControllerInteractionLogger(
  new InteractionRepository(databases.events),
  {
    onPersistenceError: (error) => {
      if (runtimeErrorTarget.app === null) {
        throw new Error(
          "Controller interaction persistence failed before app startup",
          { cause: error },
        );
      }
      runtimeErrorTarget.app.log.error(
        error,
        "Unable to persist controller interaction",
      );
    },
  },
);
const reportRuntimeError = (error: Error): void => {
  if (runtimeErrorTarget.app === null) {
    throw new Error("Controller runtime reported an error before app startup", {
      cause: error,
    });
  }
  runtimeErrorTarget.app.log.error(error, "Controller runtime callback failed");
  controllerInteractionLogger.recordRuntimeCallbackFailure(error);
};
const eventStreamHub = new StateEventStreamHub(databases.state, {
  maxReplayEvents: configuration.realtime.maxReplayEvents,
  onConnectionError: reportRuntimeError,
});
const schedulingTime = new SystemSchedulingTime();
const backupMaintenance = new ControllerBackupMaintenance(
  databases.events,
  new InteractionRepository(databases.events),
  {
    stateDatabaseFile: configuration.storage.stateDatabaseFile,
    eventsDatabaseFile: configuration.storage.eventsDatabaseFile,
    destinationDirectory: configuration.storage.backupDirectory,
  },
);
const storageHealthCoordinator = new PeriodicStorageHealthCoordinator(
  new ControllerStorageHealthService(
    new EventStorageHealthMetricReader(
      databases.events,
      new NodeFilesystemFreeSpace(),
      {
        storagePaths: [
          dirname(configuration.storage.stateDatabaseFile),
          dirname(configuration.storage.eventsDatabaseFile),
          configuration.storage.archiveDirectory,
          configuration.storage.backupDirectory,
        ],
        backupFreshnessThresholdMs:
          configuration.storage.backupFreshnessThresholdMs,
        verifiedBackups: backupMaintenance,
      },
    ),
    new ControllerStorageHealthRepository(databases.state),
    {
      evaluate: ({ observation, observedAtMs, actor }) =>
        alertService.evaluateAt(observation, observedAtMs, actor),
    },
    {
      minimumFilesystemFreeBytes:
        configuration.storage.minimumFilesystemFreeBytes,
      maximumProjectedStorageBytesAfterOneYear:
        configuration.storage.maximumProjectedStorageBytesAfterOneYear,
    },
  ),
  {
    clock: schedulingTime,
    timer: schedulingTime,
    intervalMs: configuration.storage.healthCheckIntervalMs,
    onError: reportRuntimeError,
  },
);
const backupCoordinator = new DailyControllerBackupCoordinator(
  backupMaintenance,
  {
    clock: schedulingTime,
    timer: schedulingTime,
    freshnessThresholdMs: configuration.storage.backupFreshnessThresholdMs,
    onError: reportRuntimeError,
  },
);
const alertNotificationRuntime = new AlertNotificationRuntime(
  new AlertNotificationDispatcher(
    databases.state,
    alertClock,
    alertNotificationBindings,
    new AlertNotificationInteractionLogger(
      new InteractionRepository(databases.events),
    ),
  ),
  {
    timer: schedulingTime,
    onError: reportRuntimeError,
  },
);
const runtimeComposition = composeControllerRuntime({
  configuration,
  stateDatabase: databases.state,
  eventsDatabase: databases.events,
  schedulingTime,
  deviceAlertEvaluator: new DeviceAlertEvaluator(databases.state, alertService),
  onError: reportRuntimeError,
});
const retentionCoordinator = new DailyEventRetentionCoordinator(
  new SchedulerGuardRepository(databases.state),
  new RunEventRetentionJob({
    database: databases.events,
    archiveDirectory: configuration.storage.archiveDirectory,
    routineControlOperationRetention: new ControlOperationRetentionRepository(
      databases.state,
    ),
    notificationDeliveryRetention: new NotificationDeliveryRetentionRepository(
      databases.state,
    ),
    stateRevisionRetention: new StateRevisionRetentionRepository(
      databases.state,
    ),
  }),
  new EventRetentionRunRecovery(databases.events),
  {
    clock: schedulingTime,
    timer: schedulingTime,
    staleRunAfterMs: configuration.storage.retentionStaleRunAfterMs,
    onError: reportRuntimeError,
  },
);
let mirrorHealthy = false;
const app = buildApp({
  logger: true,
  eventStreamHub,
  snapshotReader,
  configurationService,
  alertAcknowledgementCommands,
  alertHistoryReader,
  logsService,
  httpInteractionRecorder: controllerInteractionLogger,
  readinessProbe: async () => {
    await Promise.all([
      sql`select 1`.execute(databases.state),
      sql`select 1`.execute(databases.events),
    ]);
    if (!runtimeComposition.runtime.isReady()) {
      throw new Error("Controller runtime is not ready");
    }
    if (!mirrorHealthy) {
      throw new Error("State-event mirror is not ready");
    }
    if (
      !retentionCoordinator.isReady() ||
      !backupCoordinator.isReady() ||
      !storageHealthCoordinator.isReady() ||
      !alertNotificationRuntime.isReady()
    ) {
      throw new Error("Controller background maintenance is not ready");
    }
  },
  ...(configuration.server.webRoot === null
    ? {}
    : { webRoot: configuration.server.webRoot }),
  ...(runtimeComposition.mqttEnabled
    ? {
        deviceConfigurationCommands: runtimeComposition.deviceOperations,
        manualOverrideCommands: runtimeComposition.manualOverrideCommands,
      }
    : {}),
});
runtimeErrorTarget.app = app;

let mirrorPromise: Promise<void> | undefined;
const runMirrorOutbox = async (): Promise<void> => {
  try {
    const result = await mirrorPendingStateEvents(
      databases.state,
      databases.events,
      { nowMs: Date.now() },
    );
    if (result.mirroredRevisions.length > 0) {
      const committedEvents = await databases.state
        .selectFrom("state_outbox")
        .selectAll()
        .where("revision", "in", result.mirroredRevisions)
        .orderBy("revision", "asc")
        .execute();
      for (const event of committedEvents) {
        eventStreamHub.publishCommitted(event);
        if (runtimeComposition.mqttEnabled) {
          const committedEvent = toCommittedStateEvent(event);
          for (const trigger of scheduleTriggersFor(committedEvent)) {
            runtimeComposition.scheduleReconciliation.requestScheduleReconciliation(
              trigger,
            );
          }
        }
      }
      app.log.debug(
        { revisions: result.mirroredRevisions },
        "Mirrored state events into events database",
      );
    }
    const pruned = await prunePublishedStateOutbox(databases.state);
    if (pruned.deletedCount > 0) {
      app.log.debug(
        {
          deletedCount: pruned.deletedCount,
          deletedFromRevision: pruned.deletedFromRevision,
          deletedThroughRevision: pruned.deletedThroughRevision,
          earliestAvailableRevision: pruned.earliestAvailableRevision,
        },
        "Pruned the published state-event replay prefix",
      );
    }
    mirrorHealthy = true;
  } catch (error) {
    mirrorHealthy = false;
    app.log.error(error, "Unable to mirror the state event outbox");
  }
};
const mirrorOutbox = (): Promise<void> => {
  if (mirrorPromise !== undefined) {
    return mirrorPromise;
  }
  const pending = runMirrorOutbox();
  mirrorPromise = pending;
  const clearPending = (): void => {
    if (mirrorPromise === pending) {
      mirrorPromise = undefined;
    }
  };
  void pending.then(clearPending, clearPending);
  return pending;
};
await mirrorOutbox();
let mirrorInterval: NodeJS.Timeout | undefined;

const teardownOnce = async (): Promise<void> => {
  try {
    await app.close();
  } finally {
    try {
      await runtimeComposition.runtime.stop();
    } finally {
      try {
        await alertNotificationRuntime.stop();
      } finally {
        try {
          await storageHealthCoordinator.stop();
        } finally {
          try {
            await backupCoordinator.stop();
          } finally {
            try {
              await retentionCoordinator.stop();
            } finally {
              await mirrorOutbox();
              try {
                await controllerInteractionLogger.drain();
              } finally {
                await closeControllerDatabases(databases);
              }
            }
          }
        }
      }
    }
  }
};

let teardownPromise: Promise<void> | undefined;
const teardown = (): Promise<void> => {
  teardownPromise ??= teardownOnce();
  return teardownPromise;
};

let shutdownPromise: Promise<void> | undefined;
let startupPromise: Promise<void> | undefined;
let shutdownRequested = false;
const shutdown = async (signal: NodeJS.Signals): Promise<void> => {
  shutdownPromise ??= (async () => {
    app.log.info({ signal }, "Stopping aquarium controller");
    if (mirrorInterval !== undefined) {
      clearInterval(mirrorInterval);
    }
    try {
      await startupPromise;
    } catch {
      // Startup failure is logged by the startup owner; teardown is shared.
    }
    await teardown();
  })();
  await shutdownPromise;
};

const requestSignalShutdown = (signal: NodeJS.Signals): void => {
  shutdownRequested = true;
  void runSignalShutdown({
    signal,
    shutdown,
    reportFailure: (error, failedSignal) => {
      app.log.error(
        { err: error, signal: failedSignal },
        "Unable to stop aquarium controller cleanly",
      );
    },
  });
};

process.once("SIGINT", () => requestSignalShutdown("SIGINT"));
process.once("SIGTERM", () => requestSignalShutdown("SIGTERM"));

const startController = async (): Promise<void> => {
  await retentionCoordinator.start();
  if (shutdownRequested) return;
  await backupCoordinator.start();
  if (shutdownRequested) return;
  await storageHealthCoordinator.start();
  if (shutdownRequested) return;
  await alertNotificationRuntime.start();
  if (shutdownRequested) return;
  await runtimeComposition.runtime.start();
  if (shutdownRequested) return;
  mirrorInterval = setInterval(() => void mirrorOutbox(), 1_000);
  mirrorInterval.unref();
  await app.listen({
    host: configuration.server.host,
    port: configuration.server.port,
  });
};

try {
  startupPromise = startController();
  await startupPromise;
} catch (error) {
  process.exitCode = 1;
  app.log.error(error, "Unable to start aquarium controller");
  if (mirrorInterval !== undefined) {
    clearInterval(mirrorInterval);
  }
  try {
    await teardown();
  } catch (teardownError) {
    app.log.error(
      teardownError,
      "Unable to clean up failed controller startup",
    );
  }
}

function scheduleTriggersFor(
  event: CommittedStateEvent,
): readonly ScheduleReconciliationTrigger[] {
  return event.data.invalidations.flatMap<ScheduleReconciliationTrigger>(
    (invalidation) => {
      switch (invalidation.resource) {
        case "channel":
          return [{ kind: "channel", channelId: invalidation.id }];
        case "schedule":
          return [{ kind: "schedule", scheduleId: invalidation.id }];
        case "throttle":
          return [{ kind: "throttle", throttleId: invalidation.id }];
        case "mapping_profile":
          return [
            {
              kind: "mapping_profile",
              mappingProfileId: invalidation.id,
            },
          ];
        case "device":
          return [{ kind: "device_configuration", deviceId: invalidation.id }];
        case "controller":
        case "operation":
        case "override":
        case "alert_rule":
        case "alert":
        case "output":
        case "import_run":
          return [];
      }
    },
  );
}
