import {
  alertNotificationV1Schema,
  alertObservationSchema,
  alertStateEventPayloadV1Schema,
} from "@aquarium/contracts";
import { sql, type Insertable, type Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  openStateDatabase,
  parseStoredStateOutboxEnvelope,
  type AlertRulesTable,
  type StateDatabaseSchema,
} from "../../infrastructure/database/index.js";
import {
  AlertConcurrencyError,
  AlertService,
  InvalidAlertRuleError,
  InvalidPersistedAlertDataError,
} from "./alert-service.js";
import type { AlertRevisionConflictError } from "./alert-service.js";
import type {
  AlertClock,
  AlertIdGenerator,
  AlertObservation,
} from "./types.js";

class TestClock implements AlertClock {
  constructor(public value: number) {}

  nowMs(): number {
    return this.value;
  }
}

class SequentialAlertIds implements AlertIdGenerator {
  private nextId = 1;

  nextAlertId(): string {
    const id = `alert-${this.nextId}`;
    this.nextId += 1;
    return id;
  }
}

interface RuleSpec {
  readonly id?: string;
  readonly sourceType: "device" | "output" | "sensor" | "switch";
  readonly sourceId: string;
  readonly condition: string;
  readonly threshold: number | null;
  readonly delayMs?: number;
  readonly enabled?: 0 | 1;
}

let database: Kysely<StateDatabaseSchema>;
let clock: TestClock;
let ids: SequentialAlertIds;

async function seedSources(): Promise<void> {
  await database
    .insertInto("devices")
    .values({
      id: "device-main",
      hardware_id: "hardware-main",
      name: "Main device",
      desired_pwm_frequency_hz: 1_000,
      desired_pwm_resolution_bits: 8,
      created_at_ms: 0,
      updated_at_ms: 0,
    })
    .executeTakeFirstOrThrow();
  await database
    .insertInto("outputs")
    .values({
      id: "output-main",
      name: "Main output",
      kind: "light",
      display_order: 0,
      created_at_ms: 0,
      updated_at_ms: 0,
    })
    .executeTakeFirstOrThrow();
  await database
    .insertInto("sensors")
    .values({
      id: "sensor-main",
      device_id: "device-main",
      name: "Temperature",
      pin: 1,
      read_type: "temperature",
      created_at_ms: 0,
      updated_at_ms: 0,
    })
    .executeTakeFirstOrThrow();
  await database
    .insertInto("switches")
    .values({
      id: "switch-main",
      device_id: "device-main",
      name: "Float switch",
      pin: 2,
      created_at_ms: 0,
      updated_at_ms: 0,
    })
    .executeTakeFirstOrThrow();
}

async function insertRule(specification: RuleSpec): Promise<string> {
  const id = specification.id ?? `rule-${specification.sourceType}`;
  const values: Insertable<AlertRulesTable> = {
    id,
    name: `Rule ${id}`,
    source_type: specification.sourceType,
    device_id:
      specification.sourceType === "device" ? specification.sourceId : null,
    output_id:
      specification.sourceType === "output" ? specification.sourceId : null,
    sensor_id:
      specification.sourceType === "sensor" ? specification.sourceId : null,
    switch_id:
      specification.sourceType === "switch" ? specification.sourceId : null,
    condition: specification.condition,
    threshold: specification.threshold,
    delay_ms: specification.delayMs ?? 0,
    severity: "warning",
    enabled: specification.enabled ?? 1,
    created_at_ms: 0,
    updated_at_ms: 0,
    configuration_json: null,
    configuration_schema_version: null,
  };
  await database
    .insertInto("alert_rules")
    .values(values)
    .executeTakeFirstOrThrow();
  return id;
}

function createService(withDestination = false): AlertService {
  return new AlertService(database, clock, ids, {
    notificationDestinations: withDestination
      ? [{ kind: "webhook", key: "primary" }]
      : [],
  });
}

async function tableCount(
  table:
    | "active_alerts"
    | "alert_condition_states"
    | "notification_deliveries"
    | "state_revisions",
): Promise<number> {
  const result = await database
    .selectFrom(table)
    .select(({ fn }) => fn.countAll<number>().as("count"))
    .executeTakeFirstOrThrow();
  return result.count;
}

beforeEach(async () => {
  database = await openStateDatabase({ filename: ":memory:" });
  clock = new TestClock(100);
  ids = new SequentialAlertIds();
  await seedSources();
});

afterEach(async () => {
  await database.destroy();
});

describe("AlertService observations", () => {
  it("uses an explicit observation timestamp when one is supplied", async () => {
    await insertRule({
      sourceType: "sensor",
      sourceId: "sensor-main",
      condition: "above",
      threshold: 10,
    });
    const service = createService();
    const observation = {
      sourceType: "sensor",
      sourceId: "sensor-main",
      value: 11,
    } as const;

    const result = await service.evaluateAt(
      observation,
      500,
      "timestamped-evaluator",
    );

    expect(result.evaluatedAtMs).toBe(500);
    await expect(
      database
        .selectFrom("active_alerts")
        .select(["opened_at_ms", "last_observed_at_ms"])
        .executeTakeFirstOrThrow(),
    ).resolves.toMatchObject({
      opened_at_ms: 500,
      last_observed_at_ms: 500,
    });
    await expect(service.evaluateAt(observation, -1)).rejects.toThrow(
      /non-negative safe integer/u,
    );
  });

  it.each([
    {
      label: "device stale",
      rule: {
        sourceType: "device",
        sourceId: "device-main",
        condition: "stale",
        threshold: null,
      } satisfies RuleSpec,
      matching: {
        sourceType: "device",
        sourceId: "device-main",
        status: "stale",
      } satisfies AlertObservation,
      clearing: {
        sourceType: "device",
        sourceId: "device-main",
        status: "online",
      } satisfies AlertObservation,
    },
    {
      label: "output threshold",
      rule: {
        sourceType: "output",
        sourceId: "output-main",
        condition: "at_or_above",
        threshold: 50,
      } satisfies RuleSpec,
      matching: {
        sourceType: "output",
        sourceId: "output-main",
        valuePercentage: 50,
      } satisfies AlertObservation,
      clearing: {
        sourceType: "output",
        sourceId: "output-main",
        valuePercentage: 49,
      } satisfies AlertObservation,
    },
    {
      label: "sensor threshold",
      rule: {
        sourceType: "sensor",
        sourceId: "sensor-main",
        condition: "below",
        threshold: 10,
      } satisfies RuleSpec,
      matching: {
        sourceType: "sensor",
        sourceId: "sensor-main",
        value: 9,
      } satisfies AlertObservation,
      clearing: {
        sourceType: "sensor",
        sourceId: "sensor-main",
        value: 10,
      } satisfies AlertObservation,
    },
    {
      label: "switch state",
      rule: {
        sourceType: "switch",
        sourceId: "switch-main",
        condition: "open",
        threshold: null,
      } satisfies RuleSpec,
      matching: {
        sourceType: "switch",
        sourceId: "switch-main",
        isOpen: true,
      } satisfies AlertObservation,
      clearing: {
        sourceType: "switch",
        sourceId: "switch-main",
        isOpen: false,
      } satisfies AlertObservation,
    },
  ])(
    "opens and recovers a $label alert",
    async ({ rule, matching, clearing }) => {
      await insertRule(rule);
      const service = createService();

      const opened = await service.evaluate(matching);
      clock.value += 1;
      const recovered = await service.evaluate(clearing);

      expect(opened.decisions[0]).toMatchObject({
        kind: "transition",
        transition: { transition: "opened" },
      });
      expect(recovered.decisions[0]).toMatchObject({
        kind: "transition",
        transition: { transition: "recovered" },
      });
    },
  );

  it.each([
    ["above", 11, 10],
    ["at_or_above", 10, 9],
    ["below", 9, 10],
    ["at_or_below", 10, 11],
    ["equal", 10, 11],
  ] as const)(
    "implements the %s numeric boundary",
    async (condition, matchingValue, clearingValue) => {
      await insertRule({
        sourceType: "sensor",
        sourceId: "sensor-main",
        condition,
        threshold: 10,
      });
      const service = createService();

      expect(
        (
          await service.evaluate({
            sourceType: "sensor",
            sourceId: "sensor-main",
            value: matchingValue,
          })
        ).decisions[0],
      ).toMatchObject({
        kind: "transition",
        transition: { transition: "opened" },
      });
      clock.value += 1;
      expect(
        (
          await service.evaluate({
            sourceType: "sensor",
            sourceId: "sensor-main",
            value: clearingValue,
          })
        ).decisions[0],
      ).toMatchObject({
        kind: "transition",
        transition: { transition: "recovered" },
      });
    },
  );

  it.each([
    ["offline", "offline"],
    ["stale", "stale"],
    ["error", "error"],
    ["not_online", "unknown"],
  ] as const)(
    "implements the %s device condition",
    async (condition, status) => {
      await insertRule({
        sourceType: "device",
        sourceId: "device-main",
        condition,
        threshold: null,
      });

      const result = await createService().evaluate({
        sourceType: "device",
        sourceId: "device-main",
        status,
      });

      expect(result.decisions[0]).toMatchObject({
        kind: "transition",
        transition: { transition: "opened" },
      });
    },
  );

  it("implements the closed switch condition", async () => {
    await insertRule({
      sourceType: "switch",
      sourceId: "switch-main",
      condition: "closed",
      threshold: null,
    });

    const result = await createService().evaluate({
      sourceType: "switch",
      sourceId: "switch-main",
      isOpen: false,
    });

    expect(result.decisions[0]).toMatchObject({
      kind: "transition",
      transition: { transition: "opened" },
    });
  });
});

describe("AlertService durable lifecycle", () => {
  it("preserves a pending delay across service reconstruction and opens at the exact boundary", async () => {
    await insertRule({
      sourceType: "sensor",
      sourceId: "sensor-main",
      condition: "above",
      threshold: 10,
      delayMs: 1_000,
    });
    const observation = {
      sourceType: "sensor",
      sourceId: "sensor-main",
      value: 11,
    } as const;

    expect((await createService().evaluate(observation)).decisions[0]).toEqual({
      kind: "pending",
      ruleId: "rule-sensor",
      pendingSinceMs: 100,
      remainingDelayMs: 1_000,
    });
    const persisted = await database
      .selectFrom("alert_condition_states")
      .selectAll()
      .executeTakeFirstOrThrow();
    expect(
      alertObservationSchema.parse(JSON.parse(persisted.observation_json)),
    ).toEqual(observation);

    clock.value = 1_099;
    expect(
      (await createService().evaluate(observation)).decisions[0],
    ).toMatchObject({
      kind: "pending",
      pendingSinceMs: 100,
      remainingDelayMs: 1,
    });
    clock.value = 1_100;
    expect(
      (await createService().evaluate(observation)).decisions[0],
    ).toMatchObject({
      kind: "transition",
      transition: { transition: "opened" },
    });
    expect(await tableCount("alert_condition_states")).toBe(0);
    expect(await tableCount("active_alerts")).toBe(1);
  });

  it("clears and restarts a persisted pending delay", async () => {
    await insertRule({
      sourceType: "sensor",
      sourceId: "sensor-main",
      condition: "above",
      threshold: 10,
      delayMs: 1_000,
    });
    const service = createService();
    await service.evaluate({
      sourceType: "sensor",
      sourceId: "sensor-main",
      value: 11,
    });
    clock.value = 200;
    expect(
      (
        await service.evaluate({
          sourceType: "sensor",
          sourceId: "sensor-main",
          value: 10,
        })
      ).decisions[0],
    ).toEqual({ kind: "condition-clear", ruleId: "rule-sensor" });
    expect(await tableCount("alert_condition_states")).toBe(0);

    clock.value = 2_000;
    expect(
      (
        await createService().evaluate({
          sourceType: "sensor",
          sourceId: "sensor-main",
          value: 11,
        })
      ).decisions[0],
    ).toMatchObject({ kind: "pending", pendingSinceMs: 2_000 });
  });

  it("removes pending authority for a disabled rule", async () => {
    await insertRule({
      sourceType: "sensor",
      sourceId: "sensor-main",
      condition: "above",
      threshold: 10,
      delayMs: 1_000,
    });
    const service = createService();
    await service.evaluate({
      sourceType: "sensor",
      sourceId: "sensor-main",
      value: 11,
    });
    await database
      .updateTable("alert_rules")
      .set({ enabled: 0, updated_at_ms: 1 })
      .where("id", "=", "rule-sensor")
      .executeTakeFirstOrThrow();

    const result = await service.evaluate({
      sourceType: "sensor",
      sourceId: "sensor-main",
      value: 11,
    });

    expect(result.decisions).toEqual([]);
    expect(await tableCount("alert_condition_states")).toBe(0);
  });

  it("deduplicates, acknowledges, recovers, reopens, and excludes observed transitions from delivery", async () => {
    await insertRule({
      sourceType: "sensor",
      sourceId: "sensor-main",
      condition: "above",
      threshold: 10,
    });
    let service = createService(true);
    const observation = {
      sourceType: "sensor",
      sourceId: "sensor-main",
      value: 11,
    } as const;

    const opened = await service.evaluate(observation);
    expect((await service.evaluate(observation)).decisions[0]).toEqual({
      kind: "unchanged",
      ruleId: "rule-sensor",
    });
    service = createService(true);
    clock.value = 101;
    expect(
      await service.acknowledge("alert-1", "operator", "Checked"),
    ).toMatchObject({ transition: "acknowledged" });
    service = createService(true);
    expect(await service.acknowledge("alert-1", "operator")).toBeNull();
    clock.value = 102;
    expect(
      await service.recover("alert-1", "operator", "Resolved"),
    ).toMatchObject({ transition: "recovered" });
    expect(await service.recover("alert-1", "operator", "Resolved")).toBeNull();
    clock.value = 103;
    expect((await service.evaluate(observation)).decisions[0]).toMatchObject({
      kind: "transition",
      transition: { transition: "reopened" },
    });
    clock.value = 104;
    expect((await service.evaluate(observation)).decisions[0]).toEqual({
      kind: "unchanged",
      ruleId: "rule-sensor",
    });
    clock.value = 3_600_103;
    expect(
      (await createService(true).evaluate(observation)).decisions[0],
    ).toMatchObject({
      kind: "transition",
      transition: { transition: "observed" },
    });

    expect(opened.decisions[0]).toMatchObject({
      kind: "transition",
      transition: { transition: "opened" },
    });
    expect(await tableCount("notification_deliveries")).toBe(4);
    const alert = await database
      .selectFrom("active_alerts")
      .selectAll()
      .executeTakeFirstOrThrow();
    expect(alert).toMatchObject({
      state: "open",
      opened_at_ms: 103,
      acknowledged_at_ms: null,
      recovered_at_ms: null,
    });
  });

  it("keeps custom deduplication keys independent and stable", async () => {
    await insertRule({
      sourceType: "sensor",
      sourceId: "sensor-main",
      condition: "above",
      threshold: 10,
    });
    const service = createService(true);
    const first = {
      sourceType: "sensor",
      sourceId: "sensor-main",
      deduplicationKey: "probe-a",
      value: 11,
    } as const;
    const second = { ...first, deduplicationKey: "probe-b" } as const;

    await service.evaluate(first);
    await service.evaluate(second);
    expect((await service.evaluate(first)).decisions[0]).toEqual({
      kind: "unchanged",
      ruleId: "rule-sensor",
    });

    expect(await tableCount("active_alerts")).toBe(2);
    expect(await tableCount("notification_deliveries")).toBe(2);
    await expect(
      database
        .selectFrom("active_alerts")
        .select("deduplication_key")
        .orderBy("deduplication_key")
        .execute(),
    ).resolves.toEqual([
      { deduplication_key: "probe-a" },
      { deduplication_key: "probe-b" },
    ]);
  });

  it("serializes duplicate concurrent observations into one transition", async () => {
    await insertRule({
      sourceType: "sensor",
      sourceId: "sensor-main",
      condition: "above",
      threshold: 10,
    });
    const service = createService(true);
    const observation = {
      sourceType: "sensor",
      sourceId: "sensor-main",
      value: 11,
    } as const;

    const results = await Promise.all([
      service.evaluate(observation),
      service.evaluate(observation),
    ]);

    expect(results.map((result) => result.decisions[0]?.kind).sort()).toEqual([
      "transition",
      "unchanged",
    ]);
    expect(await tableCount("active_alerts")).toBe(1);
    expect(await tableCount("state_revisions")).toBe(1);
    expect(await tableCount("notification_deliveries")).toBe(1);
  });

  it("guards acknowledgements against operator commits without conflicting on background alert revisions", async () => {
    await insertRule({
      sourceType: "device",
      sourceId: "device-main",
      condition: "offline",
      threshold: null,
    });
    const service = createService(true);
    await service.evaluate({
      sourceType: "device",
      sourceId: "device-main",
      status: "offline",
    });
    clock.value = 101;

    await expect(
      service.acknowledgeAtRevision("alert-1", "operator", "Checked", 0),
    ).resolves.toMatchObject({ changed: true, revision: 2 });
    await expect(
      database
        .selectFrom("active_alerts")
        .select("state")
        .where("id", "=", "alert-1")
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ state: "acknowledged" });

    await expect(
      service.acknowledgeAtRevision("alert-1", "operator", null, 0),
    ).rejects.toMatchObject({
      name: "AlertRevisionConflictError",
      expectedRevision: 0,
      currentRevision: 2,
    } satisfies Partial<AlertRevisionConflictError>);
    expect(await tableCount("state_revisions")).toBe(2);
    expect(await tableCount("notification_deliveries")).toBe(2);
  });

  it("rejects a stale rule snapshot before committing an alert transition", async () => {
    await insertRule({
      sourceType: "sensor",
      sourceId: "sensor-main",
      condition: "above",
      threshold: 10,
    });
    await sql`
      CREATE TRIGGER mutate_alert_rule_after_pending
      AFTER INSERT ON alert_condition_states
      BEGIN
        UPDATE alert_rules
        SET updated_at_ms = updated_at_ms + 1
        WHERE id = NEW.alert_rule_id;
      END
    `.execute(database);

    await expect(
      createService().evaluate({
        sourceType: "sensor",
        sourceId: "sensor-main",
        value: 11,
      }),
    ).rejects.toBeInstanceOf(AlertConcurrencyError);
    expect(await tableCount("active_alerts")).toBe(0);
    expect(await tableCount("state_revisions")).toBe(0);
  });

  it("writes validated event details and standalone notification JSON atomically", async () => {
    await insertRule({
      sourceType: "device",
      sourceId: "device-main",
      condition: "offline",
      threshold: null,
    });
    await createService(true).evaluate({
      sourceType: "device",
      sourceId: "device-main",
      status: "offline",
    });
    const outbox = await database
      .selectFrom("state_outbox")
      .selectAll()
      .executeTakeFirstOrThrow();
    const envelope = parseStoredStateOutboxEnvelope(outbox);
    const details = alertStateEventPayloadV1Schema.parse(envelope.details.data);
    const delivery = await database
      .selectFrom("notification_deliveries")
      .selectAll()
      .executeTakeFirstOrThrow();
    const notification = alertNotificationV1Schema.parse(
      JSON.parse(delivery.notification_json),
    );

    expect(envelope.invalidations).toEqual([
      { resource: "alert", id: details.alert.id },
    ]);
    expect(details.transition).toBe("opened");
    expect(notification).toMatchObject({
      eventRevision: outbox.revision,
      transition: "opened",
      alert: { id: details.alert.id },
    });
  });
});

describe("AlertService validation", () => {
  it.each([
    {
      label: "device threshold",
      rule: {
        sourceType: "device",
        sourceId: "device-main",
        condition: "offline",
        threshold: 1,
      } satisfies RuleSpec,
      observation: {
        sourceType: "device",
        sourceId: "device-main",
        status: "offline",
      } satisfies AlertObservation,
    },
    {
      label: "missing numeric threshold",
      rule: {
        sourceType: "sensor",
        sourceId: "sensor-main",
        condition: "above",
        threshold: null,
      } satisfies RuleSpec,
      observation: {
        sourceType: "sensor",
        sourceId: "sensor-main",
        value: 11,
      } satisfies AlertObservation,
    },
    {
      label: "unsupported switch condition",
      rule: {
        sourceType: "switch",
        sourceId: "switch-main",
        condition: "unsupported",
        threshold: null,
      } satisfies RuleSpec,
      observation: {
        sourceType: "switch",
        sourceId: "switch-main",
        isOpen: true,
      } satisfies AlertObservation,
    },
  ])("rejects an invalid $label rule", async ({ rule, observation }) => {
    await insertRule(rule);

    await expect(createService().evaluate(observation)).rejects.toBeInstanceOf(
      InvalidAlertRuleError,
    );
    expect(await tableCount("state_revisions")).toBe(0);
  });

  it("rejects malformed enabled rules before any state write", async () => {
    await insertRule({
      sourceType: "sensor",
      sourceId: "sensor-main",
      condition: "unsupported",
      threshold: 10,
    });

    await expect(
      createService().evaluate({
        sourceType: "sensor",
        sourceId: "sensor-main",
        value: 11,
      }),
    ).rejects.toBeInstanceOf(InvalidAlertRuleError);
    expect(await tableCount("alert_condition_states")).toBe(0);
    expect(await tableCount("state_revisions")).toBe(0);
  });

  it("fails loudly when persisted pending observation JSON is malformed", async () => {
    await insertRule({
      sourceType: "sensor",
      sourceId: "sensor-main",
      condition: "above",
      threshold: 10,
      delayMs: 1_000,
    });
    await createService().evaluate({
      sourceType: "sensor",
      sourceId: "sensor-main",
      value: 11,
    });
    await database
      .updateTable("alert_condition_states")
      .set({ observation_json: "{}" })
      .executeTakeFirstOrThrow();
    clock.value = 200;

    await expect(
      createService().evaluate({
        sourceType: "sensor",
        sourceId: "sensor-main",
        value: 11,
      }),
    ).rejects.toBeInstanceOf(InvalidPersistedAlertDataError);
    expect(await tableCount("alert_condition_states")).toBe(1);

    await database
      .updateTable("alert_condition_states")
      .set({
        observation_json:
          '{"sourceType":"device","sourceType":"sensor","sourceId":"sensor-main","value":11}',
      })
      .executeTakeFirstOrThrow();
    await expect(
      createService().evaluate({
        sourceType: "sensor",
        sourceId: "sensor-main",
        value: 11,
      }),
    ).rejects.toBeInstanceOf(InvalidPersistedAlertDataError);
  });

  it("validates active alert detail documents on every read", async () => {
    await insertRule({
      sourceType: "device",
      sourceId: "device-main",
      condition: "offline",
      threshold: null,
    });
    await createService().evaluate({
      sourceType: "device",
      sourceId: "device-main",
      status: "offline",
    });
    await database
      .updateTable("active_alerts")
      .set({
        details_json:
          '{"schemaVersion":1,"observation":null,"note":null,"extra":true}',
        details_schema_version: 1,
      })
      .where("id", "=", "alert-1")
      .executeTakeFirstOrThrow();
    clock.value = 101;

    await expect(
      createService().evaluate({
        sourceType: "device",
        sourceId: "device-main",
        status: "offline",
      }),
    ).rejects.toBeInstanceOf(InvalidPersistedAlertDataError);
    await expect(
      createService().acknowledge("alert-1", "operator"),
    ).rejects.toBeInstanceOf(InvalidPersistedAlertDataError);
    expect(await tableCount("state_revisions")).toBe(1);
  });

  it("bounds observations, keys, actors, notes, and generated identifiers", async () => {
    await insertRule({
      sourceType: "sensor",
      sourceId: "sensor-main",
      condition: "above",
      threshold: 10,
    });
    const service = createService();

    expect(
      () =>
        new AlertService(database, clock, ids, {
          notificationDestinations: [
            { kind: "webhook", key: "primary" },
            { kind: "webhook", key: "primary" },
          ],
        }),
    ).toThrow(/Duplicate/);
    expect(
      () =>
        new AlertService(database, clock, ids, {
          notificationDestinations: [
            { kind: "webhook", key: "invalid destination" },
          ],
        }),
    ).toThrow();

    await expect(
      service.evaluate({
        sourceType: "sensor",
        sourceId: "sensor-main",
        value: Number.NaN,
      }),
    ).rejects.toThrow();
    await expect(
      service.evaluate({
        sourceType: "sensor",
        sourceId: "sensor-main",
        deduplicationKey: "x".repeat(257),
        value: 11,
      }),
    ).rejects.toThrow();
    await expect(
      service.evaluate(
        { sourceType: "sensor", sourceId: "sensor-main", value: 11 },
        "",
      ),
    ).rejects.toThrow();

    await service.evaluate({
      sourceType: "sensor",
      sourceId: "sensor-main",
      value: 11,
    });
    clock.value = 101;
    await expect(
      service.acknowledge("alert-1", "operator", "n".repeat(257)),
    ).rejects.toThrow();

    const invalidIds: AlertIdGenerator = { nextAlertId: () => "invalid id" };
    clock.value = 102;
    await expect(
      new AlertService(database, clock, invalidIds).evaluate({
        sourceType: "sensor",
        sourceId: "sensor-main",
        deduplicationKey: "another",
        value: 11,
      }),
    ).rejects.toThrow();
  });
});
