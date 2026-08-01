import {
  createEspTopicSet,
  ESP_FIRMWARE_ARTIFACT,
} from "@aquarium/esp-protocol";
import type { Kysely } from "kysely";

import type {
  ControllerConfiguration,
  EnabledMqttConfiguration,
} from "../../configuration.js";
import {
  ControlOperationRepository,
  DeviceScheduleArtifactRepository,
  ManualOverrideRepository,
  OnlineDeviceRepository,
  RefreshProjectionRepository,
  SchedulerGuardRepository,
  type EventsDatabaseSchema,
  type StateDatabaseSchema,
} from "../../infrastructure/database/index.js";
import {
  createMqttJsClientFactory,
  LegacyMqttTransport,
  type LegacyMqttClientFactory,
} from "../../infrastructure/mqtt/index.js";
import {
  createSensitiveKeyRedactor,
  InteractionRepository,
} from "../../infrastructure/storage/interaction-repository.js";
import type { DeviceAlertEvaluatorPort } from "../alerts/index.js";
import { DeviceRegistry } from "../devices/index.js";
import { FirmwareUpdateService } from "../firmware/index.js";
import { DeviceOperationService } from "../operations/index.js";
import {
  ManualOverrideCommandAdapter,
  ManualOverrideService,
} from "../overrides/index.js";
import {
  ScheduleReconciliationCommandAdapter,
  ScheduleReconciliationService,
  type ScheduleReconciliationTrigger,
} from "../schedule-artifacts/index.js";
import {
  OutputRefreshScheduler,
  ScheduledDeviceOperationDispatcher,
  SystemSchedulingTime,
  TimeSyncCoordinator,
  type SchedulingClock,
  type SchedulingTimer,
} from "../scheduling/index.js";
import { MqttInteractionLogger } from "./mqtt-interaction-logger.js";
import { SchedulingInteractionLogger } from "./scheduling-interaction-logger.js";

export interface ControllerRuntime {
  isReady(): boolean;
  start(): Promise<void>;
  stop(): Promise<void>;
}

export type ControllerRuntimeComposition =
  | {
      readonly mqttEnabled: false;
      readonly runtime: ControllerRuntime;
      readonly deviceOperations: null;
      readonly manualOverrideCommands: null;
      readonly scheduleReconciliation: null;
      readonly deviceDiscovery: null;
      readonly firmwareUpdates: null;
    }
  | {
      readonly mqttEnabled: true;
      readonly runtime: ControllerMqttRuntime;
      readonly deviceOperations: DeviceOperationService;
      readonly manualOverrideCommands: ManualOverrideService;
      readonly scheduleReconciliation: ScheduleReconciliationRequester;
      readonly deviceDiscovery: DeviceDiscoveryRequester;
      readonly firmwareUpdates: FirmwareUpdateService;
    };

export interface ScheduleReconciliationRequester {
  requestScheduleReconciliation(trigger: ScheduleReconciliationTrigger): void;
}

export interface DeviceDiscoveryRequester {
  requestDeviceDiscovery(): void;
}

export interface ComposeControllerRuntimeOptions {
  readonly configuration: ControllerConfiguration;
  readonly stateDatabase: Kysely<StateDatabaseSchema>;
  readonly eventsDatabase: Kysely<EventsDatabaseSchema>;
  readonly clientFactory?: LegacyMqttClientFactory;
  readonly now?: () => number;
  readonly schedulingTime?: SchedulingClock & SchedulingTimer;
  readonly deviceAlertEvaluator?: DeviceAlertEvaluatorPort;
  readonly onError?: (error: Error) => void;
  readonly onDeviceContact?: (contact: {
    readonly deviceId: string;
    readonly observedAtMs: number;
  }) => void;
}

interface ControllerMqttRuntimeOptions {
  readonly mqtt: EnabledMqttConfiguration;
  readonly configuration: ControllerConfiguration["deviceRegistry"];
  readonly firmware: ControllerConfiguration["firmware"];
  readonly stateDatabase: Kysely<StateDatabaseSchema>;
  readonly eventsDatabase: Kysely<EventsDatabaseSchema>;
  readonly clientFactory: LegacyMqttClientFactory;
  readonly now: () => number;
  readonly schedulingTime: SchedulingClock & SchedulingTimer;
  readonly deviceAlertEvaluator: DeviceAlertEvaluatorPort | undefined;
  readonly onError: (error: Error) => void;
  readonly onDeviceContact?: (contact: {
    readonly deviceId: string;
    readonly observedAtMs: number;
  }) => void;
}

export class ControllerMqttRuntime
  implements
    ControllerRuntime,
    ScheduleReconciliationRequester,
    DeviceDiscoveryRequester
{
  readonly #transport: LegacyMqttTransport;
  readonly #registry: DeviceRegistry;
  readonly #deviceAlertEvaluator: DeviceAlertEvaluatorPort | undefined;
  readonly #interactionLogger: MqttInteractionLogger;
  readonly #schedulingInteractionLogger: SchedulingInteractionLogger;
  readonly #deviceOperations: DeviceOperationService;
  readonly #scheduleReconciliation: ScheduleReconciliationService;
  readonly #scheduledCommands: ScheduledDeviceOperationDispatcher;
  readonly #manualOverrides: ManualOverrideService;
  readonly #outputRefresh: OutputRefreshScheduler;
  readonly #timeSync: TimeSyncCoordinator;
  readonly #firmwareUpdates: FirmwareUpdateService;
  readonly #tasks: RuntimeTaskTracker;
  readonly #now: () => number;
  readonly #healthSweepIntervalMs: number;
  readonly #discoveryIntervalMs: number;
  #healthTimer: NodeJS.Timeout | undefined;
  #discoveryTimer: NodeJS.Timeout | undefined;
  #healthTickRunning = false;
  #discoveryTickRunning = false;
  #schedulingStartPromise: Promise<void> | undefined;
  #transportReady = false;
  #readyForCommands = false;
  #transportGeneration = 0;
  #stopping = false;
  #started = false;
  #stopPromise: Promise<void> | undefined;

  constructor(options: ControllerMqttRuntimeOptions) {
    this.#now = options.now;
    this.#healthSweepIntervalMs = options.configuration.healthSweepIntervalMs;
    this.#discoveryIntervalMs = options.mqtt.discoveryIntervalMs;
    this.#deviceAlertEvaluator = options.deviceAlertEvaluator;
    this.#tasks = new RuntimeTaskTracker(options.onError);
    this.#registry = new DeviceRegistry(options.stateDatabase, {
      announcementPersistIntervalMs:
        options.configuration.announcementPersistIntervalMs,
      staleAfterMs: options.configuration.staleAfterMs,
      offlineAfterMs: options.configuration.offlineAfterMs,
    });
    const topics = createEspTopicSet(options.mqtt.topicNamespace === "test");
    const interactionRepository = new InteractionRepository(
      options.eventsDatabase,
      {
        redactPayload: createSensitiveKeyRedactor(),
      },
    );
    this.#interactionLogger = new MqttInteractionLogger(
      interactionRepository,
      topics,
    );
    this.#schedulingInteractionLogger = new SchedulingInteractionLogger(
      interactionRepository,
    );
    this.#transport = new LegacyMqttTransport({
      clientFactory: options.clientFactory,
      topics,
      responseTimeoutMs: options.mqtt.responseTimeoutMs,
      now: options.now,
      callbacks: {
        onAnnouncement: (event) => {
          this.#tasks.run(async () => {
            const update = await this.#registry.handleAnnouncement({
              announcement: event.announcement,
              receivedAtMs: event.receivedAtMs,
            });
            this.#tasks.run(() =>
              this.#evaluateDeviceAlerts(event.receivedAtMs),
            );
            this.#firmwareUpdates.signalDeviceAnnouncement(update.deviceId);
            if (this.#stopping) {
              return;
            }
            if (!(await this.#registry.isCommandEligible(update.deviceId))) {
              return;
            }
            this.#deviceOperations.signalDeviceAvailable(update.deviceId);
            this.#outputRefresh.signalDeviceAvailable(update.deviceId);
            await this.#ensureSchedulingStarted();
            await this.#timeSync.signalAnnouncement(update.deviceId);
            await this.#reconcileSchedules({
              kind: "announcement",
              deviceId: update.deviceId,
            });
          });
          this.#tasks.run(() => this.#interactionLogger.logAnnouncement(event));
        },
        onInteraction: (interaction) => {
          this.#tasks.run(() =>
            this.#interactionLogger.logTransportInteraction(interaction),
          );
          if (
            interaction.kind === "ignored_response" &&
            (interaction.reason === "wrong_device" ||
              interaction.reason === "index_out_of_range")
          ) {
            this.#tasks.run(async () => {
              const update = await this.#registry.recordProtocolFault(
                interaction.responderId,
                interaction.atMs,
                `Correlated response violated the protocol (${interaction.reason})`,
              );
              if (update !== null) {
                await this.#evaluateDeviceAlerts(interaction.atMs);
              }
            });
          }
          if (interaction.kind === "lifecycle") {
            this.#transportReady =
              !this.#stopping && interaction.state === "ready";
            this.#readyForCommands = false;
            const transportGeneration = ++this.#transportGeneration;
            if (this.#transportReady) {
              this.#tasks.run(() =>
                this.#handleTransportReady(transportGeneration),
              );
            }
          }
        },
        onCallbackError: options.onError,
      },
    });
    this.#deviceOperations = new DeviceOperationService(
      new ControlOperationRepository(options.stateDatabase),
      this.#transport,
      this.#registry,
      this.#interactionLogger,
      {
        now: options.now,
        operationTimeoutMs: options.mqtt.responseTimeoutMs,
        onBackgroundError: options.onError,
        ...(options.onDeviceContact === undefined
          ? {}
          : { onDeviceContact: options.onDeviceContact }),
      },
    );
    this.#firmwareUpdates = new FirmwareUpdateService(
      options.stateDatabase,
      this.#deviceOperations,
      {
        artifact: {
          version: ESP_FIRMWARE_ARTIFACT.version,
          sizeBytes: ESP_FIRMWARE_ARTIFACT.sizeBytes,
          sha256: ESP_FIRMWARE_ARTIFACT.sha256,
          url: `${options.firmware.baseUrl}/api/firmware/esp32/current.bin`,
        },
        now: options.now,
        onBackgroundError: options.onError,
      },
    );
    this.#scheduledCommands = new ScheduledDeviceOperationDispatcher(
      this.#deviceOperations,
    );
    this.#scheduleReconciliation = new ScheduleReconciliationService(
      new DeviceScheduleArtifactRepository(options.stateDatabase),
      new ScheduleReconciliationCommandAdapter(
        this.#scheduledCommands,
        this.#deviceOperations,
      ),
      { nowMs: options.now },
    );
    const manualOverrideRepository = new ManualOverrideRepository(
      options.stateDatabase,
    );
    this.#manualOverrides = new ManualOverrideService(
      manualOverrideRepository,
      new ManualOverrideCommandAdapter(
        this.#scheduledCommands,
        this.#deviceOperations,
      ),
      {
        clock: options.schedulingTime,
        timer: options.schedulingTime,
        operationTimeoutMs: options.mqtt.responseTimeoutMs,
        onBackgroundError: options.onError,
      },
    );
    this.#outputRefresh = new OutputRefreshScheduler(
      new RefreshProjectionRepository(options.stateDatabase),
      this.#scheduledCommands,
      {
        clock: options.schedulingTime,
        timer: options.schedulingTime,
        manualOverrideReader: manualOverrideRepository,
        onTick: (report) => {
          this.#tasks.run(() =>
            this.#schedulingInteractionLogger.logOutputRefresh(
              report,
              this.#now(),
            ),
          );
        },
        onError: options.onError,
      },
    );
    this.#timeSync = new TimeSyncCoordinator(
      new OnlineDeviceRepository(options.stateDatabase),
      new SchedulerGuardRepository(options.stateDatabase),
      this.#scheduledCommands,
      {
        clock: options.schedulingTime,
        timer: options.schedulingTime,
        onDiagnostic: (diagnostic) => {
          this.#tasks.run(() =>
            this.#schedulingInteractionLogger.logTimeSync(
              diagnostic,
              this.#now(),
            ),
          );
        },
        onError: options.onError,
      },
    );
  }

  get deviceOperations(): DeviceOperationService {
    return this.#deviceOperations;
  }

  get manualOverrideCommands(): ManualOverrideService {
    return this.#manualOverrides;
  }

  get firmwareUpdateCommands(): FirmwareUpdateService {
    return this.#firmwareUpdates;
  }

  isReady(): boolean {
    return (
      this.#started &&
      !this.#stopping &&
      this.#transportReady &&
      this.#readyForCommands &&
      this.#manualOverrides.isReady() &&
      this.#outputRefresh.isReady() &&
      this.#timeSync.isReady()
    );
  }

  requestScheduleReconciliation(trigger: ScheduleReconciliationTrigger): void {
    if (!this.#started || this.#stopping || !this.#readyForCommands) {
      // A ready/reconnect lifecycle always performs a full startup pass, so a
      // persisted mutation observed while offline cannot be lost.
      return;
    }
    this.#tasks.run(async () => {
      await this.#ensureSchedulingStarted();
      await this.#reconcileSchedules(trigger);
      this.#outputRefresh.requestRefresh();
    });
  }

  requestDeviceDiscovery(): void {
    this.#scheduleDiscoveryTick();
  }

  async #handleTransportReady(transportGeneration: number): Promise<void> {
    await this.#ensureSchedulingStarted();
    if (
      this.#stopping ||
      !this.#transportReady ||
      transportGeneration !== this.#transportGeneration
    ) {
      return;
    }
    await this.#reconcileSchedules({ kind: "startup" });
    if (
      !this.#stopping &&
      this.#transportReady &&
      transportGeneration === this.#transportGeneration &&
      this.#scheduledCommands.blockedReason === null
    ) {
      this.#readyForCommands = true;
    }
  }

  async #reconcileSchedules(
    trigger: ScheduleReconciliationTrigger,
  ): Promise<void> {
    try {
      const result = await this.#scheduleReconciliation.reconcile(trigger);
      await this.#schedulingInteractionLogger.logScheduleReconciliation(
        result,
        this.#now(),
      );
    } catch (error) {
      this.#readyForCommands = false;
      throw error;
    }
  }

  #ensureSchedulingStarted(): Promise<void> {
    if (this.#schedulingStartPromise !== undefined) {
      return this.#schedulingStartPromise;
    }
    const start = (async () => {
      await this.#manualOverrides.initialize();
      await this.#timeSync.start();
      this.#outputRefresh.start();
    })();
    this.#schedulingStartPromise = start;
    return start;
  }

  async start(): Promise<void> {
    if (this.#started) {
      return;
    }
    if (this.#stopPromise !== undefined) {
      throw new Error("Stopped MQTT runtime cannot be restarted");
    }
    await this.#deviceOperations.start();
    this.#firmwareUpdates.start();
    const startedAtMs = this.#now();
    await this.#registry.refreshConnectionStatuses(startedAtMs);
    await this.#evaluateDeviceAlerts(startedAtMs);
    this.#transport.start();
    this.#healthTimer = setInterval(
      () => this.#scheduleHealthTick(),
      this.#healthSweepIntervalMs,
    );
    this.#healthTimer.unref();
    this.#discoveryTimer = setInterval(
      () => this.#scheduleDiscoveryTick(),
      this.#discoveryIntervalMs,
    );
    this.#discoveryTimer.unref();
    this.#started = true;
  }

  async stop(): Promise<void> {
    this.#stopPromise ??= this.#stopOnce();
    await this.#stopPromise;
  }

  async #stopOnce(): Promise<void> {
    this.#stopping = true;
    this.#transportReady = false;
    this.#readyForCommands = false;
    this.#transportGeneration += 1;
    if (this.#healthTimer !== undefined) {
      clearInterval(this.#healthTimer);
      this.#healthTimer = undefined;
    }
    if (this.#discoveryTimer !== undefined) {
      clearInterval(this.#discoveryTimer);
      this.#discoveryTimer = undefined;
    }
    const errors: Error[] = [];
    if (this.#schedulingStartPromise !== undefined) {
      try {
        await this.#schedulingStartPromise;
      } catch (error) {
        errors.push(toError(error));
      }
    }
    const schedulingStops = await Promise.allSettled([
      this.#outputRefresh.stop(),
      this.#timeSync.stop(),
      this.#manualOverrides.stop(),
    ]);
    for (const result of schedulingStops) {
      if (result.status === "rejected") {
        errors.push(toError(result.reason));
      }
    }
    try {
      await this.#scheduledCommands.drain();
    } catch (error) {
      errors.push(toError(error));
    }
    this.#firmwareUpdates.stop();
    try {
      await this.#firmwareUpdates.drain();
    } catch (error) {
      errors.push(toError(error));
    }
    this.#deviceOperations.beginShutdown();
    try {
      await this.#transport.stop();
    } catch (error) {
      errors.push(toError(error));
    }
    const drainResults = await Promise.allSettled([
      this.#deviceOperations.drain(),
      this.#tasks.drain(),
    ]);
    for (const result of drainResults) {
      if (result.status === "rejected") {
        errors.push(toError(result.reason));
      }
    }
    this.#started = false;
    if (errors.length > 0) {
      throw new AggregateError(errors, "MQTT runtime shutdown failed");
    }
  }

  #scheduleHealthTick(): void {
    if (this.#stopping || !this.#started || this.#healthTickRunning) {
      return;
    }
    this.#healthTickRunning = true;
    this.#tasks.run(async () => {
      try {
        const observedAtMs = this.#now();
        await this.#registry.refreshConnectionStatuses(observedAtMs);
        await this.#evaluateDeviceAlerts(observedAtMs);
      } finally {
        this.#healthTickRunning = false;
      }
    });
  }

  async #evaluateDeviceAlerts(observedAtMs: number): Promise<void> {
    await this.#deviceAlertEvaluator?.evaluateAll(observedAtMs);
  }

  #scheduleDiscoveryTick(): void {
    if (this.#stopping || !this.#started) {
      return;
    }
    if (this.#discoveryTickRunning) {
      this.#tasks.run(() =>
        this.#interactionLogger.logDiscoverySkipped(this.#now()),
      );
      return;
    }
    this.#discoveryTickRunning = true;
    this.#tasks.run(async () => {
      try {
        const result = await this.#transport.requestDiscovery();
        if (result === "skipped_busy") {
          await this.#interactionLogger.logDiscoverySkipped(this.#now());
        }
      } finally {
        this.#discoveryTickRunning = false;
      }
    });
  }
}

export function composeControllerRuntime(
  options: ComposeControllerRuntimeOptions,
): ControllerRuntimeComposition {
  if (!options.configuration.mqtt.enabled) {
    return {
      mqttEnabled: false,
      runtime: new DisabledControllerRuntime(),
      deviceOperations: null,
      manualOverrideCommands: null,
      scheduleReconciliation: null,
      deviceDiscovery: null,
      firmwareUpdates: null,
    };
  }
  if (options.onError === undefined) {
    throw new TypeError("Enabled MQTT runtime requires an error reporter");
  }
  const onError = options.onError;
  const clientFactory =
    options.clientFactory ??
    createMqttJsClientFactory({
      brokerUrl: options.configuration.mqtt.brokerUrl,
    });
  const runtime = new ControllerMqttRuntime({
    mqtt: options.configuration.mqtt,
    configuration: options.configuration.deviceRegistry,
    firmware: options.configuration.firmware,
    stateDatabase: options.stateDatabase,
    eventsDatabase: options.eventsDatabase,
    clientFactory,
    now: options.now ?? Date.now,
    schedulingTime: options.schedulingTime ?? new SystemSchedulingTime(),
    deviceAlertEvaluator: options.deviceAlertEvaluator,
    onError,
    ...(options.onDeviceContact === undefined
      ? {}
      : { onDeviceContact: options.onDeviceContact }),
  });
  return {
    mqttEnabled: true,
    runtime,
    deviceOperations: runtime.deviceOperations,
    manualOverrideCommands: runtime.manualOverrideCommands,
    scheduleReconciliation: runtime,
    deviceDiscovery: runtime,
    firmwareUpdates: runtime.firmwareUpdateCommands,
  };
}

class DisabledControllerRuntime implements ControllerRuntime {
  #started = false;

  isReady(): boolean {
    return this.#started;
  }

  async start(): Promise<void> {
    this.#started = true;
  }

  async stop(): Promise<void> {
    this.#started = false;
  }
}

class RuntimeTaskTracker {
  readonly #pending = new Set<Promise<void>>();
  readonly #onError: (error: Error) => void;
  #fatalReporterError: Error | null = null;

  constructor(onError: (error: Error) => void) {
    this.#onError = onError;
  }

  run(task: () => Promise<void>): void {
    let taskPromise: Promise<void>;
    try {
      taskPromise = task();
    } catch (error) {
      this.#report(error);
      return;
    }
    const pending = taskPromise.catch((error) => {
      this.#report(error);
    });
    this.#pending.add(pending);
    void pending.finally(() => this.#pending.delete(pending));
  }

  #report(error: unknown): void {
    const reportedError = toError(error);
    try {
      this.#onError(reportedError);
    } catch (reporterError) {
      const failure = new AggregateError(
        [reportedError, toError(reporterError)],
        "Controller runtime error reporter failed",
      );
      this.#fatalReporterError =
        this.#fatalReporterError === null
          ? failure
          : new AggregateError(
              [this.#fatalReporterError, failure],
              "Controller runtime error reporter failed more than once",
            );
    }
  }

  async drain(): Promise<void> {
    while (this.#pending.size > 0) {
      await Promise.all([...this.#pending]);
    }
    if (this.#fatalReporterError !== null) {
      throw this.#fatalReporterError;
    }
  }
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
