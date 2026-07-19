import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join } from "node:path";

import type {
  FakeEspPersistence,
  FakeEspPersistenceSnapshot,
  FakeEspTimeSnapshot,
} from "./persistence.js";

interface PersistedEepromDocument {
  readonly schemaVersion: 1;
  readonly deviceName?: string;
  readonly deviceId?: string;
  readonly frequency?: number;
  readonly resolution?: number;
  readonly time?: FakeEspTimeSnapshot;
}

export class FileFakeEspPersistence implements FakeEspPersistence {
  private readonly eepromPath: string;
  private readonly schedulePath: string;

  public constructor(directory: string) {
    if (!isAbsolute(directory)) {
      throw new Error(
        "Fake ESP persistence directory must be an absolute path",
      );
    }
    mkdirSync(directory, { recursive: true });
    this.eepromPath = join(directory, "eeprom.json");
    this.schedulePath = join(directory, "schedule.json");
  }

  public read(): FakeEspPersistenceSnapshot {
    const eeprom = existsSync(this.eepromPath)
      ? parseEeprom(readFileSync(this.eepromPath, "utf8"))
      : undefined;
    const schedule = existsSync(this.schedulePath)
      ? readFileSync(this.schedulePath, "utf8")
      : undefined;

    return {
      ...(eeprom?.deviceName === undefined
        ? {}
        : { deviceName: eeprom.deviceName }),
      ...(eeprom?.deviceId === undefined ? {} : { deviceId: eeprom.deviceId }),
      ...(eeprom?.frequency === undefined
        ? {}
        : { frequency: eeprom.frequency }),
      ...(eeprom?.resolution === undefined
        ? {}
        : { resolution: eeprom.resolution }),
      ...(eeprom?.time === undefined ? {} : { time: { ...eeprom.time } }),
      ...(schedule === undefined ? {} : { schedule }),
    };
  }

  public writeEeprom(
    values: Omit<FakeEspPersistenceSnapshot, "schedule">,
  ): void {
    const document: PersistedEepromDocument = {
      schemaVersion: 1,
      ...(values.deviceName === undefined
        ? {}
        : { deviceName: values.deviceName }),
      ...(values.deviceId === undefined ? {} : { deviceId: values.deviceId }),
      ...(values.frequency === undefined
        ? {}
        : { frequency: values.frequency }),
      ...(values.resolution === undefined
        ? {}
        : { resolution: values.resolution }),
      ...(values.time === undefined ? {} : { time: { ...values.time } }),
    };
    atomicWrite(this.eepromPath, `${JSON.stringify(document)}\n`);
  }

  public clearEeprom(): void {
    if (existsSync(this.eepromPath)) {
      unlinkSync(this.eepromPath);
    }
  }

  public writeSchedule(schedule: string): void {
    atomicWrite(this.schedulePath, schedule);
  }
}

function atomicWrite(path: string, contents: string): void {
  const temporaryPath = `${path}.${process.pid}.tmp`;
  writeFileSync(temporaryPath, contents, { encoding: "utf8", flag: "w" });
  renameSync(temporaryPath, path);
}

function parseEeprom(json: string): PersistedEepromDocument {
  const value: unknown = JSON.parse(json);
  if (!isRecord(value) || value.schemaVersion !== 1) {
    throw new Error("Unsupported fake ESP EEPROM document");
  }
  const allowedFields = new Set([
    "schemaVersion",
    "deviceName",
    "deviceId",
    "frequency",
    "resolution",
    "time",
  ]);
  const excessField = Object.keys(value).find(
    (field) => !allowedFields.has(field),
  );
  if (excessField !== undefined) {
    throw new Error(`Unexpected fake ESP EEPROM field ${excessField}`);
  }
  assertOptionalString(value.deviceName, "deviceName");
  assertOptionalString(value.deviceId, "deviceId");
  assertOptionalInteger(value.frequency, "frequency");
  assertOptionalInteger(value.resolution, "resolution");

  let time: FakeEspTimeSnapshot | undefined;
  if (value.time !== undefined) {
    if (
      !isRecord(value.time) ||
      !Number.isSafeInteger(value.time.lastSavedEpochSeconds)
    ) {
      throw new Error("Invalid fake ESP EEPROM time");
    }
    time = {
      lastSavedEpochSeconds: value.time.lastSavedEpochSeconds as number,
    };
  }

  return {
    schemaVersion: 1,
    ...(value.deviceName === undefined
      ? {}
      : { deviceName: value.deviceName as string }),
    ...(value.deviceId === undefined
      ? {}
      : { deviceId: value.deviceId as string }),
    ...(value.frequency === undefined
      ? {}
      : { frequency: value.frequency as number }),
    ...(value.resolution === undefined
      ? {}
      : { resolution: value.resolution as number }),
    ...(time === undefined ? {} : { time }),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function assertOptionalString(value: unknown, field: string): void {
  if (value !== undefined && typeof value !== "string") {
    throw new Error(`Invalid fake ESP EEPROM ${field}`);
  }
}

function assertOptionalInteger(value: unknown, field: string): void {
  if (value !== undefined && !Number.isSafeInteger(value)) {
    throw new Error(`Invalid fake ESP EEPROM ${field}`);
  }
}
