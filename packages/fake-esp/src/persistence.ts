export interface FakeEspTimeSnapshot {
  readonly lastSavedEpochSeconds: number;
}

export interface FakeEspPersistenceSnapshot {
  readonly deviceName?: string;
  readonly deviceId?: string;
  readonly frequency?: number;
  readonly resolution?: number;
  readonly time?: FakeEspTimeSnapshot;
  readonly schedule?: string;
}

export interface FakeEspPersistence {
  read(): FakeEspPersistenceSnapshot;
  writeEeprom(values: Omit<FakeEspPersistenceSnapshot, "schedule">): void;
  clearEeprom(): void;
  writeSchedule(schedule: string): void;
}

export class MemoryFakeEspPersistence implements FakeEspPersistence {
  private deviceName: string | undefined;
  private deviceId: string | undefined;
  private frequency: number | undefined;
  private resolution: number | undefined;
  private time: FakeEspTimeSnapshot | undefined;
  private schedule: string | undefined;

  public constructor(seed: FakeEspPersistenceSnapshot = {}) {
    this.deviceName = seed.deviceName;
    this.deviceId = seed.deviceId;
    this.frequency = seed.frequency;
    this.resolution = seed.resolution;
    this.time = seed.time;
    this.schedule = seed.schedule;
  }

  public read(): FakeEspPersistenceSnapshot {
    return {
      ...(this.deviceName === undefined ? {} : { deviceName: this.deviceName }),
      ...(this.deviceId === undefined ? {} : { deviceId: this.deviceId }),
      ...(this.frequency === undefined ? {} : { frequency: this.frequency }),
      ...(this.resolution === undefined ? {} : { resolution: this.resolution }),
      ...(this.time === undefined ? {} : { time: { ...this.time } }),
      ...(this.schedule === undefined ? {} : { schedule: this.schedule }),
    };
  }

  public writeEeprom(
    values: Omit<FakeEspPersistenceSnapshot, "schedule">,
  ): void {
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
}
