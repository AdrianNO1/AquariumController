import type {
  CancelScheduledTask,
  SchedulingClock,
  SchedulingTimer,
} from "./scheduling-time.js";

interface ScheduledTestTask {
  readonly id: number;
  readonly deadlineMs: number;
  readonly callback: () => void;
  cancelled: boolean;
}

export class ManualSchedulingTime implements SchedulingClock, SchedulingTimer {
  #monotonicMs = 0;
  #utcMs: number;
  #nextTaskId = 0;
  readonly #tasks: ScheduledTestTask[] = [];

  constructor(initialUtc: string | number | Date) {
    this.#utcMs = new Date(initialUtc).getTime();
    if (!Number.isSafeInteger(this.#utcMs) || this.#utcMs < 0) {
      throw new RangeError("Manual scheduling time requires a valid UTC value");
    }
  }

  monotonicNowMs(): number {
    return this.#monotonicMs;
  }

  utcNow(): Date {
    return new Date(this.#utcMs);
  }

  schedule(delayMs: number, callback: () => void): CancelScheduledTask {
    if (!Number.isFinite(delayMs) || delayMs < 0) {
      throw new RangeError(
        "Manual timer delay must be finite and non-negative",
      );
    }
    const task: ScheduledTestTask = {
      id: ++this.#nextTaskId,
      deadlineMs: this.#monotonicMs + delayMs,
      callback,
      cancelled: false,
    };
    this.#tasks.push(task);
    return () => {
      task.cancelled = true;
    };
  }

  setUtc(utc: string | number | Date): void {
    const epochMs = new Date(utc).getTime();
    if (!Number.isSafeInteger(epochMs) || epochMs < 0) {
      throw new RangeError("Manual scheduling time requires a valid UTC value");
    }
    this.#utcMs = epochMs;
  }

  async advanceBy(durationMs: number): Promise<void> {
    if (!Number.isFinite(durationMs) || durationMs < 0) {
      throw new RangeError(
        "Manual time advance must be finite and non-negative",
      );
    }
    const targetMs = this.#monotonicMs + durationMs;
    for (let iteration = 0; iteration < 10_000; iteration += 1) {
      await flushMicrotasks();
      const next = this.#nextDueTask(targetMs);
      if (next !== undefined) {
        this.#moveTo(next.deadlineMs);
        next.cancelled = true;
        next.callback();
        continue;
      }
      if (this.#monotonicMs < targetMs) {
        this.#moveTo(targetMs);
        continue;
      }
      await flushMicrotasks();
      if (this.#nextDueTask(targetMs) === undefined) {
        return;
      }
    }
    throw new Error("Manual scheduling timer exceeded its task safety limit");
  }

  #nextDueTask(targetMs: number): ScheduledTestTask | undefined {
    return this.#tasks
      .filter((task) => !task.cancelled && task.deadlineMs <= targetMs)
      .sort(
        (left, right) =>
          left.deadlineMs - right.deadlineMs || left.id - right.id,
      )[0];
  }

  #moveTo(monotonicMs: number): void {
    const elapsedMs = monotonicMs - this.#monotonicMs;
    this.#monotonicMs = monotonicMs;
    this.#utcMs += elapsedMs;
  }
}

async function flushMicrotasks(): Promise<void> {
  for (let iteration = 0; iteration < 10; iteration += 1) {
    await Promise.resolve();
  }
}
