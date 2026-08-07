import { describe, expect, it, vi } from "vitest";

import {
  assertLoopbackMqttBrokerUrl,
  createFakeEspMqttConnectionOptions,
  MqttFakeEspSession,
  type FakeEspMqttClientPort,
} from "./mqtt-transport.js";
import { encodeFakeEspCommandRequest } from "./structured-protocol.js";
import { createFakeEspTopics, InMemoryFakeEspBus } from "./transport.js";

const encoder = new TextEncoder();

interface PublishedMessage {
  readonly topic: string;
  readonly payload: string;
  readonly options: { readonly qos: 0; readonly retain: false };
}

class TestMqttClient implements FakeEspMqttClientPort {
  public readonly actions: string[] = [];
  public readonly publications: PublishedMessage[] = [];
  public subscribeError: Error | undefined;
  public subscribeBlocker: Promise<void> | undefined;
  public stopErrorEmission: Error | undefined;
  private readonly connectedHandlers = new Set<() => void>();
  private readonly disconnectedHandlers = new Set<() => void>();
  private readonly errorHandlers = new Set<(error: Error) => void>();
  private readonly messageHandlers = new Set<
    (topic: string, payload: Uint8Array) => void
  >();

  public onConnected(handler: () => void): () => void {
    this.connectedHandlers.add(handler);
    return () => this.connectedHandlers.delete(handler);
  }

  public onDisconnected(handler: () => void): () => void {
    this.disconnectedHandlers.add(handler);
    return () => this.disconnectedHandlers.delete(handler);
  }

  public onError(handler: (error: Error) => void): () => void {
    this.errorHandlers.add(handler);
    return () => this.errorHandlers.delete(handler);
  }

  public onMessage(
    handler: (topic: string, payload: Uint8Array) => void,
  ): () => void {
    this.messageHandlers.add(handler);
    return () => this.messageHandlers.delete(handler);
  }

  public start(): void {
    this.actions.push("start");
  }

  public async subscribe(
    topic: string,
    options: { readonly qos: 0 },
  ): Promise<void> {
    this.actions.push(`subscribe:${topic}:${options.qos}`);
    if (this.subscribeError !== undefined) {
      throw this.subscribeError;
    }
    await this.subscribeBlocker;
  }

  public publish(
    topic: string,
    payload: string,
    options: { readonly qos: 0; readonly retain: false },
  ): void {
    this.actions.push(`publish:${topic}`);
    this.publications.push({ topic, payload, options });
  }

  public async stop(): Promise<void> {
    this.actions.push("stop");
    if (this.stopErrorEmission !== undefined) {
      this.emitError(this.stopErrorEmission);
    }
  }

  public emitConnected(): void {
    for (const handler of this.connectedHandlers) {
      handler();
    }
  }

  public emitDisconnected(): void {
    for (const handler of this.disconnectedHandlers) {
      handler();
    }
  }

  public emitError(error: Error): void {
    for (const handler of this.errorHandlers) {
      handler(error);
    }
  }

  public emitMessage(topic: string, payload: string): void {
    for (const handler of this.messageHandlers) {
      handler(topic, encoder.encode(payload));
    }
  }
}

describe("fake ESP MQTT safety and lifecycle", () => {
  it("accepts only credential-free loopback MQTT URLs", () => {
    for (const url of [
      "mqtt://localhost:1883",
      "mqtt://127.0.0.1:1883",
      "mqtt://127.99.10.4:12345",
      "mqtt://[::1]:1883",
    ]) {
      expect(() => assertLoopbackMqttBrokerUrl(url)).not.toThrow();
    }

    for (const url of [
      "mqtt://192.0.2.1:1883",
      "mqtt://broker.example:1883",
      "mqtts://localhost:8883",
      "mqtt://user:secret@localhost:1883",
      "mqtt://localhost:1883/path",
      "mqtt://localhost:1883/?unsafe=1",
    ]) {
      expect(() => assertLoopbackMqttBrokerUrl(url)).toThrow(/loopback/);
    }
  });

  it("pins MQTT 3.1.1, clean sessions, and disabled QoS-zero queueing", () => {
    expect(
      createFakeEspMqttConnectionOptions({
        brokerUrl: "mqtt://127.0.0.1:1883",
        clientId: "fake-alpha",
      }),
    ).toEqual({
      protocolVersion: 4,
      protocolId: "MQTT",
      clean: true,
      manualConnect: true,
      queueQoSZero: false,
      resubscribe: false,
      keepalive: 15,
      connectTimeout: 10_000,
      reconnectPeriod: 1_000,
      clientId: "fake-alpha",
    });
  });

  it("subscribes before announcing and publishes only QoS-zero non-retained messages", async () => {
    const client = new TestMqttClient();
    const session = createSession(client);
    const ready = session.start();
    client.emitConnected();
    await ready;

    expect(client.actions.slice(0, 4)).toEqual([
      "start",
      "subscribe:test/aquarium/v1/discovery/request:0",
      "subscribe:test/aquarium/v1/devices/A1B2C3D4/command:0",
      "publish:test/aquarium/v1/devices/A1B2C3D4/announce",
    ]);
    expect(client.publications[0]?.options).toEqual({ qos: 0, retain: false });

    client.emitMessage(
      "test/aquarium/v1/devices/A1B2C3D4/command",
      pingRequest(),
    );
    expect(client.publications.at(-1)).toMatchObject({
      topic: "test/aquarium/v1/devices/A1B2C3D4/response",
      options: { qos: 0, retain: false },
    });
    await session.stop();
  });

  it("disconnects the actor, then resubscribes before its reconnect announcement", async () => {
    const client = new TestMqttClient();
    const session = createSession(client);
    const ready = session.start();
    client.emitConnected();
    await ready;
    client.emitDisconnected();
    expect(session.actor.isReady()).toBe(false);

    client.emitConnected();
    await vi.waitFor(() => {
      expect(
        client.actions.filter((action) => action.startsWith("subscribe:")),
      ).toHaveLength(4);
      expect(
        client.publications.filter(({ topic }) => topic.endsWith("/announce")),
      ).toHaveLength(2);
    });
    await session.stop();
  });

  it("isolates and restores the simulated network without stopping MQTT", async () => {
    const client = new TestMqttClient();
    const session = createSession(client);
    const ready = session.start();
    client.emitConnected();
    await ready;
    expect(session.isMqttConnected()).toBe(true);
    expect(session.actor.isReady()).toBe(true);

    session.setNetworkEnabled(false);
    expect(session.isNetworkEnabled()).toBe(false);
    expect(session.isMqttConnected()).toBe(true);
    expect(session.actor.isReady()).toBe(false);
    const publicationCount = client.publications.length;
    client.emitMessage(
      "test/aquarium/v1/devices/A1B2C3D4/command",
      pingRequest(),
    );
    expect(client.publications).toHaveLength(publicationCount);

    session.setNetworkEnabled(true);
    expect(session.actor.isReady()).toBe(true);
    expect(
      client.publications.filter(({ topic }) => topic.endsWith("/announce")),
    ).toHaveLength(2);
    await session.stop();
  });

  it("can start MQTT with the simulated device network disabled", async () => {
    const client = new TestMqttClient();
    const session = createSession(client, undefined, false);
    const ready = session.start();
    client.emitConnected();
    await ready;

    expect(session.isMqttConnected()).toBe(true);
    expect(session.actor.isReady()).toBe(false);
    expect(client.publications).toEqual([]);
    await session.stop();
  });

  it("fails initial readiness loudly when subscription fails", async () => {
    const client = new TestMqttClient();
    client.subscribeError = new Error("SUBACK rejected");
    const session = createSession(client);
    const ready = session.start();
    client.emitConnected();

    await expect(ready).rejects.toThrow(/SUBACK/);
    expect(client.publications).toEqual([]);
    await session.stop();
  });

  it("rejects readiness when stopped before the initial connection", async () => {
    const client = new TestMqttClient();
    const session = createSession(client);
    const ready = session.start();
    const readinessFailure = expect(ready).rejects.toThrow(/stopped before/);

    await session.stop();
    await readinessFailure;
    expect(() => session.start()).toThrow(/already started|cannot be started/);
  });

  it("rejects readiness when stopped while waiting for SUBACK", async () => {
    const client = new TestMqttClient();
    let releaseSubscription = (): void => {
      throw new Error("Subscription blocker was not initialized");
    };
    client.subscribeBlocker = new Promise<void>((resolve) => {
      releaseSubscription = resolve;
    });
    const session = createSession(client);
    const ready = session.start();
    client.emitConnected();
    await vi.waitFor(() =>
      expect(client.actions).toContain(
        "subscribe:test/aquarium/v1/devices/A1B2C3D4/command:0",
      ),
    );
    const readinessFailure = expect(ready).rejects.toThrow(/stopped before/);

    await session.stop();
    releaseSubscription();
    await readinessFailure;
    expect(client.publications).toEqual([]);
  });

  it("captures MQTT errors without an unhandled event", async () => {
    const client = new TestMqttClient();
    const observed: Error[] = [];
    const session = createSession(client, (error) => observed.push(error));
    const ready = session.start();
    client.emitConnected();
    await ready;

    const failure = new Error("socket closed");
    client.emitError(failure);
    expect(session.lastError()).toBe(failure);
    expect(observed).toEqual([failure]);
    await session.stop();
  });

  it("keeps the MQTT error handler attached through client shutdown", async () => {
    const client = new TestMqttClient();
    const observed: Error[] = [];
    const session = createSession(client, (error) => observed.push(error));
    const ready = session.start();
    client.emitConnected();
    await ready;

    const reset = new Error("read ECONNRESET");
    client.stopErrorEmission = reset;
    await session.stop();

    expect(session.lastError()).toBe(reset);
    expect(observed).toEqual([reset]);
  });

  it("rejects production, wildcard, empty-segment, and wrong-direction topics", () => {
    expect(() => createFakeEspTopics("aquarium")).toThrow(/test namespaces/);
    expect(() => createFakeEspTopics("test/aquarium/#")).toThrow(/segments/);
    expect(() => createFakeEspTopics("test/aquarium//x")).toThrow(/segments/);
    const topics = createFakeEspTopics("test/aquarium/r8");
    expect(topics.discoveryRequest).toBe(
      "test/aquarium/r8/v1/discovery/request",
    );
    expect(topics.command("A1B2C3D4")).toBe(
      "test/aquarium/r8/v1/devices/A1B2C3D4/command",
    );
    expect(topics.announcement("A1B2C3D4")).toBe(
      "test/aquarium/r8/v1/devices/A1B2C3D4/announce",
    );
    expect(topics.response("A1B2C3D4")).toBe(
      "test/aquarium/r8/v1/devices/A1B2C3D4/response",
    );

    const bus = new InMemoryFakeEspBus();
    expect(() => bus.publishFromHost("aquarium/command", "discover")).toThrow();
    expect(() =>
      bus.publishFromHost("test/aquarium/response", "unsafe"),
    ).toThrow(/structured test namespace/);
  });
});

function pingRequest(): string {
  return encodeFakeEspCommandRequest({
    deviceId: "A1B2C3D4",
    requestId: "mqtt-test-ping",
    commands: [{ index: 0, kind: "ping" }],
  });
}

function createSession(
  client: TestMqttClient,
  onError?: (error: Error) => void,
  networkEnabled?: boolean,
): MqttFakeEspSession {
  return new MqttFakeEspSession({
    brokerUrl: "mqtt://127.0.0.1:1883",
    clientId: "fake-alpha",
    actor: {
      defaultDeviceName: "Alpha",
      idGenerator: () => "A1B2C3D4",
    },
    clientFactory: () => client,
    ...(networkEnabled === undefined ? {} : { networkEnabled }),
    ...(onError === undefined ? {} : { onError }),
  });
}
