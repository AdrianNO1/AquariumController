import { connect, type IClientOptions, type MqttClient } from "mqtt";

import { FakeEspActor, type FakeEspActorOptions } from "./fake-esp.js";
import {
  assertFakeEspTestTopic,
  createFakeEspTopics,
  type FakeEspMessageHandler,
  type FakeEspTopics,
  type FakeEspTransport,
} from "./transport.js";

const decoder = new TextDecoder();

export interface FakeEspMqttClientPort {
  onConnected(handler: () => void): () => void;
  onDisconnected(handler: () => void): () => void;
  onError(handler: (error: Error) => void): () => void;
  onMessage(handler: (topic: string, payload: Uint8Array) => void): () => void;
  start(): void;
  subscribe(topic: string, options: { readonly qos: 0 }): Promise<void>;
  publish(
    topic: string,
    payload: string,
    options: { readonly qos: 0; readonly retain: false },
  ): void;
  stop(): Promise<void>;
}

export interface FakeEspMqttClientConfig {
  readonly brokerUrl: string;
  readonly clientId: string;
  readonly connectTimeoutMilliseconds?: number;
  readonly reconnectPeriodMilliseconds?: number;
}

export type FakeEspMqttClientFactory = (
  config: FakeEspMqttClientConfig,
) => FakeEspMqttClientPort;

export interface MqttFakeEspSessionOptions {
  readonly brokerUrl: string;
  readonly clientId: string;
  readonly namespace?: string;
  readonly networkEnabled?: boolean;
  readonly actor: Omit<FakeEspActorOptions, "transport" | "namespace">;
  readonly clientFactory?: FakeEspMqttClientFactory;
  readonly onError?: (error: Error) => void;
}

export interface FakeEspMqttConnectionOptions {
  readonly protocolVersion: 4;
  readonly protocolId: "MQTT";
  readonly clean: true;
  readonly manualConnect: true;
  readonly queueQoSZero: false;
  readonly resubscribe: false;
  readonly keepalive: 15;
  readonly connectTimeout: number;
  readonly reconnectPeriod: number;
  readonly clientId: string;
}

class MqttJsFakeEspClient implements FakeEspMqttClientPort {
  private readonly publicationErrorHandlers = new Set<(error: Error) => void>();

  public constructor(private readonly client: MqttClient) {}

  public onConnected(handler: () => void): () => void {
    this.client.on("connect", handler);
    return () => this.client.off("connect", handler);
  }

  public onDisconnected(handler: () => void): () => void {
    this.client.on("close", handler);
    return () => this.client.off("close", handler);
  }

  public onError(handler: (error: Error) => void): () => void {
    this.client.on("error", handler);
    this.publicationErrorHandlers.add(handler);
    return () => {
      this.client.off("error", handler);
      this.publicationErrorHandlers.delete(handler);
    };
  }

  public onMessage(
    handler: (topic: string, payload: Uint8Array) => void,
  ): () => void {
    const mqttHandler = (topic: string, payload: Buffer): void => {
      handler(topic, payload);
    };
    this.client.on("message", mqttHandler);
    return () => this.client.off("message", mqttHandler);
  }

  public start(): void {
    this.client.connect();
  }

  public async subscribe(
    topic: string,
    options: { readonly qos: 0 },
  ): Promise<void> {
    const grants = await this.client.subscribeAsync(topic, options);
    if (grants.some((grant) => grant.qos === 128)) {
      throw new Error(`MQTT broker rejected fake ESP subscription to ${topic}`);
    }
  }

  public publish(
    topic: string,
    payload: string,
    options: { readonly qos: 0; readonly retain: false },
  ): void {
    this.client.publish(topic, payload, options, (error?: Error) => {
      if (error !== undefined) {
        for (const handler of this.publicationErrorHandlers) {
          handler(error);
        }
      }
    });
  }

  public async stop(): Promise<void> {
    await this.client.endAsync(false);
  }
}

class MqttActorTransport implements FakeEspTransport {
  private readonly handlers = new Set<FakeEspMessageHandler>();

  public constructor(
    private readonly client: FakeEspMqttClientPort,
    private readonly topics: FakeEspTopics,
  ) {}

  public publish(topic: string, payload: string): void {
    if (topic !== this.topics.announce && topic !== this.topics.response) {
      throw new Error(
        "Fake ESP MQTT actor attempted to publish an unsafe topic",
      );
    }
    assertFakeEspTestTopic(
      topic,
      topic === this.topics.announce ? "announce" : "response",
    );
    this.client.publish(topic, payload, { qos: 0, retain: false });
  }

  public subscribe(topic: string, handler: FakeEspMessageHandler): () => void {
    if (topic !== this.topics.command) {
      throw new Error(
        "Fake ESP MQTT actor attempted to subscribe to an unsafe topic",
      );
    }
    assertFakeEspTestTopic(topic, "command");
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  public dispatch(topic: string, payload: Uint8Array): void {
    if (topic !== this.topics.command) {
      return;
    }
    const text = decoder.decode(payload);
    for (const handler of this.handlers) {
      handler(topic, text);
    }
  }
}

export class MqttFakeEspSession {
  public readonly actor: FakeEspActor;

  private readonly client: FakeEspMqttClientPort;
  private readonly transport: MqttActorTransport;
  private readonly topics: FakeEspTopics;
  private readonly onError: ((error: Error) => void) | undefined;
  private readonly unsubscribeCallbacks: Array<() => void> = [];
  private started = false;
  private stopped = false;
  private mqttConnected = false;
  private networkEnabled: boolean;
  private connectionGeneration = 0;
  private connectionWork = Promise.resolve();
  private initialReadyResolve: (() => void) | undefined;
  private initialReadyReject: ((error: Error) => void) | undefined;
  private initialReadySettled = false;
  private mostRecentError: Error | undefined;

  public constructor(options: MqttFakeEspSessionOptions) {
    assertLoopbackMqttBrokerUrl(options.brokerUrl);
    this.topics = createFakeEspTopics(options.namespace);
    const config = {
      brokerUrl: options.brokerUrl,
      clientId: options.clientId,
    };
    this.client = (options.clientFactory ?? createMqttJsFakeEspClient)(config);
    this.transport = new MqttActorTransport(this.client, this.topics);
    this.onError = options.onError;
    this.networkEnabled = options.networkEnabled ?? true;
    this.actor = new FakeEspActor({
      ...options.actor,
      transport: this.transport,
      ...(options.namespace === undefined
        ? {}
        : { namespace: options.namespace }),
    });
  }

  public start(): Promise<void> {
    if (this.started) {
      throw new Error("Fake ESP MQTT session has already started");
    }
    if (this.stopped) {
      throw new Error("Stopped fake ESP MQTT sessions cannot be started");
    }
    this.started = true;
    const ready = new Promise<void>((resolve, reject) => {
      this.initialReadyResolve = resolve;
      this.initialReadyReject = reject;
    });

    this.unsubscribeCallbacks.push(
      this.client.onConnected(() => {
        this.mqttConnected = true;
        const generation = ++this.connectionGeneration;
        this.connectionWork = this.connectionWork
          .then(() => this.handleConnected(generation))
          .catch((error: Error) => this.captureError(error));
      }),
      this.client.onDisconnected(() => {
        this.mqttConnected = false;
        this.connectionGeneration += 1;
        this.actor.disconnect();
      }),
      this.client.onError((error) => this.captureError(error)),
      this.client.onMessage((topic, payload) =>
        this.transport.dispatch(topic, payload),
      ),
    );
    this.client.start();
    return ready;
  }

  public lastError(): Error | undefined {
    return this.mostRecentError;
  }

  public isMqttConnected(): boolean {
    return this.mqttConnected;
  }

  public isNetworkEnabled(): boolean {
    return this.networkEnabled;
  }

  public setNetworkEnabled(enabled: boolean): void {
    if (this.stopped) {
      throw new Error("Stopped fake ESP MQTT sessions cannot change network");
    }
    if (enabled === this.networkEnabled) {
      return;
    }
    this.networkEnabled = enabled;
    if (!this.started || !this.mqttConnected) {
      return;
    }
    if (enabled) {
      this.actor.connect();
    } else {
      this.actor.disconnect();
    }
  }

  public async stop(): Promise<void> {
    if (this.stopped) {
      return;
    }
    this.stopped = true;
    this.connectionGeneration += 1;
    if (this.started && !this.initialReadySettled) {
      this.initialReadySettled = true;
      this.initialReadyReject?.(
        new Error("Fake ESP MQTT session stopped before initial readiness"),
      );
      this.initialReadyResolve = undefined;
      this.initialReadyReject = undefined;
    }
    this.actor.disconnect();
    this.mqttConnected = false;
    try {
      // Keep the socket error listener attached until MQTT.js finishes
      // shutting down. A broker restart can otherwise surface ECONNRESET in
      // the gap between listener removal and endAsync settling.
      await this.client.stop();
    } finally {
      for (const unsubscribe of this.unsubscribeCallbacks.splice(0)) {
        unsubscribe();
      }
    }
  }

  private async handleConnected(generation: number): Promise<void> {
    await this.client.subscribe(this.topics.command, { qos: 0 });
    if (this.stopped || generation !== this.connectionGeneration) {
      return;
    }
    if (this.networkEnabled) {
      if (this.actor.isReady()) {
        this.actor.reconnect();
      } else {
        this.actor.connect();
      }
    } else {
      this.actor.disconnect();
    }
    if (!this.initialReadySettled) {
      this.initialReadySettled = true;
      this.initialReadyResolve?.();
      this.initialReadyResolve = undefined;
      this.initialReadyReject = undefined;
    }
  }

  private captureError(error: Error): void {
    this.mostRecentError = error;
    this.onError?.(error);
    if (!this.initialReadySettled) {
      this.initialReadySettled = true;
      this.initialReadyReject?.(error);
      this.initialReadyResolve = undefined;
      this.initialReadyReject = undefined;
    }
  }
}

export function createFakeEspMqttConnectionOptions(
  config: FakeEspMqttClientConfig,
): FakeEspMqttConnectionOptions {
  assertLoopbackMqttBrokerUrl(config.brokerUrl);
  assertPositiveInteger(config.connectTimeoutMilliseconds, "connect timeout");
  assertNonNegativeInteger(
    config.reconnectPeriodMilliseconds,
    "reconnect period",
  );
  if (config.clientId.length === 0) {
    throw new Error("Fake ESP MQTT client ID must not be empty");
  }
  return {
    protocolVersion: 4,
    protocolId: "MQTT",
    clean: true,
    manualConnect: true,
    queueQoSZero: false,
    resubscribe: false,
    keepalive: 15,
    connectTimeout: config.connectTimeoutMilliseconds ?? 10_000,
    reconnectPeriod: config.reconnectPeriodMilliseconds ?? 1_000,
    clientId: config.clientId,
  };
}

export function assertLoopbackMqttBrokerUrl(brokerUrl: string): void {
  // R8 runs actors in the host test process against Testcontainers' mapped
  // loopback port. Container-internal DNS is deliberately not accepted here;
  // R13 must add a separately provenance-bound test-network mechanism if its
  // fake actors later run inside Compose.
  let parsed: URL;
  try {
    parsed = new URL(brokerUrl);
  } catch {
    throw new Error("Fake ESP MQTT broker URL must be an absolute URL");
  }
  const hostname = parsed.hostname.toLowerCase();
  const ipv4Parts = hostname.split(".");
  const isIpv4Loopback =
    ipv4Parts.length === 4 &&
    ipv4Parts[0] === "127" &&
    ipv4Parts.every(
      (part) =>
        /^\d{1,3}$/.test(part) && Number(part) >= 0 && Number(part) <= 255,
    );
  const isLoopback =
    hostname === "localhost" ||
    hostname === "[::1]" ||
    hostname === "::1" ||
    isIpv4Loopback;
  if (
    parsed.protocol !== "mqtt:" ||
    !isLoopback ||
    parsed.username.length > 0 ||
    parsed.password.length > 0 ||
    (parsed.pathname !== "" && parsed.pathname !== "/") ||
    parsed.search.length > 0 ||
    parsed.hash.length > 0
  ) {
    throw new Error(
      "Fake ESP MQTT is restricted to credential-free mqtt:// loopback brokers",
    );
  }
}

function createMqttJsFakeEspClient(
  config: FakeEspMqttClientConfig,
): FakeEspMqttClientPort {
  const options: IClientOptions = createFakeEspMqttConnectionOptions(config);
  return new MqttJsFakeEspClient(connect(config.brokerUrl, options));
}

function assertPositiveInteger(value: number | undefined, label: string): void {
  if (value !== undefined && (!Number.isSafeInteger(value) || value < 1)) {
    throw new RangeError(`Fake ESP MQTT ${label} must be a positive integer`);
  }
}

function assertNonNegativeInteger(
  value: number | undefined,
  label: string,
): void {
  if (value !== undefined && (!Number.isSafeInteger(value) || value < 0)) {
    throw new RangeError(
      `Fake ESP MQTT ${label} must be a non-negative integer`,
    );
  }
}
