import { createServer } from "node:net";

import { connectAsync, type MqttClient } from "mqtt";
import {
  GenericContainer,
  Network,
  Wait,
  type StartedNetwork,
  type StartedTestContainer,
} from "testcontainers";

export const PINNED_MOSQUITTO_IMAGE =
  "eclipse-mosquitto:2.0.22-openssl@sha256:212f89e1eaeb2c322d6441b64396e3346026674db8fa9c27beac293405c32b3c";

export interface CapturedMqttPublication {
  readonly topic: string;
  readonly payload: string;
  readonly qos: number;
  readonly retain: boolean;
}

const MOSQUITTO_PORT = 1_883;
const CAPTURE_RECONNECT_TIMEOUT_MS = 5_000;
const CAPTURE_RECONNECT_DELAY_MS = 50;
const MOSQUITTO_CONFIGURATION = [
  "listener 1883 0.0.0.0",
  "allow_anonymous true",
  "persistence false",
  "log_dest stdout",
  "connection_messages true",
  "log_type all",
  "",
].join("\n");

/**
 * A host-only real-broker fixture shared by MQTT integration and browser tests.
 * It captures both allowed and production namespaces so teardown can prove that
 * a test never escaped onto `aquarium/*`.
 */
export class MosquittoTestHarness {
  readonly #network: StartedNetwork;
  readonly #container: StartedTestContainer;
  #captureClient: MqttClient;
  readonly #captureClientId: string;
  readonly #publications: CapturedMqttPublication[] = [];
  #stopped = false;

  private constructor(
    network: StartedNetwork,
    container: StartedTestContainer,
    captureClient: MqttClient,
    publicBrokerUrl: string,
    captureClientId: string,
  ) {
    this.#network = network;
    this.#container = container;
    this.#captureClient = captureClient;
    this.#captureClientId = captureClientId;
    this.brokerUrl = publicBrokerUrl;
  }

  readonly brokerUrl: string;

  static async start(): Promise<MosquittoTestHarness> {
    const network = await new Network().start();
    const hostPort = await allocateHostPort();
    let container: StartedTestContainer | undefined;
    let captureClient: MqttClient | undefined;
    try {
      container = await new GenericContainer(PINNED_MOSQUITTO_IMAGE)
        .withNetwork(network)
        .withNetworkAliases("mosquitto-integration")
        .withExposedPorts({ container: MOSQUITTO_PORT, host: hostPort })
        .withCopyContentToContainer([
          {
            content: MOSQUITTO_CONFIGURATION,
            target: "/mosquitto/config/mosquitto.conf",
            mode: 0o644,
          },
        ])
        // Docker Desktop can reset its log-stream connection while this same
        // container restarts. Port readiness avoids leaving that diagnostic
        // stream as an unowned error source during the broker-loss test.
        .withWaitStrategy(Wait.forListeningPorts())
        .withStartupTimeout(60_000)
        .start();

      const brokerUrl = `mqtt://${container.getHost()}:${container.getMappedPort(MOSQUITTO_PORT)}`;
      const captureClientId = `aquarium-integration-capture-${container.getId().slice(0, 12)}`;
      captureClient = await connectAsync(
        brokerUrl,
        captureConnectionOptions(captureClientId),
      );

      const harness = new MosquittoTestHarness(
        network,
        container,
        captureClient,
        brokerUrl,
        captureClientId,
      );
      harness.#attachCaptureClient(captureClient);
      await harness.#subscribeCaptureClient(captureClient);
      return harness;
    } catch (error) {
      const errors = [toError(error)];
      if (captureClient !== undefined) {
        try {
          await captureClient.endAsync(true);
        } catch (cleanupError) {
          errors.push(toError(cleanupError));
        }
      }
      if (container !== undefined) {
        try {
          await container.stop();
        } catch (cleanupError) {
          errors.push(toError(cleanupError));
        }
      }
      try {
        await network.stop();
      } catch (cleanupError) {
        errors.push(toError(cleanupError));
      }
      if (errors.length > 1) {
        throw new AggregateError(
          errors,
          "Mosquitto test harness startup and cleanup failed",
          { cause: error },
        );
      }
      throw error;
    }
  }

  publications(): readonly CapturedMqttPublication[] {
    return [...this.#publications];
  }

  clearPublications(): void {
    this.#publications.length = 0;
  }

  async publish(topic: string, payload: string): Promise<void> {
    assertTestAquariumTopic(topic);
    await this.#captureClient.publishAsync(topic, payload, {
      qos: 0,
      retain: false,
    });
  }

  async restartBroker(): Promise<void> {
    await this.#captureClient.endAsync(true);
    await this.#container.restart({ timeout: 5_000 });
    const currentBrokerUrl = `mqtt://${this.#container.getHost()}:${this.#container.getMappedPort(MOSQUITTO_PORT)}`;
    if (currentBrokerUrl !== this.brokerUrl) {
      throw new Error(
        `Mosquitto mapped endpoint changed across restart: ${this.brokerUrl} -> ${currentBrokerUrl}`,
      );
    }
    // Capture is instrumentation rather than a reconnect subject. Recreate it
    // after the broker is ready; controller and fake clients still recover
    // autonomously.
    const captureClient = await reconnectCaptureClient(
      this.brokerUrl,
      this.#captureClientId,
    );
    this.#captureClient = captureClient;
    this.#attachCaptureClient(captureClient);
    await this.#subscribeCaptureClient(captureClient);
  }

  assertOnlyTestAquariumTraffic(): void {
    const unsafe = this.#publications.filter(
      ({ topic }) => !isTestAquariumTopic(topic),
    );
    if (unsafe.length > 0) {
      throw new Error(
        `Observed MQTT traffic outside test/aquarium/*: ${unsafe
          .map(({ topic }) => topic)
          .join(", ")}`,
      );
    }
  }

  async stop(): Promise<void> {
    if (this.#stopped) {
      return;
    }
    this.#stopped = true;
    const errors: Error[] = [];
    try {
      await this.#captureClient.endAsync(false);
    } catch (error) {
      errors.push(toError(error));
    }
    try {
      await this.#container.stop();
    } catch (error) {
      errors.push(toError(error));
    }
    try {
      await this.#network.stop();
    } catch (error) {
      errors.push(toError(error));
    }
    if (errors.length > 0) {
      throw new AggregateError(
        errors,
        "Mosquitto test harness teardown failed",
      );
    }
  }

  #attachCaptureClient(client: MqttClient): void {
    client.on("message", (topic, payload, packet) => {
      this.#publications.push({
        topic,
        payload: payload.toString("utf8"),
        qos: packet.qos,
        retain: packet.retain,
      });
    });
  }

  async #subscribeCaptureClient(client: MqttClient): Promise<void> {
    await client.subscribeAsync(["test/aquarium/#", "aquarium/#"], {
      qos: 0,
    });
  }
}

export async function waitUntil(
  predicate: () => boolean | Promise<boolean>,
  description: string,
  timeoutMs = 5_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() <= deadline) {
    if (await predicate()) {
      return;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

function assertTestAquariumTopic(
  topic: string,
): void {
  if (!isTestAquariumTopic(topic)) {
    throw new Error(
      `MQTT integration publication attempted unsafe topic ${topic}`,
    );
  }
}

function isTestAquariumTopic(topic: string): boolean {
  return (
    topic === "test/aquarium/command" ||
    topic === "test/aquarium/announce" ||
    topic === "test/aquarium/v1/discovery/request" ||
    /^test\/aquarium\/v1\/devices\/[A-Za-z0-9_-]{1,128}\/(?:command|announce|response)$/u.test(
      topic,
    )
  );
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function captureConnectionOptions(clientId: string) {
  return {
    protocolVersion: 4 as const,
    protocolId: "MQTT" as const,
    clean: true,
    clientId,
    keepalive: 5,
    connectTimeout: 5_000,
    reconnectPeriod: 100,
    resubscribe: true,
  };
}

async function reconnectCaptureClient(
  brokerUrl: string,
  clientId: string,
): Promise<MqttClient> {
  const deadline = Date.now() + CAPTURE_RECONNECT_TIMEOUT_MS;
  let mostRecentError: Error | undefined;

  do {
    try {
      return await connectAsync(brokerUrl, captureConnectionOptions(clientId));
    } catch (error) {
      const normalizedError = toError(error);
      if (!isTransientBrokerRestartError(normalizedError)) {
        throw normalizedError;
      }
      mostRecentError = normalizedError;
      await new Promise<void>((resolve) =>
        setTimeout(resolve, CAPTURE_RECONNECT_DELAY_MS),
      );
    }
  } while (Date.now() < deadline);

  throw new Error(
    `Capture client could not reconnect within ${CAPTURE_RECONNECT_TIMEOUT_MS}ms`,
    { cause: mostRecentError },
  );
}

function isTransientBrokerRestartError(error: Error): boolean {
  if (!("code" in error) || typeof error.code !== "string") {
    return false;
  }
  return error.code === "ECONNRESET" || error.code === "ECONNREFUSED";
}

async function allocateHostPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    server.close();
    throw new Error("Could not allocate a loopback port for Mosquitto");
  }
  await new Promise<void>((resolve, reject) => {
    server.close((error) => (error === undefined ? resolve() : reject(error)));
  });
  return address.port;
}
