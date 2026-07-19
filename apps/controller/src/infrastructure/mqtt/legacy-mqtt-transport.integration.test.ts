import {
  ManualFakeEspClock,
  MemoryFakeEspPersistence,
  MqttFakeEspSession,
  type FakeEspPersistence,
} from "@aquarium/fake-esp";
import {
  assertLegacyScheduleFits,
  calculateLegacyScheduleHash,
  createEspTopicSet,
  encodeLegacyMessage,
  utf8ByteLength,
} from "@aquarium/esp-protocol";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  MosquittoTestHarness,
  waitUntil,
} from "../../integration-support/mosquitto-test-harness.js";
import { createMqttJsClientFactory } from "./mqtt-js-client.js";
import {
  LegacyMqttOutcomeUnknownError,
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
  readonly persistence: FakeEspPersistence;
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

describe.sequential("legacy MQTT transport against pinned Mosquitto", () => {
  it("discovers multiple actors and recovers fake, controller, and broker restarts", async () => {
    const alpha = await startActor("alpha", "Alpha", ALPHA_ID);
    await startActor("beta", "Beta", BETA_ID);
    const firstController = await startTransport();

    await waitUntil(
      () => announcedIds(firstController).includes(ALPHA_ID),
      "Alpha discovery",
    );
    await waitUntil(
      () => announcedIds(firstController).includes(BETA_ID),
      "Beta discovery",
    );

    await broker.publish(topics.announce, "{");
    await waitUntil(
      () =>
        firstController.interactions.some(
          (interaction) => interaction.kind === "malformed_message",
        ),
      "malformed announcement accounting",
    );

    const alphaAnnouncements = countAnnouncements(firstController, ALPHA_ID);
    await delay(25);
    alpha.session.actor.reconnect();
    alpha.session.actor.reconnect();
    await waitUntil(
      () =>
        countAnnouncements(firstController, ALPHA_ID) >= alphaAnnouncements + 2,
      "duplicate delayed announcements",
    );

    await firstController.transport.stop();
    const restartedController = await startTransport();
    await waitUntil(
      () =>
        announcedIds(restartedController).includes(ALPHA_ID) &&
        announcedIds(restartedController).includes(BETA_ID),
      "discovery after controller restart",
    );

    const readyCount = lifecycleCount(restartedController, "ready");
    const announcementCount = restartedController.announcements.length;
    await broker.restartBroker();
    await waitUntil(
      () => lifecycleCount(restartedController, "ready") > readyCount,
      "controller reconnect after broker restart",
      15_000,
    );
    await waitUntil(
      () => restartedController.announcements.length > announcementCount,
      "fake announcement after broker restart",
      15_000,
    );

    const pingResult = await restartedController.transport.executeCommands([
      ping(ALPHA_ID),
    ]);
    expect(pingResult.outcomes).toMatchObject([
      { targetId: ALPHA_ID, status: "succeeded", response: "o" },
    ]);
    expect(
      broker
        .publications()
        .filter(({ topic }) => topic.startsWith("aquarium/")),
    ).toEqual([]);
  }, 30_000);

  it("preserves canonical global batching, local response indexes, and command fixtures", async () => {
    const alpha = await startActor("alpha", "Alpha", ALPHA_ID);
    const beta = await startActor("beta", "Beta", BETA_ID);
    alpha.session.actor.setAnalogValue(7, 321);
    const controller = await startTransport(1_000);
    await waitForDiscovery(controller, ALPHA_ID, BETA_ID);
    broker.clearPublications();

    alpha.session.actor.setResponseFaults({ delayMilliseconds: 100 });
    const firstConcurrent = controller.transport.executeCommands([
      ping(ALPHA_ID),
    ]);
    const secondConcurrent = controller.transport.executeCommands([
      ping(BETA_ID),
    ]);
    expect(await capturedCommandPayloads(1)).toEqual([`${ALPHA_ID} p`]);
    await delay(25);
    expect(await capturedCommandPayloads(1)).toEqual([`${ALPHA_ID} p`]);
    alpha.clock.advanceBy(100);
    alpha.session.actor.runLoop();
    expect((await firstConcurrent).outcomes[0]?.status).toBe("succeeded");
    expect((await secondConcurrent).outcomes[0]?.status).toBe("succeeded");
    expect(await capturedCommandPayloads(2)).toEqual([
      `${ALPHA_ID} p`,
      `${BETA_ID} p`,
    ]);
    alpha.session.actor.setResponseFaults({});
    await delay(25);
    broker.clearPublications();

    const result = await controller.transport.executeCommands([
      exact("Alpha p", ALPHA_ID, "o", ["Alpha"]),
      ping(BETA_ID),
      exact(`${ALPHA_ID} s 4 128 1`, ALPHA_ID, "s 4 128 1"),
      exact(`${BETA_ID} sync ${EPOCH_SECONDS}`, BETA_ID, `${EPOCH_SECONDS}`),
      analogRead(ALPHA_ID, 7),
      exact(`${ALPHA_ID} e Renamed 6000 10`, ALPHA_ID, "Renamed 6000 10"),
      ping(ALPHA_ID),
    ]);

    expect(result.outcomes.map(({ status }) => status)).toEqual([
      "succeeded",
      "succeeded",
      "succeeded",
      "succeeded",
      "succeeded",
      "succeeded",
      "succeeded",
    ]);
    expect(result.outcomes[4]).toMatchObject({ analogValue: 321 });
    const commandPayloads = await capturedCommandPayloads(2);
    expect(commandPayloads).toEqual([
      `${ALPHA_ID} p;${BETA_ID} p;${ALPHA_ID} s 4 128 1;${BETA_ID} sync ${EPOCH_SECONDS};${ALPHA_ID} r 7`,
      `${ALPHA_ID} e Renamed 6000 10;${ALPHA_ID} p`,
    ]);

    await waitUntil(
      () => capturedResponsePayloads().length >= 3,
      "batch-local response frames",
    );
    const responseFrames = capturedResponsePayloads()
      .filter((payload) => payload.startsWith("{"))
      .map(parseResponseFrame);
    expect(responseFrames).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: ALPHA_ID,
          responses: expect.arrayContaining([
            { index: 0, response: "o" },
            { index: 2, response: "s 4 128 1" },
            { index: 4, response: "r 7 321" },
          ]),
        }),
        expect.objectContaining({
          id: BETA_ID,
          responses: [
            { index: 1, response: "o" },
            { index: 3, response: `${EPOCH_SECONDS}` },
          ],
        }),
        expect.objectContaining({
          id: ALPHA_ID,
          responses: [
            { index: 0, response: "Renamed 6000 10" },
            { index: 1, response: "o" },
          ],
        }),
      ]),
    );

    expect(alpha.session.actor.identity()).toMatchObject({
      deviceName: "Renamed",
      frequency: 6_000,
      resolution: 10,
    });
    await alpha.session.stop();
    const restartedAlpha = await startActor(
      "alpha-restarted",
      "Alpha",
      ALPHA_ID,
      alpha.persistence,
    );
    await waitUntil(
      () =>
        controller.announcements.some(
          ({ announcement }) =>
            announcement.id === ALPHA_ID &&
            announcement.name === "Renamed" &&
            announcement.freq === 6_000 &&
            announcement.res === 10,
        ),
      "edited configuration after fake restart",
    );

    broker.clearPublications();
    await broker.publish(topics.command, `${ALPHA_ID} clear`);
    await waitUntil(
      () =>
        capturedResponsePayloads().some((payload) =>
          payload.includes("E: Invalid command"),
        ),
      "targeted clear rejection",
    );
    broker.clearPublications();
    await broker.publish(topics.command, "clear");
    await waitUntil(
      () =>
        capturedResponsePayloads().filter(
          (payload) => payload === "EEPROM cleared",
        ).length === 2,
      "bare clear response from both actors",
    );
    expect(restartedAlpha.session.actor.identity().deviceName).toBe("Alpha");
    expect(beta.session.actor.identity().deviceName).toBe("Beta");
  }, 20_000);

  it("carries UTF-8, chunk, schedule, hash, evaluation, persistence, and time boundaries over the broker", async () => {
    const actor = await startActor("alpha", "Alpha", ALPHA_ID);
    const controller = await startTransport(1_000);
    await waitForDiscovery(controller, ALPHA_ID);

    for (const byteLength of [256, 257]) {
      broker.clearPublications();
      const command = paddedPing(byteLength);
      expect(utf8ByteLength(command)).toBe(byteLength);
      const operation = await controller.transport.executeCommands([
        exact(command, ALPHA_ID, "o"),
      ]);
      expect(operation.outcomes[0]?.status).toBe("succeeded");
      const frames = await capturedCommandPayloads(byteLength === 256 ? 1 : 2);
      expect(frames).toEqual(encodeLegacyMessage(command));
      if (byteLength === 257) {
        expect(frames.map(chunkDataByteLength)).toEqual([200, 57]);
      }
    }

    broker.clearPublications();
    const fiftyChunkCommand = paddedAsciiPing(10_000);
    const fiftyFrames = encodeLegacyMessage(fiftyChunkCommand);
    expect(fiftyFrames).toHaveLength(50);
    for (const frame of fiftyFrames) {
      await broker.publish(topics.command, frame);
    }
    await waitUntil(
      () =>
        capturedResponsesAfterLastCommand().some((payload) =>
          payload.includes('"response":"o"'),
        ),
      "fifty-chunk response",
    );

    broker.clearPublications();
    const fiftyOneChunkCommand = paddedAsciiPing(10_001);
    const unsafeFrames = manualChunkFrames(fiftyOneChunkCommand, 51);
    expect(unsafeFrames).toHaveLength(51);
    for (const frame of unsafeFrames) {
      await broker.publish(topics.command, frame);
    }
    await delay(100);
    expect(capturedResponsePayloads()).toEqual([]);

    await exerciseChunkFaults(actor);

    broker.clearPublications();
    const scheduleCore = {
      c: [
        {
          o: 4,
          t: 108 as const,
          l: [
            {
              s: { t: 0, p: 50 },
              d: { t: 1_439, p: 50 },
            },
          ],
        },
      ],
    };
    const scheduleDocument = JSON.stringify({
      c: scheduleCore.c,
      syncTime: EPOCH_SECONDS,
    });
    const scheduleResult = await controller.transport.executeCommands([
      exact(`${ALPHA_ID} sc ${scheduleDocument}`, ALPHA_ID, "schedule_ok"),
      exact(`${ALPHA_ID} sync ${EPOCH_SECONDS}`, ALPHA_ID, `${EPOCH_SECONDS}`),
    ]);
    expect(
      scheduleResult.outcomes.every(({ status }) => status === "succeeded"),
    ).toBe(true);
    actor.clock.advanceBy(1_000);
    actor.session.actor.runLoop();
    expect(actor.session.actor.pinSnapshot(4).outputValue).toBe(127);
    expect(actor.session.actor.persistenceSnapshot()).toMatchObject({
      schedule: scheduleDocument,
      time: { lastSavedEpochSeconds: EPOCH_SECONDS },
    });

    const priorAnnouncements = controller.announcements.length;
    await expect(controller.transport.requestDiscovery()).resolves.toBe(
      "published",
    );
    await waitUntil(
      () => controller.announcements.length > priorAnnouncements,
      "post-schedule announcement",
    );
    expect(controller.announcements.at(-1)?.announcement.scheduleHash).toBe(
      calculateLegacyScheduleHash(scheduleCore),
    );

    const maximumSchedule = paddedEmptySchedule(4_095);
    const maximumResult = await controller.transport.executeCommands([
      exact(`${ALPHA_ID} sc ${maximumSchedule}`, ALPHA_ID, "schedule_ok"),
    ]);
    expect(maximumResult.outcomes[0]?.status).toBe("succeeded");
    expect(
      utf8ByteLength(actor.session.actor.persistenceSnapshot().schedule ?? ""),
    ).toBe(4_095);

    const publicationCount = broker.publications().length;
    expect(() => assertLegacyScheduleFits(paddedEmptySchedule(4_096))).toThrow(
      /4095/u,
    );
    expect(broker.publications()).toHaveLength(publicationCount);
  }, 30_000);

  it("fails closed on response faults and broker loss without actuator retry", async () => {
    const actor = await startActor("alpha", "Alpha", ALPHA_ID);
    const controller = await startTransport(200);
    await waitForDiscovery(controller, ALPHA_ID);

    actor.session.actor.setResponseFaults({ drop: true });
    broker.clearPublications();
    const dropped = await controller.transport.executeCommands([
      exact(`${ALPHA_ID} s 4 200 1`, ALPHA_ID, "s 4 200 1"),
    ]);
    expect(dropped.outcomes).toMatchObject([
      { status: "outcome_unknown", reason: "timeout" },
    ]);
    expect(await capturedCommandPayloads(1)).toEqual([`${ALPHA_ID} s 4 200 1`]);
    await expect(
      controller.transport.executeCommands([ping(ALPHA_ID)]),
    ).rejects.toBeInstanceOf(LegacyMqttOutcomeUnknownError);
    expect(await capturedCommandPayloads(1)).toHaveLength(1);

    actor.session.actor.setResponseFaults({});
    controller.transport.acknowledgeUnknownOutcome();
    expect(
      (await controller.transport.executeCommands([ping(ALPHA_ID)])).outcomes[0]
        ?.status,
    ).toBe("succeeded");

    broker.clearPublications();
    actor.session.actor.setResponseFaults({ delayMilliseconds: 100 });
    const delayed = controller.transport.executeCommands([ping(ALPHA_ID)]);
    await capturedCommandPayloads(1);
    await delay(25);
    actor.clock.advanceBy(100);
    actor.session.actor.runLoop();
    expect((await delayed).outcomes[0]?.status).toBe("succeeded");

    broker.clearPublications();
    actor.session.actor.setResponseFaults({ duplicateResponses: 1 });
    expect(
      (await controller.transport.executeCommands([ping(ALPHA_ID)])).outcomes[0]
        ?.status,
    ).toBe("succeeded");
    await waitUntil(
      () => capturedResponsesAfterLastCommand().length >= 2,
      "duplicate responses",
    );
    expect(capturedResponsesAfterLastCommand()).toHaveLength(2);
    await waitUntil(
      () =>
        controller.interactions.some(
          (interaction) =>
            interaction.kind === "ignored_response" &&
            (interaction.reason === "duplicate" ||
              interaction.reason === "no_active_batch"),
        ),
      "controller duplicate-response rejection",
    );

    broker.clearPublications();
    actor.session.actor.setResponseFaults({ malformed: true });
    const malformed = await controller.transport.executeCommands([
      ping(ALPHA_ID),
    ]);
    expect(malformed.outcomes[0]).toMatchObject({
      status: "outcome_unknown",
      reason: "timeout",
    });
    expect(
      controller.interactions.some(
        (interaction) =>
          interaction.kind === "malformed_message" &&
          interaction.topic === topics.response,
      ),
    ).toBe(true);
    controller.transport.acknowledgeUnknownOutcome();

    broker.clearPublications();
    actor.session.actor.setResponseFaults({ delayMilliseconds: 1_000 });
    const readyCount = lifecycleCount(controller, "ready");
    const announcementCount = controller.announcements.length;
    const interrupted = controller.transport.executeCommands([
      exact(`${ALPHA_ID} s 4 17 1`, ALPHA_ID, "s 4 17 1"),
    ]);
    await capturedCommandPayloads(1);
    await delay(25);
    await broker.restartBroker();
    const interruptedOutcome = (await interrupted).outcomes[0];
    if (interruptedOutcome?.status !== "outcome_unknown") {
      throw new Error("Broker interruption did not fail closed");
    }
    expect(["disconnected", "timeout"]).toContain(interruptedOutcome.reason);
    expect(await capturedCommandPayloads(1)).toHaveLength(1);
    await waitUntil(
      () => lifecycleCount(controller, "ready") > readyCount,
      "controller ready after interrupted broker operation",
      15_000,
    );
    await waitUntil(
      () => controller.announcements.length > announcementCount,
      "fake ESP ready after interrupted broker operation",
      15_000,
    );

    actor.session.actor.setResponseFaults({});
    controller.transport.acknowledgeUnknownOutcome();
    expect(
      (await controller.transport.executeCommands([ping(ALPHA_ID)])).outcomes[0]
        ?.status,
    ).toBe("succeeded");
  }, 30_000);
});

async function startActor(
  key: string,
  name: string,
  id: string,
  persistence: FakeEspPersistence = new MemoryFakeEspPersistence(),
): Promise<ActorFixture> {
  const clock = new ManualFakeEspClock(1);
  const session = new MqttFakeEspSession({
    brokerUrl: broker.brokerUrl,
    clientId: `aquarium-integration-fake-${key}-${++clientSequence}`,
    actor: {
      clock,
      persistence,
      defaultDeviceName: name,
      idGenerator: () => id,
    },
  });
  activeSessions.push(session);
  await session.start();
  return { session, clock, persistence };
}

async function startTransport(
  responseTimeoutMs = 1_000,
): Promise<TransportFixture> {
  const announcements: LegacyAnnouncementEvent[] = [];
  const interactions: LegacyMqttInteraction[] = [];
  const transport = new LegacyMqttTransport({
    clientFactory: createMqttJsClientFactory({
      brokerUrl: broker.brokerUrl,
      clientId: `aquarium-integration-controller-${++clientSequence}`,
      keepaliveSeconds: 5,
      reconnectPeriodMs: 100,
      connectTimeoutMs: 5_000,
    }),
    topics,
    responseTimeoutMs,
    callbacks: {
      onAnnouncement: (announcement) => announcements.push(announcement),
      onInteraction: (interaction) => interactions.push(interaction),
    },
  });
  activeTransports.push(transport);
  transport.start();
  await waitUntil(
    () =>
      interactions.some(
        (interaction) =>
          interaction.kind === "lifecycle" && interaction.state === "ready",
      ),
    "controller MQTT readiness",
  );
  return { transport, announcements, interactions };
}

async function waitForDiscovery(
  controller: TransportFixture,
  ...deviceIds: readonly string[]
): Promise<void> {
  await waitUntil(
    () =>
      deviceIds.every((deviceId) =>
        announcedIds(controller).includes(deviceId),
      ),
    `device discovery for ${deviceIds.join(", ")}`,
  );
}

function announcedIds(controller: TransportFixture): readonly string[] {
  return controller.announcements.map(({ announcement }) => announcement.id);
}

function countAnnouncements(
  controller: TransportFixture,
  deviceId: string,
): number {
  return controller.announcements.filter(
    ({ announcement }) => announcement.id === deviceId,
  ).length;
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
  return exact(`${targetId} p`, targetId, "o");
}

function analogRead(targetId: string, pin: number): LegacyWireCommand {
  return {
    command: `${targetId} r ${pin}`,
    target: { id: targetId },
    expectedResponse: { kind: "analog_read", pin },
  };
}

function exact(
  command: string,
  targetId: string,
  response: string,
  aliases: readonly string[] = [],
): LegacyWireCommand {
  return {
    command,
    target: { id: targetId, aliases },
    expectedResponse: { kind: "exact", value: response },
  };
}

async function capturedCommandPayloads(
  expectedCount: number,
): Promise<readonly string[]> {
  await waitUntil(
    () =>
      broker
        .publications()
        .filter(({ topic }) => topic === topics.command)
        .filter(({ payload }) => payload !== "discover").length >=
      expectedCount,
    `${expectedCount} MQTT command publication(s)`,
  );
  return broker
    .publications()
    .filter(
      ({ topic, payload }) =>
        topic === topics.command && payload !== "discover",
    )
    .map(({ payload }) => payload);
}

function capturedResponsePayloads(): readonly string[] {
  return broker
    .publications()
    .filter(({ topic }) => topic === topics.response)
    .map(({ payload }) => payload);
}

function capturedResponsesAfterLastCommand(): readonly string[] {
  const publications = broker.publications();
  const lastCommandIndex = publications.findLastIndex(
    ({ topic }) => topic === topics.command,
  );
  if (lastCommandIndex < 0) {
    return [];
  }
  return publications
    .slice(lastCommandIndex + 1)
    .filter(({ topic }) => topic === topics.response)
    .map(({ payload }) => payload);
}

function parseResponseFrame(payload: string): {
  readonly id: string;
  readonly responses: readonly {
    readonly index: number;
    readonly response: string;
  }[];
} {
  return JSON.parse(payload) as {
    readonly id: string;
    readonly responses: readonly {
      readonly index: number;
      readonly response: string;
    }[];
  };
}

function paddedPing(byteLength: number): string {
  const prefix = `${ALPHA_ID} p `;
  const suffix = "é";
  const paddingLength =
    byteLength - utf8ByteLength(prefix) - utf8ByteLength(suffix);
  if (paddingLength < 0) {
    throw new RangeError("Padded ping length is too small");
  }
  return `${prefix}${"x".repeat(paddingLength)}${suffix}`;
}

function paddedAsciiPing(byteLength: number): string {
  const prefix = `${ALPHA_ID} p `;
  const paddingLength = byteLength - prefix.length;
  if (paddingLength < 0) {
    throw new RangeError("Padded ping length is too small");
  }
  return `${prefix}${"x".repeat(paddingLength)}`;
}

function chunkDataByteLength(frame: string): number {
  const separator = frame.indexOf(
    ":",
    frame.indexOf(":", frame.indexOf(":") + 1) + 1,
  );
  const dataSeparator = frame.indexOf(":", separator + 1);
  if (dataSeparator < 0) {
    throw new Error("Expected a chunk frame");
  }
  return utf8ByteLength(frame.slice(dataSeparator + 1));
}

function manualChunkFrames(
  payload: string,
  totalChunks: number,
): readonly string[] {
  return Array.from({ length: totalChunks }, (_, index) => {
    const data = payload.slice(index * 200, (index + 1) * 200);
    return `chunk:${index}:${totalChunks}:${index === totalChunks - 1 ? 1 : 0}:${data}`;
  });
}

async function exerciseChunkFaults(actor: ActorFixture): Promise<void> {
  broker.clearPublications();
  await broker.publish(topics.command, `chunk:1:2:1:C3D4 p`);
  await broker.publish(topics.command, `chunk:0:2:0:A1B2`);
  await delay(25);
  expect(capturedResponsePayloads()).toEqual([]);
  await broker.publish(topics.command, `chunk:1:2:1:C3D4 p`);
  await waitUntil(
    () => capturedResponsePayloads().length === 1,
    "out-of-order chunk recovery",
  );

  broker.clearPublications();
  const threeChunkCommand = `${ALPHA_ID} p ${"x".repeat(390)}`;
  const threeFrames = manualChunkFrames(threeChunkCommand, 3);
  const first = threeFrames[0];
  const second = threeFrames[1];
  const third = threeFrames[2];
  if (first === undefined || second === undefined || third === undefined) {
    throw new Error("Expected three chunk fixtures");
  }
  await broker.publish(topics.command, first);
  await broker.publish(topics.command, second);
  await broker.publish(topics.command, second);
  await broker.publish(topics.command, third);
  await waitUntil(
    () => capturedResponsePayloads().length === 1,
    "duplicate nonzero chunk handling",
  );

  broker.clearPublications();
  await broker.publish(topics.command, `chunk:0:2:0:${ALPHA_ID} `);
  await delay(25);
  actor.clock.advanceBy(10_001);
  actor.session.actor.runLoop();
  await broker.publish(topics.command, "chunk:1:2:1:p");
  await delay(100);
  expect(capturedResponsePayloads()).toEqual([]);
}

function paddedEmptySchedule(bytes: number): string {
  const json = '{"c":[]}';
  return `${" ".repeat(bytes - json.length)}${json}`;
}

async function delay(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
