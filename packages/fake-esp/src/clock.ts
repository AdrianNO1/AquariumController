export interface FakeEspClock {
  nowMilliseconds(): number;
}

export class ManualFakeEspClock implements FakeEspClock {
  public constructor(private currentMilliseconds = 0) {
    if (!Number.isSafeInteger(currentMilliseconds) || currentMilliseconds < 0) {
      throw new RangeError(
        "The fake ESP clock must start at a non-negative integer millisecond",
      );
    }
  }

  public nowMilliseconds(): number {
    return this.currentMilliseconds;
  }

  public advanceBy(milliseconds: number): void {
    if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) {
      throw new RangeError(
        "The fake ESP clock can only advance by whole, non-negative milliseconds",
      );
    }
    const nextMilliseconds = this.currentMilliseconds + milliseconds;
    if (!Number.isSafeInteger(nextMilliseconds)) {
      throw new RangeError(
        "The fake ESP clock exceeded JavaScript's safe integer range",
      );
    }
    this.currentMilliseconds = nextMilliseconds;
  }
}

export class SystemFakeEspClock implements FakeEspClock {
  public nowMilliseconds(): number {
    return Number(process.hrtime.bigint() / 1_000_000n);
  }
}
