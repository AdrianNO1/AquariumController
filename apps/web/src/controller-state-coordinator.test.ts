import type {
  ControllerSnapshot,
  ControllerStreamEvent,
} from "@aquarium/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  ControllerStateCoordinator,
  type ControllerEventStream,
  type ControllerEventStreamHandlers,
} from "./controller-state-coordinator.js";
import { createTestControllerSnapshot } from "./test-controller-snapshot.js";
import { createTestControlSnapshot } from "./test-control-snapshot.js";

const occurredAt = "2026-07-13T10:00:00.000Z";

class FakeEventStream implements ControllerEventStream {
  #handlers: ControllerEventStreamHandlers | null = null;
  closed = false;

  listen(handlers: ControllerEventStreamHandlers): void {
    if (this.#handlers !== null) {
      throw new Error("Fake event stream already has listeners");
    }
    this.#handlers = handlers;
  }

  close(): void {
    this.closed = true;
  }

  emitOpen(): void {
    this.#getHandlers().open();
  }

  emit(event: ControllerStreamEvent): void {
    this.#getHandlers().message(JSON.stringify(event));
  }

  emitRaw(data: string): void {
    this.#getHandlers().message(data);
  }

  emitError(): void {
    this.#getHandlers().error();
  }

  #getHandlers(): ControllerEventStreamHandlers {
    if (this.#handlers === null) {
      throw new Error("Fake event stream has no listeners");
    }
    return this.#handlers;
  }
}

interface Deferred<Value> {
  readonly promise: Promise<Value>;
  readonly resolve: (value: Value) => void;
}

function deferred<Value>(): Deferred<Value> {
  let resolvePromise: ((value: Value) => void) | null = null;
  const promise = new Promise<Value>((resolve) => {
    resolvePromise = resolve;
  });
  return {
    promise,
    resolve: (value) => {
      if (resolvePromise === null) {
        throw new Error("Deferred promise was not initialized");
      }
      resolvePromise(value);
    },
  };
}

function committedEvent(revision: number): ControllerStreamEvent {
  return {
    revision,
    type: "channel.updated",
    occurredAt,
    entity: { type: "channel", id: "channel-1" },
    schemaVersion: 1,
    data: {
      invalidations: [{ resource: "channel", id: "channel-1" }],
    },
    retentionClass: "audit",
  };
}

function streamReady(currentRevision: number): ControllerStreamEvent {
  return {
    type: "system.stream-ready",
    occurredAt,
    data: { currentRevision, replayedCount: 0 },
  };
}

function heartbeat(currentRevision: number): ControllerStreamEvent {
  return {
    type: "system.heartbeat",
    occurredAt,
    data: { currentRevision, serverNow: occurredAt },
  };
}

function resyncRequired(currentRevision: number): ControllerStreamEvent {
  return {
    type: "system.resync-required",
    occurredAt,
    data: {
      requestedRevision: 5,
      earliestAvailableRevision: currentRevision,
      currentRevision,
      reason: "replay window was pruned",
    },
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("ControllerStateCoordinator", () => {
  it("hydrates a typed snapshot before opening one revision-bound stream", async () => {
    const streams: FakeEventStream[] = [];
    const urls: string[] = [];
    const fetchSnapshot = vi.fn(async () => createTestControllerSnapshot(5));
    const coordinator = new ControllerStateCoordinator({
      fetchSnapshot,
      createEventStream: (url) => {
        urls.push(url);
        const stream = new FakeEventStream();
        streams.push(stream);
        return stream;
      },
      now: () => new Date(occurredAt),
    });

    coordinator.start();
    expect(coordinator.getState()).toMatchObject({
      status: "loading",
      snapshot: null,
      isRefreshing: true,
    });
    await vi.waitFor(() => expect(streams).toHaveLength(1));

    expect(urls).toEqual(["/api/events?afterRevision=5"]);
    expect(coordinator.getState()).toMatchObject({
      status: "reconnecting",
      revision: 5,
      dataStale: false,
      isRefreshing: false,
    });
    streams[0]?.emitOpen();
    streams[0]?.emit(streamReady(5));
    expect(coordinator.getState()).toMatchObject({
      status: "connected",
      revision: 5,
      lastMessageAt: occurredAt,
      error: null,
    });
    expect(fetchSnapshot).toHaveBeenCalledTimes(1);

    coordinator.stop();
    expect(streams[0]?.closed).toBe(true);
  });

  it("coalesces contiguous replay events into one snapshot refresh and ignores duplicates", async () => {
    const snapshots = [
      createTestControllerSnapshot(5),
      createTestControllerSnapshot(7),
    ];
    const streams: FakeEventStream[] = [];
    const fetchSnapshot = vi.fn(async () => {
      const snapshot = snapshots.shift();
      if (snapshot === undefined) {
        throw new Error("Unexpected snapshot request");
      }
      return snapshot;
    });
    const coordinator = new ControllerStateCoordinator({
      fetchSnapshot,
      createEventStream: () => {
        const stream = new FakeEventStream();
        streams.push(stream);
        return stream;
      },
    });

    coordinator.start();
    await vi.waitFor(() => expect(streams).toHaveLength(1));
    const stream = streams[0];
    stream?.emit(committedEvent(6));
    stream?.emit(committedEvent(7));
    expect(fetchSnapshot).toHaveBeenCalledTimes(1);
    expect(coordinator.getState()).toMatchObject({
      revision: 7,
      dataStale: true,
    });

    stream?.emit(streamReady(7));
    await vi.waitFor(() =>
      expect(coordinator.getState().snapshot?.revision).toBe(7),
    );
    expect(fetchSnapshot).toHaveBeenCalledTimes(2);
    expect(coordinator.getState()).toMatchObject({
      status: "connected",
      dataStale: false,
    });

    stream?.emit(committedEvent(7));
    stream?.emit(committedEvent(6));
    expect(fetchSnapshot).toHaveBeenCalledTimes(2);
    coordinator.stop();
  });

  it("applies live device contact from the stream without fetching a snapshot", async () => {
    const snapshot = createTestControlSnapshot(5);
    const device = snapshot.devices[0];
    if (device === undefined) throw new Error("Test snapshot has no device");
    const streams: FakeEventStream[] = [];
    const fetchSnapshot = vi.fn(async () => snapshot);
    const coordinator = new ControllerStateCoordinator({
      fetchSnapshot,
      createEventStream: () => {
        const stream = new FakeEventStream();
        streams.push(stream);
        return stream;
      },
    });

    coordinator.start();
    await vi.waitFor(() => expect(streams).toHaveLength(1));
    streams[0]?.emit(streamReady(5));
    const contactAt = "2026-07-13T10:00:05.000Z";
    streams[0]?.emit({
      type: "device.contact",
      occurredAt: contactAt,
      data: { deviceId: device.id },
    });

    expect(
      coordinator
        .getState()
        .snapshot?.devices.find(({ id }) => id === device.id)?.lastSeenAt,
    ).toBe(contactAt);
    expect(fetchSnapshot).toHaveBeenCalledOnce();
    coordinator.stop();
  });

  it("closes a gapped stream, refreshes through the received revision, and reconnects", async () => {
    const snapshots = [
      createTestControllerSnapshot(5),
      createTestControllerSnapshot(7),
    ];
    const streams: FakeEventStream[] = [];
    const urls: string[] = [];
    const coordinator = new ControllerStateCoordinator({
      fetchSnapshot: async () => {
        const snapshot = snapshots.shift();
        if (snapshot === undefined) {
          throw new Error("Unexpected snapshot request");
        }
        return snapshot;
      },
      createEventStream: (url) => {
        urls.push(url);
        const stream = new FakeEventStream();
        streams.push(stream);
        return stream;
      },
    });

    coordinator.start();
    await vi.waitFor(() => expect(streams).toHaveLength(1));
    streams[0]?.emit(streamReady(5));
    streams[0]?.emit(committedEvent(7));

    expect(streams[0]?.closed).toBe(true);
    expect(coordinator.getState()).toMatchObject({
      status: "reconnecting",
      dataStale: true,
    });
    await vi.waitFor(() => expect(streams).toHaveLength(2));
    expect(urls).toEqual([
      "/api/events?afterRevision=5",
      "/api/events?afterRevision=7",
    ]);
    expect(coordinator.getState().snapshot?.revision).toBe(7);
    coordinator.stop();
  });

  it("honors an explicit resync-required signal", async () => {
    const snapshots = [
      createTestControllerSnapshot(5),
      createTestControllerSnapshot(9),
    ];
    const streams: FakeEventStream[] = [];
    const coordinator = new ControllerStateCoordinator({
      fetchSnapshot: async () => {
        const snapshot = snapshots.shift();
        if (snapshot === undefined) {
          throw new Error("Unexpected snapshot request");
        }
        return snapshot;
      },
      createEventStream: () => {
        const stream = new FakeEventStream();
        streams.push(stream);
        return stream;
      },
    });

    coordinator.start();
    await vi.waitFor(() => expect(streams).toHaveLength(1));
    streams[0]?.emit(streamReady(5));
    streams[0]?.emit(resyncRequired(9));

    await vi.waitFor(() => expect(streams).toHaveLength(2));
    expect(streams[0]?.closed).toBe(true);
    expect(coordinator.getState()).toMatchObject({
      status: "reconnecting",
      revision: 9,
      dataStale: false,
    });
    coordinator.stop();
  });

  it("reports reconnecting and stale states, then recovers on a current heartbeat", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(occurredAt));
    const snapshots = [
      createTestControllerSnapshot(5),
      createTestControllerSnapshot(5),
    ];
    const streams: FakeEventStream[] = [];
    const coordinator = new ControllerStateCoordinator({
      fetchSnapshot: async () => {
        const snapshot = snapshots.shift();
        if (snapshot === undefined) {
          throw new Error("Unexpected snapshot request");
        }
        return snapshot;
      },
      createEventStream: () => {
        const stream = new FakeEventStream();
        streams.push(stream);
        return stream;
      },
      heartbeatTimeoutMs: 1_000,
      now: () => new Date(Date.now()),
    });

    coordinator.start();
    await Promise.resolve();
    await Promise.resolve();
    const stream = streams[0];
    expect(stream).toBeDefined();
    stream?.emitOpen();
    stream?.emit(streamReady(5));
    expect(coordinator.getState().status).toBe("connected");

    stream?.emitError();
    expect(coordinator.getState()).toMatchObject({
      status: "reconnecting",
      dataStale: true,
    });
    stream?.emitOpen();
    stream?.emit(streamReady(5));
    await Promise.resolve();
    await Promise.resolve();
    expect(coordinator.getState()).toMatchObject({
      status: "connected",
      dataStale: false,
    });

    await vi.advanceTimersByTimeAsync(1_001);
    expect(coordinator.getState()).toMatchObject({
      status: "stale",
      dataStale: true,
    });
    stream?.emit(heartbeat(5));
    expect(coordinator.getState()).toMatchObject({
      status: "connected",
      dataStale: false,
    });
    coordinator.stop();
  });

  it("rejects a stale in-flight refresh when a newer event arrives", async () => {
    const firstRefresh = deferred<ControllerSnapshot>();
    const secondRefresh = deferred<ControllerSnapshot>();
    let requestIndex = 0;
    const streams: FakeEventStream[] = [];
    const fetchSnapshot = vi.fn(() => {
      requestIndex += 1;
      if (requestIndex === 1) {
        return Promise.resolve(createTestControllerSnapshot(5));
      }
      if (requestIndex === 2) {
        return firstRefresh.promise;
      }
      if (requestIndex === 3) {
        return secondRefresh.promise;
      }
      return Promise.reject(new Error("Unexpected snapshot request"));
    });
    const coordinator = new ControllerStateCoordinator({
      fetchSnapshot,
      createEventStream: () => {
        const stream = new FakeEventStream();
        streams.push(stream);
        return stream;
      },
    });

    coordinator.start();
    await vi.waitFor(() => expect(streams).toHaveLength(1));
    const stream = streams[0];
    stream?.emit(streamReady(5));
    stream?.emit(committedEvent(6));
    expect(fetchSnapshot).toHaveBeenCalledTimes(2);
    stream?.emit(committedEvent(7));
    expect(fetchSnapshot).toHaveBeenCalledTimes(2);

    firstRefresh.resolve(createTestControllerSnapshot(6));
    await vi.waitFor(() => expect(fetchSnapshot).toHaveBeenCalledTimes(3));
    expect(coordinator.getState().snapshot?.revision).toBe(5);
    expect(coordinator.getState()).toMatchObject({
      revision: 7,
      dataStale: true,
      isRefreshing: true,
    });

    secondRefresh.resolve(createTestControllerSnapshot(7));
    await vi.waitFor(() =>
      expect(coordinator.getState().snapshot?.revision).toBe(7),
    );
    expect(coordinator.getState()).toMatchObject({
      revision: 7,
      dataStale: false,
      isRefreshing: false,
    });
    coordinator.stop();
  });

  it("fails loudly on invalid stream data and creates a fresh stream on retry", async () => {
    const snapshots = [
      createTestControllerSnapshot(5),
      createTestControllerSnapshot(5),
    ];
    const streams: FakeEventStream[] = [];
    const coordinator = new ControllerStateCoordinator({
      fetchSnapshot: async () => {
        const snapshot = snapshots.shift();
        if (snapshot === undefined) {
          throw new Error("Unexpected snapshot request");
        }
        return snapshot;
      },
      createEventStream: () => {
        const stream = new FakeEventStream();
        streams.push(stream);
        return stream;
      },
    });

    coordinator.start();
    await vi.waitFor(() => expect(streams).toHaveLength(1));
    streams[0]?.emitRaw('{"type":"not-a-controller-event"}');
    expect(streams[0]?.closed).toBe(true);
    expect(coordinator.getState()).toMatchObject({
      status: "error",
      dataStale: true,
      error: "Controller event stream sent invalid data",
    });

    coordinator.retry();
    await vi.waitFor(() => expect(streams).toHaveLength(2));
    expect(coordinator.getState()).toMatchObject({
      status: "reconnecting",
      error: null,
    });
    coordinator.stop();
  });
});
