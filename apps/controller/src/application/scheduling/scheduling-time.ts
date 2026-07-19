import { performance } from "node:perf_hooks";

export type CancelScheduledTask = () => void;

export interface SchedulingClock {
  monotonicNowMs(): number;
  utcNow(): Date;
}

export interface SchedulingTimer {
  schedule(delayMs: number, task: () => void): CancelScheduledTask;
}

export class SystemSchedulingTime implements SchedulingClock, SchedulingTimer {
  monotonicNowMs(): number {
    return performance.now();
  }

  utcNow(): Date {
    return new Date();
  }

  schedule(delayMs: number, task: () => void): CancelScheduledTask {
    assertTimerDelay(delayMs);
    const timeout = setTimeout(task, delayMs);
    timeout.unref();
    return () => clearTimeout(timeout);
  }
}

export function assertMonotonicTimestamp(value: number): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(
      "The scheduling monotonic clock must return a finite non-negative value",
    );
  }
  return value;
}

export function readUtcTimestamp(clock: SchedulingClock): {
  readonly date: Date;
  readonly epochMs: number;
} {
  const date = clock.utcNow();
  const epochMs = date.getTime();
  if (!Number.isSafeInteger(epochMs) || epochMs < 0) {
    throw new RangeError(
      "The scheduling UTC clock must return a valid non-negative timestamp",
    );
  }
  return { date, epochMs };
}

function assertTimerDelay(value: number): void {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(
      "Scheduling timer delay must be finite and non-negative",
    );
  }
}
