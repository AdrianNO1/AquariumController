import type { AlertObservation } from "@aquarium/contracts";
import type { Kysely } from "kysely";
import { afterEach, describe, expect, it } from "vitest";

import {
  openStateDatabase,
  toCommittedStateEvent,
  type StateDatabaseSchema,
} from "../../infrastructure/database/index.js";
import { AlertService } from "./alert-service.js";
import {
  DeviceAlertEvaluator,
  defaultDeviceHealthRuleId,
  type AlertObservationEvaluationPort,
} from "./device-alert-evaluator.js";

const openDatabases: Kysely<StateDatabaseSchema>[] = [];

afterEach(async () => {
  await Promise.all(
    openDatabases.splice(0).map((database) => database.destroy()),
  );
});

describe("device alert evaluator", () => {
  it("idempotently seeds rules and evaluates only enabled devices in stable order", async () => {
    const database = await openStateDatabase({ filename: ":memory:" });
    openDatabases.push(database);
    await database
      .insertInto("devices")
      .values([
        device("B2", "offline", 1),
        device("A1", "online", 1),
        device("disabled", "error", 0),
      ])
      .execute();
    const observations: AlertObservation[] = [];
    const alerts: AlertObservationEvaluationPort = {
      async evaluate(observation) {
        observations.push(observation);
        return { evaluatedAtMs: 1_000, decisions: [] };
      },
    };
    const evaluator = new DeviceAlertEvaluator(database, alerts);

    await expect(evaluator.evaluateAll(1_000)).resolves.toMatchObject({
      observedAtMs: 1_000,
      deviceCount: 2,
    });
    await evaluator.evaluateAll(2_000);

    expect(observations).toEqual([
      { sourceType: "device", sourceId: "A1", status: "online" },
      { sourceType: "device", sourceId: "B2", status: "offline" },
      { sourceType: "device", sourceId: "A1", status: "online" },
      { sourceType: "device", sourceId: "B2", status: "offline" },
    ]);
    expect(
      await database
        .selectFrom("alert_rules")
        .select(["id", "device_id", "condition", "enabled"])
        .orderBy("device_id")
        .execute(),
    ).toEqual([
      {
        id: defaultDeviceHealthRuleId("A1"),
        device_id: "A1",
        condition: "not_online",
        enabled: 1,
      },
      {
        id: defaultDeviceHealthRuleId("B2"),
        device_id: "B2",
        condition: "not_online",
        enabled: 1,
      },
    ]);
    const outbox = await database
      .selectFrom("state_outbox")
      .selectAll()
      .orderBy("revision")
      .execute();
    expect(outbox).toHaveLength(1);
    const ruleEvent = outbox[0];
    if (ruleEvent === undefined) throw new Error("Expected rule event");
    expect(toCommittedStateEvent(ruleEvent).data.invalidations).toEqual([
      { resource: "controller", id: null },
      {
        resource: "alert_rule",
        id: defaultDeviceHealthRuleId("A1"),
      },
      {
        resource: "alert_rule",
        id: defaultDeviceHealthRuleId("B2"),
      },
    ]);
    await expect(
      database
        .selectFrom("operator_concurrency")
        .select("last_operator_revision")
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ last_operator_revision: 0 });
  });

  it("bounds each rule-seeding event while preserving precise invalidations", async () => {
    const database = await openStateDatabase({ filename: ":memory:" });
    openDatabases.push(database);
    await database
      .insertInto("devices")
      .values(
        Array.from({ length: 100 }, (_, index) =>
          device(`device-${index.toString().padStart(3, "0")}`, "online", 1),
        ),
      )
      .execute();
    const evaluator = new DeviceAlertEvaluator(database, {
      async evaluate() {
        return { evaluatedAtMs: 1_000, decisions: [] };
      },
    });

    await evaluator.evaluateAll(1_000);

    const outbox = await database
      .selectFrom("state_outbox")
      .selectAll()
      .orderBy("revision")
      .execute();
    expect(outbox.map((event) => event.revision)).toEqual([1, 2]);
    expect(
      outbox.map(
        (event) => toCommittedStateEvent(event).data.invalidations.length,
      ),
    ).toEqual([100, 2]);
    await expect(
      database
        .selectFrom("alert_rules")
        .select(({ fn }) => fn.countAll<number>().as("count"))
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ count: 100 });
  });

  it("opens and recovers a durable default device-health alert", async () => {
    const database = await openStateDatabase({ filename: ":memory:" });
    openDatabases.push(database);
    await database
      .insertInto("devices")
      .values(device("A1", "online", 1))
      .executeTakeFirstOrThrow();
    let nowMs = 1_000;
    let nextAlertId = 0;
    const alerts = new AlertService(
      database,
      { nowMs: () => nowMs },
      { nextAlertId: () => `device-alert-${++nextAlertId}` },
    );
    const evaluator = new DeviceAlertEvaluator(database, alerts);

    await evaluator.evaluateAll(nowMs);
    expect(
      await database.selectFrom("active_alerts").select("id").execute(),
    ).toEqual([]);

    nowMs = 2_000;
    await database
      .updateTable("devices")
      .set({ status: "offline", updated_at_ms: nowMs })
      .where("id", "=", "A1")
      .executeTakeFirstOrThrow();
    await evaluator.evaluateAll(nowMs);
    expect(
      await database
        .selectFrom("active_alerts")
        .select(["id", "state"])
        .executeTakeFirstOrThrow(),
    ).toEqual({ id: "device-alert-1", state: "open" });

    nowMs = 3_000;
    await database
      .updateTable("devices")
      .set({ status: "online", updated_at_ms: nowMs })
      .where("id", "=", "A1")
      .executeTakeFirstOrThrow();
    await evaluator.evaluateAll(nowMs);
    expect(
      await database
        .selectFrom("active_alerts")
        .select(["id", "state", "recovered_at_ms"])
        .executeTakeFirstOrThrow(),
    ).toEqual({
      id: "device-alert-1",
      state: "recovered",
      recovered_at_ms: 3_000,
    });
  });
});

function device(
  id: string,
  status: "online" | "offline" | "error",
  enabled: 0 | 1,
) {
  return {
    id,
    hardware_id: id,
    name: id,
    mapping_profile_id: null,
    reported_name: id,
    desired_pwm_frequency_hz: 5_000,
    desired_pwm_resolution_bits: 8,
    reported_pwm_frequency_hz: 5_000,
    reported_pwm_resolution_bits: 8,
    firmware_version: "4.0.0",
    reported_schedule_hash: "0",
    status,
    last_seen_at_ms: 1,
    last_error_code: null,
    last_error_message: null,
    enabled,
    created_at_ms: 1,
    updated_at_ms: 1,
    metadata_json: null,
    metadata_schema_version: null,
  } as const;
}
