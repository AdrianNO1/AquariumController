import { afterEach, describe, expect, it } from "vitest";

import {
  closeControllerDatabases,
  commitStateChange,
  mirrorPendingStateEvents,
  openControllerDatabases,
  readCurrentStateRevision,
  StateEventMirrorConflictError,
  type ControllerDatabases,
  type StateChangeEvent,
} from "./index.js";

const openDatabases: ControllerDatabases[] = [];

async function createDatabases(): Promise<ControllerDatabases> {
  const databases = await openControllerDatabases({
    state: { filename: ":memory:" },
    events: { filename: ":memory:" },
  });
  openDatabases.push(databases);
  return databases;
}

function createEvent(
  overrides: Partial<StateChangeEvent> = {},
): StateChangeEvent {
  return {
    actor: "test-suite",
    mutationType: "throttle.create",
    summary: "Create the blue-channel throttle",
    eventType: "configuration.throttle-created",
    entityType: "throttle",
    entityId: "throttle-blue",
    occurredAtMs: 10,
    retentionClass: "audit",
    payloadJson: '{"id":"throttle-blue","label":"Blå"}',
    payloadSchemaVersion: 1,
    ...overrides,
  };
}

afterEach(async () => {
  await Promise.all(openDatabases.splice(0).map(closeControllerDatabases));
});

describe("state revision and outbox commits", () => {
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
      payload_json: '{"id":"throttle-blue","label":"Blå"}',
      payload_schema_version: 1,
      byte_count: new TextEncoder().encode(
        '{"id":"throttle-blue","label":"Blå"}',
      ).byteLength,
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
});
