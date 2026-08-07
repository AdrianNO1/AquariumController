import {
  ManualFakeEspClock,
  MemoryFakeEspPersistence,
  MqttFakeEspSession,
} from "@aquarium/fake-esp";
import {
  calculateLegacyScheduleHash,
  createEspTopicSet,
  espCommandRequestSchema,
} from "@aquarium/esp-protocol";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  MosquittoTestHarness,
  waitUntil,
} from "../../integration-support/mosquitto-test-harness.js";
import { createMqttJsClientFactory } from "./mqtt-js-client.js";
import {
  LegacyMqttTransport,
  type LegacyAnnouncementEvent,
  type LegacyMqttInteraction,
  type LegacyWireCommand,
} from "./legacy-mqtt-transport.js";

const topics = createEspTopicSet(true);
const ALPHA_ID = "A1B2C3D4";
const BETA_ID = "B1C2D3E4";
const EPOCH_SECONDS = 1_735_689_600;

interface ActorFixture {
  readonly session: MqttFakeEspSession;
  readonly clock: ManualFakeEspClock;
}

interface TransportFixture {
  readonly transport: LegacyMqttTransport;
  readonly announcements: LegacyAnnouncementEvent[];
  readonly interactions: LegacyMqttInteraction[];
}

let broker: MosquittoTestHarness;
let clientSequence = 0;
const activeSessions: MqttFakeEspSession[] = [];
const activeTransports: LegacyMqttTransport[] = [];

beforeAll(async () => {
  broker = await MosquittoTestHarness.start();
}, 60_000);

afterEach(async () => {
  const results = await Promise.allSettled([
    ...activeTransports.splice(0).map((transport) => transport.stop()),
    ...activeSessions.splice(0).map((session) => session.stop()),
  ]);
  broker.assertOnlyTestAquariumTraffic();
  broker.clearPublications();
  const failures = results.flatMap((result) =>
    result.status === "rejected" ? [toError(result.reason)] : [],
  );
  if (failures.length > 0) {
    throw new AggregateError(failures, "MQTT integration teardown failed");
  }
});

afterAll(async () => {
  await (broker as MosquittoTestHarness | undefined)?.stop();
}, 30_000);

describe.sequential("structured MQTT transport against pinned Mosquitto", () => {
  it("discovers multiple actors and recovers controller and broker restarts", async () => {
    const alpha = await startActor("alpha", "Alpha", ALPHA_ID);
    await startActor("beta", "Beta", BETA_ID);
    const first = await startTransport();
    await waitForDiscovery(first, ALPHA_ID, BETA_ID);

    await broker.publish(topics.announcement(ALPHA_ID), "{");
    await waitUntil(
      () =>
        first.interactions.some(
          (interaction) => interaction.kind === "malformed_message",
        ),
      "malformed structured announcement accounting",
    );

    await first.transport.stop();
    const restarted = await startTransport();
    await waitForDiscovery(restarted, ALPHA_ID, BETA_ID);

    const readyCount = lifecycleCount(restarted, "ready");
    await broker.restartBroker();
    await waitUntil(
      () => lifecycleCount(restarted, "ready") > readyCount,
      "controller reconnect after broker restart",
      15_000,
    );
    alpha.session.actor.reconnect();
    await waitForDiscovery(restarted, ALPHA_ID, BETA_ID);

    await expect(
      restarted.transport.executeCommands([ping(ALPHA_ID)]),
    ).resolves.toMatchObject({
      outcomes: [{ targetId: ALPHA_ID, status: "succeeded" }],
    });
  }, 30_000);

  it("uses independent device topics and executes typed schedule, PWM, and analog commands", async () => {
    const alpha = await startActor("alpha", "Alpha", ALPHA_ID);
    const beta = await startActor("beta", "Beta", BETA_ID);
    alpha.session.actor.setAnalogValue(34, 321);
    const controller = await startTransport();
    await waitForDiscovery(controller, ALPHA_ID, BETA_ID);

    const schedule = {
      c: [
        {
          o: 16,
          t: 108 as const,
          l: [
            {
              s: { t: 0, p: 50 },
              d: { t: 1_439, p: 50 },
            },
          ],
        },
      ],
      syncTime: EPOCH_SECONDS,
    };
    const operation = controller.transport.executeCommands([
      scheduleCommand(ALPHA_ID, schedule),
      syncTime(ALPHA_ID, EPOCH_SECONDS),
      analogRead(ALPHA_ID, 34),
      setPwm(BETA_ID, 17, 128, true),
    ]);
    await expect(operation).resolves.toMatchObject({
      outcomes: [
        { targetId: ALPHA_ID, status: "succeeded" },
        { targetId: ALPHA_ID, status: "succeeded" },
        { targetId: ALPHA_ID, status: "succeeded", analogValue: 321 },
        { targetId: BETA_ID, status: "succeeded" },
      ],
    });

    alpha.clock.advanceBy(1_000);
    alpha.session.actor.runLoop();
    expect(alpha.session.actor.pinSnapshot(16).outputValue).toBe(127);
    expect(beta.session.actor.pinSnapshot(17)).toMatchObject({
      attached: true,
      overwritten: true,
      outputValue: 128,
    });

    const commandTopics = broker
      .publications()
      .filter(
        ({ topic }) =>
          topic.includes("/v1/devices/") && topic.endsWith("/command"),
      )
      .map(({ topic }) => topic);
    expect(new Set(commandTopics)).toEqual(
      new Set([topics.command(ALPHA_ID), topics.command(BETA_ID)]),
    );
    for (const publication of broker
      .publications()
      .filter(
        ({ topic }) =>
          topic.includes("/v1/devices/") && topic.endsWith("/command"),
      )) {
      expect(() =>
        espCommandRequestSchema.parse(JSON.parse(publication.payload)),
      ).not.toThrow();
    }
    expect(
      broker
        .publications()
        .filter(({ topic }) => topic === topics.legacyCommand)
        .every(({ payload }) => payload === "discover"),
    ).toBe(true);
    expect(calculateLegacyScheduleHash({ c: schedule.c })).not.toBe("0");
  });

  it("isolates a dropped-response device while a healthy actor completes", async () => {
    const alpha = await startActor("alpha", "Alpha", ALPHA_ID, {
      drop: true,
    });
    await startActor("beta", "Beta", BETA_ID);
    const controller = await startTransport(250);
    await waitForDiscovery(controller, ALPHA_ID, BETA_ID);

    await expect(
      controller.transport.executeCommands([ping(ALPHA_ID), ping(BETA_ID)]),
    ).resolves.toMatchObject({
      outcomes: [
        { targetId: ALPHA_ID, status: "outcome_unknown", reason: "timeout" },
        { targetId: BETA_ID, status: "succeeded" },
      ],
    });
    expect(alpha.session.actor.isReady()).toBe(true);
  });

  it("surfaces pin failures as typed device errors and later recovery", async () => {
    const alpha = await startActor("alpha", "Alpha", ALPHA_ID);
    alpha.session.actor.setPinAttachmentFailure(16, true);
    const controller = await startTransport();
    await waitForDiscovery(controller, ALPHA_ID);

    await expect(
      controller.transport.executeCommands([setPwm(ALPHA_ID, 16, 100, false)]),
    ).resolves.toMatchObject({
      outcomes: [
        {
          status: "failed",
          failure: { kind: "device_error", code: "ledc_attach_failed" },
        },
      ],
    });
    alpha.session.actor.setPinAttachmentFailure(16, false);
    await expect(
      controller.transport.executeCommands([setPwm(ALPHA_ID, 16, 100, false)]),
    ).resolves.toMatchObject({ outcomes: [{ status: "succeeded" }] });
  });
});

async function startActor(
  key: string,
  name: string,
  id: string,
  responseFaults: { readonly drop?: boolean } = {},
): Promise<ActorFixture> {
  const clock = new ManualFakeEspClock(1);
  const persistence = new MemoryFakeEspPersistence({
    deviceName: name,
    deviceId: id,
    frequency: 5_000,
    resolution: 8,
  });
  const session = new MqttFakeEspSession({
    brokerUrl: broker.brokerUrl,
    clientId: `fake-${key}-${++clientSequence}`,
    actor: { clock, persistence, responseFaults },
  });
  activeSessions.push(session);
  await session.start();
  return { session, clock };
}

async function startTransport(
  responseTimeoutMs = 1_000,
): Promise<TransportFixture> {
  const announcements: LegacyAnnouncementEvent[] = [];
  const interactions: LegacyMqttInteraction[] = [];
  const transport = new LegacyMqttTransport({
    clientFactory: createMqttJsClientFactory({
      brokerUrl: broker.brokerUrl,
      clientId: `controller-${++clientSequence}`,
    }),
    topics,
    responseTimeoutMs,
    callbacks: {
      onAnnouncement: (announcement) => announcements.push(announcement),
      onInteraction: (interaction) => interactions.push(interaction),
    },
    requestSessionId: `integration-${clientSequence}`,
  });
  activeTransports.push(transport);
  transport.start();
  await waitUntil(
    () => lifecycleCount({ transport, announcements, interactions }, "ready") > 0,
    "controller MQTT readiness",
  );
  return { transport, announcements, interactions };
}

async function waitForDiscovery(
  controller: TransportFixture,
  ...deviceIds: readonly string[]
): Promise<void> {
  await controller.transport.requestDiscovery().catch(() => "skipped_busy");
  await waitUntil(
    () =>
      deviceIds.every((deviceId) =>
        controller.announcements.some(
          ({ announcement }) => announcement.id === deviceId,
        ),
      ),
    `device discovery for ${deviceIds.join(", ")}`,
  );
}

function lifecycleCount(
  controller: TransportFixture,
  state: "ready" | "disconnected",
): number {
  return controller.interactions.filter(
    (interaction) =>
      interaction.kind === "lifecycle" && interaction.state === state,
  ).length;
}

function ping(targetId: string): LegacyWireCommand {
  return command(targetId, "ping", { kind: "ping" });
}

function setPwm(
  targetId: string,
  pin: number,
  value: number,
  overwrite: boolean,
): LegacyWireCommand {
  return command(targetId, "set PWM", {
    kind: "set_pwm",
    pin,
    value,
    overwrite,
  });
}

function analogRead(targetId: string, pin: number): LegacyWireCommand {
  return command(targetId, "read analog", { kind: "analog_read", pin });
}

function syncTime(
  targetId: string,
  epochSeconds: number,
): LegacyWireCommand {
  return command(targetId, "sync time", { kind: "sync_time", epochSeconds });
}

function scheduleCommand(
  targetId: string,
  schedule: {
    c: {
      o: number;
      t: 108;
      l: {
        s: { t: number; p: number };
        d: { t: number; p: number };
      }[];
    }[];
    syncTime: number;
  },
): LegacyWireCommand {
  return command(targetId, "schedule", { kind: "schedule", schedule });
}

function command(
  targetId: string,
  description: string,
  operation: LegacyWireCommand["operation"],
): LegacyWireCommand {
  return {
    command: `${targetId} ${description}`,
    target: { id: targetId },
    operation,
  };
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
