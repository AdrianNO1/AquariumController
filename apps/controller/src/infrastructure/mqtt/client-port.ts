export const QOS_ZERO = 0 as const;

export interface QosZeroSubscribeOptions {
  readonly qos: typeof QOS_ZERO;
}

export interface QosZeroPublishOptions {
  readonly qos: typeof QOS_ZERO;
  readonly retain: false;
}

export type MqttMessageHandler = (topic: string, payload: Uint8Array) => void;

/**
 * The deliberately small MQTT surface used by the legacy transport. Tests use
 * an in-memory implementation; the production implementation wraps MQTT.js.
 */
export interface LegacyMqttClientPort {
  onConnected(handler: () => void): () => void;
  onDisconnected(handler: () => void): () => void;
  onError(handler: (error: Error) => void): () => void;
  onMessage(handler: MqttMessageHandler): () => void;
  start(): void;
  subscribe(
    topics: readonly string[],
    options: QosZeroSubscribeOptions,
  ): Promise<void>;
  publish(
    topic: string,
    payload: string,
    options: QosZeroPublishOptions,
  ): Promise<void>;
  stop(): Promise<void>;
}

export type LegacyMqttClientFactory = () => LegacyMqttClientPort;
