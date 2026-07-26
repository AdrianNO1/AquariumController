import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  FileFakeEspPersistence,
  ManualFakeEspClock,
  MqttFakeEspSession,
} from "@aquarium/fake-esp";
import type { Kysely } from "kysely";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import { parseControllerConfiguration } from "../../configuration.js";
import {
  openControllerDatabases,
  type ControllerDatabases,
  type StateDatabaseSchema,
} from "../../infrastructure/database/index.js";
import {
  MosquittoTestHarness,
  waitUntil,
} from "../../integration-support/mosquitto-test-harness.js";
import { ManualSchedulingTime } from "../scheduling/test-scheduling-time.js";
import {
  composeControllerRuntime,
  type ControllerRuntimeComposition,
} from "./controller-runtime.js";

const DEVICE_ID = "A1B2C3D4";
const DEVICE_NAME = "Alpha";
const CHANNEL_ID = "channel-light";
const PROFILE_ID = "profile-main";
const MAPPING_ID = "mapping-light";
const INITIAL_UTC = "2025-01-01T00:00:00.000Z";
const SCHEDULED_PWM = 102;
const OVERRIDE_PWM = 204;

type EnabledRuntimeComposition = Extract<
  ControllerRuntimeComposition,
  { readonly mqttEnabled: true }
>;

interface RunningActor {
  readonly session: MqttFakeEspSession;
  readonly clock: ManualFakeEspClock;
}

let broker: MosquittoTestHarness;
let clientSequence = 0;
const activeRuntimes: EnabledRuntimeComposition[] = [];
const activeSessions: MqttFakeEspSession[] = [];
const activeDatabases: ControllerDatabases[] = [];
const temporaryDirectories: string[] = [];

beforeAll(async () => {
  broker = await MosquittoTestHarness.start();
}, 60_000);

afterEach(async () => {
  const results = await Promise.allSettled([
    ...activeRuntimes.splice(0).map(({ runtime }) => runtime.stop()),
    ...activeSessions.splice(0).map((session) => session.stop()),
  ]);
  for (const databases of activeDatabases.splice(0)) {
    const closeResult = await Promise.allSettled([
      databases.state.destroy(),
      databases.events.destroy(),
    ]);
    results.push(...closeResult);
  }
  broker.assertOnlyTestAquariumTraffic();
  broker.clearPublications();
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
  const failures = results.flatMap((result) =>
    result.status === "rejected" ? [toError(result.reason)] : [],
  );
  if (failures.length > 0) {
    throw new AggregateError(failures, "Controller runtime teardown failed");
  }
});

afterAll(async () => {
  await (broker as MosquittoTestHarness | undefined)?.stop();
}, 30_000);

describe.sequential(
  "composed controller runtime against pinned Mosquitto",
  () => {
    it("persists and restores schedule, time, refresh, and override safety across every restart boundary", async () => {
      const directory = createTemporaryDirectory();
      const fakeStorageDirectory = join(directory, "fake-alpha");
      const stateFilename = join(directory, "state.db");
      const eventsFilename = join(directory, "events.db");
      const schedulingTime = new ManualSchedulingTime(INITIAL_UTC);
      const errors: Error[] = [];

      let actor = await startActor(fakeStorageDirectory);
      let databases = await openTestDatabases(stateFilename, eventsFilename);
      const composition = await startRuntime(databases, schedulingTime, errors);

      await waitUntil(
        async () =>
          (await databases.state
            .selectFrom("devices")
            .select("id")
            .where("id", "=", DEVICE_ID)
            .executeTakeFirst()) !== undefined,
        "device registry discovery",
      );
      await waitUntil(
        () => actor.session.actor.currentEpochSeconds() > 0,
        "announcement-triggered time synchronization",
      );
      expect(actor.session.actor.currentEpochSeconds()).toBe(
        Date.parse(INITIAL_UTC) / 1_000,
      );

      await seedScheduledOutput(databases.state, Date.parse(INITIAL_UTC));
      composition.scheduleReconciliation.requestScheduleReconciliation({
        kind: "mapping_profile",
        mappingProfileId: PROFILE_ID,
      });
      await waitUntil(
        () =>
          (actor.session.actor.persistenceSnapshot().schedule?.length ?? 0) > 0,
        "schedule reconciliation delivery",
      );

      const persistedSchedule =
        actor.session.actor.persistenceSnapshot().schedule;
      if (persistedSchedule === undefined) {
        throw new Error("Expected the reconciled schedule to be persisted");
      }
      expect(JSON.parse(persistedSchedule)).toMatchObject({
        c: [{ o: 4, t: 108 }],
      });

      await actor.session.stop();
      actor = await startActor(fakeStorageDirectory);
      await waitUntil(
        () =>
          actor.session.actor.persistenceSnapshot().schedule ===
          persistedSchedule,
        "fake ESP schedule after actor restart",
      );
      await waitUntil(
        () => actor.session.actor.currentEpochSeconds() > 0,
        "fake ESP time after actor restart",
      );
      actor.clock.advanceBy(1_000);
      actor.session.actor.runLoop();
      expect(actor.session.actor.pinSnapshot(4).outputValue).toBe(
        SCHEDULED_PWM,
      );

      broker.clearPublications();
      await schedulingTime.advanceBy(5_000);
      await waitUntil(
        () => actor.session.actor.pinSnapshot(4).outputValue === SCHEDULED_PWM,
        "five-second scheduled output refresh",
      );
      await waitUntil(
        () =>
          commandPayloads().some(
            (payload) => payload === `${DEVICE_ID} s 4 ${SCHEDULED_PWM} 1`,
          ),
        "scheduled refresh wire command",
      );

      const revision = await latestRevision(databases.state);
      await composition.manualOverrideCommands.startOverride({
        expectedRevision: revision,
        target: { targetType: "channel", targetId: CHANNEL_ID },
        valuePercentage: 80,
      });
      await waitUntil(
        () =>
          actor.session.actor.pinSnapshot(4).outputValue === OVERRIDE_PWM &&
          actor.session.actor.pinSnapshot(4).overwritten,
        "manual override command completion",
      );
      await waitUntil(
        async () =>
          (
            await databases.state
              .selectFrom("overrides")
              .select("status")
              .where("channel_id", "=", CHANNEL_ID)
              .executeTakeFirst()
          )?.status === "active",
        "durable active override state",
      );

      broker.clearPublications();
      await schedulingTime.advanceBy(5_000);
      await waitUntil(
        () =>
          commandPayloads().some(
            (payload) => payload === `${DEVICE_ID} s 4 ${OVERRIDE_PWM} 1`,
          ),
        "five-second override refresh",
      );
      expect(actor.session.actor.pinSnapshot(4)).toMatchObject({
        outputValue: OVERRIDE_PWM,
        overwritten: true,
      });

      await composition.runtime.stop();
      actor.clock.advanceBy(119_999);
      expect(actor.session.actor.pinSnapshot(4)).toMatchObject({
        outputValue: OVERRIDE_PWM,
        overwritten: true,
      });
      actor.clock.advanceBy(1);
      actor.session.actor.runLoop();
      expect(actor.session.actor.pinSnapshot(4)).toMatchObject({
        outputValue: SCHEDULED_PWM,
        overwritten: false,
      });

      await schedulingTime.advanceBy(120_000);
      await closeDatabases(databases);
      databases = await openTestDatabases(stateFilename, eventsFilename);
      await startRuntime(databases, schedulingTime, errors);

      await waitUntil(
        async () =>
          (
            await databases.state
              .selectFrom("overrides")
              .select("status")
              .where("channel_id", "=", CHANNEL_ID)
              .executeTakeFirst()
          )?.status === "expired",
        "persisted override expiry after controller and database restart",
      );
      await waitUntil(
        () =>
          actor.session.actor.pinSnapshot(4).outputValue === SCHEDULED_PWM &&
          actor.session.actor.pinSnapshot(4).overwritten,
        "scheduled output after controller and database restart",
      );

      const persistedOperations = await databases.state
        .selectFrom("control_operations")
        .select(({ fn }) => fn.countAll<number>().as("count"))
        .where("device_id", "=", DEVICE_ID)
        .executeTakeFirstOrThrow();
      expect(Number(persistedOperations.count)).toBeGreaterThan(0);
      expect(errors).toEqual([]);
    }, 40_000);
  },
);

async function startActor(storageDirectory: string): Promise<RunningActor> {
  const clock = new ManualFakeEspClock(1);
  const session = new MqttFakeEspSession({
    brokerUrl: broker.brokerUrl,
    clientId: `aquarium-runtime-fake-${++clientSequence}`,
    actor: {
      clock,
      persistence: new FileFakeEspPersistence(storageDirectory),
      defaultDeviceName: DEVICE_NAME,
      idGenerator: () => DEVICE_ID,
    },
  });
  activeSessions.push(session);
  await session.start();
  return { session, clock };
}

async function startRuntime(
  databases: ControllerDatabases,
  schedulingTime: ManualSchedulingTime,
  errors: Error[],
): Promise<EnabledRuntimeComposition> {
  const composition = composeControllerRuntime({
    configuration: parseControllerConfiguration({
      AQUARIUM_RUNTIME_MODE: "test",
      AQUARIUM_MQTT_ENABLED: "true",
      AQUARIUM_MQTT_BROKER_URL: broker.brokerUrl,
      AQUARIUM_MQTT_TOPIC_NAMESPACE: "test",
      AQUARIUM_MQTT_RESPONSE_TIMEOUT_MS: "1000",
      AQUARIUM_MQTT_DISCOVERY_INTERVAL_MS: "1000",
      AQUARIUM_DEVICE_ANNOUNCEMENT_PERSIST_INTERVAL_MS: "1000",
      AQUARIUM_DEVICE_STALE_AFTER_MS: "5000",
      AQUARIUM_DEVICE_OFFLINE_AFTER_MS: "10000",
      AQUARIUM_DEVICE_HEALTH_SWEEP_INTERVAL_MS: "500",
      NODE_ENV: "test",
    }),
    stateDatabase: databases.state,
    eventsDatabase: databases.events,
    schedulingTime,
    now: () => schedulingTime.utcNow().getTime(),
    onError: (error) => errors.push(error),
  });
  if (!composition.mqttEnabled) {
    throw new Error("Expected MQTT-enabled runtime composition");
  }
  activeRuntimes.push(composition);
  await composition.runtime.start();
  return composition;
}

async function openTestDatabases(
  stateFilename: string,
  eventsFilename: string,
): Promise<ControllerDatabases> {
  const databases = await openControllerDatabases({
    state: { filename: stateFilename },
    events: { filename: eventsFilename },
  });
  activeDatabases.push(databases);
  return databases;
}

async function closeDatabases(databases: ControllerDatabases): Promise<void> {
  await Promise.all([databases.state.destroy(), databases.events.destroy()]);
  const index = activeDatabases.indexOf(databases);
  if (index >= 0) {
    activeDatabases.splice(index, 1);
  }
}

async function seedScheduledOutput(
  database: Kysely<StateDatabaseSchema>,
  nowMs: number,
): Promise<void> {
  await database
    .insertInto("mapping_profiles")
    .values({
      id: PROFILE_ID,
      name: "Main",
      device_name_prefix: DEVICE_NAME,
      output_gain: 1,
      created_at_ms: nowMs,
      updated_at_ms: nowMs,
    })
    .executeTakeFirstOrThrow();
  await database
    .updateTable("devices")
    .set({ mapping_profile_id: PROFILE_ID })
    .where("id", "=", DEVICE_ID)
    .executeTakeFirstOrThrow();
  await database
    .insertInto("throttles")
    .values({
      id: "throttle-light",
      type_key: "light",
      percentage: 100,
      created_at_ms: nowMs,
      updated_at_ms: nowMs,
    })
    .executeTakeFirstOrThrow();
  await database
    .insertInto("channels")
    .values({
      id: CHANNEL_ID,
      name: "Light",
      kind: "light",
      throttle_id: "throttle-light",
      display_order: 0,
      enabled: 1,
      created_at_ms: nowMs,
      updated_at_ms: nowMs,
    })
    .executeTakeFirstOrThrow();
  await database
    .insertInto("schedules")
    .values({
      id: "schedule-light",
      channel_id: CHANNEL_ID,
      name: "Light",
      timezone: "UTC",
      enabled: 1,
      graph_revision: 1,
      created_at_ms: nowMs,
      updated_at_ms: nowMs,
    })
    .executeTakeFirstOrThrow();
  await database
    .insertInto("schedule_points")
    .values([
      {
        id: "point-start",
        schedule_id: "schedule-light",
        position: 0,
        minute_of_day: 0,
        percentage: 40,
        editor_x: null,
        editor_y: null,
        created_at_ms: nowMs,
        updated_at_ms: nowMs,
      },
      {
        id: "point-end",
        schedule_id: "schedule-light",
        position: 1,
        minute_of_day: 1_439,
        percentage: 40,
        editor_x: null,
        editor_y: null,
        created_at_ms: nowMs,
        updated_at_ms: nowMs,
      },
    ])
    .execute();
  await database
    .insertInto("pin_mappings")
    .values({
      id: MAPPING_ID,
      mapping_profile_id: PROFILE_ID,
      output_id: null,
      channel_id: CHANNEL_ID,
      pin: 4,
      display_order: 0,
      enabled: 1,
      created_at_ms: nowMs,
      updated_at_ms: nowMs,
    })
    .executeTakeFirstOrThrow();
}

async function latestRevision(
  database: Kysely<StateDatabaseSchema>,
): Promise<number> {
  const row = await database
    .selectFrom("state_revisions")
    .select(({ fn }) => fn.max<number>("revision").as("revision"))
    .executeTakeFirstOrThrow();
  return Number(row.revision ?? 0);
}

function commandPayloads(): readonly string[] {
  return broker
    .publications()
    .filter(({ topic }) => topic === "test/aquarium/command")
    .filter(({ payload }) => payload !== "discover")
    .map(({ payload }) => correlatedCommandPayload(payload));
}

function correlatedCommandPayload(envelope: string): string {
  const prefix = "request:";
  const separator = envelope.indexOf("|");
  if (!envelope.startsWith(prefix) || separator <= prefix.length) {
    throw new Error("Expected a correlated MQTT command envelope");
  }
  const payload = envelope.slice(separator + 1);
  if (payload.length === 0) {
    throw new Error("Correlated MQTT command envelope had an empty payload");
  }
  return payload;
}

function createTemporaryDirectory(): string {
  const directory = mkdtempSync(
    join(tmpdir(), "aquarium-runtime-integration-"),
  );
  temporaryDirectories.push(directory);
  return directory;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
