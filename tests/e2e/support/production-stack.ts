import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, mkdir, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import type { ControllerSnapshot } from "@aquarium/contracts";
import {
  espCommandRequestSchema,
  espCommandResponseSchema,
} from "@aquarium/esp-protocol";
import {
  startFakeEspControlServer,
  startFakeEspLauncher,
  type FakeEspResponseFaults,
  type RunningFakeEspControlServer,
  type RunningFakeEspLauncher,
} from "@aquarium/fake-esp";

import {
  type CapturedMqttPublication,
  MosquittoTestHarness,
  waitUntil,
} from "../../../apps/controller/src/integration-support/mosquitto-test-harness.js";
import {
  closeControllerDatabases,
  ControllerConfigurationRepository,
  openControllerDatabases,
} from "../../../apps/controller/src/infrastructure/database/index.js";

const repositoryRoot = resolve(import.meta.dirname, "../../..");
const controllerStartupTimeoutMs = 30_000;
const snapshotWaitTimeoutMs = 15_000;
const fakeDevices = [
  { key: "main", name: "main-a", id: "A1B2C3D4" },
  { key: "backup", name: "main-b", id: "B1C2D3E4" },
] as const;

export interface ProductionE2eStack {
  readonly baseUrl: string;
  readonly brokerUrl: string;
  readonly controllerLog: string;
  readonly fakeEspConsoleUrl: string;
  fetchSnapshot(): Promise<ControllerSnapshot>;
  mqttPublications(): readonly CapturedMqttPublication[];
  pauseFakeDevices(): Promise<void>;
  resumeFakeDevices(): Promise<void>;
  restartBroker(): Promise<void>;
  restartController(): Promise<void>;
  restartFakeDevices(): Promise<void>;
  setFakeDeviceNetworkEnabled(
    deviceKey: (typeof fakeDevices)[number]["key"],
    enabled: boolean,
  ): void;
  setFakeDevicePower(
    deviceKey: (typeof fakeDevices)[number]["key"],
    powered: boolean,
  ): Promise<void>;
  setFakeResponseFaults(
    deviceKey: (typeof fakeDevices)[number]["key"],
    faults: FakeEspResponseFaults,
  ): void;
  waitForSettled(): Promise<ControllerSnapshot>;
  stop(): Promise<void>;
}

interface E2ePaths {
  readonly root: string;
  readonly stateDatabase: string;
  readonly eventsDatabase: string;
  readonly archives: string;
  readonly backups: string;
  readonly fakeEspStorage: string;
}

class RunningProductionE2eStack implements ProductionE2eStack {
  readonly #paths: E2ePaths;
  readonly #broker: MosquittoTestHarness;
  readonly #controllerPort: number;
  readonly #fakeControlPort: number;
  #controller: ChildProcess | null = null;
  #fakeLauncher: RunningFakeEspLauncher | null = null;
  #fakeControlServer: RunningFakeEspControlServer | null = null;
  #controllerLogLines: string[] = [];
  #stopped = false;

  public constructor(
    paths: E2ePaths,
    broker: MosquittoTestHarness,
    controllerPort: number,
    fakeControlPort: number,
  ) {
    this.#paths = paths;
    this.#broker = broker;
    this.#controllerPort = controllerPort;
    this.#fakeControlPort = fakeControlPort;
  }

  public get baseUrl(): string {
    return `http://127.0.0.1:${this.#controllerPort}`;
  }

  public get brokerUrl(): string {
    return this.#broker.brokerUrl;
  }

  public get controllerLog(): string {
    return this.#controllerLogLines.join("\n");
  }

  public get fakeEspConsoleUrl(): string {
    return `http://127.0.0.1:${this.#fakeControlPort}`;
  }

  public async start(): Promise<void> {
    await this.startController();
    await this.startFakeDevices();
    await this.waitForSnapshot(
      (snapshot) =>
        fakeDevices.every((device) =>
          snapshot.devices.some(
            (candidate) => candidate.hardwareId === device.id,
          ),
        ),
      "both fake ESP devices to announce",
    );
    await this.assignSeededMappingProfiles();
    await this.waitForSettled();
  }

  public async fetchSnapshot(): Promise<ControllerSnapshot> {
    const response = await fetch(`${this.baseUrl}/api/snapshot`, {
      headers: { Accept: "application/json" },
    });
    if (!response.ok) {
      throw new Error(`Snapshot request failed with HTTP ${response.status}`);
    }
    return (await response.json()) as ControllerSnapshot;
  }

  public mqttPublications(): readonly CapturedMqttPublication[] {
    return this.#broker.publications();
  }

  public async restartController(): Promise<void> {
    this.assertRunning();
    await this.stopController();
    await this.startController();
    await this.waitForSnapshot(
      (snapshot) =>
        fakeDevices.every((device) =>
          snapshot.devices.some(
            (candidate) =>
              candidate.hardwareId === device.id &&
              candidate.status === "online",
          ),
        ),
      "both fake ESP devices to reconnect after controller restart",
    );
    await this.waitForSettled();
  }

  public async restartBroker(): Promise<void> {
    this.assertRunning();
    const baseline = await this.fetchSnapshot();
    const baselineOperationIds = new Set(
      baseline.operations.items.map((operation) => operation.id),
    );
    const baselineCompletedPwmExchanges = countCompletedScheduledPwmExchanges(
      this.#broker.publications(),
    );
    const mappingProfiles = new Map(
      baseline.mappingProfiles.map((profile) => [profile.id, profile]),
    );
    const scheduledChannelIds = new Set(
      baseline.schedules
        .filter((schedule) => schedule.enabled)
        .map((schedule) => schedule.channelId),
    );
    const activeScheduledChannelIds = new Set(
      baseline.channels
        .filter(
          (channel) => channel.enabled && scheduledChannelIds.has(channel.id),
        )
        .map((channel) => channel.id),
    );
    const scheduledOperationCount = baseline.devices.reduce((count, device) => {
      if (!device.enabled || device.mappingProfileId === null) {
        return count;
      }
      const profile = mappingProfiles.get(device.mappingProfileId);
      return (
        count +
        (profile?.mappings.filter(
          (mapping) =>
            mapping.enabled &&
            mapping.target.kind === "channel" &&
            activeScheduledChannelIds.has(mapping.target.id),
        ).length ?? 0)
      );
    }, 0);
    if (scheduledOperationCount === 0) {
      throw new Error(
        "Broker restart requires at least one scheduled output operation",
      );
    }
    await waitUntil(
      () =>
        countCompletedScheduledPwmExchanges(this.#broker.publications()) >=
        baselineCompletedPwmExchanges + scheduledOperationCount,
      "a complete acknowledged scheduled PWM batch before broker restart",
      snapshotWaitTimeoutMs,
    );
    const settled = await this.waitForSettled();
    const activeOperationIds = settled.operations.items
      .filter(
        (operation) =>
          operation.status === "pending" || operation.status === "in_flight",
      )
      .map((operation) => operation.id);
    const unknownOutcomeIds = settled.operations.items
      .filter(
        (operation) =>
          !baselineOperationIds.has(operation.id) &&
          operation.status === "outcome_unknown",
      )
      .map((operation) => operation.id);
    if (activeOperationIds.length > 0 || unknownOutcomeIds.length > 0) {
      throw new Error(
        `Broker restart requires a clean scheduler boundary; active=${activeOperationIds.join(",") || "none"}, new unknown outcomes=${unknownOutcomeIds.join(",") || "none"}`,
      );
    }
    this.#broker.clearPublications();
    await this.#broker.restartBroker();
    await waitUntil(
      () =>
        this.#broker
          .publications()
          .filter(({ topic }) => topic.endsWith("/announce")).length >=
        fakeDevices.length,
      "both fake ESP devices to announce after broker restart",
      15_000,
    );
    await this.waitForSettled();
  }

  public async pauseFakeDevices(): Promise<void> {
    this.assertRunning();
    await this.stopFakeDevices();
  }

  public async resumeFakeDevices(): Promise<void> {
    this.assertRunning();
    await this.startFakeDevices();
    await this.waitForSnapshot(
      (snapshot) =>
        fakeDevices.every((device) =>
          snapshot.devices.some(
            (candidate) =>
              candidate.hardwareId === device.id &&
              candidate.status === "online",
          ),
        ),
      "both resumed fake ESP devices to return online",
    );
  }

  public async restartFakeDevices(): Promise<void> {
    this.assertRunning();
    const priorAnnouncementCount = this.#broker
      .publications()
      .filter(({ topic }) => topic.endsWith("/announce")).length;
    await this.stopFakeDevices();
    await this.resumeFakeDevices();
    await waitUntil(
      () =>
        this.#broker
          .publications()
          .filter(({ topic }) => topic.endsWith("/announce")).length >=
        priorAnnouncementCount + fakeDevices.length,
      "both restarted fake ESP actors to publish fresh announcements",
      snapshotWaitTimeoutMs,
    );
  }

  public setFakeResponseFaults(
    deviceKey: (typeof fakeDevices)[number]["key"],
    faults: FakeEspResponseFaults,
  ): void {
    this.assertRunning();
    const launcher = this.#fakeLauncher;
    if (launcher === null) {
      throw new Error("Fake ESP launcher is not running");
    }
    launcher.setResponseFaults(deviceKey, faults);
  }

  public setFakeDeviceNetworkEnabled(
    deviceKey: (typeof fakeDevices)[number]["key"],
    enabled: boolean,
  ): void {
    this.assertRunning();
    const launcher = this.#fakeLauncher;
    if (launcher === null) {
      throw new Error("Fake ESP launcher is not running");
    }
    launcher.setNetworkEnabled(deviceKey, enabled);
  }

  public async setFakeDevicePower(
    deviceKey: (typeof fakeDevices)[number]["key"],
    powered: boolean,
  ): Promise<void> {
    this.assertRunning();
    const launcher = this.#fakeLauncher;
    if (launcher === null) {
      throw new Error("Fake ESP launcher is not running");
    }
    if (powered) {
      await launcher.powerOn(deviceKey);
    } else {
      await launcher.powerOff(deviceKey);
    }
  }

  public async waitForSettled(): Promise<ControllerSnapshot> {
    this.assertRunning();
    const deadline = Date.now() + 20_000;
    let priorRevision: number | null = null;
    let stableSinceMs = Date.now();
    let lastSnapshot: ControllerSnapshot | null = null;
    while (Date.now() < deadline) {
      lastSnapshot = await this.fetchSnapshot();
      const hasActiveOperation = lastSnapshot.operations.items.some(
        (operation) =>
          operation.status === "pending" || operation.status === "in_flight",
      );
      if (hasActiveOperation || lastSnapshot.revision !== priorRevision) {
        priorRevision = lastSnapshot.revision;
        stableSinceMs = Date.now();
      } else if (Date.now() - stableSinceMs >= 1_500) {
        return lastSnapshot;
      }
      await delay(150);
    }
    throw new Error(
      `Controller did not settle; last snapshot revision ${lastSnapshot?.revision ?? "unavailable"}`,
    );
  }

  public async stop(): Promise<void> {
    if (this.#stopped) return;
    this.#stopped = true;
    const failures: Error[] = [];
    await captureCleanupFailure(() => this.stopController(), failures);
    await captureCleanupFailure(() => this.stopFakeDevices(), failures);
    await captureCleanupFailure(async () => {
      this.#broker.assertOnlyTestAquariumTraffic();
    }, failures);
    await captureCleanupFailure(() => this.#broker.stop(), failures);
    await captureCleanupFailure(
      () => rm(this.#paths.root, { recursive: true, force: true }),
      failures,
    );
    if (failures.length > 0) {
      throw new AggregateError(failures, "Production E2E stack cleanup failed");
    }
  }

  private async startController(): Promise<void> {
    if (this.#controller !== null) {
      throw new Error("E2E controller is already running");
    }
    const blockedEnvironmentKeys = new Set([
      "AQUARIUM_ALERT_WEBHOOK_URL",
      "AQUARIUM_ALERT_WEBHOOK_KEY",
      "AQUARIUM_ALERT_WEBHOOK_TIMEOUT_MS",
      "AQUARIUM_ALERT_WEBHOOK_AUTH_HEADER_NAME",
      "AQUARIUM_ALERT_WEBHOOK_AUTH_HEADER_VALUE",
      "AQUARIUM_PRODUCTION_MQTT_CONFIRMATION",
    ]);
    const environment: NodeJS.ProcessEnv = Object.fromEntries(
      Object.entries(process.env).filter(
        ([key]) => !blockedEnvironmentKeys.has(key),
      ),
    );
    Object.assign(environment, {
      NODE_ENV: "test",
      AQUARIUM_RUNTIME_MODE: "test",
      AQUARIUM_HOST: "127.0.0.1",
      AQUARIUM_PORT: String(this.#controllerPort),
      AQUARIUM_STATE_DB_PATH: this.#paths.stateDatabase,
      AQUARIUM_EVENTS_DB_PATH: this.#paths.eventsDatabase,
      AQUARIUM_ARCHIVE_DIRECTORY: this.#paths.archives,
      AQUARIUM_BACKUP_DIRECTORY: this.#paths.backups,
      AQUARIUM_WEB_ROOT: resolve(repositoryRoot, "apps/web/dist"),
      AQUARIUM_MQTT_ENABLED: "true",
      AQUARIUM_MQTT_BROKER_URL: this.brokerUrl,
      AQUARIUM_MQTT_TOPIC_NAMESPACE: "test",
      AQUARIUM_MQTT_RESPONSE_TIMEOUT_MS: "500",
      AQUARIUM_MQTT_DISCOVERY_INTERVAL_MS: "5000",
      AQUARIUM_DEVICE_ANNOUNCEMENT_PERSIST_INTERVAL_MS: "10000",
      AQUARIUM_DEVICE_STALE_AFTER_MS: "12000",
      AQUARIUM_DEVICE_OFFLINE_AFTER_MS: "15000",
      AQUARIUM_DEVICE_HEALTH_SWEEP_INTERVAL_MS: "500",
      AQUARIUM_STORAGE_HEALTH_INTERVAL_MS: "10000",
      AQUARIUM_STORAGE_MINIMUM_FREE_BYTES: "1",
    });

    const child = spawn(
      process.execPath,
      [resolve(repositoryRoot, "apps/controller/dist/server.js")],
      {
        cwd: repositoryRoot,
        env: environment,
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    this.#controller = child;
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => this.captureLog(chunk));
    child.stderr?.on("data", (chunk: string) => this.captureLog(chunk));

    try {
      await waitForHttpHealth(
        `${this.baseUrl}/api/health`,
        child,
        controllerStartupTimeoutMs,
      );
    } catch (error) {
      await this.stopController();
      throw new Error(
        `Production controller failed to start.\n${this.controllerLog}`,
        { cause: error },
      );
    }
  }

  private async stopController(): Promise<void> {
    const child = this.#controller;
    if (child === null) return;
    this.#controller = null;
    if (child.exitCode === null && child.signalCode === null) {
      if (!child.kill("SIGTERM")) {
        throw new Error("Unable to signal the E2E controller process");
      }
    }
    await waitForChildExit(child, 10_000);
  }

  private async startFakeDevices(): Promise<void> {
    if (this.#fakeLauncher !== null) {
      throw new Error("Fake ESP launcher is already running");
    }
    const launcher = await startFakeEspLauncher({
      brokerUrl: this.brokerUrl,
      storageDirectory: this.#paths.fakeEspStorage,
      devices: fakeDevices,
      onError: (error) => this.captureLog(`fake-esp: ${error.message}`),
    });
    try {
      this.#fakeControlServer = await startFakeEspControlServer({
        host: "127.0.0.1",
        port: this.#fakeControlPort,
        launcher,
      });
      this.#fakeLauncher = launcher;
    } catch (error) {
      await launcher.stop();
      throw error;
    }
  }

  private async assignSeededMappingProfiles(): Promise<void> {
    for (const fakeDevice of fakeDevices) {
      const snapshot = await this.waitForSettled();
      const device = snapshot.devices.find(
        (candidate) => candidate.hardwareId === fakeDevice.id,
      );
      if (device === undefined) {
        throw new Error(
          `Cannot assign a mapping profile before ${fakeDevice.id} is discovered`,
        );
      }
      const response = await fetch(
        `${this.baseUrl}/api/devices/${encodeURIComponent(device.id)}/configuration`,
        {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            expectedRevision: snapshot.revision,
            mappingProfileId: "profile-main",
          }),
        },
      );
      if (!response.ok) {
        throw new Error(
          `Mapping-profile assignment for ${fakeDevice.id} failed with HTTP ${response.status}`,
        );
      }
    }
  }

  private async stopFakeDevices(): Promise<void> {
    const launcher = this.#fakeLauncher;
    const controlServer = this.#fakeControlServer;
    if (launcher === null && controlServer === null) return;
    this.#fakeLauncher = null;
    this.#fakeControlServer = null;
    const results = await Promise.allSettled([
      controlServer?.stop() ?? Promise.resolve(),
      launcher?.stop() ?? Promise.resolve(),
    ]);
    const failures = results
      .filter(
        (result): result is PromiseRejectedResult =>
          result.status === "rejected",
      )
      .map((result) =>
        result.reason instanceof Error
          ? result.reason
          : new Error("Unknown fake ESP shutdown failure"),
      );
    if (failures.length > 0) {
      throw new AggregateError(failures, "Fake ESP shutdown failed");
    }
  }

  private async waitForSnapshot(
    predicate: (snapshot: ControllerSnapshot) => boolean,
    description: string,
  ): Promise<ControllerSnapshot> {
    const deadline = Date.now() + snapshotWaitTimeoutMs;
    let lastSnapshot: ControllerSnapshot | null = null;
    while (Date.now() < deadline) {
      lastSnapshot = await this.fetchSnapshot();
      if (predicate(lastSnapshot)) return lastSnapshot;
      await delay(100);
    }
    throw new Error(
      `Timed out waiting for ${description}; last snapshot revision ${lastSnapshot?.revision ?? "unavailable"}`,
    );
  }

  private captureLog(chunk: string): void {
    this.#controllerLogLines.push(
      ...chunk
        .split(/\r?\n/u)
        .map((line) => line.trimEnd())
        .filter((line) => line.length > 0),
    );
    if (this.#controllerLogLines.length > 1_000) {
      this.#controllerLogLines.splice(
        0,
        this.#controllerLogLines.length - 1_000,
      );
    }
  }

  private assertRunning(): void {
    if (this.#stopped) {
      throw new Error("Production E2E stack has stopped");
    }
  }
}

export async function startProductionE2eStack(): Promise<ProductionE2eStack> {
  const paths = await createE2ePaths();
  let broker: MosquittoTestHarness | null = null;
  try {
    await seedState(paths);
    broker = await MosquittoTestHarness.start();
    const [controllerPort, fakeControlPort] = await Promise.all([
      reserveLoopbackPort(),
      reserveLoopbackPort(),
    ]);
    const stack = new RunningProductionE2eStack(
      paths,
      broker,
      controllerPort,
      fakeControlPort,
    );
    await stack.start();
    return stack;
  } catch (error) {
    await broker?.stop();
    await rm(paths.root, { recursive: true, force: true });
    throw error;
  }
}

async function createE2ePaths(): Promise<E2ePaths> {
  const root = await mkdtemp(join(tmpdir(), "aquarium-playwright-"));
  const paths = {
    root,
    stateDatabase: join(root, "state.db"),
    eventsDatabase: join(root, "events.db"),
    archives: join(root, "archives"),
    backups: join(root, "backups"),
    fakeEspStorage: join(root, "fake-esp"),
  };
  await Promise.all([
    mkdir(paths.archives),
    mkdir(paths.backups),
    mkdir(paths.fakeEspStorage),
  ]);
  return paths;
}

async function seedState(paths: E2ePaths): Promise<void> {
  const databases = await openControllerDatabases({
    state: { filename: paths.stateDatabase },
    events: { filename: paths.eventsDatabase },
  });
  try {
    const nowMs = Date.now();
    await databases.state
      .updateTable("throttles")
      .set({ percentage: 80, updated_at_ms: nowMs })
      .where("type_key", "=", "light")
      .executeTakeFirstOrThrow();
    await databases.state
      .insertInto("outputs")
      .values({
        id: "output-moonlight",
        name: "Moonlight output",
        kind: "light",
        display_order: 0,
        enabled: 1,
        output_gain: 0.7,
        created_at_ms: nowMs,
        updated_at_ms: nowMs,
      })
      .executeTakeFirstOrThrow();

    const repository = new ControllerConfigurationRepository(databases.state, {
      actor: "playwright-seed",
      nowMs: () => nowMs,
    });
    let revision = 0;
    for (const channel of [
      {
        id: "light-main",
        name: "Main light",
        color: "#6f5bd5",
        typeKey: "light",
        throttleId: "throttle-light",
      },
      {
        id: "pump-main",
        name: "Return pump",
        color: "#13a4c7",
        typeKey: "pump",
        throttleId: "throttle-pump",
      },
    ] as const) {
      revision = (
        await repository.createChannel({
          expectedRevision: revision,
          ...channel,
          displayOrder: 0,
          enabled: true,
        })
      ).revision;
      revision = (
        await repository.replaceSchedule(channel.id, {
          expectedRevision: revision,
          points: [
            schedulePoint(channel.id, "start", 0, 0, 0),
            schedulePoint(channel.id, "noon", 1, 720, 60),
            schedulePoint(channel.id, "end", 2, 1_439, 0),
          ],
        })
      ).revision;
    }
    await repository.replaceMappingProfile("profile-main", {
      expectedRevision: revision,
      name: "Main rack",
      hardwareProfileId: "nodemcu-esp32s-v1.1",
      outputGain: 1,
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
          pin: 12,
          displayOrder: 1,
          enabled: true,
          target: { kind: "channel", id: "pump-main" },
        },
        {
          id: "mapping-moonlight",
          pin: 13,
          displayOrder: 2,
          enabled: true,
          target: { kind: "output", id: "output-moonlight" },
        },
      ],
    });
  } finally {
    await closeControllerDatabases(databases);
  }
}

function schedulePoint(
  channelId: string,
  suffix: string,
  position: number,
  minuteOfDay: number,
  percentage: number,
) {
  return {
    id: `${channelId}-${suffix}`,
    position,
    minuteOfDay,
    percentage,
    editorX: null,
    editorY: null,
  };
}

export function countCompletedScheduledPwmExchanges(
  publications: readonly CapturedMqttPublication[],
): number {
  const requestIds = new Set<string>();
  const responseIds = new Set<string>();
  for (const publication of publications) {
    if (publication.topic.endsWith("/command")) {
      try {
        const request = espCommandRequestSchema.safeParse(
          JSON.parse(publication.payload) as object,
        );
        if (
          request.success &&
          request.data.commands.some(
            (command) => command.kind === "set_pwm" && command.overwrite,
          )
        ) {
          requestIds.add(request.data.requestId);
        }
      } catch (error) {
        if (!(error instanceof SyntaxError)) throw error;
      }
      continue;
    }
    if (!publication.topic.endsWith("/response")) {
      continue;
    }
    try {
      const response = espCommandResponseSchema.safeParse(
        JSON.parse(publication.payload) as object,
      );
      if (response.success) {
        responseIds.add(response.data.requestId);
      }
    } catch (error) {
      if (!(error instanceof SyntaxError)) {
        throw error;
      }
    }
  }
  return [...requestIds].filter((requestId) => responseIds.has(requestId))
    .length;
}

async function reserveLoopbackPort(): Promise<number> {
  return new Promise<number>((resolvePort, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        server.close();
        reject(new Error("Unable to reserve a loopback TCP port"));
        return;
      }
      server.close((error) => {
        if (error !== undefined) {
          reject(error);
        } else {
          resolvePort(address.port);
        }
      });
    });
  });
}

async function waitForHttpHealth(
  url: string,
  child: ChildProcess,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error(
        `Controller exited before health check (exit=${child.exitCode}, signal=${child.signalCode})`,
      );
    }
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
      if (response.ok) return;
    } catch (error) {
      if (!(error instanceof Error)) {
        throw error;
      }
    }
    await delay(100);
  }
  throw new Error(`Timed out waiting for ${url}`);
}

async function waitForChildExit(
  child: ChildProcess,
  timeoutMs: number,
): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  await new Promise<void>((resolveExit, reject) => {
    const timeout = setTimeout(() => {
      child.off("exit", onExit);
      reject(new Error("Timed out waiting for E2E controller shutdown"));
    }, timeoutMs);
    const onExit = (): void => {
      clearTimeout(timeout);
      resolveExit();
    };
    child.once("exit", onExit);
  });
}

async function captureCleanupFailure(
  cleanup: () => Promise<void>,
  failures: Error[],
): Promise<void> {
  try {
    await cleanup();
  } catch (error) {
    failures.push(
      error instanceof Error ? error : new Error("Unknown cleanup failure"),
    );
  }
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, milliseconds));
}
