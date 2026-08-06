import {
  createEspTopicSet,
  ESP_MQTT_PROTOCOL_VERSION,
  espCommandRequestSchema,
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
  type LegacyMqttInteraction,
  type LegacyMqttTransportCallbacks,
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

class InMemoryMqttClient implements LegacyMqttClientPort {
  public readonly publishes: PublishCall[] = [];
  public readonly subscriptions: Array<{
    readonly topics: readonly string[];
    readonly options: QosZeroSubscribeOptions;
  }> = [];
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
    for (const handler of this.connectedHandlers) handler();
  }

  public emitDisconnected(): void {
    for (const handler of this.disconnectedHandlers) handler();
  }

  public emitJson(topic: string, payload: object): void {
    this.emitBytes(topic, encoder.encode(JSON.stringify(payload)));
  }

  public emitText(topic: string, payload: string): void {
    this.emitBytes(topic, encoder.encode(payload));
  }

  private emitBytes(topic: string, payload: Uint8Array): void {
    for (const handler of this.messageHandlers) handler(topic, payload);
  }
}

afterEach(() => {
  vi.useRealTimers();
});

describe("structured per-device MQTT transport", () => {
  it("uses MQTT 3.1.1 and subscribes before structured and passive discovery", async () => {
    expect(
      createMqttJsConnectionOptions({ brokerUrl: "mqtt://127.0.0.1:1883" }),
    ).toMatchObject({
      protocolVersion: 4,
      protocolId: "MQTT",
      clean: true,
      manualConnect: true,
      queueQoSZero: false,
      resubscribe: false,
    });
    expect(
      createMqttJsConnectionOptions({
        brokerUrl: "mqtt://127.0.0.1:1883",
        username: "controller",
        password: "secret",
      }),
    ).toMatchObject({ username: "controller", password: "secret" });
    expect(() =>
      createMqttJsConnectionOptions({
        brokerUrl: "mqtt://controller:secret@127.0.0.1:1883",
      }),
    ).toThrow(/must not contain credentials/u);

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
    client.emitConnected();
    await vi.waitFor(() => expect(client.publishes).toHaveLength(2));

    expect(client.subscriptions).toEqual([
      {
        topics: [
          topics.announcementFilter,
          topics.responseFilter,
          topics.legacyAnnouncement,
          topics.legacyResponse,
        ],
        options: { qos: 0 },
      },
    ]);
    expect(client.publishes).toEqual([
      {
        topic: topics.discoveryRequest,
        payload: JSON.stringify({ protocolVersion: 1, kind: "discover" }),
        options: { qos: 0, retain: false },
      },
      {
        topic: topics.legacyCommand,
        payload: "discover",
        options: { qos: 0, retain: false },
      },
    ]);

    client.emitJson(topics.announcement("A1"), announcement("A1", "One"));
    client.emitJson(topics.legacyAnnouncement, legacyAnnouncement("OLD", "Old"));
    expect(announcements).toEqual(["A1", "OLD"]);
    await transport.stop();
  });

  it("publishes a typed command only on the addressed device topic", async () => {
    const client = new InMemoryMqttClient();
    const transport = await readyTransport(client);
    const operation = transport.executeCommands([
      setPwm("A1", 16, 128, true),
    ]);
    await vi.waitFor(() => expect(commandPublishes(client)).toHaveLength(1));

    const publication = commandPublishes(client)[0];
    if (publication === undefined) {
      throw new Error("Expected one command publication");
    }
    expect(publication.topic).toBe(topics.command("A1"));
    const request = espCommandRequestSchema.parse(JSON.parse(publication.payload));
    expect(request).toMatchObject({
      protocolVersion: ESP_MQTT_PROTOCOL_VERSION,
      deviceId: "A1",
      commands: [
        { index: 0, kind: "set_pwm", pin: 16, value: 128, overwrite: true },
      ],
    });

    client.emitJson(
      topics.response("A1"),
      response("A1", request.requestId, [
        {
          index: 0,
          kind: "set_pwm",
          ok: true,
          pin: 16,
          value: 128,
          overwrite: true,
        },
      ]),
    );
    await expect(operation).resolves.toMatchObject({
      outcomes: [{ status: "succeeded", targetId: "A1" }],
    });
    await transport.stop();
  });

  it("uses the old broadcast protocol only for a firmware 5 OTA upgrade", async () => {
    const client = new InMemoryMqttClient();
    const transport = await readyTransport(client);
    const sha256 = "a".repeat(64);
    const operation = transport.executeCommands([
      {
        command: "OLD ota 6.0.0",
        target: { id: "OLD" },
        operation: {
          kind: "firmware_update",
          version: "6.0.0",
          url: "http://192.168.1.73:3001/api/firmware/esp32/current.bin",
          size: 1_200_000,
          sha256,
        },
        wireProtocol: "legacy_v5_ota",
      },
    ]);
    await vi.waitFor(() =>
      expect(
        client.publishes.filter(
          ({ topic, payload }) =>
            topic === topics.legacyCommand && payload.startsWith("request:"),
        ),
      ).toHaveLength(1),
    );
    const publication = client.publishes.find(
      ({ topic, payload }) =>
        topic === topics.legacyCommand && payload.startsWith("request:"),
    );
    expect(publication?.payload).toContain(
      `|OLD ota 6.0.0 1200000 ${sha256} http://192.168.1.73:3001/`,
    );
    if (publication === undefined) {
      throw new Error("Expected one legacy OTA publication");
    }
    const requestId = /^request:([^|]+)\|/u.exec(publication.payload)?.[1];
    expect(requestId).toBeDefined();
    client.emitJson(topics.legacyResponse, {
      id: "OLD",
      name: "Legacy",
      requestId,
      responses: [{ index: 0, response: "ota_accepted" }],
    });
    await expect(operation).resolves.toMatchObject({
      outcomes: [{ status: "succeeded", targetId: "OLD" }],
    });
    expect(commandPublishes(client)).toHaveLength(0);
    await transport.stop();
  });

  it("treats typed device errors as valid failures and mismatches as protocol faults", async () => {
    const client = new InMemoryMqttClient();
    const transport = await readyTransport(client);
    const deviceFailure = transport.executeCommands([ping("A1")]);
    const first = await nextRequest(client, 1);
    client.emitJson(
      topics.response("A1"),
      response("A1", first.requestId, [
        {
          index: 0,
          kind: "ping",
          ok: false,
          error: { code: "busy", message: "Device is busy" },
        },
      ]),
    );
    await expect(deviceFailure).resolves.toMatchObject({
      outcomes: [
        {
          status: "failed",
          failure: { kind: "device_error", code: "busy" },
        },
      ],
    });

    const protocolFailure = transport.executeCommands([ping("A1")]);
    const second = await nextRequest(client, 2);
    client.emitJson(
      topics.response("A1"),
      response("A1", second.requestId, [
        { index: 0, kind: "schedule", ok: true },
      ]),
    );
    await expect(protocolFailure).resolves.toMatchObject({
      outcomes: [
        { status: "failed", failure: { kind: "protocol_error" } },
      ],
    });
    await transport.stop();
  });

  it("rejects topic/payload identity mismatches without settling another device", async () => {
    vi.useFakeTimers();
    const interactions: LegacyMqttInteraction[] = [];
    const client = new InMemoryMqttClient();
    const transport = await readyTransport(client, {
      onInteraction: (interaction) => interactions.push(interaction),
    });
    const operation = transport.executeCommands([ping("A1")]);
    const request = await nextRequest(client, 1);
    client.emitJson(
      topics.response("A1"),
      response("A2", request.requestId, [
        { index: 0, kind: "ping", ok: true },
      ]),
    );
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(operation).resolves.toMatchObject({
      outcomes: [{ status: "outcome_unknown", reason: "timeout" }],
    });
    expect(interactions).toContainEqual(
      expect.objectContaining({ kind: "malformed_message" }),
    );
    await transport.stop();
  });

  it("rejects oversized inbound MQTT payloads before decoding them", async () => {
    const interactions: LegacyMqttInteraction[] = [];
    const client = new InMemoryMqttClient();
    const transport = await readyTransport(client, {
      onInteraction: (interaction) => interactions.push(interaction),
    });

    client.emitText(topics.announcement("A1"), "x".repeat(8_193));

    expect(interactions).toContainEqual(
      expect.objectContaining({
        kind: "malformed_message",
        payloadBytes: 8_193,
        payloadPreview: "",
        previewTruncated: true,
      }),
    );
    await transport.stop();
  });

  it("lets a healthy device complete while another device times out", async () => {
    vi.useFakeTimers();
    const client = new InMemoryMqttClient();
    const transport = await readyTransport(client, {}, 1_000, 16);
    const operation = transport.executeCommands([ping("DEAD"), ping("LIVE")]);
    await vi.waitFor(() => expect(commandPublishes(client)).toHaveLength(2));
    const live = requestFor(client, "LIVE");
    client.emitJson(
      topics.response("LIVE"),
      response("LIVE", live.requestId, [
        { index: 0, kind: "ping", ok: true },
      ]),
    );
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(operation).resolves.toMatchObject({
      outcomes: [
        { targetId: "DEAD", status: "outcome_unknown", reason: "timeout" },
        { targetId: "LIVE", status: "succeeded" },
      ],
    });
    await transport.stop();
  });

  it("batches at three commands per request and waits for each device batch", async () => {
    const client = new InMemoryMqttClient();
    const transport = await readyTransport(client);
    const operation = transport.executeCommands([
      ping("A1"),
      ping("A1"),
      ping("A1"),
      ping("A1"),
    ]);
    const first = await nextRequest(client, 1);
    expect(first.commands).toHaveLength(3);
    client.emitJson(
      topics.response("A1"),
      response(
        "A1",
        first.requestId,
        first.commands.map(({ index, kind }) => ({ index, kind, ok: true })),
      ),
    );
    const second = await nextRequest(client, 2);
    expect(second.commands).toHaveLength(1);
    client.emitJson(
      topics.response("A1"),
      response("A1", second.requestId, [
        { index: 0, kind: "ping", ok: true },
      ]),
    );
    await expect(operation).resolves.toMatchObject({
      outcomes: [
        { status: "succeeded" },
        { status: "succeeded" },
        { status: "succeeded" },
        { status: "succeeded" },
      ],
    });
    await transport.stop();
  });

  it("settles active work as unknown and rejects unsent work on disconnect", async () => {
    const client = new InMemoryMqttClient();
    const transport = await readyTransport(client, {}, 1_000, 1);
    const active = transport.executeCommands([ping("A1")]);
    const queued = transport.executeCommands([ping("A2")]);
    await nextRequest(client, 1);
    client.emitDisconnected();

    await expect(active).resolves.toMatchObject({
      outcomes: [{ status: "outcome_unknown", reason: "disconnected" }],
    });
    await expect(queued).rejects.toBeInstanceOf(LegacyMqttUnavailableError);
    await transport.stop();
  });

  it("skips explicit discovery while command traffic is active", async () => {
    const client = new InMemoryMqttClient();
    const transport = await readyTransport(client);
    const operation = transport.executeCommands([ping("A1")]);
    const request = await nextRequest(client, 1);
    await expect(transport.requestDiscovery()).resolves.toBe("skipped_busy");
    client.emitJson(
      topics.response("A1"),
      response("A1", request.requestId, [
        { index: 0, kind: "ping", ok: true },
      ]),
    );
    await operation;
    await expect(transport.requestDiscovery()).resolves.toBe("published");
    await transport.stop();
  });

  it("rejects invalid device identifiers and invalid structured operations", async () => {
    const client = new InMemoryMqttClient();
    const transport = await readyTransport(client);
    expect(() =>
      transport.executeCommands([
        {
          command: "bad",
          target: { id: "bad/topic" },
          operation: { kind: "ping" },
          wireProtocol: "structured_v1",
        },
      ]),
    ).toThrow();
    expect(() =>
      transport.executeCommands([
        {
          command: "bad pin",
          target: { id: "A1" },
          operation: { kind: "analog_read", pin: 64 },
          wireProtocol: "structured_v1",
        },
      ]),
    ).toThrow();
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
  await vi.waitFor(() => expect(client.publishes).toHaveLength(2));
  return transport;
}

function ping(targetId: string): LegacyWireCommand {
  return {
    command: `${targetId} ping`,
    target: { id: targetId },
    operation: { kind: "ping" },
    wireProtocol: "structured_v1",
  };
}

function setPwm(
  targetId: string,
  pin: number,
  value: number,
  overwrite: boolean,
): LegacyWireCommand {
  return {
    command: `${targetId} set PWM`,
    target: { id: targetId },
    operation: { kind: "set_pwm", pin, value, overwrite },
    wireProtocol: "structured_v1",
  };
}

function announcement(id: string, name: string) {
  return {
    protocolVersion: ESP_MQTT_PROTOCOL_VERSION,
    id,
    name,
    freq: 5_000,
    res: 8,
    status: "online",
    version: "6.0.0",
    scheduleHash: "0",
  };
}

function legacyAnnouncement(id: string, name: string): object {
  return {
    id,
    name,
    freq: 5_000,
    res: 8,
    status: "online",
    version: "6.0.0",
    scheduleHash: "0",
  };
}

function response(
  deviceId: string,
  requestId: string,
  results: readonly object[],
): object {
  return {
    protocolVersion: ESP_MQTT_PROTOCOL_VERSION,
    deviceId,
    name: deviceId,
    requestId,
    results,
  };
}

function commandPublishes(client: InMemoryMqttClient): readonly PublishCall[] {
  return client.publishes.filter(({ topic }) => topic.endsWith("/command") && topic.includes("/v1/devices/"));
}

async function nextRequest(
  client: InMemoryMqttClient,
  count: number,
): Promise<ReturnType<typeof espCommandRequestSchema.parse>> {
  await vi.waitFor(() => expect(commandPublishes(client)).toHaveLength(count));
  const publication = commandPublishes(client)[count - 1];
  if (publication === undefined) {
    throw new Error(`Missing command publication ${count}`);
  }
  return espCommandRequestSchema.parse(
    JSON.parse(publication.payload),
  );
}

function requestFor(
  client: InMemoryMqttClient,
  deviceId: string,
): ReturnType<typeof espCommandRequestSchema.parse> {
  const publication = commandPublishes(client).find(
    ({ topic }) => topic === topics.command(deviceId),
  );
  if (publication === undefined) throw new Error("Missing device request");
  return espCommandRequestSchema.parse(JSON.parse(publication.payload));
}
