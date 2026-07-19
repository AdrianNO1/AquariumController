import { alertNotificationV1Schema } from "@aquarium/contracts";
import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  openStateDatabase,
  parseStoredStateOutboxEnvelope,
  toCommittedStateEvent,
  type StateDatabaseSchema,
} from "../../infrastructure/database/index.js";
import { AlertService } from "./alert-service.js";
import {
  AlertNotificationDispatcher,
  type AlertNotificationOutcomeRecorder,
  type AlertNotificationTerminalOutcomeRecord,
} from "./notification-dispatcher.js";
import type { AlertNotifier } from "./notification-port.js";
import type {
  AlertClock,
  AlertIdGenerator,
  AlertNotificationV1,
} from "./types.js";

class TestClock implements AlertClock {
  constructor(public value: number) {}

  nowMs(): number {
    return this.value;
  }
}

class FixedAlertId implements AlertIdGenerator {
  nextAlertId(): string {
    return "alert-offline";
  }
}

class CountingNotifier implements AlertNotifier {
  readonly notifications: AlertNotificationV1[] = [];
  failure: Error | undefined;
  afterSend: (() => void) | undefined;

  async send(notification: AlertNotificationV1): Promise<void> {
    this.notifications.push(structuredClone(notification));
    this.afterSend?.();
    if (this.failure !== undefined) throw this.failure;
  }
}

class RecordingOutcomeRecorder implements AlertNotificationOutcomeRecorder {
  readonly attempts: AlertNotificationTerminalOutcomeRecord[] = [];
  readonly records: AlertNotificationTerminalOutcomeRecord[] = [];
  failure: Error | undefined;

  async recordTerminalOutcome(
    outcome: AlertNotificationTerminalOutcomeRecord,
  ): Promise<void> {
    this.attempts.push(structuredClone(outcome));
    if (this.failure !== undefined) throw this.failure;
    this.records.push(structuredClone(outcome));
  }
}

let database: Kysely<StateDatabaseSchema>;
let clock: TestClock;
let outcomeRecorder: RecordingOutcomeRecorder;

async function createPendingDelivery(): Promise<number> {
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
    .insertInto("alert_rules")
    .values({
      id: "rule-offline",
      name: "Device offline",
      source_type: "device",
      device_id: "device-main",
      output_id: null,
      sensor_id: null,
      switch_id: null,
      condition: "offline",
      threshold: null,
      delay_ms: 0,
      severity: "critical",
      enabled: 1,
      created_at_ms: 0,
      updated_at_ms: 0,
      configuration_json: null,
      configuration_schema_version: null,
    })
    .executeTakeFirstOrThrow();
  const service = new AlertService(database, clock, new FixedAlertId(), {
    notificationDestinations: [{ kind: "webhook", key: "primary" }],
  });
  await service.evaluate({
    sourceType: "device",
    sourceId: "device-main",
    status: "offline",
  });
  return (
    await database
      .selectFrom("notification_deliveries")
      .select("id")
      .executeTakeFirstOrThrow()
  ).id;
}

beforeEach(async () => {
  database = await openStateDatabase({ filename: ":memory:" });
  clock = new TestClock(100);
  outcomeRecorder = new RecordingOutcomeRecorder();
});

afterEach(async () => {
  await database.destroy();
});

describe("AlertNotificationDispatcher", () => {
  it("claims and delivers each intent exactly once", async () => {
    const deliveryId = await createPendingDelivery();
    const notifier = new CountingNotifier();
    const dispatcher = new AlertNotificationDispatcher(
      database,
      clock,
      [{ kind: "webhook", key: "primary", notifier }],
      outcomeRecorder,
    );

    const first = await dispatcher.dispatchPending();
    const second = await dispatcher.dispatchPending();

    expect(first.outcomes).toEqual([
      { deliveryId, status: "delivered", errorCode: null },
    ]);
    expect(second.outcomes).toEqual([]);
    expect(notifier.notifications).toHaveLength(1);
    expect(notifier.notifications[0]).toMatchObject({
      eventRevision: 1,
      transition: "opened",
      alert: { id: "alert-offline" },
    });
    expect(outcomeRecorder.records).toEqual([
      {
        deliveryId,
        alertTransitionRevision: 1,
        alertId: "alert-offline",
        transition: "opened",
        destinationKind: "webhook",
        destinationKey: "primary",
        status: "delivered",
        completedAtMs: 100,
        errorCode: null,
      },
    ]);
    await expect(
      database
        .selectFrom("notification_deliveries")
        .select([
          "status",
          "attempt_count",
          "attempt_started_at_ms",
          "completed_at_ms",
          "last_error_code",
          "last_error_message",
          "outcome_audit_recorded_at_ms",
        ])
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({
      status: "delivered",
      attempt_count: 1,
      attempt_started_at_ms: 100,
      completed_at_ms: 100,
      last_error_code: null,
      last_error_message: null,
      outcome_audit_recorded_at_ms: 100,
    });
    const outbox = await database
      .selectFrom("state_outbox")
      .selectAll()
      .orderBy("revision")
      .execute();
    expect(outbox.map(({ revision }) => revision)).toEqual([1, 2, 3]);
    expect(
      outbox.slice(1).map((event) => ({
        type: event.event_type,
        invalidations: toCommittedStateEvent(event).data.invalidations,
        details: parseStoredStateOutboxEnvelope(event).details.data,
      })),
    ).toMatchObject([
      {
        type: "alert.notification-delivery-status-changed",
        invalidations: [{ resource: "alert", id: "alert-offline" }],
        details: { deliveryId, status: "attempting", errorCode: null },
      },
      {
        type: "alert.notification-delivery-status-changed",
        invalidations: [{ resource: "alert", id: "alert-offline" }],
        details: { deliveryId, status: "delivered", errorCode: null },
      },
    ]);
    await expect(
      database
        .selectFrom("operator_concurrency")
        .select("last_operator_revision")
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ last_operator_revision: 0 });
  });

  it("records a redacted terminal failure without retrying or changing alert state", async () => {
    const deliveryId = await createPendingDelivery();
    const notifier = new CountingNotifier();
    notifier.failure = new Error("private destination and auth details");
    const dispatcher = new AlertNotificationDispatcher(
      database,
      clock,
      [{ kind: "webhook", key: "primary", notifier }],
      outcomeRecorder,
    );

    const first = await dispatcher.dispatchPending();
    const second = await dispatcher.dispatchPending();

    expect(first.outcomes).toEqual([
      { deliveryId, status: "failed", errorCode: "notifier_error" },
    ]);
    expect(second.outcomes).toEqual([]);
    expect(notifier.notifications).toHaveLength(1);
    const delivery = await database
      .selectFrom("notification_deliveries")
      .selectAll()
      .executeTakeFirstOrThrow();
    expect(delivery).toMatchObject({
      status: "failed",
      attempt_count: 1,
      last_error_code: "notifier_error",
      last_error_message: "Alert notifier failed",
    });
    expect(JSON.stringify(delivery)).not.toContain("private destination");
    expect(outcomeRecorder.records).toMatchObject([
      {
        deliveryId,
        status: "failed",
        errorCode: "notifier_error",
      },
    ]);
    expect(JSON.stringify(outcomeRecorder.records)).not.toContain(
      "private destination",
    );
    await expect(
      database
        .selectFrom("active_alerts")
        .select("state")
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ state: "open" });
    const terminalEvent = await database
      .selectFrom("state_outbox")
      .selectAll()
      .where("revision", "=", 3)
      .executeTakeFirstOrThrow();
    expect(
      parseStoredStateOutboxEnvelope(terminalEvent).details.data,
    ).toMatchObject({
      deliveryId,
      status: "failed",
      errorCode: "notifier_error",
    });
  });

  it("survives an audit recorder failure and backfills it exactly once after restart", async () => {
    const deliveryId = await createPendingDelivery();
    const notifier = new CountingNotifier();
    const failingRecorder = new RecordingOutcomeRecorder();
    failingRecorder.failure = new Error("events database unavailable");
    const firstDispatcher = new AlertNotificationDispatcher(
      database,
      clock,
      [{ kind: "webhook", key: "primary", notifier }],
      failingRecorder,
    );

    await expect(firstDispatcher.dispatchPending()).rejects.toThrow(
      "events database unavailable",
    );
    expect(notifier.notifications).toHaveLength(1);
    expect(failingRecorder.attempts).toMatchObject([
      {
        deliveryId,
        status: "delivered",
        errorCode: null,
      },
    ]);
    expect(failingRecorder.records).toEqual([]);
    await expect(
      database
        .selectFrom("notification_deliveries")
        .select(["status", "outcome_audit_recorded_at_ms"])
        .where("id", "=", deliveryId)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({
      status: "delivered",
      outcome_audit_recorded_at_ms: null,
    });

    const restartedRecorder = new RecordingOutcomeRecorder();
    const restartedDispatcher = new AlertNotificationDispatcher(
      database,
      clock,
      [],
      restartedRecorder,
    );
    await expect(restartedDispatcher.recoverInterrupted()).resolves.toEqual([]);
    await expect(restartedDispatcher.recoverInterrupted()).resolves.toEqual([]);

    expect(notifier.notifications).toHaveLength(1);
    expect(restartedRecorder.records).toMatchObject([
      {
        deliveryId,
        status: "delivered",
        errorCode: null,
      },
    ]);
    await expect(
      database
        .selectFrom("notification_deliveries")
        .select("outcome_audit_recorded_at_ms")
        .where("id", "=", deliveryId)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ outcome_audit_recorded_at_ms: 100 });
  });

  it("fails invalid persisted notification JSON before calling the notifier", async () => {
    const deliveryId = await createPendingDelivery();
    await database
      .updateTable("notification_deliveries")
      .set({ notification_json: "{}" })
      .where("id", "=", deliveryId)
      .executeTakeFirstOrThrow();
    const notifier = new CountingNotifier();
    const dispatcher = new AlertNotificationDispatcher(
      database,
      clock,
      [{ kind: "webhook", key: "primary", notifier }],
      outcomeRecorder,
    );

    const result = await dispatcher.dispatchPending();

    expect(result.outcomes).toEqual([
      { deliveryId, status: "failed", errorCode: "invalid_notification" },
    ]);
    expect(notifier.notifications).toEqual([]);
  });

  it("rejects duplicate keys in otherwise valid notification JSON", async () => {
    const deliveryId = await createPendingDelivery();
    const stored = await database
      .selectFrom("notification_deliveries")
      .select("notification_json")
      .where("id", "=", deliveryId)
      .executeTakeFirstOrThrow();
    const duplicated = stored.notification_json.replace(
      '"eventRevision":1',
      '"eventRevision":999,"eventRevision":1',
    );
    expect(duplicated).not.toBe(stored.notification_json);
    await database
      .updateTable("notification_deliveries")
      .set({ notification_json: duplicated })
      .where("id", "=", deliveryId)
      .executeTakeFirstOrThrow();
    const notifier = new CountingNotifier();
    const dispatcher = new AlertNotificationDispatcher(
      database,
      clock,
      [{ kind: "webhook", key: "primary", notifier }],
      outcomeRecorder,
    );

    const result = await dispatcher.dispatchPending();

    expect(result.outcomes[0]).toMatchObject({
      status: "failed",
      errorCode: "invalid_notification",
    });
    expect(notifier.notifications).toEqual([]);
  });

  it("rejects valid notification JSON whose persisted transition metadata differs", async () => {
    const deliveryId = await createPendingDelivery();
    const delivery = await database
      .selectFrom("notification_deliveries")
      .select("notification_json")
      .where("id", "=", deliveryId)
      .executeTakeFirstOrThrow();
    const notification = alertNotificationV1Schema.parse(
      JSON.parse(delivery.notification_json),
    );
    await database
      .updateTable("notification_deliveries")
      .set({
        notification_json: JSON.stringify({
          ...notification,
          eventRevision: notification.eventRevision + 1,
        }),
      })
      .where("id", "=", deliveryId)
      .executeTakeFirstOrThrow();
    const notifier = new CountingNotifier();
    const dispatcher = new AlertNotificationDispatcher(
      database,
      clock,
      [{ kind: "webhook", key: "primary", notifier }],
      outcomeRecorder,
    );

    const result = await dispatcher.dispatchPending();

    expect(result.outcomes[0]).toMatchObject({
      status: "failed",
      errorCode: "invalid_notification",
    });
    expect(notifier.notifications).toEqual([]);
  });

  it("records a configured intent with no runtime binding as terminal", async () => {
    const deliveryId = await createPendingDelivery();
    const dispatcher = new AlertNotificationDispatcher(
      database,
      clock,
      [],
      outcomeRecorder,
    );

    const result = await dispatcher.dispatchPending();

    expect(result.outcomes).toEqual([
      {
        deliveryId,
        status: "failed",
        errorCode: "destination_unavailable",
      },
    ]);
    await expect(dispatcher.dispatchPending()).resolves.toEqual({
      outcomes: [],
    });
  });

  it("converts startup in-flight state to outcome unknown without delivery", async () => {
    const deliveryId = await createPendingDelivery();
    await database
      .updateTable("notification_deliveries")
      .set({
        status: "attempting",
        attempt_count: 1,
        attempt_started_at_ms: 100,
        updated_at_ms: 100,
      })
      .where("id", "=", deliveryId)
      .executeTakeFirstOrThrow();
    clock.value = 200;
    const notifier = new CountingNotifier();
    const dispatcher = new AlertNotificationDispatcher(
      database,
      clock,
      [{ kind: "webhook", key: "primary", notifier }],
      outcomeRecorder,
    );

    await expect(dispatcher.recoverInterrupted()).resolves.toEqual([
      deliveryId,
    ]);
    await expect(dispatcher.dispatchPending()).resolves.toEqual({
      outcomes: [],
    });

    expect(notifier.notifications).toEqual([]);
    expect(outcomeRecorder.records).toMatchObject([
      {
        deliveryId,
        status: "outcome_unknown",
        completedAtMs: 200,
        errorCode: "delivery_interrupted",
      },
    ]);
    await expect(
      database
        .selectFrom("notification_deliveries")
        .select([
          "status",
          "attempt_count",
          "completed_at_ms",
          "last_error_code",
          "outcome_audit_recorded_at_ms",
        ])
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({
      status: "outcome_unknown",
      attempt_count: 1,
      completed_at_ms: 200,
      last_error_code: "delivery_interrupted",
      outcome_audit_recorded_at_ms: 200,
    });
    const recoveryEvent = await database
      .selectFrom("state_outbox")
      .selectAll()
      .where("revision", "=", 2)
      .executeTakeFirstOrThrow();
    expect(
      parseStoredStateOutboxEnvelope(recoveryEvent).details.data,
    ).toMatchObject({
      deliveryId,
      status: "outcome_unknown",
      errorCode: "delivery_interrupted",
    });
  });

  it("does not retry when persistence cannot record a remote success", async () => {
    const deliveryId = await createPendingDelivery();
    const notifier = new CountingNotifier();
    notifier.afterSend = () => {
      clock.value = 99;
    };
    const dispatcher = new AlertNotificationDispatcher(
      database,
      clock,
      [{ kind: "webhook", key: "primary", notifier }],
      outcomeRecorder,
    );

    await expect(dispatcher.dispatchPending()).rejects.toThrow(
      /completion clock precedes/,
    );
    expect(notifier.notifications).toHaveLength(1);
    await expect(dispatcher.dispatchPending()).resolves.toEqual({
      outcomes: [],
    });
    clock.value = 200;
    await expect(dispatcher.recoverInterrupted()).resolves.toEqual([
      deliveryId,
    ]);
    expect(notifier.notifications).toHaveLength(1);
  });

  it("allows only one concurrent dispatcher to claim an intent", async () => {
    await createPendingDelivery();
    const notifier = new CountingNotifier();
    const first = new AlertNotificationDispatcher(
      database,
      clock,
      [{ kind: "webhook", key: "primary", notifier }],
      outcomeRecorder,
    );
    const second = new AlertNotificationDispatcher(
      database,
      clock,
      [{ kind: "webhook", key: "primary", notifier }],
      outcomeRecorder,
    );

    const results = await Promise.all([
      first.dispatchPending(),
      second.dispatchPending(),
    ]);

    expect(results.flatMap((result) => result.outcomes)).toHaveLength(1);
    expect(notifier.notifications).toHaveLength(1);
    await expect(
      database
        .selectFrom("state_outbox")
        .select(({ fn }) => fn.countAll<number>().as("count"))
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ count: 3 });
  });

  it("validates destination uniqueness and dispatch batch bounds", async () => {
    const notifier = new CountingNotifier();
    expect(
      () =>
        new AlertNotificationDispatcher(
          database,
          clock,
          [
            { kind: "webhook", key: "primary", notifier },
            { kind: "webhook", key: "primary", notifier },
          ],
          outcomeRecorder,
        ),
    ).toThrow(/Duplicate/);
    const dispatcher = new AlertNotificationDispatcher(
      database,
      clock,
      [],
      outcomeRecorder,
    );
    await expect(dispatcher.dispatchPending(0)).rejects.toThrow(
      /between 1 and 100/,
    );
    await expect(dispatcher.dispatchPending(101)).rejects.toThrow(
      /between 1 and 100/,
    );
  });
});
