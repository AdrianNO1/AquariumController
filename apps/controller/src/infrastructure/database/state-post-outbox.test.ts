import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Kysely } from "kysely";

import {
  commitStateChange,
  openStateDatabase,
  type StateDatabaseSchema,
} from "./index.js";

let state: Kysely<StateDatabaseSchema>;

beforeEach(async () => {
  state = await openStateDatabase({ filename: ":memory:" });
  await state
    .insertInto("devices")
    .values({
      id: "device-alert",
      hardware_id: "device-alert-hardware",
      name: "Alert device",
      desired_pwm_frequency_hz: 5_000,
      desired_pwm_resolution_bits: 8,
      created_at_ms: 100,
      updated_at_ms: 100,
    })
    .executeTakeFirstOrThrow();
  await state
    .insertInto("alert_rules")
    .values({
      id: "rule-offline",
      name: "Offline",
      source_type: "device",
      device_id: "device-alert",
      condition: "offline",
      severity: "critical",
      created_at_ms: 100,
      updated_at_ms: 100,
    })
    .executeTakeFirstOrThrow();
  await state
    .insertInto("active_alerts")
    .values({
      id: "alert-offline",
      alert_rule_id: "rule-offline",
      deduplication_key: "device:device-alert",
      state: "open",
      opened_at_ms: 100,
      last_observed_at_ms: 100,
    })
    .executeTakeFirstOrThrow();
});

afterEach(async () => {
  await state.destroy();
});

const alertEvent = {
  actor: "alert-service",
  mutationType: "alert.acknowledged",
  summary: "Acknowledged alert",
  eventType: "alert.acknowledged",
  entityType: "alert",
  entityId: "alert-offline",
  occurredAtMs: 101,
  retentionClass: "critical",
  payloadJson: '{"schemaVersion":1,"transition":"acknowledged"}',
  payloadSchemaVersion: 1,
} as const;

describe("commitStateChange post-outbox hook", () => {
  it("registers a notification intent atomically after allocating the revision", async () => {
    const committed = await commitStateChange(
      state,
      alertEvent,
      async (transaction) => {
        await transaction
          .updateTable("active_alerts")
          .set({
            state: "acknowledged",
            acknowledged_at_ms: 101,
          })
          .where("id", "=", "alert-offline")
          .executeTakeFirstOrThrow();
        return "acknowledged" as const;
      },
      async (transaction, context) => {
        const outbox = await transaction
          .selectFrom("state_outbox")
          .select("revision")
          .where("revision", "=", context.revision)
          .executeTakeFirstOrThrow();
        expect(outbox.revision).toBe(context.outboxEvent.revision);

        await transaction
          .insertInto("notification_deliveries")
          .values({
            alert_transition_revision: context.revision,
            alert_id: "alert-offline",
            transition: "acknowledged",
            destination_kind: "webhook",
            destination_key: "primary",
            deduplication_key: `${context.revision}:primary`,
            notification_json: JSON.stringify({
              schemaVersion: 1,
              eventRevision: context.revision,
            }),
            notification_schema_version: 1,
            created_at_ms: 101,
            updated_at_ms: 101,
          })
          .executeTakeFirstOrThrow();
      },
    );

    expect(committed.result).toBe("acknowledged");
    expect(committed.revision).toBe(1);
    expect(
      await state
        .selectFrom("notification_deliveries")
        .select(["alert_transition_revision", "status", "attempt_count"])
        .executeTakeFirstOrThrow(),
    ).toEqual({
      alert_transition_revision: 1,
      status: "pending",
      attempt_count: 0,
    });
  });

  it("rolls back the mutation, revision, outbox, and intent when the hook fails", async () => {
    await expect(
      commitStateChange(
        state,
        alertEvent,
        async (transaction) => {
          await transaction
            .insertInto("outputs")
            .values({
              id: "rolled-back-output",
              name: "Rolled back",
              kind: "test",
              display_order: 0,
              created_at_ms: 101,
              updated_at_ms: 101,
            })
            .executeTakeFirstOrThrow();
        },
        async (transaction, context) => {
          await transaction
            .insertInto("notification_deliveries")
            .values({
              alert_transition_revision: context.revision,
              alert_id: "alert-offline",
              transition: "acknowledged",
              destination_kind: "webhook",
              destination_key: "primary",
              deduplication_key: `${context.revision}:primary`,
              notification_json: JSON.stringify({
                schemaVersion: 1,
                eventRevision: context.revision,
              }),
              notification_schema_version: 1,
              created_at_ms: 101,
              updated_at_ms: 101,
            })
            .executeTakeFirstOrThrow();
          throw new Error("intent registration failed");
        },
      ),
    ).rejects.toThrow("intent registration failed");

    expect(
      await state
        .selectFrom("outputs")
        .select(({ fn }) => fn.countAll<number>().as("count"))
        .executeTakeFirstOrThrow(),
    ).toEqual({ count: 0 });
    expect(
      await state
        .selectFrom("state_revisions")
        .select(({ fn }) => fn.countAll<number>().as("count"))
        .executeTakeFirstOrThrow(),
    ).toEqual({ count: 0 });
    expect(
      await state
        .selectFrom("state_outbox")
        .select(({ fn }) => fn.countAll<number>().as("count"))
        .executeTakeFirstOrThrow(),
    ).toEqual({ count: 0 });
    expect(
      await state
        .selectFrom("notification_deliveries")
        .select(({ fn }) => fn.countAll<number>().as("count"))
        .executeTakeFirstOrThrow(),
    ).toEqual({ count: 0 });
  });
});
