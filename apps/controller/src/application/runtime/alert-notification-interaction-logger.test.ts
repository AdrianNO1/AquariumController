import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  openEventsDatabase,
  type EventsDatabaseSchema,
} from "../../infrastructure/database/index.js";
import { InteractionRepository } from "../../infrastructure/storage/index.js";
import type { AlertNotificationTerminalOutcomeRecord } from "../alerts/index.js";
import { AlertNotificationInteractionLogger } from "./alert-notification-interaction-logger.js";

let database: Kysely<EventsDatabaseSchema>;
let logger: AlertNotificationInteractionLogger;
let repository: InteractionRepository;

beforeEach(async () => {
  database = await openEventsDatabase({ filename: ":memory:" });
  repository = new InteractionRepository(database);
  logger = new AlertNotificationInteractionLogger(repository);
});

afterEach(async () => {
  await database.destroy();
});

describe("alert notification interaction logging", () => {
  it.each([
    {
      status: "delivered" as const,
      errorCode: null,
      direction: "outbound",
      severity: "info",
      outcome: "succeeded",
      retentionClass: "audit",
    },
    {
      status: "failed" as const,
      errorCode: "notifier_error",
      direction: "outbound",
      severity: "error",
      outcome: "failed",
      retentionClass: "audit",
    },
    {
      status: "outcome_unknown" as const,
      errorCode: "delivery_interrupted",
      direction: "internal",
      severity: "critical",
      outcome: "outcome_unknown",
      retentionClass: "critical",
    },
  ])(
    "persists sanitized $status evidence with durable retention",
    async (expected) => {
      const record: AlertNotificationTerminalOutcomeRecord = {
        deliveryId: 42,
        alertTransitionRevision: 7,
        alertId: "alert-main",
        transition: "opened",
        destinationKind: "webhook",
        destinationKey: "primary",
        status: expected.status,
        completedAtMs: 1_000,
        errorCode: expected.errorCode,
      };

      await logger.recordTerminalOutcome(record);

      const stored = await database
        .selectFrom("interactions")
        .selectAll()
        .executeTakeFirstOrThrow();
      expect(stored).toMatchObject({
        occurred_at_ms: 1_000,
        direction: expected.direction,
        kind: "alert.notification-delivery",
        severity: expected.severity,
        operation_id: "notification-delivery-42",
        outcome: expected.outcome,
        byte_count: 0,
        retention_class: expected.retentionClass,
        payload_schema_version: 1,
      });
      const interaction = await repository.getById(stored.id);
      expect(interaction?.payload).toEqual({
        alertId: "alert-main",
        alertTransitionRevision: 7,
        deliveryId: 42,
        destinationKey: "primary",
        destinationKind: "webhook",
        errorCode: expected.errorCode,
        errorMessageStored: false,
        notificationPayloadStored: false,
        status: expected.status,
        transition: "opened",
      });
      expect(stored.payload_json).not.toContain("notification_json");
      expect(stored.payload_json).not.toContain("last_error_message");
    },
  );

  it("treats an identical replay as success without duplicating the audit row", async () => {
    const record: AlertNotificationTerminalOutcomeRecord = {
      deliveryId: 42,
      alertTransitionRevision: 7,
      alertId: "alert-main",
      transition: "opened",
      destinationKind: "webhook",
      destinationKey: "primary",
      status: "failed",
      completedAtMs: 1_000,
      errorCode: "notifier_error",
    };

    await Promise.all([
      logger.recordTerminalOutcome(record),
      logger.recordTerminalOutcome(structuredClone(record)),
    ]);

    await expect(
      database
        .selectFrom("interactions")
        .select(({ fn }) => fn.count<number>("id").as("count"))
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ count: 1 });
  });

  it("fails loudly when a delivery identifier is replayed with conflicting audit metadata", async () => {
    const record: AlertNotificationTerminalOutcomeRecord = {
      deliveryId: 42,
      alertTransitionRevision: 7,
      alertId: "alert-main",
      transition: "opened",
      destinationKind: "webhook",
      destinationKey: "primary",
      status: "failed",
      completedAtMs: 1_000,
      errorCode: "notifier_error",
    };
    await logger.recordTerminalOutcome(record);

    await expect(
      logger.recordTerminalOutcome({
        ...record,
        status: "delivered",
        errorCode: null,
      }),
    ).rejects.toThrow(/conflicts with its durable outcome/u);
    await expect(
      database
        .selectFrom("interactions")
        .select(({ fn }) => fn.count<number>("id").as("count"))
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ count: 1 });
  });
});
