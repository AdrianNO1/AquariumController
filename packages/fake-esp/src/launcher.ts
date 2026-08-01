import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { SystemFakeEspClock } from "./clock.js";
import {
  startFakeEspControlServer,
  type RunningFakeEspControlServer,
} from "./control-server.js";
import {
  FAKE_ESP_FIRMWARE_VERSION,
  normalizeFakeEspResponseFaults,
  type FakeEspResponseFaults,
  type NormalizedFakeEspResponseFaults,
} from "./fake-esp.js";
import { FileFakeEspPersistence } from "./file-persistence.js";
import {
  assertLoopbackMqttBrokerUrl,
  MqttFakeEspSession,
  type FakeEspMqttClientFactory,
} from "./mqtt-transport.js";
import type { FakeEspLastError, FakeEspPersistence } from "./persistence.js";
import { assertFakeEspTestNamespace } from "./transport.js";

const LOOP_INTERVAL_MILLISECONDS = 50;
const DEFAULT_FREQUENCY_HERTZ = 5_000;
const DEFAULT_RESOLUTION_BITS = 8;

export interface FakeEspLauncherDevice {
  readonly key: string;
  readonly name: string;
  readonly id: string;
}

export interface FakeEspLauncherOptions {
  readonly brokerUrl: string;
  readonly storageDirectory: string;
  readonly devices: readonly FakeEspLauncherDevice[];
  readonly namespace?: string;
  readonly clientFactory?: FakeEspMqttClientFactory;
  readonly onError?: (error: Error) => void;
}

export interface FakeEspLauncherCommandOptions extends FakeEspLauncherOptions {
  readonly controlHost?: string;
  readonly controlPort?: number;
}

export interface FakeEspSimulatorPinSnapshot {
  readonly pin: number;
  readonly attached: boolean;
  readonly outputValue: number;
  readonly outputPercentage: number;
  readonly lastManualValue: number;
  readonly overwritten: boolean;
  readonly overwriteExpiryMilliseconds?: number;
  readonly analogValue?: number;
  readonly attachmentFailure: boolean;
}

export interface FakeEspSimulatorDeviceSnapshot {
  readonly key: string;
  readonly configuredName: string;
  readonly configuredId: string;
  readonly powered: boolean;
  readonly networkEnabled: boolean;
  readonly mqttConnected: boolean;
  readonly deviceName: string;
  readonly deviceId: string;
  readonly firmwareVersion: string;
  readonly frequencyHz: number;
  readonly resolutionBits: number;
  readonly currentEpochSeconds: number | null;
  readonly currentMinuteOfDay: number | null;
  readonly persistedEpochSeconds: number | null;
  readonly scheduleBytes: number;
  readonly lastError: FakeEspLastError | null;
  readonly responseFaults: NormalizedFakeEspResponseFaults;
  readonly pins: readonly FakeEspSimulatorPinSnapshot[];
}

export interface FakeEspSimulatorSnapshot {
  readonly devices: readonly FakeEspSimulatorDeviceSnapshot[];
}

export interface RunningFakeEspLauncher {
  readonly sessions: ReadonlyMap<string, MqttFakeEspSession>;
  snapshot(): FakeEspSimulatorSnapshot;
  powerOn(key: string): Promise<void>;
  powerOff(key: string): Promise<void>;
  reboot(key: string): Promise<void>;
  setNetworkEnabled(key: string, enabled: boolean): void;
  setResponseFaults(key: string, faults: FakeEspResponseFaults): void;
  setPinAttachmentFailure(key: string, pin: number, failing: boolean): void;
  setAnalogValue(key: string, pin: number, value: number): void;
  stop(): Promise<void>;
}

interface ManagedFakeEspDevice {
  readonly options: FakeEspLauncherDevice;
  readonly persistence: FakeEspPersistence;
  readonly attachmentFailures: Set<number>;
  readonly analogValues: Map<number, number>;
  session: MqttFakeEspSession | null;
  networkEnabled: boolean;
  responseFaults: NormalizedFakeEspResponseFaults;
}

class ManagedFakeEspLauncher implements RunningFakeEspLauncher {
  public readonly sessions = new Map<string, MqttFakeEspSession>();

  private readonly devices = new Map<string, ManagedFakeEspDevice>();
  private readonly clock = new SystemFakeEspClock();
  private loopTimer: NodeJS.Timeout | null = null;
  private stopped = false;

  public constructor(private readonly options: FakeEspLauncherOptions) {
    for (const device of options.devices) {
      assertLauncherDevice(device);
      if (this.devices.has(device.key)) {
        throw new Error(`Duplicate fake ESP launcher key ${device.key}`);
      }
      this.devices.set(device.key, {
        options: device,
        persistence: new FileFakeEspPersistence(
          resolve(options.storageDirectory, device.key),
        ),
        attachmentFailures: new Set<number>(),
        analogValues: new Map<number, number>(),
        session: null,
        networkEnabled: true,
        responseFaults: normalizeFakeEspResponseFaults(),
      });
    }
  }

  public async start(): Promise<void> {
    try {
      for (const key of this.devices.keys()) {
        await this.powerOn(key);
      }
    } catch (error) {
      await this.stop();
      throw error;
    }
    this.loopTimer = setInterval(() => {
      for (const session of this.sessions.values()) {
        session.actor.runLoop();
      }
    }, LOOP_INTERVAL_MILLISECONDS);
  }

  public snapshot(): FakeEspSimulatorSnapshot {
    return {
      devices: [...this.devices.values()].map((device) =>
        this.deviceSnapshot(device),
      ),
    };
  }

  public async powerOn(key: string): Promise<void> {
    this.assertRunning();
    const device = this.device(key);
    if (device.session !== null) {
      return;
    }
    const session = new MqttFakeEspSession({
      brokerUrl: this.options.brokerUrl,
      clientId: `aquarium-fake-esp-${device.options.key}`,
      networkEnabled: device.networkEnabled,
      actor: {
        clock: this.clock,
        persistence: device.persistence,
        defaultDeviceName: device.options.name,
        idGenerator: () => device.options.id,
        responseFaults: device.responseFaults,
        pinAttachmentFailures: [...device.attachmentFailures],
      },
      ...(this.options.namespace === undefined
        ? {}
        : { namespace: this.options.namespace }),
      ...(this.options.clientFactory === undefined
        ? {}
        : { clientFactory: this.options.clientFactory }),
      ...(this.options.onError === undefined
        ? {}
        : { onError: this.options.onError }),
    });
    for (const [pin, value] of device.analogValues) {
      session.actor.setAnalogValue(pin, value);
    }
    device.session = session;
    this.sessions.set(device.options.key, session);
    try {
      await session.start();
    } catch (error) {
      device.session = null;
      this.sessions.delete(device.options.key);
      await session.stop();
      throw error;
    }
  }

  public async powerOff(key: string): Promise<void> {
    this.assertRunning();
    const device = this.device(key);
    const session = device.session;
    if (session === null) {
      return;
    }
    device.session = null;
    this.sessions.delete(device.options.key);
    await session.stop();
  }

  public async reboot(key: string): Promise<void> {
    this.assertRunning();
    await this.powerOff(key);
    await this.powerOn(key);
  }

  public setNetworkEnabled(key: string, enabled: boolean): void {
    this.assertRunning();
    const device = this.device(key);
    device.networkEnabled = enabled;
    device.session?.setNetworkEnabled(enabled);
  }

  public setResponseFaults(key: string, faults: FakeEspResponseFaults): void {
    this.assertRunning();
    const device = this.device(key);
    const normalized = normalizeFakeEspResponseFaults(faults);
    device.responseFaults = normalized;
    device.session?.actor.setResponseFaults(normalized);
  }

  public setPinAttachmentFailure(
    key: string,
    pin: number,
    failing: boolean,
  ): void {
    this.assertRunning();
    const device = this.device(key);
    device.session?.actor.setPinAttachmentFailure(pin, failing);
    if (failing) {
      device.attachmentFailures.add(pin);
    } else {
      device.attachmentFailures.delete(pin);
    }
  }

  public setAnalogValue(key: string, pin: number, value: number): void {
    this.assertRunning();
    const device = this.device(key);
    device.session?.actor.setAnalogValue(pin, value);
    device.analogValues.set(pin, value);
  }

  public async stop(): Promise<void> {
    if (this.stopped) {
      return;
    }
    if (this.loopTimer !== null) {
      clearInterval(this.loopTimer);
      this.loopTimer = null;
    }
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    for (const device of this.devices.values()) {
      device.session = null;
    }
    await Promise.all(sessions.map((session) => session.stop()));
    this.stopped = true;
  }

  private deviceSnapshot(
    device: ManagedFakeEspDevice,
  ): FakeEspSimulatorDeviceSnapshot {
    const session = device.session;
    const persisted = device.persistence.read();
    const identity = session?.actor.identity() ?? {
      deviceName: persisted.deviceName ?? device.options.name,
      deviceId: persisted.deviceId ?? device.options.id,
      frequency: persisted.frequency ?? DEFAULT_FREQUENCY_HERTZ,
      resolution: persisted.resolution ?? DEFAULT_RESOLUTION_BITS,
    };
    const maximumOutput = 2 ** identity.resolution - 1;
    const pinSnapshots = new Map(
      (session?.actor.pinSnapshots() ?? []).map((pin) => [pin.pin, pin]),
    );
    for (const pin of device.attachmentFailures) {
      if (!pinSnapshots.has(pin)) {
        pinSnapshots.set(pin, {
          pin,
          attached: false,
          outputValue: 0,
          lastManualValue: 0,
          overwritten: false,
        });
      }
    }
    return {
      key: device.options.key,
      configuredName: device.options.name,
      configuredId: device.options.id,
      powered: session !== null,
      networkEnabled: device.networkEnabled,
      mqttConnected: session?.isMqttConnected() ?? false,
      deviceName: identity.deviceName,
      deviceId: identity.deviceId,
      firmwareVersion:
        session?.actor.reportedFirmwareVersion() ?? FAKE_ESP_FIRMWARE_VERSION,
      frequencyHz: identity.frequency,
      resolutionBits: identity.resolution,
      currentEpochSeconds: session?.actor.currentEpochSeconds() ?? null,
      currentMinuteOfDay: session?.actor.currentMinuteOfDay() ?? null,
      persistedEpochSeconds: persisted.time?.lastSavedEpochSeconds ?? null,
      scheduleBytes:
        persisted.schedule === undefined
          ? 0
          : new TextEncoder().encode(persisted.schedule).byteLength,
      lastError: persisted.lastError ?? null,
      responseFaults: { ...device.responseFaults },
      pins: [...pinSnapshots.values()]
        .sort((left, right) => left.pin - right.pin)
        .map((pin) => ({
          ...pin,
          outputPercentage:
            maximumOutput <= 0
              ? 0
              : Math.round((pin.outputValue / maximumOutput) * 10_000) / 100,
          attachmentFailure: device.attachmentFailures.has(pin.pin),
        })),
    };
  }

  private device(key: string): ManagedFakeEspDevice {
    const device = this.devices.get(key);
    if (device === undefined) {
      throw new Error(`Unknown fake ESP launcher key ${key}`);
    }
    return device;
  }

  private assertRunning(): void {
    if (this.stopped) {
      throw new Error("Stopped fake ESP launcher cannot be controlled");
    }
  }
}

export async function startFakeEspLauncher(
  options: FakeEspLauncherOptions,
): Promise<RunningFakeEspLauncher> {
  if (options.devices.length === 0) {
    throw new Error("Fake ESP launcher requires at least one device");
  }
  if (options.namespace !== undefined) {
    assertFakeEspTestNamespace(options.namespace);
  }
  const launcher = new ManagedFakeEspLauncher(options);
  await launcher.start();
  return launcher;
}

export function parseFakeEspLauncherArguments(
  arguments_: readonly string[],
): FakeEspLauncherCommandOptions {
  let brokerUrl: string | undefined;
  let storageDirectory: string | undefined;
  let namespace: string | undefined;
  let controlHost: string | undefined;
  let controlPort: number | undefined;
  const devices: FakeEspLauncherDevice[] = [];

  for (let index = 0; index < arguments_.length; index += 2) {
    const flag = arguments_[index];
    const value = arguments_[index + 1];
    if (flag === undefined || value === undefined) {
      throw new Error("Fake ESP launcher arguments must be flag/value pairs");
    }
    if (flag === "--broker") {
      brokerUrl = assignOnce(brokerUrl, value, flag);
    } else if (flag === "--store") {
      storageDirectory = assignOnce(storageDirectory, value, flag);
    } else if (flag === "--namespace") {
      namespace = assignOnce(namespace, value, flag);
    } else if (flag === "--device") {
      devices.push(parseDevice(value));
    } else if (flag === "--control-host") {
      controlHost = assignOnce(controlHost, value, flag);
    } else if (flag === "--control-port") {
      controlPort = parsePort(value);
    } else {
      throw new Error(`Unknown fake ESP launcher argument ${flag}`);
    }
  }

  if (brokerUrl === undefined || storageDirectory === undefined) {
    throw new Error("Fake ESP launcher requires --broker and --store");
  }
  if (devices.length === 0) {
    throw new Error(
      "Fake ESP launcher requires at least one --device key:name:id",
    );
  }
  if ((controlHost === undefined) !== (controlPort === undefined)) {
    throw new Error(
      "Fake ESP launcher control server requires both --control-host and --control-port",
    );
  }
  assertLoopbackMqttBrokerUrl(brokerUrl);
  if (namespace !== undefined) {
    assertFakeEspTestNamespace(namespace);
  }
  return {
    brokerUrl,
    storageDirectory: resolve(storageDirectory),
    devices,
    ...(namespace === undefined ? {} : { namespace }),
    ...(controlHost === undefined ? {} : { controlHost }),
    ...(controlPort === undefined ? {} : { controlPort }),
  };
}

function parseDevice(value: string): FakeEspLauncherDevice {
  const [key, name, id, excess] = value.split(":");
  if (
    key === undefined ||
    name === undefined ||
    id === undefined ||
    excess !== undefined
  ) {
    throw new Error("Fake ESP --device must use key:name:id");
  }
  const device = { key, name, id };
  assertLauncherDevice(device);
  return device;
}

function assertLauncherDevice(device: FakeEspLauncherDevice): void {
  if (!/^[A-Za-z0-9_-]+$/.test(device.key)) {
    throw new Error("Fake ESP launcher key contains unsafe characters");
  }
  if (!/^[!-~]+$/.test(device.name)) {
    throw new Error(
      "Fake ESP launcher name must be printable ASCII without spaces",
    );
  }
  if (!/^[0-9A-F]{8}$/.test(device.id)) {
    throw new Error(
      "Fake ESP launcher ID must be eight uppercase hexadecimal characters",
    );
  }
}

function assignOnce(
  current: string | undefined,
  value: string,
  flag: string,
): string {
  if (current !== undefined) {
    throw new Error(`Fake ESP launcher received duplicate ${flag}`);
  }
  return value;
}

function parsePort(value: string): number {
  if (!/^\d{1,5}$/.test(value)) {
    throw new Error("Fake ESP control port must be an integer");
  }
  const port = Number(value);
  if (port < 1 || port > 65_535) {
    throw new Error("Fake ESP control port must be between 1 and 65535");
  }
  return port;
}

async function main(): Promise<void> {
  const options = parseFakeEspLauncherArguments(process.argv.slice(2));
  const launcher = await startFakeEspLauncher({
    ...options,
    onError: (error) => console.error(error),
  });
  let controlServer: RunningFakeEspControlServer | null = null;
  try {
    controlServer =
      options.controlHost === undefined || options.controlPort === undefined
        ? null
        : await startFakeEspControlServer({
            host: options.controlHost,
            port: options.controlPort,
            launcher,
          });
  } catch (error) {
    await launcher.stop();
    throw error;
  }
  if (controlServer !== null) {
    console.log(`Fake ESP console listening on ${controlServer.url}`);
  }
  let stopping = false;
  const stop = async (): Promise<void> => {
    if (stopping) {
      return;
    }
    stopping = true;
    await controlServer?.stop();
    await launcher.stop();
    process.exitCode = 0;
  };
  process.once("SIGINT", () => void stop());
  process.once("SIGTERM", () => void stop());
}

const entryPoint = process.argv[1];
if (
  entryPoint !== undefined &&
  import.meta.url === pathToFileURL(resolve(entryPoint)).href
) {
  void main().catch((error: Error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
