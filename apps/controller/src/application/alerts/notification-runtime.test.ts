import { describe, expect, it } from "vitest";

import type { SchedulingTimer } from "../scheduling/index.js";
import type { AlertNotificationDispatchResult } from "./notification-dispatcher.js";
import {
  ALERT_NOTIFICATION_DISPATCH_BATCH_SIZE,
  AlertNotificationRuntime,
} from "./notification-runtime.js";

describe("alert notification runtime", () => {
  it("recovers once, drains full batches, and polls without overlap", async () => {
    const timer = new FakeSchedulingTimer();
    let recoveries = 0;
    let dispatches = 0;
    const runtime = new AlertNotificationRuntime(
      {
        async recoverInterrupted() {
          recoveries += 1;
          return [];
        },
        async dispatchPending(): Promise<AlertNotificationDispatchResult> {
          dispatches += 1;
          return {
            outcomes:
              dispatches === 1
                ? deliveredOutcomes(ALERT_NOTIFICATION_DISPATCH_BATCH_SIZE)
                : [],
          };
        },
      },
      {
        timer,
        pollIntervalMs: 250,
        onError: (error) => {
          throw error;
        },
      },
    );

    await runtime.start();
    expect(recoveries).toBe(1);
    expect(dispatches).toBe(2);
    expect(timer.delays).toEqual([250]);

    await timer.fireNext();
    expect(dispatches).toBe(3);
    expect(timer.delays).toEqual([250, 250]);
    await runtime.stop();
    expect(timer.pendingCount).toBe(0);
  });

  it("reports a scheduled dispatcher failure and surfaces the fatal state on stop", async () => {
    const timer = new FakeSchedulingTimer();
    const reported: Error[] = [];
    let fail = false;
    const runtime = new AlertNotificationRuntime(
      {
        async recoverInterrupted() {
          return [];
        },
        async dispatchPending() {
          if (fail) {
            throw new Error("notification database unavailable");
          }
          return { outcomes: [] };
        },
      },
      {
        timer,
        onError: (error) => reported.push(error),
      },
    );
    await runtime.start();

    fail = true;
    await timer.fireNext();
    expect(reported.map(({ message }) => message)).toEqual([
      "notification database unavailable",
    ]);
    await expect(runtime.stop()).rejects.toThrow(
      "notification database unavailable",
    );
    expect(timer.pendingCount).toBe(0);
  });

  it("rejects invalid polling intervals", () => {
    expect(
      () =>
        new AlertNotificationRuntime(
          {
            async recoverInterrupted() {
              return [];
            },
            async dispatchPending() {
              return { outcomes: [] };
            },
          },
          {
            timer: new FakeSchedulingTimer(),
            pollIntervalMs: 0,
            onError: () => undefined,
          },
        ),
    ).toThrow(/poll interval/i);
  });
});

function deliveredOutcomes(count: number) {
  return Array.from({ length: count }, (_, index) => ({
    deliveryId: index + 1,
    status: "delivered" as const,
    errorCode: null,
  }));
}

interface ScheduledTask {
  readonly delayMs: number;
  readonly task: () => void;
  cancelled: boolean;
}

class FakeSchedulingTimer implements SchedulingTimer {
  readonly delays: number[] = [];
  readonly #tasks: ScheduledTask[] = [];

  get pendingCount(): number {
    return this.#tasks.filter(({ cancelled }) => !cancelled).length;
  }

  schedule(delayMs: number, task: () => void): () => void {
    this.delays.push(delayMs);
    const scheduled = { delayMs, task, cancelled: false };
    this.#tasks.push(scheduled);
    return () => {
      scheduled.cancelled = true;
    };
  }

  async fireNext(): Promise<void> {
    const scheduled = this.#tasks.find(({ cancelled }) => !cancelled);
    if (scheduled === undefined) {
      throw new Error("No scheduled notification task is available");
    }
    scheduled.cancelled = true;
    scheduled.task();
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  }
}
