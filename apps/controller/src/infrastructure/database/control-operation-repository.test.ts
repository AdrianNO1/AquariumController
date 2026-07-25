import { describe, expect, it } from "vitest";

import { ControlOperationRepository, openStateDatabase } from "./index.js";

describe("control operation reconciliation repository", () => {
  it("commits one audited outcome acknowledgement and treats an HTTP retry as a no-op", async () => {
    const database = await openStateDatabase({ filename: ":memory:" });
    try {
      await database
        .insertInto("devices")
        .values({
          id: "device-main",
          hardware_id: "hardware-main",
          name: "Main",
          desired_pwm_frequency_hz: 5_000,
          desired_pwm_resolution_bits: 8,
          created_at_ms: 0,
          updated_at_ms: 0,
        })
        .executeTakeFirstOrThrow();
      const repository = new ControlOperationRepository(database);
      await repository.createPending({
        id: "operation-unknown",
        deviceId: "device-main",
        requestedAtMs: 100,
        deadlineAtMs: 1_000,
        request: { kind: "ping" },
      });
      await repository.markInFlight("operation-unknown", 110);
      await repository.completeInFlight("operation-unknown", 120, {
        status: "outcome_unknown",
        wireOperationId: "wire-unknown",
        reason: "timeout",
        reconciledAtMs: null,
      });

      const first = await repository.reconcileOutcome({
        operationId: "operation-unknown",
        expectedRevision: 0,
        origin: "operator",
        reconciledAtMs: 200,
      });
      expect(first).toMatchObject({
        changed: true,
        revision: 4,
        event: {
          type: "operation.outcome-reconciled",
          retentionClass: "critical",
          entity: { type: "operation", id: "operation-unknown" },
        },
      });

      await expect(
        repository.reconcileOutcome({
          operationId: "operation-unknown",
          expectedRevision: 0,
          origin: "operator",
          reconciledAtMs: 201,
        }),
      ).resolves.toEqual({
        changed: false,
        revision: 4,
        event: null,
      });
      await expect(
        repository.reconcileOutcome({
          operationId: "operation-unknown",
          expectedRevision: 4,
          origin: "operator",
          reconciledAtMs: 202,
        }),
      ).resolves.toEqual({
        changed: false,
        revision: 4,
        event: null,
      });
      await expect(
        repository.reconcileOutcome({
          operationId: "operation-unknown",
          expectedRevision: 5,
          origin: "operator",
          reconciledAtMs: 203,
        }),
      ).rejects.toMatchObject({
        name: "DeviceOperationRevisionConflictError",
        expectedRevision: 5,
        currentRevision: 4,
      });
      await expect(
        repository.getById("operation-unknown"),
      ).resolves.toMatchObject({
        result: { status: "outcome_unknown", reconciledAtMs: 200 },
      });
      const auditRows = await database
        .selectFrom("state_revisions")
        .select(["revision", "actor", "mutation_type"])
        .where("mutation_type", "=", "operation.reconcile-outcome")
        .execute();
      expect(auditRows).toEqual([
        {
          revision: 4,
          actor: "controller-api",
          mutation_type: "operation.reconcile-outcome",
        },
      ]);
      const outboxRows = await database
        .selectFrom("state_outbox")
        .select(["revision", "event_type", "payload_json"])
        .where("event_type", "=", "operation.outcome-reconciled")
        .execute();
      expect(outboxRows).toHaveLength(1);
      expect(outboxRows[0]).toMatchObject({
        revision: 4,
        event_type: "operation.outcome-reconciled",
      });
      expect(outboxRows[0]?.payload_json).toContain('"origin":"operator"');
    } finally {
      await database.destroy();
    }
  });
});
