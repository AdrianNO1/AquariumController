import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { SystemFakeEspClock } from "./clock.js";
import { FileFakeEspPersistence } from "./file-persistence.js";
import {
  assertLoopbackMqttBrokerUrl,
  MqttFakeEspSession,
  type FakeEspMqttClientFactory,
} from "./mqtt-transport.js";
import { assertFakeEspTestNamespace } from "./transport.js";

const LOOP_INTERVAL_MILLISECONDS = 50;

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

export interface RunningFakeEspLauncher {
  readonly sessions: ReadonlyMap<string, MqttFakeEspSession>;
  stop(): Promise<void>;
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

  const sessions = new Map<string, MqttFakeEspSession>();
  const clock = new SystemFakeEspClock();
  for (const device of options.devices) {
    assertLauncherDevice(device);
    if (sessions.has(device.key)) {
      throw new Error(`Duplicate fake ESP launcher key ${device.key}`);
    }
    const persistence = new FileFakeEspPersistence(
      resolve(options.storageDirectory, device.key),
    );
    const session = new MqttFakeEspSession({
      brokerUrl: options.brokerUrl,
      clientId: `aquarium-fake-esp-${device.key}`,
      actor: {
        clock,
        persistence,
        defaultDeviceName: device.name,
        idGenerator: () => device.id,
      },
      ...(options.namespace === undefined
        ? {}
        : { namespace: options.namespace }),
      ...(options.clientFactory === undefined
        ? {}
        : { clientFactory: options.clientFactory }),
      ...(options.onError === undefined ? {} : { onError: options.onError }),
    });
    sessions.set(device.key, session);
  }

  try {
    for (const session of sessions.values()) {
      await session.start();
    }
  } catch (error) {
    await Promise.allSettled(
      [...sessions.values()].map((session) => session.stop()),
    );
    throw error;
  }

  const loopTimer = setInterval(() => {
    for (const session of sessions.values()) {
      session.actor.runLoop();
    }
  }, LOOP_INTERVAL_MILLISECONDS);
  let stopped = false;
  return {
    sessions,
    async stop(): Promise<void> {
      if (stopped) {
        return;
      }
      stopped = true;
      clearInterval(loopTimer);
      await Promise.all(
        [...sessions.values()].map((session) => session.stop()),
      );
    },
  };
}

export function parseFakeEspLauncherArguments(
  arguments_: readonly string[],
): FakeEspLauncherOptions {
  let brokerUrl: string | undefined;
  let storageDirectory: string | undefined;
  let namespace: string | undefined;
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
  assertLoopbackMqttBrokerUrl(brokerUrl);
  if (namespace !== undefined) {
    assertFakeEspTestNamespace(namespace);
  }
  return {
    brokerUrl,
    storageDirectory: resolve(storageDirectory),
    devices,
    ...(namespace === undefined ? {} : { namespace }),
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

async function main(): Promise<void> {
  const options = parseFakeEspLauncherArguments(process.argv.slice(2));
  const launcher = await startFakeEspLauncher({
    ...options,
    onError: (error) => console.error(error),
  });
  const stop = async (): Promise<void> => {
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
