import { afterEach, describe, expect, it } from "vitest";
import { sql } from "kysely";

import { buildApp } from "../app.js";
import {
  closeControllerDatabases,
  commitStateChange,
  openControllerDatabases,
  type ControllerDatabases,
  type StoredStateOutboxEvent,
} from "../infrastructure/database/index.js";
import {
  StateEventStreamHub,
  type StateEventStreamSink,
} from "./state-event-stream.js";

const openDatabases: ControllerDatabases[] = [];

afterEach(async () => {
  await Promise.all(openDatabases.splice(0).map(closeControllerDatabases));
});

describe("state event stream replay", () => {
  it("replays exactly the configured cap before stream-ready and then delivers live commits", async () => {
    const databases = await createDatabases();
    const first = await createEvent(databases, 1);
    const second = await createEvent(databases, 2);
    const third = await createEvent(databases, 3);
    const sink = new RecordingSink();
    const hub = new StateEventStreamHub(databases.state, {
      maxReplayEvents: 2,
    });

    const connection = await hub.open(sink, {
      afterRevision: 1,
      now: () => new Date("2026-07-10T20:00:00.000Z"),
    });

    expect(sink.frames.map(frameKind)).toEqual([
      "revision:2",
      "revision:3",
      "system.stream-ready",
    ]);
    expect(sink.frames[0]).toContain(
      '"invalidations":[{"resource":"channel","id":"2"}]',
    );
    expect(sink.frames[0]).not.toContain('"number"');
    expect(connection.currentRevision).toBe(3);
    expect(hub.connectionCount).toBe(1);

    const fourth = await createEvent(databases, 4);
    hub.publishCommitted(fourth);
    expect(sink.frames.map(frameKind).at(-1)).toBe("revision:4");
    hub.publishCommitted(third);
    expect(sink.frames.filter((frame) => frame.includes("id: 3"))).toHaveLength(
      1,
    );

    connection.close();
    expect(sink.closeCount).toBe(1);
    expect(hub.connectionCount).toBe(0);
    expect(first.revision).toBe(1);
    expect(second.revision).toBe(2);
  });

  it("isolates a failing sink and closes every stream during app shutdown", async () => {
    const databases = await createDatabases();
    const connectionErrors: Error[] = [];
    const hub = new StateEventStreamHub(databases.state, {
      onConnectionError: (error) => {
        connectionErrors.push(error);
        throw new Error("simulated error observer failure");
      },
    });
    const failingSink = new ThrowingLiveSink();
    const healthySink = new RecordingSink();
    await hub.open(failingSink, {
      afterRevision: 0,
      now: () => new Date("2026-07-10T20:00:00.000Z"),
    });
    await hub.open(healthySink, {
      afterRevision: 0,
      now: () => new Date("2026-07-10T20:00:00.000Z"),
    });
    const event = await createEvent(databases, 1);

    expect(() => hub.publishCommitted(event)).not.toThrow();
    expect(connectionErrors.map((error) => error.message)).toEqual([
      "simulated closed stream",
    ]);
    expect(failingSink.closeCount).toBe(1);
    expect(healthySink.frames.map(frameKind)).toContain("revision:1");
    expect(hub.connectionCount).toBe(1);

    const app = buildApp({ eventStreamHub: hub });
    await app.ready();
    await app.close();

    expect(healthySink.closeCount).toBe(1);
    expect(hub.connectionCount).toBe(0);
  });

  it("forces resync without replaying a partial prefix at cap plus one", async () => {
    const databases = await createDatabases();
    await createEvent(databases, 1);
    await createEvent(databases, 2);
    await createEvent(databases, 3);
    const sink = new RecordingSink();
    const hub = new StateEventStreamHub(databases.state, {
      maxReplayEvents: 2,
    });

    const connection = await hub.open(sink, {
      afterRevision: 0,
      now: () => new Date("2026-07-10T20:00:00.000Z"),
    });

    expect(connection.closed).toBe(true);
    expect(connection.currentRevision).toBe(0);
    expect(hub.connectionCount).toBe(0);
    expect(sink.closeCount).toBe(1);
    expect(sink.frames).toHaveLength(1);
    expect(frameKind(sink.frames[0] ?? "")).toBe("system.resync-required");
    expect(sink.frames[0]).toContain('"requestedRevision":0');
    expect(sink.frames[0]).toContain('"earliestAvailableRevision":1');
    expect(sink.frames[0]).toContain('"currentRevision":3');
    expect(sink.frames[0]).toContain("bounded event limit");
    expect(sink.frames[0]).not.toContain("id:");
  });

  it("bounds the replay lookup for a very large retained backlog", async () => {
    const databases = await createDatabases();
    await seedSequentialOutboxEvents(databases, 50_000);
    const sink = new RecordingSink();
    const hub = new StateEventStreamHub(databases.state, {
      maxReplayEvents: 2,
    });

    const connection = await hub.open(sink, {
      afterRevision: 0,
      now: () => new Date("2026-07-10T20:00:00.000Z"),
    });

    expect(connection.closed).toBe(true);
    expect(sink.frames).toHaveLength(1);
    expect(frameKind(sink.frames[0] ?? "")).toBe("system.resync-required");
    expect(sink.frames[0]).toContain('"currentRevision":50000');
  });

  it("honors a replay watermark and forces resync when history is gone", async () => {
    const databases = await createDatabases();
    await createEvent(databases, 1);
    await createEvent(databases, 2);
    await createEvent(databases, 3);
    await databases.state
      .deleteFrom("state_outbox")
      .where("revision", "<", 3)
      .execute();
    const sink = new RecordingSink();
    const hub = new StateEventStreamHub(databases.state);

    const connection = await hub.open(sink, {
      afterRevision: 0,
      now: () => new Date("2026-07-10T20:00:00.000Z"),
    });

    expect(connection.closed).toBe(true);
    expect(sink.closeCount).toBe(1);
    expect(sink.frames).toHaveLength(1);
    expect(sink.frames[0]).toContain("system.resync-required");
    expect(sink.frames[0]).toContain('"earliestAvailableRevision":3');
  });

  it("preserves replay gap detection within the configured cap", async () => {
    const databases = await createDatabases();
    await createEvent(databases, 1);
    await createEvent(databases, 2);
    await createEvent(databases, 3);
    await databases.state
      .deleteFrom("state_outbox")
      .where("revision", "=", 2)
      .execute();
    const sink = new RecordingSink();
    const hub = new StateEventStreamHub(databases.state, {
      maxReplayEvents: 3,
    });

    const connection = await hub.open(sink, {
      afterRevision: 0,
      now: () => new Date("2026-07-10T20:00:00.000Z"),
    });

    expect(connection.closed).toBe(true);
    expect(connection.currentRevision).toBe(1);
    expect(sink.frames.map(frameKind)).toEqual([
      "revision:1",
      "system.resync-required",
    ]);
    expect(sink.frames.at(-1)).toContain(
      "state event gap: expected revision 2, received 3",
    );
  });

  it("detects live revision gaps instead of applying out-of-order state", async () => {
    const databases = await createDatabases();
    const sink = new RecordingSink();
    const hub = new StateEventStreamHub(databases.state);
    const connection = await hub.open(sink, {
      afterRevision: 0,
      now: () => new Date("2026-07-10T20:00:00.000Z"),
    });
    const first = await createEvent(databases, 1);
    const third = { ...first, revision: 3 };

    hub.publishCommitted(third);

    expect(connection.closed).toBe(true);
    expect(sink.frames.at(-1)).toContain("state event gap");
  });

  it("bounds a blocked client's queue and closes with resync-required", async () => {
    const databases = await createDatabases();
    await createEvent(databases, 1);
    await createEvent(databases, 2);
    const sink = new RecordingSink(false);
    const hub = new StateEventStreamHub(databases.state);

    const connection = await hub.open(sink, {
      afterRevision: 0,
      now: () => new Date("2026-07-10T20:00:00.000Z"),
      maxQueuedFrames: 1,
    });

    expect(connection.closed).toBe(true);
    expect(sink.frames.at(-1)).toContain("bounded capacity");
    expect(sink.closeCount).toBe(1);
  });

  it("emits transient heartbeats without revision identifiers", async () => {
    const databases = await createDatabases();
    const sink = new RecordingSink();
    const hub = new StateEventStreamHub(databases.state);
    const connection = await hub.open(sink, {
      afterRevision: 0,
      now: () => new Date("2026-07-10T20:00:00.000Z"),
    });

    connection.heartbeat(new Date("2026-07-10T20:00:15.000Z"));

    const heartbeat = sink.frames.at(-1);
    expect(heartbeat).toContain(": heartbeat");
    expect(heartbeat).toContain("system.heartbeat");
    expect(heartbeat).not.toContain("id:");
  });
});

class RecordingSink implements StateEventStreamSink {
  readonly frames: string[] = [];
  closeCount = 0;
  readonly #writeResult: boolean;

  constructor(writeResult = true) {
    this.#writeResult = writeResult;
  }

  write(frame: string): boolean {
    this.frames.push(frame);
    return this.#writeResult;
  }

  close(): void {
    this.closeCount += 1;
  }
}

class ThrowingLiveSink implements StateEventStreamSink {
  closeCount = 0;
  #writes = 0;

  write(): boolean {
    this.#writes += 1;
    if (this.#writes > 1) {
      throw new Error("simulated closed stream");
    }
    return true;
  }

  close(): void {
    this.closeCount += 1;
  }
}

async function createDatabases(): Promise<ControllerDatabases> {
  const databases = await openControllerDatabases({
    state: { filename: ":memory:" },
    events: { filename: ":memory:" },
  });
  openDatabases.push(databases);
  return databases;
}

async function createEvent(
  databases: ControllerDatabases,
  number: number,
): Promise<StoredStateOutboxEvent> {
  const committed = await commitStateChange(
    databases.state,
    {
      actor: "test",
      mutationType: "test.change",
      summary: `Test change ${number}`,
      eventType: "test.changed",
      entityType: "channel",
      entityId: String(number),
      occurredAtMs: number * 1_000,
      retentionClass: "audit",
      payloadJson: JSON.stringify({ number }),
      payloadSchemaVersion: 1,
    },
    async () => undefined,
  );
  return committed.outboxEvent;
}

async function seedSequentialOutboxEvents(
  databases: ControllerDatabases,
  count: number,
): Promise<void> {
  await sql`
    WITH RECURSIVE sequence(revision) AS (
      SELECT 1
      UNION ALL
      SELECT revision + 1 FROM sequence WHERE revision < ${count}
    )
    INSERT INTO state_revisions (
      revision,
      committed_at_ms,
      actor,
      mutation_type,
      summary
    )
    SELECT revision, revision, 'test', 'test.bulk', 'Bulk replay fixture'
    FROM sequence
  `.execute(databases.state);
  await sql`
    WITH RECURSIVE sequence(revision) AS (
      SELECT 1
      UNION ALL
      SELECT revision + 1 FROM sequence WHERE revision < ${count}
    )
    INSERT INTO state_outbox (
      revision,
      event_type,
      entity_type,
      entity_id,
      occurred_at_ms,
      retention_class,
      payload_json,
      payload_schema_version,
      available_at_ms,
      published_at_ms
    )
    SELECT
      revision,
      'test.changed',
      'channel',
      'bulk',
      revision,
      'audit',
      '{"schemaVersion":1,"invalidations":[{"resource":"channel","id":"bulk"}],"details":{"schemaVersion":1,"data":{}}}',
      1,
      revision,
      revision
    FROM sequence
  `.execute(databases.state);
}

function frameKind(frame: string): string {
  const id = /^id: (\d+)/m.exec(frame)?.[1];
  if (id !== undefined) {
    return `revision:${id}`;
  }
  const type = /"type":"([^"]+)"/.exec(frame)?.[1];
  return type ?? "unknown";
}
