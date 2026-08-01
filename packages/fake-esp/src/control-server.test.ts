import { afterEach, describe, expect, it, vi } from "vitest";

import {
  startFakeEspControlServer,
  type RunningFakeEspControlServer,
} from "./control-server.js";
import type {
  FakeEspSimulatorSnapshot,
  RunningFakeEspLauncher,
} from "./launcher.js";

const runningServers: RunningFakeEspControlServer[] = [];

afterEach(async () => {
  await Promise.all(runningServers.splice(0).map((server) => server.stop()));
});

describe("fake ESP control server", () => {
  it("serves the compact console, assets, health, and live snapshot", async () => {
    const launcher = createLauncher();
    const server = await startServer(launcher);

    const page = await fetch(server.url);
    expect(page.status).toBe(200);
    expect(page.headers.get("content-security-policy")).toContain(
      "script-src 'self'",
    );
    expect(await page.text()).toContain("Fake ESP32 devices");

    const [styles, script, health, snapshot] = await Promise.all([
      fetch(`${server.url}/console.css`),
      fetch(`${server.url}/console.js`),
      fetch(`${server.url}/api/health`),
      fetch(`${server.url}/api/snapshot`),
    ]);
    expect(styles.headers.get("content-type")).toContain("text/css");
    expect(await styles.text()).toContain(".device-card");
    expect(script.headers.get("content-type")).toContain("text/javascript");
    expect(await script.text()).toContain('new EventSource("/api/events")');
    await expect(health.json()).resolves.toEqual({ status: "ok" });
    await expect(snapshot.json()).resolves.toEqual(simulatorSnapshot);
  });

  it("streams simulator snapshots over server-sent events", async () => {
    const server = await startServer(createLauncher());
    const controller = new AbortController();
    const response = await fetch(`${server.url}/api/events`, {
      signal: controller.signal,
    });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const reader = response.body?.getReader();
    if (reader === undefined) {
      throw new Error("Expected a readable event stream");
    }
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain(
      '"key":"reef-left"',
    );
    await reader.cancel();
    controller.abort();
  });

  it("applies power, network, response, and pin controls", async () => {
    const launcher = createLauncher();
    const server = await startServer(launcher);

    await expect(
      post(server, "/api/devices/reef-left/power", { powered: false }),
    ).resolves.toMatchObject({ status: 200 });
    expect(launcher.powerOff).toHaveBeenCalledWith("reef-left");

    await expect(
      post(server, "/api/devices/reef-left/network", { enabled: false }),
    ).resolves.toMatchObject({ status: 200 });
    expect(launcher.setNetworkEnabled).toHaveBeenCalledWith("reef-left", false);

    await expect(
      post(server, "/api/devices/reef-left/faults", {
        delayMilliseconds: 250,
        duplicateResponses: 2,
        drop: true,
        malformed: false,
      }),
    ).resolves.toMatchObject({ status: 200 });
    expect(launcher.setResponseFaults).toHaveBeenCalledWith("reef-left", {
      delayMilliseconds: 250,
      duplicateResponses: 2,
      drop: true,
      malformed: false,
    });

    await expect(
      post(server, "/api/devices/reef-left/pin-failures/4", {
        failing: true,
      }),
    ).resolves.toMatchObject({ status: 200 });
    expect(launcher.setPinAttachmentFailure).toHaveBeenCalledWith(
      "reef-left",
      4,
      true,
    );
  });

  it("rejects malformed and cross-origin mutations", async () => {
    const launcher = createLauncher();
    const server = await startServer(launcher);
    const malformed = await post(server, "/api/devices/reef-left/power", {
      powered: "no",
    });
    expect(malformed.status).toBe(400);

    const crossOrigin = await fetch(
      `${server.url}/api/devices/reef-left/reboot`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Origin: "https://example.invalid",
        },
        body: "{}",
      },
    );
    expect(crossOrigin.status).toBe(403);
    expect(launcher.reboot).not.toHaveBeenCalled();
  });
});

async function startServer(
  launcher: RunningFakeEspLauncher,
): Promise<RunningFakeEspControlServer> {
  const server = await startFakeEspControlServer({
    host: "127.0.0.1",
    port: 0,
    launcher,
  });
  runningServers.push(server);
  return server;
}

async function post(
  server: RunningFakeEspControlServer,
  path: string,
  body: object,
): Promise<Response> {
  return fetch(`${server.url}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

function createLauncher(): RunningFakeEspLauncher {
  return {
    sessions: new Map(),
    snapshot: vi.fn(() => simulatorSnapshot),
    powerOn: vi.fn(async () => {}),
    powerOff: vi.fn(async () => {}),
    reboot: vi.fn(async () => {}),
    setNetworkEnabled: vi.fn(),
    setResponseFaults: vi.fn(),
    setPinAttachmentFailure: vi.fn(),
    setAnalogValue: vi.fn(),
    stop: vi.fn(async () => {}),
  };
}

const simulatorSnapshot: FakeEspSimulatorSnapshot = {
  devices: [
    {
      key: "reef-left",
      configuredName: "ReefLeft",
      configuredId: "000000A1",
      powered: true,
      networkEnabled: true,
      mqttConnected: true,
      deviceName: "ReefLeft",
      deviceId: "000000A1",
      firmwareVersion: "4.1.0",
      frequencyHz: 5_000,
      resolutionBits: 8,
      currentEpochSeconds: 1_735_689_600,
      currentMinuteOfDay: 720,
      persistedEpochSeconds: 1_735_689_600,
      scheduleBytes: 512,
      lastError: null,
      responseFaults: {
        delayMilliseconds: 0,
        drop: false,
        dropNextResponseForCommand: null,
        duplicateResponses: 0,
        malformed: false,
      },
      pins: [
        {
          pin: 4,
          attached: true,
          outputValue: 128,
          outputPercentage: 50.2,
          lastManualValue: 128,
          overwritten: false,
          attachmentFailure: false,
        },
      ],
    },
  ],
};
