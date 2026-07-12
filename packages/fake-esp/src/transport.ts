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

export class InMemoryFakeEspBus {
  private readonly subscriptions = new Set<Subscription>();
  private readonly recordedPublications: InMemoryFakeEspPublication[] = [];

  public createActorTransport(): FakeEspTransport {
    return new ActorTransport(this);
  }

  public publishFromHost(topic: string, payload: string): void {
    this.publish(topic, payload, "host");
  }

  public publications(): readonly InMemoryFakeEspPublication[] {
    return this.recordedPublications.map((publication) => ({ ...publication }));
  }

  public clearPublications(): void {
    this.recordedPublications.length = 0;
  }

  public publishFromActor(topic: string, payload: string): void {
    this.publish(topic, payload, "actor");
  }

  public subscribeActor(topic: string, handler: FakeEspMessageHandler): () => void {
    const subscription = { topic, handler };
    this.subscriptions.add(subscription);
    return () => {
      this.subscriptions.delete(subscription);
    };
  }

  private publish(topic: string, payload: string, origin: "host" | "actor"): void {
    this.recordedPublications.push({ topic, payload, origin });
    for (const subscription of [...this.subscriptions]) {
      if (subscription.topic === topic) {
        subscription.handler(topic, payload);
      }
    }
  }
}
