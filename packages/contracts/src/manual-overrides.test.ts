import { describe, expect, it } from "vitest";

import {
  manualOverrideCommandResponseSchema,
  startManualOverrideRequestSchema,
} from "./manual-overrides.js";

describe("manual override contracts", () => {
  it("accepts only server-timed start inputs", () => {
    expect(
      startManualOverrideRequestSchema.parse({
        expectedRevision: 7,
        target: { targetType: "channel", targetId: "channel-blue" },
        valuePercentage: 62.5,
      }),
    ).toEqual({
      expectedRevision: 7,
      target: { targetType: "channel", targetId: "channel-blue" },
      valuePercentage: 62.5,
    });

    expect(
      startManualOverrideRequestSchema.safeParse({
        expectedRevision: 7,
        target: { targetType: "channel", targetId: "channel-blue" },
        valuePercentage: 62.5,
        expiresAt: "2026-07-13T12:00:00.000Z",
      }).success,
    ).toBe(false);
  });

  it("requires the returned override to reference its coordinator operation", () => {
    const mutation = {
      changed: true as const,
      revision: 8,
      event: {
        revision: 8,
        type: "override.pending",
        occurredAt: "2026-07-13T10:00:00.000Z",
        entity: { type: "override" as const, id: "override-blue" },
        schemaVersion: 1 as const,
        data: {
          invalidations: [
            { resource: "override" as const, id: "override-blue" },
            { resource: "operation" as const, id: "operation-start" },
          ],
        },
        retentionClass: "audit" as const,
      },
    };
    const response = {
      override: {
        id: "override-blue",
        targetType: "channel" as const,
        targetId: "channel-blue",
        valuePercentage: 62.5,
        status: "pending" as const,
        requestedAt: "2026-07-13T10:00:00.000Z",
        startsAt: null,
        expiresAt: "2026-07-13T10:02:00.000Z",
        completedAt: null,
        operationId: "operation-start",
      },
      operation: {
        id: "operation-start",
        deviceId: null,
        kind: "manual_override_start",
        status: "pending" as const,
        requestedAt: "2026-07-13T10:00:00.000Z",
        deadlineAt: "2026-07-13T10:00:30.000Z",
        completedAt: null,
      },
      mutation,
    };

    expect(manualOverrideCommandResponseSchema.parse(response)).toEqual(
      response,
    );
    expect(
      manualOverrideCommandResponseSchema.safeParse({
        ...response,
        operation: { ...response.operation, id: "operation-other" },
      }).success,
    ).toBe(false);
  });
});
