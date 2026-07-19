import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { FakeEspHarness } from "./harness.js";
import {
  parseFakeEspLauncherArguments,
  startFakeEspLauncher,
} from "./launcher.js";
import type { FakeEspMqttClientPort } from "./mqtt-transport.js";

const encoder = new TextEncoder();
const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

class AutoConnectedMqttClient implements FakeEspMqttClientPort {
  public readonly publications: Array<{
    readonly topic: string;
    readonly payload: string;
  }> = [];
  private readonly connectedHandlers = new Set<() => void>();
  private readonly disconnectedHandlers = new Set<() => void>();
  private readonly errorHandlers = new Set<(error: Error) => void>();
  private readonly messageHandlers = new Set<
    (topic: string, payload: Uint8Array) => void
  >();

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
    for (const handler of this.connectedHandlers) {
      handler();
    }
  }

  public async subscribe(
    topic: string,
    options: { readonly qos: 0 },
  ): Promise<void> {
    void topic;
    void options;
  }

  public publish(
    topic: string,
    payload: string,
    options: { readonly qos: 0; readonly retain: false },
  ): void {
    void options;
    this.publications.push({ topic, payload });
  }

  public async stop(): Promise<void> {}

  public emitCommand(payload: string): void {
    for (const handler of this.messageHandlers) {
      handler("test/aquarium/command", encoder.encode(payload));
    }
  }
}

describe("fake ESP harness and launcher", () => {
  it("reconstructs one actor without losing its independent logical store", () => {
    const harness = new FakeEspHarness([
      { key: "alpha", deviceName: "Alpha", deviceId: "A1B2C3D4" },
      { key: "beta", deviceName: "Beta", deviceId: "B1C2D3E4" },
    ]);
    harness.connectAll();
    harness.publishCommand("A1B2C3D4 e Renamed 6000 10");

    expect(harness.restartActor("alpha").identity().deviceName).toBe("Renamed");
    expect(harness.actor("beta").identity().deviceName).toBe("Beta");
    expect(() => harness.actor("missing")).toThrow(/Unknown/);
  });

  it("parses only explicit launcher paths, loopback broker, and named devices", () => {
    const parsed = parseFakeEspLauncherArguments([
      "--broker",
      "mqtt://127.0.0.1:1883",
      "--store",
      ".tmp/fakes",
      "--namespace",
      "test/aquarium/r8",
      "--device",
      "alpha:Alpha:A1B2C3D4",
      "--device",
      "beta:Beta:B1C2D3E4",
    ]);

    expect(parsed).toMatchObject({
      brokerUrl: "mqtt://127.0.0.1:1883",
      namespace: "test/aquarium/r8",
      devices: [
        { key: "alpha", name: "Alpha", id: "A1B2C3D4" },
        { key: "beta", name: "Beta", id: "B1C2D3E4" },
      ],
    });
    expect(() => parseFakeEspLauncherArguments([])).toThrow(/requires/);
    expect(() =>
      parseFakeEspLauncherArguments([
        "--broker",
        "mqtt://192.0.2.1:1883",
        "--store",
        ".tmp/fakes",
        "--device",
        "alpha:Alpha:A1B2C3D4",
      ]),
    ).toThrow(/loopback/);
    expect(() =>
      parseFakeEspLauncherArguments([
        "--broker",
        "mqtt://127.0.0.1:1883",
        "--store",
        ".tmp/fakes",
        "--device",
        "../escape:Alpha:A1B2C3D4",
      ]),
    ).toThrow(/unsafe/);
  });

  it("launches multiple MQTT actors with separate file-backed stores", async () => {
    const directory = temporaryDirectory();
    const clients: AutoConnectedMqttClient[] = [];
    const launcher = await startFakeEspLauncher({
      brokerUrl: "mqtt://127.0.0.1:1883",
      storageDirectory: directory,
      devices: [
        { key: "alpha", name: "Alpha", id: "A1B2C3D4" },
        { key: "beta", name: "Beta", id: "B1C2D3E4" },
      ],
      clientFactory: () => {
        const client = new AutoConnectedMqttClient();
        clients.push(client);
        return client;
      },
    });

    expect([...launcher.sessions.keys()]).toEqual(["alpha", "beta"]);
    expect(clients).toHaveLength(2);
    expect(
      clients.every((client) =>
        client.publications.some(({ topic }) => topic.endsWith("/announce")),
      ),
    ).toBe(true);

    for (const client of clients) {
      client.emitCommand("A1B2C3D4 p");
    }
    expect(
      clients
        .flatMap((client) => client.publications)
        .filter(({ topic }) => topic.endsWith("/response")),
    ).toHaveLength(1);
    await launcher.stop();
  });
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "aquarium-fake-launcher-"));
  temporaryDirectories.push(directory);
  return directory;
}
