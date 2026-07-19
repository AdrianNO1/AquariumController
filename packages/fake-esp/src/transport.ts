export const FAKE_ESP_TEST_NAMESPACE = "test/aquarium";

export type FakeEspTopicKind = "command" | "announce" | "response";

export interface FakeEspTopics {
  readonly command: string;
  readonly announce: string;
  readonly response: string;
}

export type FakeEspMessageHandler = (topic: string, payload: string) => void;

export interface FakeEspTransport {
  publish(topic: string, payload: string): void;
  subscribe(topic: string, handler: FakeEspMessageHandler): () => void;
}

export interface InMemoryFakeEspPublication {
  readonly topic: string;
  readonly payload: string;
  readonly origin: "host" | "actor";
}

interface Subscription {
  readonly topic: string;
  readonly handler: FakeEspMessageHandler;
}

class ActorTransport implements FakeEspTransport {
  public constructor(private readonly bus: InMemoryFakeEspBus) {}

  public publish(topic: string, payload: string): void {
    this.bus.publishFromActor(topic, payload);
  }

  public subscribe(topic: string, handler: FakeEspMessageHandler): () => void {
    return this.bus.subscribeActor(topic, handler);
  }
}

export function createFakeEspTopics(
  namespace = FAKE_ESP_TEST_NAMESPACE,
): FakeEspTopics {
  assertFakeEspTestNamespace(namespace);
  return {
    command: `${namespace}/command`,
    announce: `${namespace}/announce`,
    response: `${namespace}/response`,
  };
}

export function assertFakeEspTestNamespace(namespace: string): void {
  const prefix = `${FAKE_ESP_TEST_NAMESPACE}/`;
  if (namespace !== FAKE_ESP_TEST_NAMESPACE && !namespace.startsWith(prefix)) {
    throw new Error(
      `Fake ESP actors are restricted to ${FAKE_ESP_TEST_NAMESPACE} test namespaces`,
    );
  }

  const suffix = namespace.slice(FAKE_ESP_TEST_NAMESPACE.length);
  if (suffix.length === 0) {
    return;
  }
  const segments = suffix.slice(1).split("/");
  if (
    segments.length === 0 ||
    segments.some((segment) => !/^[A-Za-z0-9_-]+$/.test(segment))
  ) {
    throw new Error(
      "Fake ESP test namespace segments may contain only letters, numbers, underscores, and hyphens",
    );
  }
}

export function assertFakeEspTestTopic(
  topic: string,
  expectedKind?: FakeEspTopicKind,
): void {
  const segments = topic.split("/");
  const kind = segments.at(-1);
  const namespace = segments.slice(0, -1).join("/");
  if (kind !== "command" && kind !== "announce" && kind !== "response") {
    throw new Error(
      "Fake ESP topic must end in command, announce, or response",
    );
  }
  assertFakeEspTestNamespace(namespace);
  if (expectedKind !== undefined && kind !== expectedKind) {
    throw new Error(`Expected a fake ESP ${expectedKind} topic`);
  }
}

export class InMemoryFakeEspBus {
  private readonly subscriptions = new Set<Subscription>();
  private readonly recordedPublications: InMemoryFakeEspPublication[] = [];

  public createActorTransport(): FakeEspTransport {
    return new ActorTransport(this);
  }

  public publishFromHost(topic: string, payload: string): void {
    assertFakeEspTestTopic(topic, "command");
    this.publish(topic, payload, "host");
  }

  public publications(): readonly InMemoryFakeEspPublication[] {
    return this.recordedPublications.map((publication) => ({ ...publication }));
  }

  public clearPublications(): void {
    this.recordedPublications.length = 0;
  }

  public publishFromActor(topic: string, payload: string): void {
    const kind = topic.endsWith("/announce") ? "announce" : "response";
    assertFakeEspTestTopic(topic, kind);
    this.publish(topic, payload, "actor");
  }

  public subscribeActor(
    topic: string,
    handler: FakeEspMessageHandler,
  ): () => void {
    assertFakeEspTestTopic(topic, "command");
    const subscription = { topic, handler };
    this.subscriptions.add(subscription);
    return () => {
      this.subscriptions.delete(subscription);
    };
  }

  private publish(
    topic: string,
    payload: string,
    origin: "host" | "actor",
  ): void {
    this.recordedPublications.push({ topic, payload, origin });
    for (const subscription of [...this.subscriptions]) {
      if (subscription.topic === topic) {
        subscription.handler(topic, payload);
      }
    }
  }
}
