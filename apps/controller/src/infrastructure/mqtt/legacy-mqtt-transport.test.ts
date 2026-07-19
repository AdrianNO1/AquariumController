import { createEspTopicSet, encodeLegacyMessage } from "@aquarium/esp-protocol";
import { afterEach, describe, expect, it, vi } from "vitest";

import type {
  LegacyMqttClientPort,
  MqttMessageHandler,
  QosZeroPublishOptions,
  QosZeroSubscribeOptions,
} from "./client-port.js";
import {
  LegacyMqttOutcomeUnknownError,
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

  it("serializes concurrent callers into one global wire operation", async () => {
    const client = new InMemoryMqttClient();
    const transport = await readyTransport(client);
    const first = transport.executeCommands([ping("A1")]);
    const second = transport.executeCommands([ping("A2")]);

    await vi.waitFor(() => expect(commandPublishes(client)).toHaveLength(1));
    expect(commandPublishes(client)[0]?.payload).toBe("A1 p");

    client.emitJson(
      topics.response,
      response("A1", [{ index: 0, response: "o" }]),
    );
    expect((await first).outcomes[0]).toMatchObject({
      status: "succeeded",
      response: "o",
      analogValue: null,
    });
    await vi.waitFor(() => expect(commandPublishes(client)).toHaveLength(2));
    expect(commandPublishes(client)[1]?.payload).toBe("A2 p");

    client.emitJson(
      topics.response,
      response("A2", [{ index: 0, response: "o" }]),
    );
    expect((await second).outcomes[0]?.status).toBe("succeeded");
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

    await vi.waitFor(() => expect(commandPublishes(client)).toHaveLength(1));
    expect(commandPublishes(client)[0]?.payload).toBe(
      "A1 p;A1 sync 10;A2 p;A1 s 1 10 0;A2 sync 10",
    );

    client.emitJson(
      topics.response,
      response("A2", [
        { index: 2, response: "o" },
        { index: 4, response: "10" },
      ]),
    );
    client.emitJson(
      topics.response,
      response("A1", [
        { index: 0, response: "o" },
        { index: 1, response: "10" },
        { index: 3, response: "s 1 10 0" },
      ]),
    );

    await vi.waitFor(() => expect(commandPublishes(client)).toHaveLength(2));
    expect(commandPublishes(client)[1]?.payload).toBe("A1 p");
    client.emitJson(
      topics.response,
      response("A1", [{ index: 0, response: "o" }]),
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

  it("publishes protocol-package chunk frames in order", async () => {
    const client = new InMemoryMqttClient();
    const transport = await readyTransport(client);
    const rawCommand = `A1 sc ${"x".repeat(500)}`;
    const operation = transport.executeCommands([
      command(rawCommand, "A1", "schedule_ok"),
    ]);
    const expectedFrames = encodeLegacyMessage(rawCommand);

    await vi.waitFor(() =>
      expect(commandPublishes(client)).toHaveLength(expectedFrames.length),
    );
    expect(commandPublishes(client).map(({ payload }) => payload)).toEqual(
      expectedFrames,
    );
    expect(
      commandPublishes(client).every(
        ({ options }) => options.qos === 0 && options.retain === false,
      ),
    ).toBe(true);

    client.emitJson(
      topics.response,
      response("A1", [{ index: 0, response: "schedule_ok" }]),
    );
    expect((await operation).outcomes[0]?.status).toBe("succeeded");
    await transport.stop();
  });

  it("marks timeout unknown, never retries, and requires explicit reconciliation", async () => {
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
    await expect(
      transport.executeCommands([ping("A1")]),
    ).rejects.toBeInstanceOf(LegacyMqttOutcomeUnknownError);
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

    transport.acknowledgeUnknownOutcome();
    const reconciledOperation = transport.executeCommands([ping("A1")]);
    await flushMicrotasks();
    expect(commandPublishes(client)).toHaveLength(2);
    client.emitJson(
      topics.response,
      response("A1", [{ index: 0, response: "o" }]),
    );
    expect((await reconciledOperation).outcomes[0]?.status).toBe("succeeded");
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
    await expect(
      transport.executeCommands([ping("A1")]),
    ).rejects.toBeInstanceOf(LegacyMqttOutcomeUnknownError);
    expect(commandPublishes(client)).toHaveLength(1);
    await transport.stop();
  });

  it("settles the active operation unknown and rejects unsent work on disconnect", async () => {
    const client = new InMemoryMqttClient();
    const transport = await readyTransport(client);
    const active = transport.executeCommands([ping("A1")]);
    const queued = transport.executeCommands([ping("A2")]);
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
): Promise<LegacyMqttTransport> {
  const transport = new LegacyMqttTransport({
    clientFactory: () => client,
    topics,
    responseTimeoutMs,
    callbacks,
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
): object {
  return { id, name: id, responses };
}

function commandPublishes(client: InMemoryMqttClient): readonly PublishCall[] {
  return client.publishes.filter(({ payload }) => payload !== "discover");
}

async function flushMicrotasks(): Promise<void> {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}
