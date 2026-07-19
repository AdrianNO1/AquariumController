import {
  resyncRequiredEventSchema,
  streamHeartbeatEventSchema,
  streamReadyEventSchema,
  type CommittedStateEvent,
} from "@aquarium/contracts";

import {
  toCommittedStateEvent,
  type StateDatabaseTransaction,
  type StoredStateOutboxEvent,
} from "../infrastructure/database/index.js";
import type { Kysely } from "kysely";
import type { StateDatabaseSchema } from "../infrastructure/database/index.js";
import { formatCommittedSseEvent, formatTransientSseEvent } from "../sse.js";

const DEFAULT_MAX_QUEUED_FRAMES = 256;
export const DEFAULT_MAX_REPLAY_EVENTS = 1_000;
const MAX_REPLAY_EVENTS = 10_000;

export interface StateEventStreamSink {
  write(frame: string): boolean;
  close(): void;
}

export interface OpenStateEventStreamOptions {
  readonly afterRevision: number;
  readonly now: () => Date;
  readonly maxQueuedFrames?: number;
}

interface ReplayWindow {
  readonly currentRevision: number;
  readonly earliestAvailableRevision: number;
  readonly events: readonly StoredStateOutboxEvent[];
  readonly replayLimitExceeded: boolean;
}

interface QueuedFrame {
  readonly value: string;
}

export interface StateEventStreamHubOptions {
  readonly maxReplayEvents?: number;
  readonly onConnectionError?: (error: Error) => void;
}

export class StateEventStreamHub {
  readonly #database: Kysely<StateDatabaseSchema>;
  readonly #maxReplayEvents: number;
  readonly #onConnectionError: (error: Error) => void;
  readonly #connections = new Set<StateEventStreamConnection>();

  constructor(
    database: Kysely<StateDatabaseSchema>,
    options: StateEventStreamHubOptions = {},
  ) {
    this.#database = database;
    this.#maxReplayEvents =
      options.maxReplayEvents ?? DEFAULT_MAX_REPLAY_EVENTS;
    this.#onConnectionError = options.onConnectionError ?? (() => undefined);
    if (
      !Number.isSafeInteger(this.#maxReplayEvents) ||
      this.#maxReplayEvents < 1 ||
      this.#maxReplayEvents > MAX_REPLAY_EVENTS
    ) {
      throw new RangeError(
        `maxReplayEvents must be an integer between 1 and ${MAX_REPLAY_EVENTS}`,
      );
    }
  }

  async open(
    sink: StateEventStreamSink,
    options: OpenStateEventStreamOptions,
  ): Promise<StateEventStreamConnection> {
    assertRevision(options.afterRevision, "afterRevision");
    const maxQueuedFrames =
      options.maxQueuedFrames ?? DEFAULT_MAX_QUEUED_FRAMES;
    if (!Number.isSafeInteger(maxQueuedFrames) || maxQueuedFrames < 1) {
      throw new RangeError("maxQueuedFrames must be a positive safe integer");
    }

    const connection = new StateEventStreamConnection(
      sink,
      options.afterRevision,
      maxQueuedFrames,
      options.now,
      () => this.#connections.delete(connection),
      this.#onConnectionError,
    );
    this.#connections.add(connection);

    try {
      const replay = await this.#database
        .transaction()
        .execute((transaction) =>
          readReplayWindow(
            transaction,
            options.afterRevision,
            this.#maxReplayEvents,
          ),
        );
      connection.finishReplay(replay);
      return connection;
    } catch (error) {
      connection.close();
      throw error;
    }
  }

  publishCommitted(event: StoredStateOutboxEvent): void {
    const wireEvent = toCommittedStateEvent(event);
    for (const connection of this.#connections) {
      connection.acceptCommitted(wireEvent);
    }
  }

  get connectionCount(): number {
    return this.#connections.size;
  }

  closeAllConnections(): void {
    for (const connection of [...this.#connections]) {
      connection.close();
    }
  }
}

export class StateEventStreamConnection {
  readonly #sink: StateEventStreamSink;
  readonly #requestedRevision: number;
  readonly #maxQueuedFrames: number;
  readonly #now: () => Date;
  readonly #onClose: () => void;
  readonly #onError: (error: Error) => void;
  readonly #liveBuffer = new Map<number, CommittedStateEvent>();
  readonly #queue: QueuedFrame[] = [];
  #currentRevision: number;
  #currentServerRevision: number;
  #replaying = true;
  #blocked = false;
  #closed = false;

  constructor(
    sink: StateEventStreamSink,
    requestedRevision: number,
    maxQueuedFrames: number,
    now: () => Date,
    onClose: () => void,
    onError: (error: Error) => void,
  ) {
    this.#sink = sink;
    this.#requestedRevision = requestedRevision;
    this.#currentRevision = requestedRevision;
    this.#currentServerRevision = requestedRevision;
    this.#maxQueuedFrames = maxQueuedFrames;
    this.#now = now;
    this.#onClose = onClose;
    this.#onError = onError;
  }

  get closed(): boolean {
    return this.#closed;
  }

  get currentRevision(): number {
    return this.#currentRevision;
  }

  acceptCommitted(event: CommittedStateEvent): void {
    if (this.#closed) {
      return;
    }
    this.#currentServerRevision = Math.max(
      this.#currentServerRevision,
      event.revision,
    );
    if (this.#replaying) {
      this.#liveBuffer.set(event.revision, event);
      return;
    }
    this.#acceptSequentialEvent(event);
  }

  finishReplay(replay: ReplayWindow): void {
    if (this.#closed) {
      return;
    }
    const now = this.#now();
    assertValidDate(now, "stream readiness time");
    this.#currentServerRevision = Math.max(
      this.#currentServerRevision,
      replay.currentRevision,
    );

    if (this.#requestedRevision > replay.currentRevision) {
      this.#forceResync(
        replay.earliestAvailableRevision,
        replay.currentRevision,
        "requested revision is ahead of the controller",
      );
      return;
    }
    if (
      this.#requestedRevision <
      Math.max(0, replay.earliestAvailableRevision - 1)
    ) {
      this.#forceResync(
        replay.earliestAvailableRevision,
        replay.currentRevision,
        "requested revision predates the replay watermark",
      );
      return;
    }
    if (replay.replayLimitExceeded) {
      this.#forceResync(
        replay.earliestAvailableRevision,
        replay.currentRevision,
        "requested replay exceeds the bounded event limit",
      );
      return;
    }

    let replayedCount = 0;
    for (const event of replay.events) {
      if (!this.#acceptSequentialEvent(toCommittedStateEvent(event))) {
        return;
      }
      replayedCount += 1;
    }

    const buffered = [...this.#liveBuffer.values()].sort(
      (left, right) => left.revision - right.revision,
    );
    this.#liveBuffer.clear();
    this.#replaying = false;
    for (const event of buffered) {
      if (event.revision <= this.#currentRevision) {
        continue;
      }
      if (!this.#acceptSequentialEvent(event)) {
        return;
      }
    }

    this.#enqueue({
      value: formatTransientSseEvent(
        streamReadyEventSchema.parse({
          type: "system.stream-ready",
          occurredAt: now.toISOString(),
          data: {
            currentRevision: this.#currentRevision,
            replayedCount,
          },
        }),
      ),
    });
  }

  heartbeat(now: Date): void {
    if (this.#closed) {
      return;
    }
    assertValidDate(now, "heartbeat time");
    this.#enqueue({
      value:
        ": heartbeat\n\n" +
        formatTransientSseEvent(
          streamHeartbeatEventSchema.parse({
            type: "system.heartbeat",
            occurredAt: now.toISOString(),
            data: {
              currentRevision: this.#currentServerRevision,
              serverNow: now.toISOString(),
            },
          }),
        ),
    });
  }

  drain(): void {
    if (this.#closed) {
      return;
    }
    this.#blocked = false;
    while (this.#queue.length > 0 && !this.#blocked) {
      const frame = this.#queue.shift();
      if (frame !== undefined) {
        this.#write(frame);
      }
    }
  }

  close(): void {
    if (this.#closed) {
      return;
    }
    this.#closed = true;
    this.#queue.length = 0;
    this.#liveBuffer.clear();
    this.#onClose();
    try {
      this.#sink.close();
    } catch (error) {
      this.#reportError(toError(error));
    }
  }

  #acceptSequentialEvent(event: CommittedStateEvent): boolean {
    if (event.revision <= this.#currentRevision) {
      return true;
    }
    if (event.revision !== this.#currentRevision + 1) {
      this.#forceResync(
        this.#currentRevision + 1,
        this.#currentServerRevision,
        `state event gap: expected revision ${this.#currentRevision + 1}, received ${event.revision}`,
      );
      return false;
    }
    this.#currentRevision = event.revision;
    this.#enqueue({ value: formatCommittedSseEvent(event) });
    return !this.#closed;
  }

  #enqueue(frame: QueuedFrame): void {
    if (this.#closed) {
      return;
    }
    if (!this.#blocked && this.#queue.length === 0) {
      this.#write(frame);
      return;
    }
    if (this.#queue.length >= this.#maxQueuedFrames) {
      this.#forceResync(
        this.#currentRevision,
        this.#currentServerRevision,
        "client event queue exceeded its bounded capacity",
      );
      return;
    }
    this.#queue.push(frame);
  }

  #write(frame: QueuedFrame): void {
    try {
      this.#blocked = !this.#sink.write(frame.value);
    } catch (error) {
      this.close();
      this.#reportError(toError(error));
    }
  }

  #reportError(error: Error): void {
    try {
      this.#onError(error);
    } catch {
      // Error observers must not break event delivery or connection cleanup.
    }
  }

  #forceResync(
    earliestAvailableRevision: number,
    currentRevision: number,
    reason: string,
  ): void {
    if (this.#closed) {
      return;
    }
    const now = this.#now();
    assertValidDate(now, "resynchronization time");
    const event = resyncRequiredEventSchema.parse({
      type: "system.resync-required",
      occurredAt: now.toISOString(),
      data: {
        requestedRevision: this.#requestedRevision,
        earliestAvailableRevision,
        currentRevision,
        reason,
      },
    });
    this.#queue.length = 0;
    this.#write({ value: formatTransientSseEvent(event) });
    this.close();
  }
}

async function readReplayWindow(
  transaction: StateDatabaseTransaction,
  afterRevision: number,
  maxReplayEvents: number,
): Promise<ReplayWindow> {
  const [currentRow, earliestRow] = await Promise.all([
    transaction
      .selectFrom("state_revisions")
      .select(({ fn }) => fn.max<number>("revision").as("revision"))
      .executeTakeFirstOrThrow(),
    transaction
      .selectFrom("state_outbox")
      .select(({ fn }) => fn.min<number>("revision").as("revision"))
      .executeTakeFirstOrThrow(),
  ]);
  const currentRevision = currentRow.revision ?? 0;
  const earliestAvailableRevision =
    earliestRow.revision ?? (currentRevision === 0 ? 0 : currentRevision + 1);
  const events = await transaction
    .selectFrom("state_outbox")
    .selectAll()
    .where("revision", ">", afterRevision)
    .where("revision", "<=", currentRevision)
    .orderBy("revision", "asc")
    .limit(maxReplayEvents + 1)
    .execute();
  return {
    currentRevision,
    earliestAvailableRevision,
    events,
    replayLimitExceeded: events.length > maxReplayEvents,
  };
}

function assertRevision(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError(`${field} must be a non-negative safe integer`);
  }
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function assertValidDate(value: Date, field: string): void {
  if (!Number.isFinite(value.getTime())) {
    throw new RangeError(`${field} must be a valid date`);
  }
}
