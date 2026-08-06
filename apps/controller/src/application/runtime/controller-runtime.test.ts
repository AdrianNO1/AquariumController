import { afterEach, describe, expect, it, vi } from "vitest";
import {
  CURRENT_ESP_FIRMWARE_VERSION,
  type EspCommandRequest,
  type EspCommandResult,
} from "@aquarium/esp-protocol";

import { parseControllerConfiguration } from "../../configuration.js";
import {
  ControlOperationRepository,
  openControllerDatabases,
  type ControllerDatabases,
} from "../../infrastructure/database/index.js";
import type {
  LegacyMqttClientPort,
  MqttMessageHandler,
  QosZeroPublishOptions,
  QosZeroSubscribeOptions,
} from "../../infrastructure/mqtt/index.js";
import { composeControllerRuntime } from "./controller-runtime.js";

const encoder = new TextEncoder();
const openDatabases: ControllerDatabases[] = [];

afterEach(async () => {
  vi.useRealTimers();
  await Promise.all(
    openDatabases.splice(0).map(async (databases) => {
      await Promise.all([
        databases.state.destroy(),
        databases.events.destroy(),
      ]);
    }),
  );
});

describe("controller MQTT runtime composition", () => {
  it("starts and stops with MQTT disabled without constructing a client", async () => {
    const databases = await openDatabasesForTest();
    let clientFactoryCalls = 0;
    const composition = composeControllerRuntime({
      configuration: parseControllerConfiguration({}),
      stateDatabase: databases.state,
      eventsDatabase: databases.events,
      clientFactory: () => {
        clientFactoryCalls += 1;
        return new InMemoryMqttClient();
      },
    });
    expect(composition).toMatchObject({
      mqttEnabled: false,
      deviceOperations: null,
    });
    expect(composition.runtime.isReady()).toBe(false);
    await composition.runtime.start();
    expect(composition.runtime.isReady()).toBe(true);
    await composition.runtime.stop();
    expect(composition.runtime.isReady()).toBe(false);
    expect(clientFactoryCalls).toBe(0);
  });

  it("requires an explicit error reporter when MQTT is enabled", async () => {
    const databases = await openDatabasesForTest();
    expect(() =>
      composeControllerRuntime({
        configuration: enabledConfiguration(),
        stateDatabase: databases.state,
        eventsDatabase: databases.events,
        clientFactory: () => new InMemoryMqttClient(),
      }),
    ).toThrow(/error reporter/i);
  });

  it("clears a device command cooldown once before announcement work", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const databases = await openDatabasesForTest();
    const client = new InMemoryMqttClient();
    const errors: Error[] = [];
    const composition = composeControllerRuntime({
      configuration: enabledConfiguration(),
      stateDatabase: databases.state,
      eventsDatabase: databases.events,
      clientFactory: () => client,
      now: Date.now,
      onError: (error) => errors.push(error),
    });
    if (!composition.mqttEnabled) {
      throw new Error("Expected enabled MQTT runtime composition");
    }
    const signalDeviceAvailable = vi.spyOn(
      composition.deviceOperations,
      "signalDeviceAvailable",
    );
    const executeDeviceOperation = vi.spyOn(
      composition.deviceOperations,
      "executeDeviceOperation",
    );
    await composition.runtime.start();
    client.emitConnected();
    await vi.waitFor(() => expect(composition.runtime.isReady()).toBe(true));

    client.emitText(
      "test/aquarium/v1/devices/A1/announce",
      JSON.stringify({
        protocolVersion: 1,
        id: "A1",
        name: "One",
        freq: 5_000,
        res: 8,
        status: "online",
        version: CURRENT_ESP_FIRMWARE_VERSION,
        scheduleHash: "0",
      }),
    );

    await vi.waitFor(() =>
      expect(signalDeviceAvailable).toHaveBeenCalledTimes(1),
    );
    expect(signalDeviceAvailable).toHaveBeenCalledWith("A1");
    await vi.waitFor(() =>
      expect(publishedCommand(client, "A1 sync 10")).toBeDefined(),
    );
    const syncCallIndex = executeDeviceOperation.mock.calls.findIndex(
      ([, request]) => request.kind === "sync_time",
    );
    const syncOperation =
      executeDeviceOperation.mock.results[syncCallIndex]?.value;
    if (syncOperation === undefined) {
      throw new Error("Expected the announcement time-sync operation");
    }
    emitCommandResponse(client, "A1 sync 10", "A1", "10");
    await syncOperation;
    await composition.runtime.stop();
    expect(errors).toEqual([]);
  });

  it("uses guarded test topics, rejects malformed traffic, logs truthful bytes, and skips busy discovery without catch-up", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const databases = await openDatabasesForTest();
    const client = new InMemoryMqttClient();
    const errors: Error[] = [];
    const alertEvaluationTimes: number[] = [];
    const composition = composeControllerRuntime({
      configuration: enabledConfiguration(),
      stateDatabase: databases.state,
      eventsDatabase: databases.events,
      clientFactory: () => client,
      now: Date.now,
      deviceAlertEvaluator: {
        async evaluateAll(observedAtMs) {
          alertEvaluationTimes.push(observedAtMs);
          return { observedAtMs, deviceCount: 0, evaluations: [] };
        },
      },
      onError: (error) => errors.push(error),
    });
    if (!composition.mqttEnabled) {
      throw new Error("Expected enabled MQTT runtime composition");
    }
    const executeDeviceOperation = vi.spyOn(
      composition.deviceOperations,
      "executeDeviceOperation",
    );

    expect(composition.runtime.isReady()).toBe(false);
    await composition.runtime.start();
    expect(composition.runtime.isReady()).toBe(false);
    expect(client.starts).toBe(1);
    client.emitConnected();
    await vi.waitFor(() => expect(composition.runtime.isReady()).toBe(true));
    expect(client.publishes).toHaveLength(2);
    expect(client.subscriptions).toEqual([
      [
        "test/aquarium/v1/devices/+/announce",
        "test/aquarium/v1/devices/+/response",
        "test/aquarium/announce",
        "test/aquarium/response",
      ],
    ]);
    expect(client.publishes).toContainEqual({
      topic: "test/aquarium/v1/discovery/request",
      payload: '{"protocolVersion":1,"kind":"discover"}',
      options: { qos: 0, retain: false },
    });
    expect(client.publishes).toContainEqual({
      topic: "test/aquarium/command",
      payload: "discover",
      options: { qos: 0, retain: false },
    });

    client.emitText(
      "test/aquarium/announce",
      JSON.stringify({
        id: "invalid hardware id",
        name: "Invalid",
        freq: 5_000,
        res: 8,
        status: "online",
        version: "4.0.0",
        scheduleHash: "0",
      }),
    );
    const validPayload = JSON.stringify({
      protocolVersion: 1,
      id: "A1",
      name: "One",
      freq: 5_000,
      res: 8,
      status: "online",
      version: CURRENT_ESP_FIRMWARE_VERSION,
      scheduleHash: "0",
    });
    client.emitText("test/aquarium/v1/devices/A1/announce", validPayload);
    await vi.waitFor(async () => {
      const device = await databases.state
        .selectFrom("devices")
        .select("id")
        .where("id", "=", "A1")
        .executeTakeFirst();
      expect(device, errors.map((error) => error.message).join(" | ")).toEqual({
        id: "A1",
      });
    });
    expect(errors).toEqual([]);
    await vi.waitFor(async () => {
      const malformed = await databases.events
        .selectFrom("interactions")
        .select(({ fn }) => fn.countAll<number>().as("count"))
        .where("kind", "=", "mqtt.malformed-message")
        .executeTakeFirstOrThrow();
      expect(Number(malformed.count)).toBeGreaterThan(0);
    });
    expect(alertEvaluationTimes).toContain(10_000);

    await vi.waitFor(() =>
      expect(publishedCommand(client, "A1 sync 10")).toBeDefined(),
    );
    const syncCallIndex = executeDeviceOperation.mock.calls.findIndex(
      ([, request]) => request.kind === "sync_time",
    );
    const syncOperation =
      executeDeviceOperation.mock.results[syncCallIndex]?.value;
    if (syncOperation === undefined) {
      throw new Error("Expected the announcement time-sync operation");
    }
    emitCommandResponse(client, "A1 sync 10", "A1", "10");
    await syncOperation;

    const operation = composition.deviceOperations.executeDeviceOperation(
      "A1",
      { kind: "ping" },
    );
    await vi.waitFor(() =>
      expect(publishedCommand(client, "A1 p")).toBeDefined(),
    );
    await vi.advanceTimersByTimeAsync(1_000);
    const skipped = await databases.events
      .selectFrom("interactions")
      .select(({ fn }) => fn.countAll<number>().as("count"))
      .where("kind", "=", "mqtt.discovery-skipped")
      .executeTakeFirstOrThrow();
    expect(Number(skipped.count)).toBe(0);
    expect(
      client.publishes.filter(({ payload }) => payload === "discover"),
    ).toHaveLength(1);

    await composition.runtime.stop();
    await expect(operation).resolves.toMatchObject({
      status: "outcome_unknown",
      result: { reason: "transport_stopped" },
    });
    expect(client.stops).toBe(1);
    expect(
      client.publishes.every(({ topic }) => topic.startsWith("test/aquarium/")),
    ).toBe(true);

    const announcementLogs = await databases.events
      .selectFrom("interactions")
      .select(({ fn }) => fn.countAll<number>().as("count"))
      .where("kind", "=", "mqtt.announcement")
      .where("device_id", "=", "A1")
      .executeTakeFirstOrThrow();
    expect(Number(announcementLogs.count)).toBe(0);
  });

  it("requires a completed persisted-state reconciliation for every connection", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const databases = await openDatabasesForTest();
    const client = new InMemoryMqttClient();
    const errors: Error[] = [];
    const composition = composeControllerRuntime({
      configuration: enabledConfiguration(),
      stateDatabase: databases.state,
      eventsDatabase: databases.events,
      clientFactory: () => client,
      now: Date.now,
      onError: (error) => errors.push(error),
    });
    if (!composition.mqttEnabled) {
      throw new Error("Expected enabled MQTT runtime composition");
    }
    await composition.runtime.start();

    client.emitConnected();
    await vi.waitFor(() => expect(composition.runtime.isReady()).toBe(true));
    client.emitDisconnected();
    expect(composition.runtime.isReady()).toBe(false);

    client.emitConnected();
    expect(composition.runtime.isReady()).toBe(false);
    await vi.waitFor(() => expect(composition.runtime.isReady()).toBe(true));
    expect(errors).toEqual([]);

    await composition.runtime.stop();
  });

  it("starts despite a persisted device-local unknown outcome and allows operator reconciliation", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const databases = await openDatabasesForTest();
    await databases.state
      .insertInto("devices")
      .values({
        id: "device-main",
        hardware_id: "hardware-main",
        name: "Main",
        desired_pwm_frequency_hz: 5_000,
        desired_pwm_resolution_bits: 8,
        created_at_ms: 0,
        updated_at_ms: 0,
      })
      .executeTakeFirstOrThrow();
    const repository = new ControlOperationRepository(databases.state);
    await repository.createPending({
      id: "persisted-unknown",
      deviceId: "device-main",
      requestedAtMs: 100,
      deadlineAtMs: 1_000,
      request: { kind: "ping" },
    });
    await repository.markInFlight("persisted-unknown", 110);
    await repository.completeInFlight("persisted-unknown", 120, {
      status: "outcome_unknown",
      wireOperationId: "wire-persisted",
      reason: "controller_restart",
      reconciledAtMs: null,
    });
    const client = new InMemoryMqttClient();
    const errors: Error[] = [];
    const composition = composeControllerRuntime({
      configuration: enabledConfiguration(),
      stateDatabase: databases.state,
      eventsDatabase: databases.events,
      clientFactory: () => client,
      now: Date.now,
      onError: (error) => errors.push(error),
    });
    if (!composition.mqttEnabled) {
      throw new Error("Expected enabled MQTT runtime composition");
    }
    await composition.runtime.start();
    client.emitConnected();
    await vi.waitFor(() => expect(client.subscriptions).toHaveLength(1));
    await vi.advanceTimersByTimeAsync(100);
    expect(composition.runtime.isReady()).toBe(true);

    const expectedRevision = await latestRevision(databases);
    await expect(
      composition.deviceOperations.reconcileDeviceOperation(
        "persisted-unknown",
        expectedRevision,
      ),
    ).resolves.toMatchObject({ changed: true });
    await vi.waitFor(() => expect(composition.runtime.isReady()).toBe(true));
    expect(errors).toEqual([]);

    await composition.runtime.stop();
  });

  it("keeps a live direct-operation unknown local across reconnect and reconciliation", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const databases = await openDatabasesForTest();
    await databases.state
      .insertInto("devices")
      .values({
        id: "device-main",
        hardware_id: "hardware-main",
        name: "Main",
        desired_pwm_frequency_hz: 5_000,
        desired_pwm_resolution_bits: 8,
        status: "offline",
        firmware_version: CURRENT_ESP_FIRMWARE_VERSION,
        created_at_ms: 0,
        updated_at_ms: 0,
      })
      .executeTakeFirstOrThrow();
    const client = new InMemoryMqttClient();
    const errors: Error[] = [];
    const composition = composeControllerRuntime({
      configuration: enabledConfiguration(),
      stateDatabase: databases.state,
      eventsDatabase: databases.events,
      clientFactory: () => client,
      now: Date.now,
      onError: (error) => errors.push(error),
    });
    if (!composition.mqttEnabled) {
      throw new Error("Expected enabled MQTT runtime composition");
    }
    await composition.runtime.start();
    client.emitConnected();
    await vi.waitFor(() => expect(composition.runtime.isReady()).toBe(true));
    const operation = composition.deviceOperations.executeDeviceOperation(
      "device-main",
      { kind: "ping" },
    );
    await vi.waitFor(() =>
      expect(publishedCommand(client, "hardware-main p")).toBeDefined(),
    );
    client.emitDisconnected();
    await expect(operation).resolves.toMatchObject({
      status: "outcome_unknown",
    });
    expect(composition.runtime.isReady()).toBe(false);

    client.emitConnected();
    await vi.advanceTimersByTimeAsync(100);
    expect(composition.runtime.isReady()).toBe(true);
    const unknown = await databases.state
      .selectFrom("control_operations")
      .select("id")
      .where("device_id", "=", "device-main")
      .where("status", "=", "outcome_unknown")
      .executeTakeFirstOrThrow();
    await composition.deviceOperations.reconcileDeviceOperation(
      unknown.id,
      await latestRevision(databases),
    );
    await vi.waitFor(() => expect(composition.runtime.isReady()).toBe(true));
    expect(errors).toEqual([]);

    await composition.runtime.stop();
  });

  it("stays unready when persisted-state reconciliation fails", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(10_000);
    const databases = await openDatabasesForTest();
    const client = new InMemoryMqttClient();
    const errors: Error[] = [];
    const composition = composeControllerRuntime({
      configuration: enabledConfiguration(),
      stateDatabase: databases.state,
      eventsDatabase: databases.events,
      clientFactory: () => client,
      now: Date.now,
      onError: (error) => errors.push(error),
    });
    if (!composition.mqttEnabled) {
      throw new Error("Expected enabled MQTT runtime composition");
    }
    await composition.runtime.start();
    await databases.state.schema.dropTable("devices").execute();

    client.emitConnected();
    await vi.waitFor(() => expect(errors.length).toBeGreaterThan(0));
    expect(composition.runtime.isReady()).toBe(false);

    await composition.runtime.stop();
  });
});

function enabledConfiguration() {
  return parseControllerConfiguration({
    AQUARIUM_RUNTIME_MODE: "test",
    AQUARIUM_MQTT_ENABLED: "true",
    AQUARIUM_MQTT_BROKER_URL: "mqtt://127.0.0.1:1883",
    AQUARIUM_MQTT_TOPIC_NAMESPACE: "test",
    AQUARIUM_MQTT_RESPONSE_TIMEOUT_MS: "60000",
    AQUARIUM_MQTT_DISCOVERY_INTERVAL_MS: "1000",
    AQUARIUM_DEVICE_ANNOUNCEMENT_PERSIST_INTERVAL_MS: "1000",
    AQUARIUM_DEVICE_STALE_AFTER_MS: "5000",
    AQUARIUM_DEVICE_OFFLINE_AFTER_MS: "10000",
    AQUARIUM_DEVICE_HEALTH_SWEEP_INTERVAL_MS: "500",
    NODE_ENV: "test",
  });
}

async function openDatabasesForTest(): Promise<ControllerDatabases> {
  const databases = await openControllerDatabases({
    state: { filename: ":memory:" },
    events: { filename: ":memory:" },
  });
  openDatabases.push(databases);
  return databases;
}

async function latestRevision(databases: ControllerDatabases): Promise<number> {
  const row = await databases.state
    .selectFrom("state_revisions")
    .select(({ fn }) => fn.max<number>("revision").as("revision"))
    .executeTakeFirstOrThrow();
  return Number(row.revision ?? 0);
}

interface PublishRecord {
  readonly topic: string;
  readonly payload: string;
  readonly options: QosZeroPublishOptions;
}

function publishedCommand(
  client: InMemoryMqttClient,
  command: string,
): PublishRecord | undefined {
  const [deviceId, operation, argument] = command.split(" ");
  const expectedKind = operation === "p" ? "ping" : "sync_time";
  return client.publishes.find(({ topic, payload }) => {
    if (topic !== `test/aquarium/v1/devices/${deviceId}/command`) return false;
    try {
      const request = JSON.parse(payload) as EspCommandRequest;
      return request.commands.some(
        (candidate) =>
          candidate.kind === expectedKind &&
          (candidate.kind !== "sync_time" ||
            candidate.epochSeconds === Number(argument)),
      );
    } catch {
      return false;
    }
  });
}

function emitCommandResponse(
  client: InMemoryMqttClient,
  command: string,
  deviceId: string,
  response: string,
): void {
  const publication = publishedCommand(client, command);
  if (publication === undefined) {
    throw new Error(`Command ${command} was not published`);
  }
  const request = JSON.parse(publication.payload) as EspCommandRequest;
  const requestCommand = request.commands[0];
  if (requestCommand === undefined) {
    throw new Error(`Command ${command} has no request correlation`);
  }
  const result: EspCommandResult =
    requestCommand.kind === "sync_time"
      ? {
          index: requestCommand.index,
          kind: "sync_time",
          ok: true,
          epochSeconds: Number(response),
        }
      : { index: requestCommand.index, kind: "ping", ok: true };
  client.emitText(
    `test/aquarium/v1/devices/${deviceId}/response`,
    JSON.stringify({
      protocolVersion: 1,
      deviceId,
      name: deviceId,
      requestId: request.requestId,
      results: [result],
    }),
  );
}

class InMemoryMqttClient implements LegacyMqttClientPort {
  readonly subscriptions: string[][] = [];
  readonly publishes: PublishRecord[] = [];
  readonly #connectedHandlers = new Set<() => void>();
  readonly #disconnectedHandlers = new Set<() => void>();
  readonly #errorHandlers = new Set<(error: Error) => void>();
  readonly #messageHandlers = new Set<MqttMessageHandler>();
  starts = 0;
  stops = 0;

  onConnected(handler: () => void): () => void {
    this.#connectedHandlers.add(handler);
    return () => this.#connectedHandlers.delete(handler);
  }

  onDisconnected(handler: () => void): () => void {
    this.#disconnectedHandlers.add(handler);
    return () => this.#disconnectedHandlers.delete(handler);
  }

  onError(handler: (error: Error) => void): () => void {
    this.#errorHandlers.add(handler);
    return () => this.#errorHandlers.delete(handler);
  }

  onMessage(handler: MqttMessageHandler): () => void {
    this.#messageHandlers.add(handler);
    return () => this.#messageHandlers.delete(handler);
  }

  start(): void {
    this.starts += 1;
  }

  async subscribe(
    topics: readonly string[],
    options: QosZeroSubscribeOptions,
  ): Promise<void> {
    expect(options).toEqual({ qos: 0 });
    this.subscriptions.push([...topics]);
  }

  async publish(
    topic: string,
    payload: string,
    options: QosZeroPublishOptions,
  ): Promise<void> {
    this.publishes.push({ topic, payload, options });
  }

  async stop(): Promise<void> {
    this.stops += 1;
  }

  emitConnected(): void {
    for (const handler of this.#connectedHandlers) {
      handler();
    }
  }

  emitDisconnected(): void {
    for (const handler of this.#disconnectedHandlers) {
      handler();
    }
  }

  emitText(topic: string, payload: string): void {
    for (const handler of this.#messageHandlers) {
      handler(topic, encoder.encode(payload));
    }
  }
}
