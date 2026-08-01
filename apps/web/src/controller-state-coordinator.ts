import {
  controllerStreamEventSchema,
  type ControllerSnapshot,
  type ControllerStreamEvent,
} from "@aquarium/contracts";

const DEFAULT_HEARTBEAT_TIMEOUT_MS = 45_000;

export type ControllerConnectionStatus =
  "loading" | "connected" | "reconnecting" | "stale" | "error";

export interface ControllerClientState {
  readonly status: ControllerConnectionStatus;
  readonly snapshot: ControllerSnapshot | null;
  readonly revision: number;
  readonly dataStale: boolean;
  readonly isRefreshing: boolean;
  readonly lastMessageAt: string | null;
  readonly error: string | null;
}

export interface ControllerEventStreamHandlers {
  readonly open: () => void;
  readonly message: (data: string) => void;
  readonly error: () => void;
}

export interface ControllerEventStream {
  listen(handlers: ControllerEventStreamHandlers): void;
  close(): void;
}

export interface ControllerStateCoordinatorOptions {
  readonly fetchSnapshot: (signal: AbortSignal) => Promise<ControllerSnapshot>;
  readonly createEventStream: (url: string) => ControllerEventStream;
  readonly heartbeatTimeoutMs?: number;
  readonly now?: () => Date;
}

const initialState: ControllerClientState = {
  status: "loading",
  snapshot: null,
  revision: 0,
  dataStale: true,
  isRefreshing: false,
  lastMessageAt: null,
  error: null,
};

export class ControllerStateCoordinator {
  readonly #options: ControllerStateCoordinatorOptions;
  readonly #listeners = new Set<() => void>();
  readonly #heartbeatTimeoutMs: number;
  readonly #now: () => Date;
  #state: ControllerClientState = initialState;
  #running = false;
  #generation = 0;
  #stream: ControllerEventStream | null = null;
  #streamReady = false;
  #heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  #snapshotAbortController: AbortController | null = null;
  #snapshotFetchInFlight = false;
  #requiredSnapshotRevision = 0;
  #reconnectAfterSnapshot = false;

  constructor(options: ControllerStateCoordinatorOptions) {
    const heartbeatTimeoutMs =
      options.heartbeatTimeoutMs ?? DEFAULT_HEARTBEAT_TIMEOUT_MS;
    if (!Number.isSafeInteger(heartbeatTimeoutMs) || heartbeatTimeoutMs < 1) {
      throw new RangeError(
        "heartbeatTimeoutMs must be a positive safe integer",
      );
    }

    this.#options = options;
    this.#heartbeatTimeoutMs = heartbeatTimeoutMs;
    this.#now = options.now ?? (() => new Date());
  }

  readonly getState = (): ControllerClientState => this.#state;

  readonly subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  start(): void {
    if (this.#running) {
      return;
    }

    this.#running = true;
    this.#generation += 1;
    this.#requiredSnapshotRevision = 0;
    this.#reconnectAfterSnapshot = true;
    this.#setState(initialState);
    this.#requestSnapshot();
  }

  stop(): void {
    if (!this.#running) {
      return;
    }

    this.#running = false;
    this.#generation += 1;
    this.#snapshotAbortController?.abort();
    this.#snapshotAbortController = null;
    this.#snapshotFetchInFlight = false;
    this.#closeStream();
  }

  readonly refresh = (): void => {
    if (!this.#running) {
      return;
    }

    this.#requiredSnapshotRevision = Math.max(
      this.#requiredSnapshotRevision,
      this.#state.revision,
    );
    this.#requestSnapshot();
  };

  readonly retry = (): void => {
    if (!this.#running) {
      this.start();
      return;
    }

    this.#closeStream();
    this.#reconnectAfterSnapshot = true;
    this.#requiredSnapshotRevision = Math.max(
      this.#requiredSnapshotRevision,
      this.#state.revision,
    );
    this.#setState({
      ...this.#state,
      status: this.#state.snapshot === null ? "loading" : "reconnecting",
      dataStale: true,
      error: null,
    });
    this.#requestSnapshot();
  };

  #requestSnapshot(): void {
    if (!this.#running || this.#snapshotFetchInFlight) {
      return;
    }

    this.#snapshotFetchInFlight = true;
    const generation = this.#generation;
    const abortController = new AbortController();
    this.#snapshotAbortController = abortController;
    this.#setState({
      ...this.#state,
      status:
        this.#state.snapshot === null
          ? "loading"
          : this.#reconnectAfterSnapshot
            ? "reconnecting"
            : this.#streamReady
              ? "connected"
              : this.#state.status,
      isRefreshing: true,
      error: null,
    });

    void this.#options
      .fetchSnapshot(abortController.signal)
      .then((snapshot) => {
        if (!this.#running || generation !== this.#generation) {
          return;
        }

        this.#snapshotFetchInFlight = false;
        this.#snapshotAbortController = null;
        if (snapshot.revision < this.#requiredSnapshotRevision) {
          this.#requestSnapshot();
          return;
        }

        const reconnect = this.#reconnectAfterSnapshot;
        this.#reconnectAfterSnapshot = false;
        this.#requiredSnapshotRevision = snapshot.revision;
        this.#setState({
          ...this.#state,
          status: reconnect ? "reconnecting" : this.#state.status,
          snapshot,
          revision: snapshot.revision,
          dataStale: false,
          isRefreshing: false,
          error: null,
        });
        if (reconnect) {
          this.#openStream(snapshot.revision);
        }
      })
      .catch((error) => {
        if (!this.#running || generation !== this.#generation) {
          return;
        }

        this.#snapshotFetchInFlight = false;
        this.#snapshotAbortController = null;
        this.#setState({
          ...this.#state,
          status: "error",
          dataStale: true,
          isRefreshing: false,
          error:
            error instanceof Error
              ? error.message
              : "Controller snapshot request failed",
        });
      });
  }

  #openStream(afterRevision: number): void {
    if (!this.#running) {
      return;
    }

    this.#closeStream();
    this.#streamReady = false;
    let stream: ControllerEventStream;
    try {
      stream = this.#options.createEventStream(
        `/api/events?afterRevision=${encodeURIComponent(String(afterRevision))}`,
      );
    } catch (error) {
      this.#setState({
        ...this.#state,
        status: "error",
        dataStale: true,
        error:
          error instanceof Error
            ? error.message
            : "Controller event stream could not be created",
      });
      return;
    }

    this.#stream = stream;
    try {
      stream.listen({
        open: () => {
          if (this.#stream !== stream || !this.#running) {
            return;
          }
          if (!this.#touchStream(stream)) {
            return;
          }
          if (this.#state.status !== "error") {
            this.#setState({ ...this.#state, status: "reconnecting" });
          }
        },
        message: (data) => this.#handleMessage(stream, data),
        error: () => {
          if (this.#stream !== stream || !this.#running) {
            return;
          }
          this.#streamReady = false;
          this.#scheduleHeartbeatTimeout(stream);
          if (this.#state.status !== "error") {
            this.#setState({
              ...this.#state,
              status: "reconnecting",
              dataStale: true,
            });
          }
        },
      });
    } catch (error) {
      this.#closeStream();
      this.#setState({
        ...this.#state,
        status: "error",
        dataStale: true,
        error:
          error instanceof Error
            ? error.message
            : "Controller event stream listeners could not be registered",
      });
    }
  }

  #handleMessage(stream: ControllerEventStream, data: string): void {
    if (this.#stream !== stream || !this.#running) {
      return;
    }

    let event: ControllerStreamEvent;
    try {
      event = controllerStreamEventSchema.parse(JSON.parse(data));
    } catch {
      this.#closeStream();
      this.#setState({
        ...this.#state,
        status: "error",
        dataStale: true,
        error: "Controller event stream sent invalid data",
      });
      return;
    }

    if (!this.#touchStream(stream)) {
      return;
    }
    if ("revision" in event) {
      this.#handleCommittedEvent(event);
      return;
    }
    if (event.type === "system.resync-required") {
      this.#resynchronize(event.data.currentRevision);
      return;
    }
    if (event.type === "device.contact") {
      this.#applyDeviceContact(event.data.deviceId, event.occurredAt);
      return;
    }
    if (event.data.currentRevision > this.#state.revision) {
      this.#resynchronize(event.data.currentRevision);
      return;
    }
    if (event.type === "system.stream-ready") {
      this.#streamReady = true;
      this.#setState({
        ...this.#state,
        status: "connected",
        error: null,
      });
      if (this.#state.dataStale) {
        this.#requestSnapshot();
      }
      return;
    }

    if (this.#streamReady && this.#state.status !== "error") {
      this.#setState({
        ...this.#state,
        status: "connected",
        dataStale:
          this.#state.snapshot === null ||
          this.#state.snapshot.revision < this.#state.revision,
      });
    }
  }

  #applyDeviceContact(deviceId: string, occurredAt: string): void {
    const snapshot = this.#state.snapshot;
    if (snapshot === null) return;
    const contactMs = Date.parse(occurredAt);
    let changed = false;
    const devices = snapshot.devices.map((device) => {
      if (device.id !== deviceId) return device;
      const currentMs =
        device.lastSeenAt === null
          ? Number.NEGATIVE_INFINITY
          : Date.parse(device.lastSeenAt);
      if (contactMs <= currentMs) return device;
      changed = true;
      return { ...device, lastSeenAt: occurredAt };
    });
    if (!changed) return;
    this.#setState({
      ...this.#state,
      snapshot: { ...snapshot, devices },
    });
  }

  #handleCommittedEvent(
    event: Extract<ControllerStreamEvent, { revision: number }>,
  ): void {
    if (event.revision <= this.#state.revision) {
      return;
    }
    if (event.revision !== this.#state.revision + 1) {
      this.#resynchronize(event.revision);
      return;
    }

    this.#requiredSnapshotRevision = event.revision;
    this.#setState({
      ...this.#state,
      revision: event.revision,
      dataStale:
        this.#state.snapshot === null ||
        this.#state.snapshot.revision < event.revision,
    });
    if (this.#streamReady) {
      this.#requestSnapshot();
    }
  }

  #resynchronize(requiredRevision: number): void {
    this.#closeStream();
    this.#requiredSnapshotRevision = Math.max(
      this.#state.revision,
      requiredRevision,
    );
    this.#reconnectAfterSnapshot = true;
    this.#setState({
      ...this.#state,
      status: "reconnecting",
      dataStale: true,
      error: null,
    });
    this.#requestSnapshot();
  }

  #touchStream(stream: ControllerEventStream): boolean {
    const now = this.#now();
    if (!Number.isFinite(now.getTime())) {
      this.#closeStream();
      this.#setState({
        ...this.#state,
        status: "error",
        dataStale: true,
        error: "Controller event clock returned an invalid time",
      });
      return false;
    }
    this.#setState({ ...this.#state, lastMessageAt: now.toISOString() });
    this.#scheduleHeartbeatTimeout(stream);
    return true;
  }

  #scheduleHeartbeatTimeout(stream: ControllerEventStream): void {
    if (this.#heartbeatTimer !== null) {
      clearTimeout(this.#heartbeatTimer);
    }
    this.#heartbeatTimer = setTimeout(() => {
      if (
        this.#running &&
        this.#stream === stream &&
        this.#state.status !== "error"
      ) {
        this.#setState({
          ...this.#state,
          status: "stale",
          dataStale: true,
        });
      }
    }, this.#heartbeatTimeoutMs);
  }

  #closeStream(): void {
    if (this.#heartbeatTimer !== null) {
      clearTimeout(this.#heartbeatTimer);
      this.#heartbeatTimer = null;
    }
    const stream = this.#stream;
    this.#stream = null;
    this.#streamReady = false;
    stream?.close();
  }

  #setState(state: ControllerClientState): void {
    this.#state = state;
    for (const listener of this.#listeners) {
      listener();
    }
  }
}
