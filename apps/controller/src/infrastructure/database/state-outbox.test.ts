import { afterEach, describe, expect, it } from "vitest";

import {
  closeControllerDatabases,
  commitConditionalStateChange,
  commitStateChange,
  mirrorPendingStateEvents,
  openControllerDatabases,
  parseStoredStateOutboxEnvelope,
  readCurrentStateRevision,
  StateEventMirrorConflictError,
  toCommittedStateEvent,
  type ControllerDatabases,
  type OperatorConcurrencyGuard,
  type StateChangeEvent,
} from "./index.js";

const openDatabases: ControllerDatabases[] = [];

async function createDatabases(): Promise<ControllerDatabases> {
  const databases = await openControllerDatabases({
    state: { filename: ":memory:" },
    events: { filename: ":memory:" },
  });
  await databases.state.deleteFrom("throttles").execute();
  openDatabases.push(databases);
  return databases;
}

function createEvent(
  overrides: Partial<Omit<StateChangeEvent, "entityType" | "entityId">> = {},
): StateChangeEvent {
  return {
    actor: "test-suite",
    mutationType: "throttle.create",
    summary: "Create the blue-channel throttle",
    eventType: "configuration.throttle-created",
    occurredAtMs: 10,
    retentionClass: "audit",
    payloadJson: '{"id":"throttle-blue","label":"Blå"}',
    payloadSchemaVersion: 1,
    ...overrides,
    entityType: "throttle",
    entityId: "throttle-blue",
  };
}

class TestOperatorConflictError extends Error {
  override readonly name = "TestOperatorConflictError";

  constructor(
    readonly expectedRevision: number,
    readonly currentRevision: number,
  ) {
    super(
      `Expected operator revision ${expectedRevision}, current state revision ${currentRevision}`,
    );
  }
}

function operatorGuard(expectedRevision: number): OperatorConcurrencyGuard {
  return {
    expectedRevision,
    conflictError: (expected, current) =>
      new TestOperatorConflictError(expected, current),
  };
}

async function readOperatorFloor(
  databases: ControllerDatabases,
): Promise<number> {
  return (
    await databases.state
      .selectFrom("operator_concurrency")
      .select("last_operator_revision")
      .executeTakeFirstOrThrow()
  ).last_operator_revision;
}

afterEach(async () => {
  await Promise.all(openDatabases.splice(0).map(closeControllerDatabases));
});

describe("state revision and outbox commits", () => {
  it("does not allocate a revision or outbox row for a true no-op", async () => {
    const databases = await createDatabases();
    let eventWasBuilt = false;

    const committed = await commitConditionalStateChange(
      databases.state,
      (result) => {
        eventWasBuilt = true;
        return createEvent({ payloadJson: JSON.stringify({ id: result.id }) });
      },
      async () => ({
        changed: false as const,
        result: { id: "throttle-blue" },
      }),
    );

    expect(committed).toEqual({
      changed: false,
      revision: 0,
      result: { id: "throttle-blue" },
      outboxEvent: null,
    });
    expect(eventWasBuilt).toBe(false);
    expect(await readCurrentStateRevision(databases.state)).toBe(0);
    await expect(
      databases.state.selectFrom("state_outbox").selectAll().execute(),
    ).resolves.toEqual([]);
  });

  it("builds a result-dependent event and commits one conditional change atomically", async () => {
    const databases = await createDatabases();

    const committed = await commitConditionalStateChange<{
      readonly changed: true;
      readonly result: { readonly id: string };
    }>(
      databases.state,
      (result) =>
        createEvent({
          payloadJson: JSON.stringify({ id: result.id, percentage: 75 }),
        }),
      async (transaction) => {
        await transaction
          .insertInto("throttles")
          .values({
            id: "throttle-blue",
            type_key: "Blue",
            percentage: 75,
            created_at_ms: 10,
            updated_at_ms: 10,
          })
          .executeTakeFirstOrThrow();
        return {
          changed: true as const,
          result: { id: "throttle-blue" },
        };
      },
    );

    expect(committed).toMatchObject({
      changed: true,
      revision: 1,
      result: { id: "throttle-blue" },
      outboxEvent: { revision: 1 },
    });
    if (!committed.changed) {
      throw new Error("Conditional test mutation unexpectedly became a no-op");
    }
    expect(
      parseStoredStateOutboxEnvelope(committed.outboxEvent).details.data,
    ).toEqual({ id: "throttle-blue", percentage: 75 });
    await expect(
      databases.state
        .selectFrom("state_outbox")
        .select(({ fn }) => fn.countAll<number>().as("count"))
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ count: 1 });
  });

  it("accepts a snapshot revision after background commits and advances the operator floor", async () => {
    const databases = await createDatabases();
    await commitStateChange(
      databases.state,
      createEvent({
        mutationType: "operation.succeeded",
        summary: "Completed background operation",
        eventType: "operation.succeeded",
      }),
      async () => undefined,
    );

    const committed = await commitConditionalStateChange(
      databases.state,
      createEvent({ occurredAtMs: 11 }),
      async (transaction) => {
        await transaction
          .insertInto("throttles")
          .values({
            id: "throttle-blue",
            type_key: "Blue",
            percentage: 75,
            created_at_ms: 11,
            updated_at_ms: 11,
          })
          .executeTakeFirstOrThrow();
        return { changed: true as const, result: "throttle-blue" };
      },
      undefined,
      operatorGuard(0),
    );

    expect(committed).toMatchObject({ changed: true, revision: 2 });
    expect(await readOperatorFloor(databases)).toBe(2);
  });

  it("does not advance the operator floor for a guarded no-op", async () => {
    const databases = await createDatabases();
    await commitStateChange(
      databases.state,
      createEvent({
        mutationType: "device.announcement",
        summary: "Background device announcement",
        eventType: "device.announcement",
      }),
      async () => undefined,
    );

    await expect(
      commitConditionalStateChange(
        databases.state,
        createEvent({ occurredAtMs: 11 }),
        async () => ({ changed: false as const, result: "unchanged" }),
        undefined,
        operatorGuard(0),
      ),
    ).resolves.toMatchObject({ changed: false, revision: 1 });
    expect(await readOperatorFloor(databases)).toBe(0);
  });

  it("serializes simultaneous operator requests using the same snapshot token", async () => {
    const databases = await createDatabases();
    const mutate = (id: string) =>
      commitConditionalStateChange(
        databases.state,
        { ...createEvent(), entityType: "throttle", entityId: id },
        async (transaction) => {
          await transaction
            .insertInto("throttles")
            .values({
              id,
              type_key: id,
              percentage: 50,
              created_at_ms: 10,
              updated_at_ms: 10,
            })
            .executeTakeFirstOrThrow();
          return { changed: true as const, result: id };
        },
        undefined,
        operatorGuard(0),
      );

    const results = await Promise.allSettled([
      mutate("throttle-one"),
      mutate("throttle-two"),
    ]);
    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(
      1,
    );
    const rejection = results.find(({ status }) => status === "rejected");
    expect(rejection).toMatchObject({
      status: "rejected",
      reason: expect.objectContaining({
        expectedRevision: 0,
        currentRevision: 1,
      }),
    });
    await expect(
      databases.state
        .selectFrom("throttles")
        .select(({ fn }) => fn.countAll<number>().as("count"))
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ count: 1 });
    expect(await readOperatorFloor(databases)).toBe(1);
  });

  it("rejects future snapshot revisions before running the mutation", async () => {
    const databases = await createDatabases();
    let mutationRan = false;

    await expect(
      commitConditionalStateChange(
        databases.state,
        createEvent(),
        async () => {
          mutationRan = true;
          return { changed: true as const, result: "invalid" };
        },
        undefined,
        operatorGuard(1),
      ),
    ).rejects.toMatchObject({
      expectedRevision: 1,
      currentRevision: 0,
    });
    expect(mutationRan).toBe(false);
    expect(await readOperatorFloor(databases)).toBe(0);
  });

  it("commits the mutation, monotonic revision, and durable event atomically", async () => {
    const databases = await createDatabases();
    expect(await readCurrentStateRevision(databases.state)).toBe(0);

    const first = await commitStateChange(
      databases.state,
      createEvent(),
      async (transaction) => {
        await transaction
          .insertInto("throttles")
          .values({
            id: "throttle-blue",
            type_key: "Blue",
            percentage: 75,
            created_at_ms: 10,
            updated_at_ms: 10,
          })
          .executeTakeFirstOrThrow();
        return "created" as const;
      },
    );
    const second = await commitStateChange(
      databases.state,
      createEvent({
        mutationType: "throttle.update",
        summary: "Update the blue-channel throttle",
        eventType: "configuration.throttle-updated",
        occurredAtMs: 11,
        payloadJson: '{"id":"throttle-blue","percentage":80}',
      }),
      async (transaction) => {
        await transaction
          .updateTable("throttles")
          .set({ percentage: 80, updated_at_ms: 11 })
          .where("id", "=", "throttle-blue")
          .executeTakeFirstOrThrow();
        return "updated" as const;
      },
    );

    expect(first).toMatchObject({
      revision: 1,
      result: "created",
      outboxEvent: {
        revision: 1,
        retention_class: "audit",
        delivery_attempts: 0,
        published_at_ms: null,
      },
    });
    expect(second.revision).toBe(2);
    expect(await readCurrentStateRevision(databases.state)).toBe(2);
    await expect(
      databases.state
        .selectFrom("throttles")
        .select("percentage")
        .where("id", "=", "throttle-blue")
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ percentage: 80 });
    await expect(
      databases.state
        .selectFrom("state_outbox")
        .select("revision")
        .orderBy("revision")
        .execute(),
    ).resolves.toEqual([{ revision: 1 }, { revision: 2 }]);
  });

  it("rolls back state, revision, and outbox together when the mutation fails", async () => {
    const databases = await createDatabases();

    await expect(
      commitStateChange(databases.state, createEvent(), async (transaction) => {
        await transaction
          .insertInto("throttles")
          .values({
            id: "throttle-blue",
            type_key: "Blue",
            percentage: 75,
            created_at_ms: 10,
            updated_at_ms: 10,
          })
          .executeTakeFirstOrThrow();
        throw new Error("stop the commit");
      }),
    ).rejects.toThrow("stop the commit");

    expect(await readCurrentStateRevision(databases.state)).toBe(0);
    await expect(
      databases.state.selectFrom("throttles").selectAll().execute(),
    ).resolves.toEqual([]);
    await expect(
      databases.state.selectFrom("state_outbox").selectAll().execute(),
    ).resolves.toEqual([]);
  });

  it("rejects malformed event data before entering the state transaction", async () => {
    const databases = await createDatabases();
    let mutationWasCalled = false;

    await expect(
      commitStateChange(
        databases.state,
        createEvent({ payloadJson: "not-json" }),
        async () => {
          mutationWasCalled = true;
        },
      ),
    ).rejects.toThrow("payloadJson must contain valid JSON");

    expect(mutationWasCalled).toBe(false);
    expect(await readCurrentStateRevision(databases.state)).toBe(0);
  });

  it("persists one replayable invalidation envelope for multi-entity changes", async () => {
    const databases = await createDatabases();
    const committed = await commitStateChange(
      databases.state,
      createEvent({
        invalidations: [
          { resource: "throttle", id: "throttle-blue" },
          { resource: "schedule", id: "schedule-blue" },
        ],
      }),
      async () => undefined,
    );

    expect(toCommittedStateEvent(committed.outboxEvent)).toMatchObject({
      revision: committed.revision,
      entity: { type: "throttle", id: "throttle-blue" },
      data: {
        invalidations: [
          { resource: "throttle", id: "throttle-blue" },
          { resource: "schedule", id: "schedule-blue" },
        ],
      },
    });
    expect(
      parseStoredStateOutboxEnvelope(committed.outboxEvent).details,
    ).toEqual({
      schemaVersion: 1,
      data: { id: "throttle-blue", label: "Blå" },
    });
  });
});

describe("state outbox mirror", () => {
  it("mirrors a due event once and marks its outbox delivery", async () => {
    const databases = await createDatabases();
    const committed = await commitStateChange(
      databases.state,
      createEvent(),
      async () => "created" as const,
    );

    await expect(
      mirrorPendingStateEvents(databases.state, databases.events, {
        nowMs: 20,
      }),
    ).resolves.toEqual({ mirroredRevisions: [committed.revision] });
    const mirrored = await databases.events
      .selectFrom("state_events")
      .selectAll()
      .executeTakeFirstOrThrow();
    expect(mirrored).toEqual({
      revision: committed.revision,
      occurred_at_ms: 10,
      event_type: "configuration.throttle-created",
      entity_type: "throttle",
      entity_id: "throttle-blue",
      retention_class: "audit",
      payload_json: committed.outboxEvent.payload_json,
      payload_schema_version: 1,
      byte_count: new TextEncoder().encode(committed.outboxEvent.payload_json)
        .byteLength,
    });
    expect(parseStoredStateOutboxEnvelope(committed.outboxEvent)).toEqual({
      schemaVersion: 1,
      invalidations: [{ resource: "throttle", id: "throttle-blue" }],
      details: {
        schemaVersion: 1,
        data: { id: "throttle-blue", label: "Blå" },
      },
    });
    await expect(
      databases.state
        .selectFrom("state_outbox")
        .select(["delivery_attempts", "published_at_ms", "last_error"])
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({
      delivery_attempts: 1,
      published_at_ms: 20,
      last_error: null,
    });

    await expect(
      mirrorPendingStateEvents(databases.state, databases.events, {
        nowMs: 30,
      }),
    ).resolves.toEqual({ mirroredRevisions: [] });
    expect(await readCurrentStateRevision(databases.state)).toBe(1);
  });

  it("recovers idempotently when the event insert committed before publication", async () => {
    const databases = await createDatabases();
    const committed = await commitStateChange(
      databases.state,
      createEvent(),
      async () => undefined,
    );
    const outboxEvent = committed.outboxEvent;
    await databases.events
      .insertInto("state_events")
      .values({
        revision: outboxEvent.revision,
        occurred_at_ms: outboxEvent.occurred_at_ms,
        event_type: outboxEvent.event_type,
        entity_type: outboxEvent.entity_type,
        entity_id: outboxEvent.entity_id,
        retention_class: outboxEvent.retention_class,
        payload_json: outboxEvent.payload_json,
        payload_schema_version: outboxEvent.payload_schema_version,
        byte_count: new TextEncoder().encode(outboxEvent.payload_json)
          .byteLength,
      })
      .executeTakeFirstOrThrow();

    await expect(
      mirrorPendingStateEvents(databases.state, databases.events, {
        nowMs: 20,
      }),
    ).resolves.toEqual({ mirroredRevisions: [committed.revision] });
    await expect(
      databases.events
        .selectFrom("state_events")
        .select(({ fn }) => fn.countAll<number>().as("count"))
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ count: 1 });
    await expect(
      databases.state
        .selectFrom("state_outbox")
        .select(["delivery_attempts", "published_at_ms"])
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ delivery_attempts: 1, published_at_ms: 20 });
  });

  it("fails loudly on a conflicting revision and records a delayed retry", async () => {
    const databases = await createDatabases();
    const committed = await commitStateChange(
      databases.state,
      createEvent(),
      async () => undefined,
    );
    await databases.events
      .insertInto("state_events")
      .values({
        revision: committed.revision,
        occurred_at_ms: 10,
        event_type: "configuration.throttle-created",
        entity_type: "throttle",
        entity_id: "throttle-blue",
        retention_class: "audit",
        payload_json: '{"id":"different"}',
        payload_schema_version: 1,
        byte_count: new TextEncoder().encode('{"id":"different"}').byteLength,
      })
      .executeTakeFirstOrThrow();

    await expect(
      mirrorPendingStateEvents(databases.state, databases.events, {
        nowMs: 20,
        retryDelayMs: 5,
      }),
    ).rejects.toBeInstanceOf(StateEventMirrorConflictError);
    const outboxState = await databases.state
      .selectFrom("state_outbox")
      .select([
        "delivery_attempts",
        "available_at_ms",
        "published_at_ms",
        "last_error",
      ])
      .executeTakeFirstOrThrow();
    expect(outboxState).toMatchObject({
      delivery_attempts: 1,
      available_at_ms: 25,
      published_at_ms: null,
    });
    expect(outboxState.last_error).toContain("payload_json");

    await expect(
      mirrorPendingStateEvents(databases.state, databases.events, {
        nowMs: 24,
      }),
    ).resolves.toEqual({ mirroredRevisions: [] });
  });

  it("honours availability and batch bounds without consuming revisions", async () => {
    const databases = await createDatabases();
    await commitStateChange(
      databases.state,
      createEvent({ availableAtMs: 100 }),
      async () => undefined,
    );

    await expect(
      mirrorPendingStateEvents(databases.state, databases.events, {
        nowMs: 99,
      }),
    ).resolves.toEqual({ mirroredRevisions: [] });
    expect(await readCurrentStateRevision(databases.state)).toBe(1);
    await expect(
      mirrorPendingStateEvents(databases.state, databases.events, {
        nowMs: 100,
        batchSize: 0,
      }),
    ).rejects.toThrow("batchSize must be an integer between 1 and 1000");
  });

  it("does not mirror a later revision while the oldest unpublished revision is delayed", async () => {
    const databases = await createDatabases();
    const first = await commitStateChange(
      databases.state,
      createEvent({ availableAtMs: 100 }),
      async () => undefined,
    );
    const second = await commitStateChange(
      databases.state,
      createEvent({ occurredAtMs: 11 }),
      async () => undefined,
    );

    await expect(
      mirrorPendingStateEvents(databases.state, databases.events, {
        nowMs: 20,
      }),
    ).resolves.toEqual({ mirroredRevisions: [] });
    await expect(
      databases.events.selectFrom("state_events").selectAll().execute(),
    ).resolves.toEqual([]);

    await expect(
      mirrorPendingStateEvents(databases.state, databases.events, {
        nowMs: 100,
      }),
    ).resolves.toEqual({
      mirroredRevisions: [first.revision, second.revision],
    });
  });

  it("validates the complete committed envelope before mirroring or publishing it", async () => {
    const databases = await createDatabases();
    const committed = await commitStateChange(
      databases.state,
      createEvent(),
      async () => undefined,
    );
    await databases.state
      .updateTable("state_outbox")
      .set({
        payload_json:
          '{"schemaVersion":1,"schemaVersion":1,"invalidations":[{"resource":"throttle","id":"throttle-blue"}],"details":{"schemaVersion":1,"data":{}}}',
      })
      .where("revision", "=", committed.revision)
      .executeTakeFirstOrThrow();

    await expect(
      mirrorPendingStateEvents(databases.state, databases.events, {
        nowMs: 20,
        retryDelayMs: 5,
      }),
    ).rejects.toThrow("contains duplicate JSON keys");
    await expect(
      databases.events.selectFrom("state_events").selectAll().execute(),
    ).resolves.toEqual([]);
    await expect(
      databases.state
        .selectFrom("state_outbox")
        .select(["published_at_ms", "delivery_attempts", "available_at_ms"])
        .where("revision", "=", committed.revision)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({
      published_at_ms: null,
      delivery_attempts: 1,
      available_at_ms: 25,
    });
  });
});
