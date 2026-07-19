import { afterEach, describe, expect, it } from "vitest";

import { StateEventStreamHub } from "../../realtime/state-event-stream.js";
import {
  closeControllerDatabases,
  commitStateChange,
  mirrorPendingStateEvents,
  openControllerDatabases,
  prunePublishedStateOutbox,
  type ControllerDatabases,
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

async function createRevisions(
  databases: ControllerDatabases,
  count: number,
): Promise<void> {
  for (let index = 1; index <= count; index += 1) {
    await commitStateChange(
      databases.state,
      {
        actor: "test-suite",
        mutationType: "test.change",
        summary: `Test change ${index}`,
        eventType: "test.changed",
        entityType: "channel",
        entityId: String(index),
        occurredAtMs: index,
        retentionClass: "audit",
        payloadJson: JSON.stringify({ index }),
        payloadSchemaVersion: 1,
      },
      async () => undefined,
    );
  }
}

afterEach(async () => {
  await Promise.all(openDatabases.splice(0).map(closeControllerDatabases));
});

describe("published state outbox retention", () => {
  it("prunes only mirrored revisions while retaining the configured replay tail", async () => {
    const databases = await createDatabases();
    await createRevisions(databases, 6);
    await mirrorPendingStateEvents(databases.state, databases.events, {
      nowMs: 100,
    });

    const result = await prunePublishedStateOutbox(databases.state, {
      retainRevisionCount: 2,
      maxDeleteRows: 10,
    });

    expect(result).toEqual({
      currentRevision: 6,
      earliestAvailableRevision: 5,
      deletedCount: 4,
      deletedFromRevision: 1,
      deletedThroughRevision: 4,
    });
    await expect(
      databases.state
        .selectFrom("state_outbox")
        .select("revision")
        .orderBy("revision")
        .execute(),
    ).resolves.toEqual([{ revision: 5 }, { revision: 6 }]);
    await expect(
      databases.events
        .selectFrom("state_events")
        .select("revision")
        .orderBy("revision")
        .execute(),
    ).resolves.toHaveLength(6);

    const frames: string[] = [];
    const connection = await new StateEventStreamHub(databases.state).open(
      {
        write: (frame) => {
          frames.push(frame);
          return true;
        },
        close: () => undefined,
      },
      {
        afterRevision: 0,
        now: () => new Date("2026-07-13T12:00:00.000Z"),
      },
    );
    expect(connection.closed).toBe(true);
    expect(frames.join("\n")).toContain("system.resync-required");
    expect(frames.join("\n")).toContain('"earliestAvailableRevision":5');
  });

  it("uses bounded batches without changing the retained replay boundary", async () => {
    const databases = await createDatabases();
    await createRevisions(databases, 6);
    await mirrorPendingStateEvents(databases.state, databases.events, {
      nowMs: 100,
    });

    const first = await prunePublishedStateOutbox(databases.state, {
      retainRevisionCount: 1,
      maxDeleteRows: 2,
    });
    const second = await prunePublishedStateOutbox(databases.state, {
      retainRevisionCount: 1,
      maxDeleteRows: 2,
    });
    const third = await prunePublishedStateOutbox(databases.state, {
      retainRevisionCount: 1,
      maxDeleteRows: 2,
    });

    expect(first).toMatchObject({
      deletedCount: 2,
      deletedFromRevision: 1,
      deletedThroughRevision: 2,
      earliestAvailableRevision: 3,
    });
    expect(second).toMatchObject({
      deletedCount: 2,
      deletedFromRevision: 3,
      deletedThroughRevision: 4,
      earliestAvailableRevision: 5,
    });
    expect(third).toMatchObject({
      deletedCount: 1,
      deletedFromRevision: 5,
      deletedThroughRevision: 5,
      earliestAvailableRevision: 6,
    });
  });

  it("stops before the earliest unpublished revision and never leapfrogs it", async () => {
    const databases = await createDatabases();
    await createRevisions(databases, 5);
    await databases.state
      .updateTable("state_outbox")
      .set({ available_at_ms: 1_000 })
      .where("revision", ">=", 3)
      .execute();
    await mirrorPendingStateEvents(databases.state, databases.events, {
      nowMs: 100,
    });

    const result = await prunePublishedStateOutbox(databases.state, {
      retainRevisionCount: 1,
      maxDeleteRows: 10,
    });

    expect(result).toEqual({
      currentRevision: 5,
      earliestAvailableRevision: 3,
      deletedCount: 2,
      deletedFromRevision: 1,
      deletedThroughRevision: 2,
    });
    const remaining = await databases.state
      .selectFrom("state_outbox")
      .select(["revision", "published_at_ms"])
      .orderBy("revision")
      .execute();
    expect(remaining).toEqual([
      { revision: 3, published_at_ms: null },
      { revision: 4, published_at_ms: null },
      { revision: 5, published_at_ms: null },
    ]);
  });

  it("is a no-op for an empty database and rejects unsafe bounds", async () => {
    const databases = await createDatabases();

    await expect(prunePublishedStateOutbox(databases.state)).resolves.toEqual({
      currentRevision: 0,
      earliestAvailableRevision: 0,
      deletedCount: 0,
      deletedFromRevision: null,
      deletedThroughRevision: null,
    });
    await expect(
      prunePublishedStateOutbox(databases.state, { retainRevisionCount: 0 }),
    ).rejects.toThrow("retainRevisionCount");
    await expect(
      prunePublishedStateOutbox(databases.state, { maxDeleteRows: 10_001 }),
    ).rejects.toThrow("maxDeleteRows");
  });
});
