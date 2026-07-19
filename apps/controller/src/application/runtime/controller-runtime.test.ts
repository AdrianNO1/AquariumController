import { afterEach, describe, expect, it, vi } from "vitest";

import { parseControllerConfiguration } from "../../configuration.js";
import {
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

  it("uses guarded test topics, survives callback failures, logs truthful bytes, and skips busy discovery without catch-up", async () => {
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

    expect(composition.runtime.isReady()).toBe(false);
    await composition.runtime.start();
    expect(composition.runtime.isReady()).toBe(false);
    expect(client.starts).toBe(1);
    client.emitConnected();
    await vi.waitFor(() => expect(composition.runtime.isReady()).toBe(true));
    expect(client.publishes).toHaveLength(1);
    expect(client.subscriptions).toEqual([
      ["test/aquarium/announce", "test/aquarium/response"],
    ]);
    expect(client.publishes[0]).toMatchObject({
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
    const validPayload =
      '{ "id":"A1", "name":"One", "freq":5000, "res":8, "status":"online", "version":"4.0.0", "scheduleHash":"0" }';
    client.emitText("test/aquarium/announce", validPayload);
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
    expect(errors.length).toBeGreaterThan(0);
    expect(alertEvaluationTimes).toContain(10_000);

    await vi.waitFor(() =>
      expect(
        client.publishes.some(({ payload }) => payload === "A1 sync 10"),
      ).toBe(true),
    );
    client.emitText(
      "test/aquarium/response",
      JSON.stringify({
        id: "A1",
        name: "A1",
        responses: [{ index: 0, response: "10" }],
      }),
    );

    const operation = composition.deviceOperations.executeDeviceOperation(
      "A1",
      { kind: "ping" },
    );
    await vi.waitFor(() =>
      expect(client.publishes.some(({ payload }) => payload === "A1 p")).toBe(
        true,
      ),
    );
    await vi.advanceTimersByTimeAsync(1_000);
    await vi.waitFor(async () => {
      const skipped = await databases.events
        .selectFrom("interactions")
        .select(({ fn }) => fn.countAll<number>().as("count"))
        .where("kind", "=", "mqtt.discovery-skipped")
        .executeTakeFirstOrThrow();
      expect(Number(skipped.count)).toBe(1);
    });
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
      client.publishes.every(({ topic }) => topic === "test/aquarium/command"),
    ).toBe(true);

    const announcementLog = await databases.events
      .selectFrom("interactions")
      .selectAll()
      .where("kind", "=", "mqtt.announcement")
      .where("device_id", "=", "A1")
      .executeTakeFirstOrThrow();
    expect(announcementLog).toMatchObject({
      topic: "test/aquarium/announce",
      byte_count: encoder.encode(validPayload).byteLength,
      outcome: "succeeded",
    });
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

interface PublishRecord {
  readonly topic: string;
  readonly payload: string;
  readonly options: QosZeroPublishOptions;
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
