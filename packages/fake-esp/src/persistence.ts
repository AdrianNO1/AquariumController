export interface FakeEspTimeSnapshot {
  readonly lastSavedEpochSeconds: number;
}

export interface FakeEspLastError {
  readonly code: string;
  readonly severity: "warning" | "error";
  readonly message: string;
  readonly sequence: number;
  readonly active: boolean;
  readonly at: number;
}

export interface FakeEspPersistenceSnapshot {
  readonly deviceName?: string;
  readonly deviceId?: string;
  readonly frequency?: number;
  readonly resolution?: number;
  readonly time?: FakeEspTimeSnapshot;
  readonly schedule?: string;
  readonly lastError?: FakeEspLastError;
}

export type FakeEspEepromSnapshot = Omit<
  FakeEspPersistenceSnapshot,
  "schedule" | "lastError"
>;

export interface FakeEspPersistence {
  read(): FakeEspPersistenceSnapshot;
  writeEeprom(values: FakeEspEepromSnapshot): void;
  clearEeprom(): void;
  writeSchedule(schedule: string): void;
  writeLastError(lastError: FakeEspLastError): void;
}

export class MemoryFakeEspPersistence implements FakeEspPersistence {
  private deviceName: string | undefined;
  private deviceId: string | undefined;
  private frequency: number | undefined;
  private resolution: number | undefined;
  private time: FakeEspTimeSnapshot | undefined;
  private schedule: string | undefined;
  private lastError: FakeEspLastError | undefined;

  public constructor(seed: FakeEspPersistenceSnapshot = {}) {
    this.deviceName = seed.deviceName;
    this.deviceId = seed.deviceId;
    this.frequency = seed.frequency;
    this.resolution = seed.resolution;
    this.time = seed.time;
    this.schedule = seed.schedule;
    this.lastError = seed.lastError;
  }

  public read(): FakeEspPersistenceSnapshot {
    return {
      ...(this.deviceName === undefined ? {} : { deviceName: this.deviceName }),
      ...(this.deviceId === undefined ? {} : { deviceId: this.deviceId }),
      ...(this.frequency === undefined ? {} : { frequency: this.frequency }),
      ...(this.resolution === undefined ? {} : { resolution: this.resolution }),
      ...(this.time === undefined ? {} : { time: { ...this.time } }),
      ...(this.schedule === undefined ? {} : { schedule: this.schedule }),
      ...(this.lastError === undefined
        ? {}
        : { lastError: { ...this.lastError } }),
    };
  }

  public writeEeprom(values: FakeEspEepromSnapshot): void {
    this.deviceName = values.deviceName;
    this.deviceId = values.deviceId;
    this.frequency = values.frequency;
    this.resolution = values.resolution;
    this.time = values.time;
  }

  public clearEeprom(): void {
    this.deviceName = undefined;
    this.deviceId = undefined;
    this.frequency = undefined;
    this.resolution = undefined;
    this.time = undefined;
  }

  public writeSchedule(schedule: string): void {
    this.schedule = schedule;
  }

  public writeLastError(lastError: FakeEspLastError): void {
    this.lastError = { ...lastError };
  }
}
