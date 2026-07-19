import {
  readUtcTimestamp,
  type CancelScheduledTask,
  type SchedulingClock,
  type SchedulingTimer,
} from "../scheduling/scheduling-time.js";

export interface StorageHealthCheckPort {
  evaluate(input: { readonly observedAtMs: number }): Promise<object>;
}

export interface PeriodicStorageHealthCoordinatorOptions {
  readonly clock: SchedulingClock;
  readonly timer: SchedulingTimer;
  readonly intervalMs: number;
  readonly onError: (error: Error) => void;
}

/**
 * Runs storage-health checks immediately and then at a bounded interval. A new
 * interval starts only after the previous check settles, so checks never
 * overlap and delayed work is not replayed as a burst.
 */
export class PeriodicStorageHealthCoordinator {
  readonly #health: StorageHealthCheckPort;
  readonly #clock: SchedulingClock;
  readonly #timer: SchedulingTimer;
  readonly #intervalMs: number;
  readonly #onError: (error: Error) => void;
  #cancelTimer: CancelScheduledTask | null = null;
  #activeTask: Promise<void> | null = null;
  #fatalError: Error | null = null;
  #started = false;
  #stopping = false;

  constructor(
    health: StorageHealthCheckPort,
    options: PeriodicStorageHealthCoordinatorOptions,
  ) {
    if (!Number.isSafeInteger(options.intervalMs) || options.intervalMs <= 0) {
      throw new RangeError(
        "Storage-health interval must be a positive safe integer",
      );
    }
    this.#health = health;
    this.#clock = options.clock;
    this.#timer = options.timer;
    this.#intervalMs = options.intervalMs;
    this.#onError = options.onError;
  }

  isReady(): boolean {
    return this.#started && !this.#stopping && this.#fatalError === null;
  }

  async start(): Promise<void> {
    if (this.#started) {
      throw new Error("Storage-health coordinator is already started");
    }
    if (this.#stopping) {
      throw new Error("Stopped storage-health coordinator cannot be restarted");
    }
    this.#started = true;

    try {
      await this.#health.evaluate({
        observedAtMs: readUtcTimestamp(this.#clock).epochMs,
      });
      this.#armTimer();
    } catch (error) {
      const failure = toError(error);
      this.#setFatal(failure);
      throw failure;
    }
  }

  async stop(): Promise<void> {
    if (!this.#started && !this.#stopping) {
      return;
    }
    this.#stopping = true;
    this.#cancelTimer?.();
    this.#cancelTimer = null;
    const activeTask = this.#activeTask;
    if (activeTask !== null) {
      await activeTask;
    }
    this.#started = false;
    if (this.#fatalError !== null) {
      throw this.#fatalError;
    }
  }

  #armTimer(): void {
    if (this.#stopping) {
      return;
    }
    this.#cancelTimer = this.#timer.schedule(this.#intervalMs, () => {
      this.#timerFired();
    });
  }

  #timerFired(): void {
    this.#cancelTimer = null;
    if (this.#stopping || this.#activeTask !== null) {
      return;
    }
    const task = this.#runScheduledCheck();
    this.#activeTask = task;
    void task.then(() => {
      if (this.#activeTask === task) {
        this.#activeTask = null;
      }
      if (!this.#stopping && this.#fatalError === null) {
        try {
          this.#armTimer();
        } catch (error) {
          this.#fail(toError(error));
        }
      }
    });
  }

  async #runScheduledCheck(): Promise<void> {
    try {
      await this.#health.evaluate({
        observedAtMs: readUtcTimestamp(this.#clock).epochMs,
      });
    } catch (error) {
      this.#reportCheckFailure(toError(error));
    }
  }

  #reportCheckFailure(error: Error): void {
    try {
      this.#onError(error);
    } catch (reporterError) {
      this.#setFatal(
        new AggregateError(
          [error, toError(reporterError)],
          "Storage-health error reporter failed",
        ),
      );
    }
  }

  #fail(error: Error): void {
    if (this.#fatalError !== null) {
      return;
    }
    let fatalError = error;
    try {
      this.#onError(error);
    } catch (reporterError) {
      fatalError = new AggregateError(
        [error, toError(reporterError)],
        "Storage-health error reporter failed",
      );
    }
    this.#setFatal(fatalError);
  }

  #setFatal(error: Error): void {
    this.#fatalError ??= error;
    this.#stopping = true;
    this.#cancelTimer?.();
    this.#cancelTimer = null;
  }
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
