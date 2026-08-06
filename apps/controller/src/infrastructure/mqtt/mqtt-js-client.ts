import { connect } from "mqtt";
import type { IClientOptions, MqttClient } from "mqtt";

import type {
  LegacyMqttClientFactory,
  LegacyMqttClientPort,
  MqttMessageHandler,
  QosZeroPublishOptions,
  QosZeroSubscribeOptions,
} from "./client-port.js";

export interface MqttJsConnectionConfig {
  readonly brokerUrl: string;
  readonly clientId?: string;
  readonly username?: string;
  readonly password?: string;
  readonly keepaliveSeconds?: number;
  readonly reconnectPeriodMs?: number;
  readonly connectTimeoutMs?: number;
}

export function createMqttJsConnectionOptions(
  config: MqttJsConnectionConfig,
): Readonly<IClientOptions> {
  assertMqttBrokerUrl(config.brokerUrl);
  assertIntegerAtLeast(config.keepaliveSeconds, "keepaliveSeconds", 0);
  assertIntegerAtLeast(config.reconnectPeriodMs, "reconnectPeriodMs", 0);
  assertIntegerAtLeast(config.connectTimeoutMs, "connectTimeoutMs", 1);

  return {
    protocolVersion: 4,
    protocolId: "MQTT",
    clean: true,
    manualConnect: true,
    queueQoSZero: false,
    resubscribe: false,
    keepalive: config.keepaliveSeconds ?? 60,
    reconnectPeriod: config.reconnectPeriodMs ?? 1_000,
    connectTimeout: config.connectTimeoutMs ?? 10_000,
    ...(config.clientId === undefined ? {} : { clientId: config.clientId }),
    ...(config.username === undefined ? {} : { username: config.username }),
    ...(config.password === undefined ? {} : { password: config.password }),
  };
}

export function createMqttJsClientFactory(
  config: MqttJsConnectionConfig,
): LegacyMqttClientFactory {
  const options = createMqttJsConnectionOptions(config);
  return () => new MqttJsClientPort(connect(config.brokerUrl, options));
}

class MqttJsClientPort implements LegacyMqttClientPort {
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
    return () => this.client.off("error", handler);
  }

  public onMessage(handler: MqttMessageHandler): () => void {
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
    topics: readonly string[],
    options: QosZeroSubscribeOptions,
  ): Promise<void> {
    const grants = await this.client.subscribeAsync([...topics], options);
    const rejectedGrant = grants.find((grant) => grant.qos === 128);
    if (rejectedGrant !== undefined) {
      throw new Error(
        `MQTT broker rejected subscription to ${rejectedGrant.topic}`,
      );
    }
  }

  public async publish(
    topic: string,
    payload: string,
    options: QosZeroPublishOptions,
  ): Promise<void> {
    await this.client.publishAsync(topic, payload, options);
  }

  public async stop(): Promise<void> {
    await this.client.endAsync(false);
  }
}

function assertMqttBrokerUrl(brokerUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(brokerUrl);
  } catch {
    throw new TypeError("MQTT broker URL must be an absolute URL");
  }

  if (parsed.protocol !== "mqtt:" && parsed.protocol !== "mqtts:") {
    throw new TypeError("MQTT broker URL must use mqtt:// or mqtts://");
  }
  if (parsed.username.length > 0 || parsed.password.length > 0) {
    throw new TypeError(
      "MQTT broker URL must not contain credentials; use explicit connection options",
    );
  }
}

function assertIntegerAtLeast(
  value: number | undefined,
  description: string,
  minimum: number,
): void {
  if (
    value !== undefined &&
    (!Number.isSafeInteger(value) || value < minimum)
  ) {
    throw new RangeError(
      `${description} must be an integer of at least ${minimum}`,
    );
  }
}
