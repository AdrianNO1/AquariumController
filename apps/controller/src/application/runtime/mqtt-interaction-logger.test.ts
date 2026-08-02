import { createEspTopicSet } from "@aquarium/esp-protocol";
import type { Kysely } from "kysely";
import { afterEach, describe, expect, it } from "vitest";

import {
  openEventsDatabase,
  type EventsDatabaseSchema,
} from "../../infrastructure/database/index.js";
import { InteractionRepository } from "../../infrastructure/storage/interaction-repository.js";
import { MqttInteractionLogger } from "./mqtt-interaction-logger.js";

const openDatabases: Kysely<EventsDatabaseSchema>[] = [];

afterEach(async () => {
  await Promise.all(
    openDatabases.splice(0).map((database) => database.destroy()),
  );
});

describe("MQTT interaction volume policy", () => {
  it("keeps routine wire traffic short-lived while preserving intent and failures", async () => {
    const database = await openEventsDatabase({ filename: ":memory:" });
    openDatabases.push(database);
    const logger = new MqttInteractionLogger(
      new InteractionRepository(database),
      createEspTopicSet(true),
    );

    await logger.logAnnouncement({
      announcement: {
        id: "A1",
        name: "One",
        freq: 5_000,
        res: 8,
        status: "online",
        version: "4.0.0",
        scheduleHash: "0",
      },
      receivedAtMs: 100,
      payloadBytes: 50,
    });
    await logger.logDiscoverySkipped(200);
    await logger.logPersistentOperation({
      occurredAtMs: 300,
      deviceId: "A1",
      correlationId: "wire-pwm",
      operationId: "pwm-operation",
      request: { kind: "set_pwm", pin: 4, value: 128, overwrite: false },
      outcome: "succeeded",
      durationMs: 10,
      commandBytes: 12,
      priority: "background",
    });
    await logger.logPersistentOperation({
      occurredAtMs: 400,
      deviceId: "A1",
      correlationId: "wire-ping",
      operationId: "ping-operation",
      request: { kind: "ping" },
      outcome: "succeeded",
      durationMs: 10,
      commandBytes: 4,
      priority: "interactive",
    });
    await logger.logPersistentOperation({
      occurredAtMs: 500,
      deviceId: "A1",
      correlationId: "wire-unknown",
      operationId: "unknown-operation",
      request: { kind: "set_pwm", pin: 4, value: 0, overwrite: false },
      outcome: "outcome_unknown",
      durationMs: 10,
      commandBytes: 10,
      priority: "background",
    });
    await logger.logTransportInteraction({
      kind: "batch_published",
      operationId: "wire-batch",
      requestId: "session-request-1",
      targetId: "A1",
      batchIndex: 0,
      payloadBytes: 4,
      atMs: 600,
    });
    await logger.logTransportInteraction({
      kind: "command_outcome",
      operationId: "wire-success",
      outcome: {
        index: 0,
        command: "A1 p",
        targetId: "A1",
        status: "succeeded",
        response: "o",
        analogValue: null,
      },
      atMs: 700,
    });
    await logger.logTransportInteraction({
      kind: "command_outcome",
      operationId: "wire-failed",
      outcome: {
        index: 0,
        command: "A1 p",
        targetId: "A1",
        status: "failed",
        response: "E: Invalid command",
        expectedResponse: { kind: "exact", value: "o" },
      },
      atMs: 800,
    });

    const rows = await database
      .selectFrom("interactions")
      .select(["kind", "severity", "outcome", "retention_class"])
      .orderBy("occurred_at_ms")
      .execute();
    expect(rows).toEqual([
      {
        kind: "mqtt.device-operation",
        severity: "info",
        outcome: "succeeded",
        retention_class: "audit",
      },
      {
        kind: "mqtt.device-operation",
        severity: "error",
        outcome: "outcome_unknown",
        retention_class: "critical",
      },
      {
        kind: "mqtt.command-response",
        severity: "error",
        outcome: "failed",
        retention_class: "critical",
      },
    ]);
    const reportedError = await database
      .selectFrom("interactions")
      .select("payload_json")
      .where("kind", "=", "mqtt.command-response")
      .executeTakeFirstOrThrow();
    expect(JSON.parse(reportedError.payload_json ?? "null")).toMatchObject({
      deviceReportedError: "Invalid command",
      payloadStored: false,
    });
    await expect(
      database
        .selectFrom("interactions")
        .select(({ fn }) => fn.countAll<number>().as("count"))
        .where("severity", "=", "debug")
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ count: 0 });
  });

  it("logs each active and resolved firmware diagnostic sequence once", async () => {
    const database = await openEventsDatabase({ filename: ":memory:" });
    openDatabases.push(database);
    const logger = new MqttInteractionLogger(
      new InteractionRepository(database),
      createEspTopicSet(true),
    );
    const baseAnnouncement = {
      id: "A1",
      name: "One",
      freq: 5_000,
      res: 8,
      status: "online",
      version: "4.1.0",
      scheduleHash: "0",
    } as const;
    const activeDiagnostic = {
      code: "schedule_pin_attach_failed",
      severity: "warning" as const,
      message: "Could not attach schedule pin 4",
      sequence: 1,
      active: true,
      at: 1_752_192_000,
    };

    for (const receivedAtMs of [100, 200]) {
      await logger.logAnnouncement({
        announcement: {
          ...baseAnnouncement,
          lastError: activeDiagnostic,
        },
        receivedAtMs,
        payloadBytes: 100,
      });
    }
    for (const receivedAtMs of [300, 400]) {
      await logger.logAnnouncement({
        announcement: {
          ...baseAnnouncement,
          lastError: {
            ...activeDiagnostic,
            sequence: 2,
            active: false,
          },
        },
        receivedAtMs,
        payloadBytes: 100,
      });
    }

    const diagnostics = await database
      .selectFrom("interactions")
      .select(["outcome", "payload_json"])
      .where("kind", "=", "mqtt.device-diagnostic")
      .orderBy("occurred_at_ms")
      .execute();
    expect(diagnostics.map(({ outcome }) => outcome)).toEqual([
      "failed",
      "succeeded",
    ]);
    expect(
      diagnostics.map(({ payload_json: payloadJson }) => {
        if (payloadJson === null) {
          throw new Error("Expected device diagnostic payload JSON.");
        }
        return JSON.parse(payloadJson);
      }),
    ).toMatchObject([{ active: true }, { active: false }]);
  });

  it("durably logs terminal OTA telemetry without duplicating announcements", async () => {
    const database = await openEventsDatabase({ filename: ":memory:" });
    openDatabases.push(database);
    const logger = new MqttInteractionLogger(
      new InteractionRepository(database),
      createEspTopicSet(true),
    );
    const announcement = {
      id: "A1",
      name: "One",
      freq: 5_000,
      res: 8,
      status: "online",
      version: "5.0.6",
      scheduleHash: "0",
      ota: {
        status: "failed" as const,
        targetVersion: "5.0.6",
        progress: 0,
        error: "sha256_mismatch",
      },
    };

    await Promise.all(
      [100, 200].map((receivedAtMs) =>
        logger.logAnnouncement({
          announcement,
          receivedAtMs,
          payloadBytes: 120,
        }),
      ),
    );

    const rows = await database
      .selectFrom("interactions")
      .select([
        "kind",
        "severity",
        "outcome",
        "retention_class",
        "payload_json",
      ])
      .where("kind", "=", "mqtt.device-ota-status")
      .execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      kind: "mqtt.device-ota-status",
      severity: "error",
      outcome: "failed",
      retention_class: "critical",
    });
    expect(JSON.parse(rows[0]?.payload_json ?? "null")).toEqual({
      status: "failed",
      targetVersion: "5.0.6",
      progress: 0,
      error: "sha256_mismatch",
    });
  });
});
