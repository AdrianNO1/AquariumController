export interface FakeEspClock {
  nowMilliseconds(): number;
}

export class ManualFakeEspClock implements FakeEspClock {
  public constructor(private currentMilliseconds = 0) {
    if (!Number.isSafeInteger(currentMilliseconds) || currentMilliseconds < 0) {
      throw new RangeError("The fake ESP clock must start at a non-negative integer millisecond");
    }
  }

  public nowMilliseconds(): number {
    return this.currentMilliseconds;
  }

  public advanceBy(milliseconds: number): void {
    if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) {
      throw new RangeError("The fake ESP clock can only advance by whole, non-negative milliseconds");
    }
    this.currentMilliseconds += milliseconds;
  }
}

export class SystemFakeEspClock implements FakeEspClock {
  public nowMilliseconds(): number {
    return Date.now();
  }
}
