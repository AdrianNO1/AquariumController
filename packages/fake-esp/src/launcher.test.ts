import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  parseFakeEspLauncherArguments,
  startFakeEspLauncher,
} from "./launcher.js";
import type {
  FakeEspMqttClientConfig,
  FakeEspMqttClientPort,
} from "./mqtt-transport.js";

const encoder = new TextEncoder();
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("managed fake ESP launcher", () => {
  it("powers, isolates, faults, and reboots devices independently", async () => {
    const clients: AutomaticMqttClient[] = [];
    const storageDirectory = temporaryDirectory();
    const launcher = await startFakeEspLauncher({
      brokerUrl: "mqtt://127.0.0.1:1883",
      storageDirectory,
      namespace: "test/aquarium",
      devices: [
        { key: "alpha", name: "Alpha", id: "A1B2C3D4" },
        { key: "beta", name: "Beta", id: "B1C2D3E4" },
      ],
      clientFactory: (config) => {
        const client = new AutomaticMqttClient(config);
        clients.push(client);
        return client;
      },
    });

    try {
      expect(launcher.snapshot().devices).toMatchObject([
        {
          key: "alpha",
          powered: true,
          networkEnabled: true,
          mqttConnected: true,
          deviceName: "Alpha",
        },
        {
          key: "beta",
          powered: true,
          networkEnabled: true,
          mqttConnected: true,
          deviceName: "Beta",
        },
      ]);

      clients[0]?.emitMessage(
        "test/aquarium/command",
        "A1B2C3D4 e Renamed 6000 10",
      );
      clients[0]?.emitMessage("test/aquarium/command", "A1B2C3D4 s 4 128 1");
      expect(launcher.snapshot().devices[0]).toMatchObject({
        deviceName: "Renamed",
        frequencyHz: 6_000,
        resolutionBits: 10,
        pins: [
          {
            pin: 4,
            attached: true,
            outputValue: 513,
            outputPercentage: 50.15,
            overwritten: true,
          },
        ],
      });

      launcher.setNetworkEnabled("alpha", false);
      launcher.setResponseFaults("alpha", {
        delayMilliseconds: 250,
        drop: true,
      });
      launcher.setPinAttachmentFailure("alpha", 4, true);
      expect(launcher.snapshot().devices[0]).toMatchObject({
        powered: true,
        networkEnabled: false,
        mqttConnected: true,
        responseFaults: {
          delayMilliseconds: 250,
          drop: true,
        },
        pins: [{ pin: 4, attachmentFailure: true }],
      });
      expect(launcher.snapshot().devices[1]).toMatchObject({
        powered: true,
        networkEnabled: true,
      });

      await launcher.powerOff("alpha");
      expect(launcher.sessions.has("alpha")).toBe(false);
      expect(launcher.snapshot().devices[0]).toMatchObject({
        powered: false,
        networkEnabled: false,
        deviceName: "Renamed",
        pins: [
          {
            pin: 4,
            attached: false,
            attachmentFailure: true,
          },
        ],
      });

      launcher.setPinAttachmentFailure("alpha", 4, false);
      expect(launcher.snapshot().devices[0]?.pins).toEqual([]);

      await launcher.powerOn("alpha");
      expect(launcher.sessions.has("alpha")).toBe(true);
      expect(launcher.snapshot().devices[0]).toMatchObject({
        powered: true,
        networkEnabled: false,
        mqttConnected: true,
        deviceName: "Renamed",
        frequencyHz: 6_000,
        resolutionBits: 10,
        responseFaults: { drop: true },
      });
      expect(clients).toHaveLength(3);
    } finally {
      await launcher.stop();
    }
  });

  it("parses an optional control server endpoint as an explicit pair", () => {
    expect(
      parseFakeEspLauncherArguments([
        "--broker",
        "mqtt://127.0.0.1:1883",
        "--store",
        "C:/fake-store",
        "--namespace",
        "test/aquarium",
        "--control-host",
        "0.0.0.0",
        "--control-port",
        "3002",
        "--device",
        "alpha:Alpha:A1B2C3D4",
      ]),
    ).toMatchObject({
      controlHost: "0.0.0.0",
      controlPort: 3_002,
    });

    expect(() =>
      parseFakeEspLauncherArguments([
        "--broker",
        "mqtt://127.0.0.1:1883",
        "--store",
        "C:/fake-store",
        "--control-port",
        "3002",
        "--device",
        "alpha:Alpha:A1B2C3D4",
      ]),
    ).toThrow(/both --control-host and --control-port/u);
  });
});

class AutomaticMqttClient implements FakeEspMqttClientPort {
  private readonly connectedHandlers = new Set<() => void>();
  private readonly disconnectedHandlers = new Set<() => void>();
  private readonly errorHandlers = new Set<(error: Error) => void>();
  private readonly messageHandlers = new Set<
    (topic: string, payload: Uint8Array) => void
  >();

  public constructor(public readonly config: FakeEspMqttClientConfig) {}

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

  public onMessage(
    handler: (topic: string, payload: Uint8Array) => void,
  ): () => void {
    this.messageHandlers.add(handler);
    return () => this.messageHandlers.delete(handler);
  }

  public start(): void {
    queueMicrotask(() => {
      for (const handler of this.connectedHandlers) {
        handler();
      }
    });
  }

  public async subscribe(): Promise<void> {}

  public publish(): void {}

  public async stop(): Promise<void> {
    for (const handler of this.disconnectedHandlers) {
      handler();
    }
  }

  public emitMessage(topic: string, payload: string): void {
    for (const handler of this.messageHandlers) {
      handler(topic, encoder.encode(payload));
    }
  }
}

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "aquarium-fake-launcher-"));
  temporaryDirectories.push(directory);
  return directory;
}
