import { describe, expect, it } from "vitest";

import { ManualFakeEspClock, SystemFakeEspClock } from "./clock.js";

describe("fake ESP clocks", () => {
  it("advances deterministic whole milliseconds and rejects unsafe values", () => {
    const clock = new ManualFakeEspClock(10);
    clock.advanceBy(25);
    expect(clock.nowMilliseconds()).toBe(35);
    expect(() => clock.advanceBy(-1)).toThrow(/non-negative/);
    expect(() =>
      new ManualFakeEspClock(Number.MAX_SAFE_INTEGER).advanceBy(1),
    ).toThrow(/safe integer/);
  });

  it("uses a nondecreasing monotonic source for system-backed actors", () => {
    const clock = new SystemFakeEspClock();
    const first = clock.nowMilliseconds();
    const second = clock.nowMilliseconds();
    expect(Number.isSafeInteger(first)).toBe(true);
    expect(second).toBeGreaterThanOrEqual(first);
  });
});
