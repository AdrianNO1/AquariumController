import { ManualFakeEspClock } from "./clock.js";
import {
  encodeFakeEspCommandRequest,
  FAKE_ESP_MQTT_PROTOCOL_VERSION,
  type FakeEspCommand,
} from "./structured-protocol.js";
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
} from "./transport.js";

export interface FakeEspHarnessTopics {
  readonly discoveryRequest: string;
  readonly command: string;
  readonly announce: string;
  readonly response: string;
}

export interface FakeEspHarnessActorOptions {
  readonly key: string;
  readonly deviceName: string;
  readonly deviceId: string;
  readonly persistence?: FakeEspPersistence;
  readonly responseFaults?: FakeEspResponseFaults;
  readonly pinAttachmentFailures?: readonly number[];
}

interface HarnessActorRegistration {
  readonly options: FakeEspHarnessActorOptions;
  readonly persistence: FakeEspPersistence;
  actor: FakeEspActor;
}

export class FakeEspHarness {
  public readonly bus = new InMemoryFakeEspBus();
  public readonly clock: ManualFakeEspClock;
  public readonly topics: FakeEspHarnessTopics;

  private readonly namespace: string;
  private readonly protocolTopics: ReturnType<typeof createFakeEspTopics>;
  private readonly registrations = new Map<string, HarnessActorRegistration>();
  private requestSequence = 0;

  public constructor(
    actors: readonly FakeEspHarnessActorOptions[],
    options: {
      readonly namespace?: string;
      readonly startMilliseconds?: number;
    } = {},
  ) {
    this.namespace = options.namespace ?? "test/aquarium";
    this.protocolTopics = createFakeEspTopics(this.namespace);
    const primaryDeviceId = actors[0]?.deviceId ?? "unconfigured";
    this.topics = {
      discoveryRequest: this.protocolTopics.discoveryRequest,
      command: this.protocolTopics.command(primaryDeviceId),
      announce: this.protocolTopics.announcement(primaryDeviceId),
      response: this.protocolTopics.response(primaryDeviceId),
    };
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
    if (payload === "discover") {
      this.bus.publishFromHost(
        this.protocolTopics.discoveryRequest,
        JSON.stringify({
          protocolVersion: FAKE_ESP_MQTT_PROTOCOL_VERSION,
          kind: "discover",
        }),
      );
      return;
    }
    const legacyRequestSeparator = payload.startsWith("request:")
      ? payload.indexOf("|")
      : -1;
    const requestedId =
      legacyRequestSeparator > 8
        ? payload.slice(8, legacyRequestSeparator)
        : undefined;
    const wirePayload =
      legacyRequestSeparator >= 0
        ? payload.slice(legacyRequestSeparator + 1)
        : payload;
    const commandsByDevice = new Map<
      string,
      { readonly deviceName: string; readonly commands: string[] }
    >();
    for (const command of wirePayload
      .split(";")
      .filter((value) => value.length > 0)) {
      const commandTarget = command.split(" ", 1)[0];
      const target = [...this.registrations.values()]
        .map(({ actor }) => actor.identity())
        .find(
          ({ deviceId, deviceName }) =>
            commandTarget === deviceId || commandTarget === deviceName,
        );
      if (target === undefined) continue;
      const existing = commandsByDevice.get(target.deviceId);
      if (existing === undefined) {
        commandsByDevice.set(target.deviceId, {
          deviceName: target.deviceName,
          commands: [command],
        });
      } else {
        existing.commands.push(command);
      }
    }

    for (const [deviceId, target] of commandsByDevice) {
      for (let offset = 0; offset < target.commands.length; offset += 3) {
        const commands = target.commands
          .slice(offset, offset + 3)
          .map((command, index) =>
            parseLegacyHarnessCommand(
              command,
              deviceId,
              target.deviceName,
              index,
            ),
          );
        this.requestSequence += 1;
        const requestId =
          requestedId !== undefined &&
          commandsByDevice.size === 1 &&
          target.commands.length <= 3
            ? requestedId
            : `harness-${this.requestSequence}`;
        this.bus.publishFromHost(
          this.protocolTopics.command(deviceId),
          encodeFakeEspCommandRequest({
            deviceId,
            requestId,
            commands,
          }),
        );
      }
    }
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

  public setPinAttachmentFailure(
    key: string,
    pin: number,
    failing: boolean,
  ): void {
    this.actor(key).setPinAttachmentFailure(pin, failing);
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
      ...(options.pinAttachmentFailures === undefined
        ? {}
        : { pinAttachmentFailures: options.pinAttachmentFailures }),
    };
    return new FakeEspActor(actorOptions);
  }
}

function parseLegacyHarnessCommand(
  value: string,
  deviceId: string,
  deviceName: string,
  index: number,
): FakeEspCommand {
  const firstSpace = value.indexOf(" ");
  const target = firstSpace < 0 ? "" : value.slice(0, firstSpace);
  if (target !== deviceId && target !== deviceName) {
    throw new Error("Harness command targets more than one fake ESP");
  }
  const operation = value.slice(firstSpace + 1);
  if (operation.startsWith("sc ")) {
    return {
      index,
      kind: "schedule",
      schedule: JSON.parse(operation.slice(3)),
    } as FakeEspCommand;
  }
  const [kind, ...arguments_] = operation.split(" ");
  switch (kind) {
    case "s":
      return {
        index,
        kind: "set_pwm",
        pin: Number(arguments_[0]),
        value: Number(arguments_[1]),
        overwrite: arguments_[2] === "1",
      };
    case "p":
      return { index, kind: "ping" };
    case "e":
      if (arguments_[0] === undefined) {
        throw new Error("Harness edit command is missing a device name");
      }
      return {
        index,
        kind: "edit_configuration",
        name: arguments_[0],
        pwmFrequencyHz: Number(arguments_[1]),
        pwmResolutionBits: Number(arguments_[2]),
      };
    case "sync":
      return {
        index,
        kind: "sync_time",
        epochSeconds: Number(arguments_[0]),
      };
    case "r":
      return {
        index,
        kind: "analog_read",
        pin: Number(arguments_[0]),
      };
    default:
      throw new Error(`Unsupported legacy harness command ${kind ?? ""}`);
  }
}
