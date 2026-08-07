export const FAKE_ESP_TEST_NAMESPACE = "test/aquarium";

export type FakeEspTopicKind =
  | "discovery"
  | "command"
  | "announce"
  | "response";
export interface FakeEspTopics {
  readonly namespace: string;
  readonly discoveryRequest: string;
  readonly announcementFilter: string;
  readonly responseFilter: string;
  readonly legacyDiscoveryCommand: string;
  readonly legacyAnnouncement: string;
  command(deviceId: string): string;
  announcement(deviceId: string): string;
  response(deviceId: string): string;
  announcementDeviceId(topic: string): string | null;
  responseDeviceId(topic: string): string | null;
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
  const protocolRoot = `${namespace}/v1`;
  const deviceRoot = `${protocolRoot}/devices`;
  const topicFor = (
    deviceId: string,
    kind: "command" | "announce" | "response",
  ): string => `${deviceRoot}/${validDeviceId(deviceId)}/${kind}`;
  return {
    namespace,
    discoveryRequest: `${protocolRoot}/discovery/request`,
    announcementFilter: `${deviceRoot}/+/announce`,
    responseFilter: `${deviceRoot}/+/response`,
    legacyDiscoveryCommand: `${namespace}/command`,
    legacyAnnouncement: `${namespace}/announce`,
    command: (deviceId) => topicFor(deviceId, "command"),
    announcement: (deviceId) => topicFor(deviceId, "announce"),
    response: (deviceId) => topicFor(deviceId, "response"),
    announcementDeviceId: (topic) =>
      parseDeviceTopic(topic, deviceRoot, "announce"),
    responseDeviceId: (topic) =>
      parseDeviceTopic(topic, deviceRoot, "response"),
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
    segments.some((segment) => !/^[A-Za-z0-9_-]+$/u.test(segment))
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
  const match =
    /^(test\/aquarium(?:\/[A-Za-z0-9_-]+)*)\/v1\/(?:(?:devices\/([A-Za-z0-9_-]+)\/(command|announce|response))|(discovery\/request))$/u.exec(
      topic,
    );
  if (match === null) {
    throw new Error("Fake ESP topic is outside its structured test namespace");
  }
  assertFakeEspTestNamespace(match[1] ?? "");
  const kind: FakeEspTopicKind =
    match[4] === "discovery/request"
      ? "discovery"
      : (match[3] as "command" | "announce" | "response");
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
    assertFakeEspHostTopic(topic);
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
    assertFakeEspHostTopic(topic);
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

function assertFakeEspHostTopic(topic: string): void {
  try {
    assertFakeEspTestTopic(topic, "command");
  } catch (commandError) {
    try {
      assertFakeEspTestTopic(topic, "discovery");
    } catch {
      throw commandError;
    }
  }
}

function validDeviceId(deviceId: string): string {
  if (!/^[A-Za-z0-9_-]{1,128}$/u.test(deviceId)) {
    throw new TypeError("Fake ESP device ID is invalid");
  }
  return deviceId;
}

function parseDeviceTopic(
  topic: string,
  deviceRoot: string,
  kind: "announce" | "response",
): string | null {
  const prefix = `${deviceRoot}/`;
  const suffix = `/${kind}`;
  if (!topic.startsWith(prefix) || !topic.endsWith(suffix)) return null;
  const deviceId = topic.slice(prefix.length, -suffix.length);
  return /^[A-Za-z0-9_-]{1,128}$/u.test(deviceId) ? deviceId : null;
}
