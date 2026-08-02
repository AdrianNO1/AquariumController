import {
  createEspTopicSet,
  encodeCorrelatedLegacyRequest,
  encodeLegacyMessage,
} from "@aquarium/esp-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  LegacyMqttClientPort,
  MqttMessageHandler,
  QosZeroPublishOptions,
  QosZeroSubscribeOptions,
} from "./client-port.js";
import {
  LegacyMqttTransport,
  LegacyMqttUnavailableError,
  type LegacyAnnouncementEvent,
  type LegacyMqttInteraction,
  type LegacyMqttTransportCallbacks,
  type LegacyExpectedResponse,
  type LegacyWireCommand,
} from "./legacy-mqtt-transport.js";
import { createMqttJsConnectionOptions } from "./mqtt-js-client.js";

const topics = createEspTopicSet(true);
const encoder = new TextEncoder();

interface PublishCall {
  readonly topic: string;
  readonly payload: string;
  readonly options: QosZeroPublishOptions;
}

interface SubscribeCall {
  readonly topics: readonly string[];
  readonly options: QosZeroSubscribeOptions;
}

class InMemoryMqttClient implements LegacyMqttClientPort {
  public readonly publishes: PublishCall[] = [];
  public readonly subscriptions: SubscribeCall[] = [];
  public starts = 0;
  public stops = 0;
  public onPublish: ((call: PublishCall) => void | Promise<void>) | undefined;
  private readonly connectedHandlers = new Set<() => void>();
  private readonly disconnectedHandlers = new Set<() => void>();
  private readonly errorHandlers = new Set<(error: Error) => void>();
  private readonly messageHandlers = new Set<MqttMessageHandler>();

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

  public onMessage(handler: MqttMessageHandler): () => void {
    this.messageHandlers.add(handler);
    return () => this.messageHandlers.delete(handler);
  }

  public start(): void {
    this.starts += 1;
  }

  public async subscribe(
    requestedTopics: readonly string[],
    options: QosZeroSubscribeOptions,
  ): Promise<void> {
    this.subscriptions.push({ topics: [...requestedTopics], options });
  }

  public async publish(
    topic: string,
    payload: string,
    options: QosZeroPublishOptions,
  ): Promise<void> {
    const call = { topic, payload, options } as const;
    this.publishes.push(call);
    await this.onPublish?.(call);
  }

  public async stop(): Promise<void> {
    this.stops += 1;
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

  public emitJson(topic: string, payload: object): void {
    this.emitBytes(topic, encoder.encode(JSON.stringify(payload)));
  }

  public emitText(topic: string, payload: string): void {
    this.emitBytes(topic, encoder.encode(payload));
  }

  public emitBytes(topic: string, payload: Uint8Array): void {
    for (const handler of this.messageHandlers) {
      handler(topic, payload);
    }
  }
}

afterEach(() => {
  vi.useRealTimers();
});

describe("legacy MQTT transport in-memory state-machine unit", () => {
  it("fixes MQTT.js to MQTT 3.1.1 and subscribes before non-retained discovery", async () => {
    const mqttOptions = createMqttJsConnectionOptions({
      brokerUrl: "mqtt://127.0.0.1:1883",
    });
    expect(mqttOptions).toMatchObject({
      protocolVersion: 4,
      protocolId: "MQTT",
      clean: true,
      manualConnect: true,
      queueQoSZero: false,
      resubscribe: false,
    });

    const client = new InMemoryMqttClient();
    const announcements: string[] = [];
    const transport = new LegacyMqttTransport({
      clientFactory: () => client,
      topics,
      callbacks: {
        onAnnouncement: ({ announcement }) =>
          announcements.push(announcement.id),
      },
    });

    transport.start();
    expect(client.starts).toBe(1);
    client.emitConnected();
    await vi.waitFor(() => expect(client.publishes).toHaveLength(1));

    expect(client.subscriptions).toEqual([
      {
        topics: [topics.announce, topics.response],
        options: { qos: 0 },
      },
    ]);
    expect(client.publishes[0]).toEqual({
      topic: topics.command,
      payload: "discover",
      options: { qos: 0, retain: false },
    });

    client.emitJson(topics.announce, announcement("A1", "One"));
    expect(announcements).toEqual(["A1"]);

    client.emitDisconnected();
    client.emitConnected();
    await vi.waitFor(() => expect(client.subscriptions).toHaveLength(2));
    await vi.waitFor(() => expect(client.publishes).toHaveLength(2));
    expect(client.publishes[1]?.payload).toBe("discover");

    await transport.stop();
    expect(client.stops).toBe(1);
  });

  it("rejects unsafe MQTT.js connection option shapes before creating a client", () => {
    expect(() =>
      createMqttJsConnectionOptions({ brokerUrl: "http://127.0.0.1:1883" }),
    ).toThrow(/mqtt:\/\//i);
    expect(() =>
      createMqttJsConnectionOptions({
        brokerUrl: "mqtt://127.0.0.1:1883",
        connectTimeoutMs: 0,
      }),
    ).toThrow(/connectTimeoutMs/);
  });

  it("surfaces invalid UTF-8, invalid JSON, and invalid schemas without stopping", async () => {
    const client = new InMemoryMqttClient();
    const interactions: LegacyMqttInteraction[] = [];
    const announcements: string[] = [];
    const transport = await readyTransport(client, {
      onInteraction: (interaction) => interactions.push(interaction),
      onAnnouncement: ({ announcement: value }) => announcements.push(value.id),
    });

    client.emitBytes(topics.announce, new Uint8Array([0xc3, 0x28]));
    client.emitText(topics.announce, "{");
    client.emitJson(topics.announce, { id: "missing-required-fields" });
    client.emitJson(topics.announce, announcement("A1", "One"));

    expect(
      interactions.filter(({ kind }) => kind === "malformed_message"),
    ).toHaveLength(3);
    expect(announcements).toEqual(["A1"]);
    await transport.stop();
  });

  it("reports original wire byte counts while bounding raw previews", async () => {
    const client = new InMemoryMqttClient();
    const interactions: LegacyMqttInteraction[] = [];
    const announcementEvents: LegacyAnnouncementEvent[] = [];
    const transport = await readyTransport(client, {
      onInteraction: (interaction) => interactions.push(interaction),
      onAnnouncement: (event) => announcementEvents.push(event),
    });
    const malformed = "x".repeat(3_000);
    const ignored = "é".repeat(1_500);
    const validAnnouncement = JSON.stringify(announcement("A1", "One"));

    client.emitText(topics.announce, malformed);
    client.emitText("test/aquarium/unsubscribed", ignored);
    client.emitText(topics.announce, validAnnouncement);

    expect(
      interactions.find(
        (interaction) => interaction.kind === "malformed_message",
      ),
    ).toMatchObject({
      kind: "malformed_message",
      payloadBytes: 3_000,
      previewTruncated: true,
      payloadPreview: "x".repeat(2_048),
    });
    expect(
      interactions.find(
        (interaction) => interaction.kind === "ignored_message",
      ),
    ).toMatchObject({
      kind: "ignored_message",
      payloadBytes: 3_000,
      previewTruncated: false,
      payloadPreview: ignored,
    });
    expect(announcementEvents).toMatchObject([
      {
        announcement: { id: "A1" },
        payloadBytes: encoder.encode(validAnnouncement).byteLength,
      },
    ]);
    await transport.stop();
  });

  it("runs different device lanes concurrently and correlates out-of-order responses", async () => {
    const client = new InMemoryMqttClient();
    const transport = await readyTransport(client);
    const first = transport.executeCommands([ping("A1")]);
    const second = transport.executeCommands([ping("A2")]);

    await vi.waitFor(() => expect(commandPublishes(client)).toHaveLength(2));
    expect(commandPublishes(client)[0]?.payload).toBe(
      encodeCorrelatedLegacyRequest("session-request-1", "A1 p"),
    );
    expect(commandPublishes(client)[1]?.payload).toBe(
      encodeCorrelatedLegacyRequest("session-request-2", "A2 p"),
    );

    client.emitJson(
      topics.response,
      response("A2", [{ index: 0, response: "o" }], "session-request-2"),
    );
    expect((await second).outcomes[0]?.status).toBe("succeeded");
    client.emitJson(
      topics.response,
      response("A1", [{ index: 0, response: "o" }], "session-request-1"),
    );
    expect((await first).outcomes[0]).toMatchObject({
      status: "succeeded",
      response: "o",
      analogValue: null,
    });
    await transport.stop();
  });

  it("preserves FIFO within one device while another device continues", async () => {
    const client = new InMemoryMqttClient();
    const transport = await readyTransport(client);
    const firstA = transport.executeCommands([ping("A1")]);
    const secondA = transport.executeCommands([ping("A1")]);
    const deviceB = transport.executeCommands([ping("A2")]);

    await vi.waitFor(() => expect(commandPublishes(client)).toHaveLength(2));
    expect(commandPublishes(client).map(({ payload }) => payload)).toEqual([
      encodeCorrelatedLegacyRequest("session-request-1", "A1 p"),
      encodeCorrelatedLegacyRequest("session-request-2", "A2 p"),
    ]);

    client.emitJson(
      topics.response,
      response("A2", [{ index: 0, response: "o" }], "session-request-2"),
    );
    await expect(deviceB).resolves.toMatchObject({
      outcomes: [{ status: "succeeded" }],
    });
    expect(commandPublishes(client)).toHaveLength(2);

    client.emitJson(
      topics.response,
      response("A1", [{ index: 0, response: "o" }], "session-request-1"),
    );
    await expect(firstA).resolves.toMatchObject({
      outcomes: [{ status: "succeeded" }],
    });
    await vi.waitFor(() => expect(commandPublishes(client)).toHaveLength(3));
    expect(commandPublishes(client)[2]?.payload).toBe(
      encodeCorrelatedLegacyRequest("session-request-3", "A1 p"),
    );
    client.emitJson(
      topics.response,
      response("A1", [{ index: 0, response: "o" }], "session-request-3"),
    );
    await expect(secondA).resolves.toMatchObject({
      outcomes: [{ status: "succeeded" }],
    });
    await transport.stop();
  });

  it("bounds concurrent device lanes and fairly starts the next device", async () => {
    const client = new InMemoryMqttClient();
    const transport = await readyTransport(client, {}, 1_000, 2);
    const operations = ["A1", "A2", "A3"].map((id) =>
      transport.executeCommands([ping(id)]),
    );

    await vi.waitFor(() => expect(commandPublishes(client)).toHaveLength(2));
    expect(commandPublishes(client).map(({ payload }) => payload)).toEqual([
      encodeCorrelatedLegacyRequest("session-request-1", "A1 p"),
      encodeCorrelatedLegacyRequest("session-request-2", "A2 p"),
    ]);
    client.emitJson(
      topics.response,
      response("A2", [{ index: 0, response: "o" }], "session-request-2"),
    );

    await vi.waitFor(() => expect(commandPublishes(client)).toHaveLength(3));
    expect(commandPublishes(client)[2]?.payload).toBe(
      encodeCorrelatedLegacyRequest("session-request-3", "A3 p"),
    );
    client.emitJson(
      topics.response,
      response("A1", [{ index: 0, response: "o" }], "session-request-1"),
    );
    client.emitJson(
      topics.response,
      response("A3", [{ index: 0, response: "o" }], "session-request-3"),
    );
    await expect(Promise.all(operations)).resolves.toHaveLength(3);
    await transport.stop();
  });

  it("prefers an interactive device head over an earlier background device head", async () => {
    const client = new InMemoryMqttClient();
    const transport = await readyTransport(client, {}, 1_000, 1);
    const active = transport.executeCommands([ping("A0")], {
      priority: "background",
    });
    await vi.waitFor(() => expect(commandPublishes(client)).toHaveLength(1));

    const earlierBackground = transport.executeCommands([ping("A1")], {
      priority: "background",
    });
    const laterInteractive = transport.executeCommands([ping("A2")]);
    client.emitJson(
      topics.response,
      response("A0", [{ index: 0, response: "o" }], "session-request-1"),
    );

    await vi.waitFor(() => expect(commandPublishes(client)).toHaveLength(2));
    expect(commandPublishes(client)[1]?.payload).toBe(
      encodeCorrelatedLegacyRequest("session-request-2", "A2 p"),
    );
    client.emitJson(
      topics.response,
      response("A2", [{ index: 0, response: "o" }], "session-request-2"),
    );
    await vi.waitFor(() => expect(commandPublishes(client)).toHaveLength(3));
    expect(commandPublishes(client)[2]?.payload).toBe(
      encodeCorrelatedLegacyRequest("session-request-3", "A1 p"),
    );
    client.emitJson(
      topics.response,
      response("A1", [{ index: 0, response: "o" }], "session-request-3"),
    );
    await expect(
      Promise.all([active, earlierBackground, laterInteractive]),
    ).resolves.toHaveLength(3);
    await transport.stop();
  });

  it("preserves same-device FIFO when a later command has higher priority", async () => {
    const client = new InMemoryMqttClient();
    const transport = await readyTransport(client);
    const active = transport.executeCommands([
      command("A1 p active", "A1", "o"),
    ]);
    await vi.waitFor(() => expect(commandPublishes(client)).toHaveLength(1));

    const earlierBackground = transport.executeCommands(
      [command("A1 p background", "A1", "o")],
      { priority: "background" },
    );
    const laterInteractive = transport.executeCommands([
      command("A1 p interactive", "A1", "o"),
    ]);
    client.emitJson(
      topics.response,
      response("A1", [{ index: 0, response: "o" }], "session-request-1"),
    );

    await vi.waitFor(() => expect(commandPublishes(client)).toHaveLength(2));
    expect(commandPublishes(client)[1]?.payload).toBe(
      encodeCorrelatedLegacyRequest("session-request-2", "A1 p background"),
    );
    client.emitJson(
      topics.response,
      response("A1", [{ index: 0, response: "o" }], "session-request-2"),
    );

    await vi.waitFor(() => expect(commandPublishes(client)).toHaveLength(3));
    expect(commandPublishes(client)[2]?.payload).toBe(
      encodeCorrelatedLegacyRequest("session-request-3", "A1 p interactive"),
    );
    client.emitJson(
      topics.response,
      response("A1", [{ index: 0, response: "o" }], "session-request-3"),
    );
    await expect(
      Promise.all([active, earlierBackground, laterInteractive]),
    ).resolves.toHaveLength(3);
    await transport.stop();
  });

  it("preserves FIFO within one priority for a device", async () => {
    const client = new InMemoryMqttClient();
    const transport = await readyTransport(client);
    const first = transport.executeCommands([ping("A1")], {
      priority: "background",
    });
    const second = transport.executeCommands([ping("A1")], {
      priority: "background",
    });
    await vi.waitFor(() => expect(commandPublishes(client)).toHaveLength(1));

    client.emitJson(
      topics.response,
      response("A1", [{ index: 0, response: "o" }], "session-request-1"),
    );
    await first;
    await vi.waitFor(() => expect(commandPublishes(client)).toHaveLength(2));
    client.emitJson(
      topics.response,
      response("A1", [{ index: 0, response: "o" }], "session-request-2"),
    );
    await expect(second).resolves.toMatchObject({
      outcomes: [{ status: "succeeded" }],
    });
    await transport.stop();
  });

  it("publishes requested discovery only at an idle wire boundary", async () => {
    const client = new InMemoryMqttClient();
    const transport = await readyTransport(client);
    let releaseDiscovery: () => void = () => undefined;
    const discoveryCanComplete = new Promise<void>((resolve) => {
      releaseDiscovery = resolve;
    });
    client.onPublish = async ({ payload }) => {
      if (payload === "discover") {
        await discoveryCanComplete;
      }
    };

    const discovery = transport.requestDiscovery();
    await vi.waitFor(() => expect(client.publishes).toHaveLength(2));
    const queuedCommand = transport.executeCommands([ping("A1")]);
    await flushMicrotasks();
    expect(commandPublishes(client)).toHaveLength(0);

    releaseDiscovery();
    await expect(discovery).resolves.toBe("published");
    await vi.waitFor(() => expect(commandPublishes(client)).toHaveLength(1));
    client.emitJson(
      topics.response,
      response("A1", [{ index: 0, response: "o" }]),
    );
    expect((await queuedCommand).outcomes[0]?.status).toBe("succeeded");
    await transport.stop();
  });

  it("skips requested discovery while a command batch is active", async () => {
    const client = new InMemoryMqttClient();
    const transport = await readyTransport(client);
    const operation = transport.executeCommands([ping("A1")]);
    await vi.waitFor(() => expect(commandPublishes(client)).toHaveLength(1));

    await expect(transport.requestDiscovery()).resolves.toBe("skipped_busy");
    expect(
      client.publishes.filter(({ payload }) => payload === "discover"),
    ).toHaveLength(1);

    client.emitJson(
      topics.response,
      response("A1", [{ index: 0, response: "o" }]),
    );
    await operation;
    await transport.stop();
  });

  it("releases a hung discovery publication when MQTT disconnects", async () => {
    const client = new InMemoryMqttClient();
    const transport = await readyTransport(client);
    const neverCompletes = new Promise<void>(() => undefined);
    client.onPublish = async ({ payload }) => {
      if (payload === "discover") {
        await neverCompletes;
      }
    };

    const discovery = transport.requestDiscovery();
    await vi.waitFor(() => expect(client.publishes).toHaveLength(2));
    client.emitDisconnected();
    await expect(discovery).rejects.toBeInstanceOf(LegacyMqttUnavailableError);

    client.onPublish = undefined;
    client.emitConnected();
    await vi.waitFor(() => expect(client.publishes).toHaveLength(3));
    expect(client.publishes[2]?.payload).toBe("discover");
    await transport.stop();
  });

  it("releases a hung discovery publication when the transport stops", async () => {
    const client = new InMemoryMqttClient();
    const transport = await readyTransport(client);
    const neverCompletes = new Promise<void>(() => undefined);
    client.onPublish = async ({ payload }) => {
      if (payload === "discover") {
        await neverCompletes;
      }
    };

    const discovery = transport.requestDiscovery();
    await vi.waitFor(() => expect(client.publishes).toHaveLength(2));
    await transport.stop();
    await expect(discovery).rejects.toBeInstanceOf(LegacyMqttUnavailableError);
  });

  it("keeps exact response matching byte-for-byte", async () => {
    const client = new InMemoryMqttClient();
    const transport = await readyTransport(client);
    const operation = transport.executeCommands([ping("A1")]);
    await vi.waitFor(() => expect(commandPublishes(client)).toHaveLength(1));

    client.emitJson(
      topics.response,
      response("A1", [{ index: 0, response: "o " }]),
    );
    expect((await operation).outcomes[0]).toEqual({
      index: 0,
      command: "A1 p",
      targetId: "A1",
      status: "failed",
      response: "o ",
      expectedResponse: { kind: "exact", value: "o" },
    });
    await transport.stop();
  });

  it("canonicalizes aliases, batches at three per target, and correlates local indexes", async () => {
    const client = new InMemoryMqttClient();
    const transport = await readyTransport(client);
    const operation = transport.executeCommands([
      command("One p", "A1", "o", ["One"]),
      command("A1 sync 10", "A1", "10", ["One"]),
      command("A2 p", "A2", "o", ["Two"]),
      command("One s 1 10 0", "A1", "s 1 10 0", ["One"]),
      command("Two sync 10", "A2", "10", ["Two"]),
      command("A1 p", "A1", "o", ["One"]),
    ]);

    await vi.waitFor(() => expect(commandPublishes(client)).toHaveLength(2));
    expect(commandPublishes(client).map(({ payload }) => payload)).toEqual([
      encodeCorrelatedLegacyRequest(
        "session-request-1",
        "A1 p;A1 sync 10;A1 s 1 10 0",
      ),
      encodeCorrelatedLegacyRequest("session-request-2", "A2 p;A2 sync 10"),
    ]);

    client.emitJson(
      topics.response,
      response(
        "A2",
        [
          { index: 0, response: "o" },
          { index: 1, response: "10" },
        ],
        "session-request-2",
      ),
    );
    client.emitJson(
      topics.response,
      response(
        "A1",
        [
          { index: 0, response: "o" },
          { index: 1, response: "10" },
          { index: 2, response: "s 1 10 0" },
        ],
        "session-request-1",
      ),
    );

    await vi.waitFor(() => expect(commandPublishes(client)).toHaveLength(3));
    expect(commandPublishes(client)[2]?.payload).toBe(
      encodeCorrelatedLegacyRequest("session-request-3", "A1 p"),
    );
    client.emitJson(
      topics.response,
      response("A1", [{ index: 0, response: "o" }], "session-request-3"),
    );

    const result = await operation;
    expect(result.outcomes.map(({ index }) => index)).toEqual([
      0, 1, 2, 3, 4, 5,
    ]);
    expect(result.outcomes.every(({ status }) => status === "succeeded")).toBe(
      true,
    );
    await transport.stop();
  });

  it("publishes a long command as one MQTT message", async () => {
    const client = new InMemoryMqttClient();
    const transport = await readyTransport(client);
    const rawCommand = `A1 sc ${"x".repeat(500)}`;
    const operation = transport.executeCommands([
      command(rawCommand, "A1", "schedule_ok"),
    ]);
    const expectedPayload = encodeLegacyMessage(
      encodeCorrelatedLegacyRequest("session-request-1", rawCommand),
    );

    await vi.waitFor(() => expect(commandPublishes(client)).toHaveLength(1));
    expect(commandPublishes(client)[0]).toMatchObject({
      payload: expectedPayload,
      options: { qos: 0, retain: false },
    });

    client.emitJson(
      topics.response,
      response("A1", [{ index: 0, response: "schedule_ok" }]),
    );
    expect((await operation).outcomes[0]?.status).toBe("succeeded");
    await transport.stop();
  });

  it("serializes the brief MQTT publications for concurrent device lanes", async () => {
    const client = new InMemoryMqttClient();
    const transport = await readyTransport(client);
    const rawCommand = `A1 sc ${"x".repeat(500)}`;
    const expectedPayload = encodeLegacyMessage(
      encodeCorrelatedLegacyRequest("session-request-1", rawCommand),
    );
    let releaseFirstPublish: () => void = () => undefined;
    const firstPublishCanComplete = new Promise<void>((resolve) => {
      releaseFirstPublish = resolve;
    });
    client.onPublish = async ({ payload }) => {
      if (payload === expectedPayload) {
        await firstPublishCanComplete;
      }
    };

    const schedule = transport.executeCommands([
      command(rawCommand, "A1", "schedule_ok"),
    ]);
    const pingB = transport.executeCommands([ping("A2")]);
    await vi.waitFor(() => expect(commandPublishes(client)).toHaveLength(1));
    expect(commandPublishes(client)[0]?.payload).toBe(expectedPayload);

    releaseFirstPublish();
    await vi.waitFor(() => expect(commandPublishes(client)).toHaveLength(2));
    expect(commandPublishes(client).map(({ payload }) => payload)).toEqual([
      expectedPayload,
      encodeCorrelatedLegacyRequest("session-request-2", "A2 p"),
    ]);
    client.emitJson(
      topics.response,
      response(
        "A1",
        [{ index: 0, response: "schedule_ok" }],
        "session-request-1",
      ),
    );
    client.emitJson(
      topics.response,
      response("A2", [{ index: 0, response: "o" }], "session-request-2"),
    );
    await expect(Promise.all([schedule, pingB])).resolves.toHaveLength(2);
    await transport.stop();
  });

  it("starts the response timeout only after MQTT publication completes", async () => {
    const client = new InMemoryMqttClient();
    const transport = await readyTransport(client, {}, 100);
    const rawCommand = `A1 sc ${"x".repeat(500)}`;
    const payload = encodeLegacyMessage(
      encodeCorrelatedLegacyRequest("session-request-1", rawCommand),
    );
    let releasePublish: () => void = () => undefined;
    const publishCanComplete = new Promise<void>((resolve) => {
      releasePublish = resolve;
    });
    client.onPublish = async ({ payload: publishedPayload }) => {
      if (publishedPayload === payload) {
        await publishCanComplete;
      }
    };
    vi.useFakeTimers();
    let settled = false;
    const operation = transport.executeCommands([
      command(rawCommand, "A1", "schedule_ok"),
    ]);
    void operation.then(() => {
      settled = true;
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(commandPublishes(client)).toHaveLength(1);

    await vi.advanceTimersByTimeAsync(500);
    expect(settled).toBe(false);
    releasePublish();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(99);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await expect(operation).resolves.toMatchObject({
      outcomes: [{ status: "outcome_unknown", reason: "timeout" }],
    });
    await transport.stop();
  });

  it("accepts an early correlated response emitted during publication", async () => {
    const client = new InMemoryMqttClient();
    const interactions: LegacyMqttInteraction[] = [];
    const transport = await readyTransport(client, {
      onInteraction: (interaction) => interactions.push(interaction),
    });
    const rawCommand = `A1 sc ${"x".repeat(500)}`;
    const expectedPayload = encodeLegacyMessage(
      encodeCorrelatedLegacyRequest("session-request-1", rawCommand),
    );
    client.onPublish = ({ payload }) => {
      if (payload === expectedPayload) {
        client.emitJson(
          topics.response,
          response(
            "A1",
            [{ index: 0, response: "schedule_ok" }],
            "session-request-1",
          ),
        );
      }
    };

    await expect(
      transport.executeCommands([command(rawCommand, "A1", "schedule_ok")]),
    ).resolves.toMatchObject({
      outcomes: [{ status: "succeeded" }],
    });
    expect(interactions).toContainEqual(
      expect.objectContaining({
        kind: "batch_published",
        requestId: "session-request-1",
        targetId: "A1",
      }),
    );
    await transport.stop();
  });

  it("allows a healthy lane to finish while another device times out", async () => {
    const client = new InMemoryMqttClient();
    const transport = await readyTransport(client, {}, 100);
    vi.useFakeTimers();
    const unresponsive = transport.executeCommands([ping("A1")]);
    const healthy = transport.executeCommands([ping("A2")]);
    await flushMicrotasks();
    await vi.advanceTimersByTimeAsync(0);
    expect(commandPublishes(client)).toHaveLength(2);

    client.emitJson(
      topics.response,
      response("A2", [{ index: 0, response: "o" }], "session-request-2"),
    );
    await expect(healthy).resolves.toMatchObject({
      outcomes: [{ status: "succeeded" }],
    });
    await vi.advanceTimersByTimeAsync(100);
    await expect(unresponsive).resolves.toMatchObject({
      outcomes: [{ status: "outcome_unknown", reason: "timeout" }],
    });
    await transport.stop();
  });

  it("marks a timeout unknown, ignores its late response, and continues queued work", async () => {
    const client = new InMemoryMqttClient();
    const interactions: LegacyMqttInteraction[] = [];
    const transport = await readyTransport(
      client,
      { onInteraction: (interaction) => interactions.push(interaction) },
      100,
    );
    vi.useFakeTimers();

    const operation = transport.executeCommands([ping("A1")]);
    await flushMicrotasks();
    expect(commandPublishes(client)).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(100);

    const result = await operation;
    expect(result.outcomes).toMatchObject([
      { index: 0, status: "outcome_unknown", reason: "timeout" },
    ]);
    expect(commandPublishes(client)).toHaveLength(1);

    client.emitJson(
      topics.response,
      response("A1", [{ index: 0, response: "o" }]),
    );
    expect(
      interactions.some(
        (interaction) =>
          interaction.kind === "ignored_response" &&
          interaction.reason === "no_active_batch",
      ),
    ).toBe(true);

    const nextOperation = transport.executeCommands([ping("A1")]);
    await flushMicrotasks();
    expect(commandPublishes(client)).toHaveLength(2);
    client.emitJson(
      topics.response,
      response("A1", [{ index: 0, response: "o" }], "session-request-2"),
    );
    expect((await nextOperation).outcomes[0]?.status).toBe("succeeded");
    await transport.stop();
  });

  it("ignores a timed-out request's late response while another request is active", async () => {
    const client = new InMemoryMqttClient();
    const interactions: LegacyMqttInteraction[] = [];
    const transport = await readyTransport(
      client,
      { onInteraction: (interaction) => interactions.push(interaction) },
      100,
    );
    vi.useFakeTimers();

    const timedOut = transport.executeCommands([ping("A1")]);
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(100);
    await expect(timedOut).resolves.toMatchObject({
      outcomes: [{ status: "outcome_unknown", reason: "timeout" }],
    });

    const active = transport.executeCommands([ping("A2")]);
    await vi.advanceTimersByTimeAsync(0);
    client.emitJson(
      topics.response,
      response("A1", [{ index: 0, response: "o" }], "session-request-1"),
    );
    expect(interactions).toContainEqual(
      expect.objectContaining({
        kind: "ignored_response",
        reason: "wrong_request",
        responderId: "A1",
      }),
    );
    client.emitJson(
      topics.response,
      response("A2", [{ index: 0, response: "o" }], "session-request-2"),
    );
    await expect(active).resolves.toMatchObject({
      outcomes: [{ status: "succeeded" }],
    });
    await transport.stop();
  });

  it("treats a QoS 0 publish error as unknown instead of retrying", async () => {
    const client = new InMemoryMqttClient();
    const transport = await readyTransport(client);
    client.onPublish = ({ payload }) => {
      if (payload !== "discover") {
        throw new Error("socket closed during publish");
      }
    };

    const result = await transport.executeCommands([ping("A1")]);
    expect(result.outcomes).toMatchObject([
      { status: "outcome_unknown", reason: "publish_failed" },
    ]);
    expect(commandPublishes(client)).toHaveLength(1);

    client.onPublish = undefined;
    const nextOperation = transport.executeCommands([ping("A1")]);
    await flushMicrotasks();
    expect(commandPublishes(client)).toHaveLength(2);
    client.emitJson(
      topics.response,
      response("A1", [{ index: 0, response: "o" }], "session-request-2"),
    );
    expect((await nextOperation).outcomes[0]?.status).toBe("succeeded");
    await transport.stop();
  });

  it("settles the active operation unknown and rejects unsent work on disconnect", async () => {
    const client = new InMemoryMqttClient();
    const transport = await readyTransport(client);
    const active = transport.executeCommands([ping("A1")]);
    const queued = transport.executeCommands([ping("A1")]);
    const queuedRejection = queued.catch((error: Error) => error);
    await vi.waitFor(() => expect(commandPublishes(client)).toHaveLength(1));

    client.emitDisconnected();

    expect((await active).outcomes).toMatchObject([
      { status: "outcome_unknown", reason: "disconnected" },
    ]);
    expect(await queuedRejection).toBeInstanceOf(LegacyMqttUnavailableError);
    expect(commandPublishes(client)).toHaveLength(1);
    await transport.stop();
  });

  it("settles every concurrently active device lane on disconnect", async () => {
    const client = new InMemoryMqttClient();
    const transport = await readyTransport(client);
    const first = transport.executeCommands([ping("A1")]);
    const second = transport.executeCommands([ping("A2")]);
    await vi.waitFor(() => expect(commandPublishes(client)).toHaveLength(2));

    client.emitDisconnected();

    await expect(Promise.all([first, second])).resolves.toMatchObject([
      {
        outcomes: [{ status: "outcome_unknown", reason: "disconnected" }],
      },
      {
        outcomes: [{ status: "outcome_unknown", reason: "disconnected" }],
      },
    ]);
    await transport.stop();
  });

  it("settles a published device and marks an unsent mixed-device partition on stop", async () => {
    const client = new InMemoryMqttClient();
    const transport = await readyTransport(client, {}, 1_000, 2);
    const neverCompletes = new Promise<void>(() => undefined);
    client.onPublish = async ({ payload }) => {
      if (payload !== "discover") {
        await neverCompletes;
      }
    };
    const operation = transport.executeCommands([ping("A1"), ping("A2")]);
    await vi.waitFor(() => expect(commandPublishes(client)).toHaveLength(1));

    await transport.stop();

    await expect(operation).resolves.toMatchObject({
      outcomes: [
        {
          targetId: "A1",
          status: "outcome_unknown",
          reason: "transport_stopped",
        },
        {
          targetId: "A2",
          status: "not_attempted",
          reason: "transport_stopped",
        },
      ],
    });
  });

  it("ignores unrelated and duplicate responses while accepting the matching one", async () => {
    const client = new InMemoryMqttClient();
    const interactions: LegacyMqttInteraction[] = [];
    const transport = await readyTransport(client, {
      onInteraction: (interaction) => interactions.push(interaction),
    });
    const operation = transport.executeCommands([ping("A1")]);
    await vi.waitFor(() => expect(commandPublishes(client)).toHaveLength(1));

    client.emitJson(
      topics.response,
      response("A2", [{ index: 0, response: "o" }]),
    );
    client.emitJson(
      topics.response,
      response("A1", [{ index: 9, response: "o" }]),
    );
    client.emitJson(
      topics.response,
      response("A1", [
        { index: 0, response: "o" },
        { index: 0, response: "o" },
      ]),
    );

    expect((await operation).outcomes[0]?.status).toBe("succeeded");
    const reasons = interactions.flatMap((interaction) =>
      interaction.kind === "ignored_response" ? [interaction.reason] : [],
    );
    expect(reasons).toEqual(
      expect.arrayContaining([
        "wrong_device",
        "index_out_of_range",
        "duplicate",
      ]),
    );
    await transport.stop();
  });

  it("treats a current correlated empty response as an attributable failure", async () => {
    const client = new InMemoryMqttClient();
    const transport = await readyTransport(client);
    const operation = transport.executeCommands([ping("A1")]);
    await vi.waitFor(() => expect(commandPublishes(client)).toHaveLength(1));

    client.emitJson(topics.response, response("A1", []));

    await expect(operation).resolves.toMatchObject({
      outcomes: [
        {
          targetId: "A1",
          status: "failed",
          response: "",
          expectedResponse: { kind: "exact", value: "o" },
        },
      ],
    });
    await transport.stop();
  });

  it("attributes a malformed response envelope only when device and request match", async () => {
    const client = new InMemoryMqttClient();
    const interactions: LegacyMqttInteraction[] = [];
    const transport = await readyTransport(client, {
      onInteraction: (interaction) => interactions.push(interaction),
    });
    const operation = transport.executeCommands([ping("A1")]);
    await vi.waitFor(() => expect(commandPublishes(client)).toHaveLength(1));

    client.emitJson(topics.response, {
      id: "A1",
      name: "A1",
      requestId: "session-request-1",
      responses: "invalid",
    });

    await expect(operation).resolves.toMatchObject({
      outcomes: [
        {
          targetId: "A1",
          status: "failed",
          response: "[malformed response envelope]",
        },
      ],
    });
    expect(interactions).toContainEqual(
      expect.objectContaining({
        kind: "malformed_message",
        topic: topics.response,
      }),
    );
    await transport.stop();
  });

  it("does not attribute an empty response from a wrong request", async () => {
    const client = new InMemoryMqttClient();
    const interactions: LegacyMqttInteraction[] = [];
    const transport = await readyTransport(client, {
      onInteraction: (interaction) => interactions.push(interaction),
    });
    const operation = transport.executeCommands([ping("A1")]);
    await vi.waitFor(() => expect(commandPublishes(client)).toHaveLength(1));

    client.emitJson(topics.response, response("A1", [], "wire-old-0"));
    client.emitJson(
      topics.response,
      response("A1", [{ index: 0, response: "o" }]),
    );

    await expect(operation).resolves.toMatchObject({
      outcomes: [{ status: "succeeded" }],
    });
    expect(interactions).toContainEqual(
      expect.objectContaining({
        kind: "ignored_response",
        reason: "wrong_request",
        responderId: "A1",
      }),
    );
    await transport.stop();
  });

  it.each([
    ["r 7 0", "succeeded"],
    ["r 7 4095", "succeeded"],
    ["r 7 -1", "failed"],
    ["r 7 4096", "failed"],
    ["r 7 01", "failed"],
    ["r 8 1", "failed"],
    ["r 7 1 extra", "failed"],
  ] as const)(
    "validates analog response %s with exact firmware grammar",
    async (rawResponse, expectedStatus) => {
      const client = new InMemoryMqttClient();
      const transport = await readyTransport(client);
      const operation = transport.executeCommands([analogRead("A1", 7)]);
      await vi.waitFor(() => expect(commandPublishes(client)).toHaveLength(1));

      client.emitJson(
        topics.response,
        response("A1", [{ index: 0, response: rawResponse }]),
      );
      const outcome = (await operation).outcomes[0];
      expect(outcome).toMatchObject({
        status: expectedStatus,
        response: rawResponse,
      });
      if (outcome?.status === "failed") {
        expect(outcome.expectedResponse).toEqual({
          kind: "analog_read",
          pin: 7,
        });
      } else if (outcome?.status === "succeeded") {
        expect(outcome.analogValue).toBe(Number(rawResponse.split(" ")[2]));
      }
      await transport.stop();
    },
  );

  it("rejects analog descriptors outside the firmware pin range", async () => {
    const client = new InMemoryMqttClient();
    const transport = await readyTransport(client);

    expect(() =>
      transport.executeCommands([
        {
          command: "A1 r 64",
          target: { id: "A1" },
          expectedResponse: { kind: "analog_read", pin: 64 },
        },
      ]),
    ).toThrow(/0 to 63/);
    await transport.stop();
  });
});

async function readyTransport(
  client: InMemoryMqttClient,
  callbacks: LegacyMqttTransportCallbacks = {},
  responseTimeoutMs = 1_000,
  maxConcurrentDeviceLanes = 4,
): Promise<LegacyMqttTransport> {
  const transport = new LegacyMqttTransport({
    clientFactory: () => client,
    topics,
    responseTimeoutMs,
    maxConcurrentDeviceLanes,
    callbacks,
    requestSessionId: "session",
  });
  transport.start();
  client.emitConnected();
  await vi.waitFor(() => expect(client.publishes[0]?.payload).toBe("discover"));
  return transport;
}

function command(
  rawCommand: string,
  targetId: string,
  expectedResponse: string,
  aliases: readonly string[] = [],
): LegacyWireCommand {
  return {
    command: rawCommand,
    target: { id: targetId, aliases },
    expectedResponse: exactResponse(expectedResponse),
  };
}

function ping(targetId: string): LegacyWireCommand {
  return command(`${targetId} p`, targetId, "o");
}

function analogRead(targetId: string, pin: number): LegacyWireCommand {
  return {
    command: `${targetId} r ${pin}`,
    target: { id: targetId },
    expectedResponse: { kind: "analog_read", pin },
  };
}

function exactResponse(value: string): LegacyExpectedResponse {
  return { kind: "exact", value };
}

function announcement(id: string, name: string): object {
  return {
    id,
    name,
    freq: 5_000,
    res: 8,
    status: "ok",
    version: "1",
    scheduleHash: "0",
  };
}

function response(
  id: string,
  responses: readonly { readonly index: number; readonly response: string }[],
  requestId = "session-request-1",
): object {
  return { id, name: id, requestId, responses };
}

function commandPublishes(client: InMemoryMqttClient): readonly PublishCall[] {
  return client.publishes.filter(({ payload }) => payload !== "discover");
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}
