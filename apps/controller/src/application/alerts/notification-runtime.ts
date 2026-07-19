import type {
  CancelScheduledTask,
  SchedulingTimer,
} from "../scheduling/index.js";
import type { AlertNotificationDispatchResult } from "./notification-dispatcher.js";

export const DEFAULT_ALERT_NOTIFICATION_POLL_INTERVAL_MS = 1_000;
export const ALERT_NOTIFICATION_DISPATCH_BATCH_SIZE = 100;

export interface AlertNotificationDispatchPort {
  recoverInterrupted(): Promise<readonly number[]>;
  dispatchPending(batchSize?: number): Promise<AlertNotificationDispatchResult>;
}

export interface AlertNotificationRuntimeOptions {
  readonly timer: SchedulingTimer;
  readonly pollIntervalMs?: number;
  readonly onError: (error: Error) => void;
}

/**
 * Recovers interrupted single-attempt deliveries and drains the durable
 * notification outbox without overlapping polls or retrying terminal rows.
 */
export class AlertNotificationRuntime {
  readonly #dispatcher: AlertNotificationDispatchPort;
  readonly #timer: SchedulingTimer;
  readonly #pollIntervalMs: number;
  readonly #onError: (error: Error) => void;
  #cancelPoll: CancelScheduledTask | null = null;
  #activeCycle: Promise<void> | null = null;
  #fatalError: Error | null = null;
  #started = false;
  #stopping = false;

  constructor(
    dispatcher: AlertNotificationDispatchPort,
    options: AlertNotificationRuntimeOptions,
  ) {
    const pollIntervalMs =
      options.pollIntervalMs ?? DEFAULT_ALERT_NOTIFICATION_POLL_INTERVAL_MS;
    if (!Number.isSafeInteger(pollIntervalMs) || pollIntervalMs <= 0) {
      throw new RangeError(
        "Alert notification poll interval must be a positive safe integer",
      );
    }
    this.#dispatcher = dispatcher;
    this.#timer = options.timer;
    this.#pollIntervalMs = pollIntervalMs;
    this.#onError = options.onError;
  }

  isReady(): boolean {
    return this.#started && !this.#stopping && this.#fatalError === null;
  }

  async start(): Promise<void> {
    if (this.#started) {
      throw new Error("Alert notification runtime is already started");
    }
    if (this.#stopping) {
      throw new Error("Stopped alert notification runtime cannot be restarted");
    }
    this.#started = true;
    try {
      await this.#dispatcher.recoverInterrupted();
      await this.#runCycle();
      if (this.#fatalError !== null) {
        throw this.#fatalError;
      }
      this.#armPoll();
    } catch (error) {
      this.#fail(toError(error));
      throw this.#fatalError;
    }
  }

  async stop(): Promise<void> {
    if (!this.#started && !this.#stopping) {
      return;
    }
    this.#stopping = true;
    this.#cancelPoll?.();
    this.#cancelPoll = null;
    if (this.#activeCycle !== null) {
      await this.#activeCycle;
    }
    this.#started = false;
    if (this.#fatalError !== null) {
      throw this.#fatalError;
    }
  }

  #armPoll(): void {
    if (this.#stopping) {
      return;
    }
    this.#cancelPoll = this.#timer.schedule(this.#pollIntervalMs, () => {
      this.#cancelPoll = null;
      if (this.#stopping || this.#activeCycle !== null) {
        return;
      }
      const cycle = this.#runCycle();
      this.#activeCycle = cycle;
      void cycle.then(() => {
        if (this.#activeCycle === cycle) {
          this.#activeCycle = null;
        }
        if (!this.#stopping && this.#fatalError === null) {
          this.#armPoll();
        }
      });
    });
  }

  async #runCycle(): Promise<void> {
    try {
      while (!this.#stopping) {
        const result = await this.#dispatcher.dispatchPending(
          ALERT_NOTIFICATION_DISPATCH_BATCH_SIZE,
        );
        if (result.outcomes.length < ALERT_NOTIFICATION_DISPATCH_BATCH_SIZE) {
          return;
        }
      }
    } catch (error) {
      this.#fail(toError(error));
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
        "Alert notification error reporter failed",
      );
    }
    this.#fatalError = fatalError;
    this.#stopping = true;
    this.#cancelPoll?.();
    this.#cancelPoll = null;
  }
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
