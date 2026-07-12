import { afterEach, describe, expect, it } from "vitest";

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
  it("replays sequential commits before stream-ready and then delivers live commits", async () => {
    const databases = await createDatabases();
    const first = await createEvent(databases, 1);
    const second = await createEvent(databases, 2);
    const sink = new RecordingSink();
    const hub = new StateEventStreamHub(databases.state);

    const connection = await hub.open(sink, {
      afterRevision: 0,
      now: () => new Date("2026-07-10T20:00:00.000Z"),
    });

    expect(sink.frames.map(frameKind)).toEqual([
      "revision:1",
      "revision:2",
      "system.stream-ready",
    ]);
    expect(connection.currentRevision).toBe(2);
    expect(hub.connectionCount).toBe(1);

    const third = await createEvent(databases, 3);
    hub.publishCommitted(third);
    expect(sink.frames.map(frameKind).at(-1)).toBe("revision:3");
    hub.publishCommitted(second);
    expect(sink.frames.filter((frame) => frame.includes("id: 2"))).toHaveLength(
      1,
    );

    connection.close();
    expect(sink.closeCount).toBe(1);
    expect(hub.connectionCount).toBe(0);
    expect(first.revision).toBe(1);
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
      entityType: "test-entity",
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

function frameKind(frame: string): string {
  const id = /^id: (\d+)/m.exec(frame)?.[1];
  if (id !== undefined) {
    return `revision:${id}`;
  }
  const type = /"type":"([^"]+)"/.exec(frame)?.[1];
  return type ?? "unknown";
}
