import { ManualFakeEspClock } from "./clock.js";
import {
  FakeEspActor,
  type FakeEspActorOptions,
  type FakeEspResponseFaults,
} from "./fake-esp.js";
import type { FakeEspPersistence } from "./persistence.js";
import { MemoryFakeEspPersistence } from "./persistence.js";
import {
  createFakeEspTopics,
  InMemoryFakeEspBus,
  type FakeEspTopics,
} from "./transport.js";

export interface FakeEspHarnessActorOptions {
  readonly key: string;
  readonly deviceName: string;
  readonly deviceId: string;
  readonly persistence?: FakeEspPersistence;
  readonly responseFaults?: FakeEspResponseFaults;
}

interface HarnessActorRegistration {
  readonly options: FakeEspHarnessActorOptions;
  readonly persistence: FakeEspPersistence;
  actor: FakeEspActor;
}

export class FakeEspHarness {
  public readonly bus = new InMemoryFakeEspBus();
  public readonly clock: ManualFakeEspClock;
  public readonly topics: FakeEspTopics;

  private readonly namespace: string;
  private readonly registrations = new Map<string, HarnessActorRegistration>();

  public constructor(
    actors: readonly FakeEspHarnessActorOptions[],
    options: {
      readonly namespace?: string;
      readonly startMilliseconds?: number;
    } = {},
  ) {
    this.namespace = options.namespace ?? "test/aquarium";
    this.topics = createFakeEspTopics(this.namespace);
    this.clock = new ManualFakeEspClock(options.startMilliseconds ?? 1);
    for (const actor of actors) {
      if (this.registrations.has(actor.key)) {
        throw new Error(`Duplicate fake ESP harness key ${actor.key}`);
      }
      const persistence = actor.persistence ?? new MemoryFakeEspPersistence();
      const registration: HarnessActorRegistration = {
        options: actor,
        persistence,
        actor: this.createActor(actor, persistence),
      };
      this.registrations.set(actor.key, registration);
    }
  }

  public connectAll(): void {
    for (const registration of this.registrations.values()) {
      registration.actor.connect();
    }
  }

  public disconnectAll(): void {
    for (const registration of this.registrations.values()) {
      registration.actor.disconnect();
    }
  }

  public actor(key: string): FakeEspActor {
    const registration = this.registrations.get(key);
    if (registration === undefined) {
      throw new Error(`Unknown fake ESP harness key ${key}`);
    }
    return registration.actor;
  }

  public restartActor(key: string): FakeEspActor {
    const registration = this.registrations.get(key);
    if (registration === undefined) {
      throw new Error(`Unknown fake ESP harness key ${key}`);
    }
    const wasConnected = registration.actor.isReady();
    registration.actor.disconnect();
    registration.actor = this.createActor(
      registration.options,
      registration.persistence,
    );
    if (wasConnected) {
      registration.actor.connect();
    }
    return registration.actor;
  }

  public publishCommand(payload: string): void {
    this.bus.publishFromHost(this.topics.command, payload);
  }

  public advanceBy(milliseconds: number): void {
    this.clock.advanceBy(milliseconds);
    this.runLoops();
  }

  public runLoops(): void {
    for (const registration of this.registrations.values()) {
      registration.actor.runLoop();
    }
  }

  public setResponseFaults(key: string, faults: FakeEspResponseFaults): void {
    this.actor(key).setResponseFaults(faults);
  }

  private createActor(
    options: FakeEspHarnessActorOptions,
    persistence: FakeEspPersistence,
  ): FakeEspActor {
    const actorOptions: FakeEspActorOptions = {
      transport: this.bus.createActorTransport(),
      clock: this.clock,
      persistence,
      namespace: this.namespace,
      defaultDeviceName: options.deviceName,
      idGenerator: () => options.deviceId,
      ...(options.responseFaults === undefined
        ? {}
        : { responseFaults: options.responseFaults }),
    };
    return new FakeEspActor(actorOptions);
  }
}
