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
  FakeEspEepromSnapshot,
  FakeEspLastError,
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
  private readonly lastErrorPath: string;

  public constructor(directory: string) {
    if (!isAbsolute(directory)) {
      throw new Error(
        "Fake ESP persistence directory must be an absolute path",
      );
    }
    mkdirSync(directory, { recursive: true });
    this.eepromPath = join(directory, "eeprom.json");
    this.schedulePath = join(directory, "schedule.json");
    this.lastErrorPath = join(directory, "last-error.json");
  }

  public read(): FakeEspPersistenceSnapshot {
    const eeprom = existsSync(this.eepromPath)
      ? parseEeprom(readFileSync(this.eepromPath, "utf8"))
      : undefined;
    const schedule = existsSync(this.schedulePath)
      ? readFileSync(this.schedulePath, "utf8")
      : undefined;
    const lastError = existsSync(this.lastErrorPath)
      ? parseLastError(readFileSync(this.lastErrorPath, "utf8"))
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
      ...(lastError === undefined ? {} : { lastError }),
    };
  }

  public writeEeprom(values: FakeEspEepromSnapshot): void {
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

  public writeLastError(lastError: FakeEspLastError): void {
    atomicWrite(
      this.lastErrorPath,
      `${JSON.stringify({ schemaVersion: 1, ...lastError })}\n`,
    );
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

function parseLastError(json: string): FakeEspLastError {
  const value: unknown = JSON.parse(json);
  if (!isRecord(value) || value.schemaVersion !== 1) {
    throw new Error("Unsupported fake ESP last-error document");
  }
  const allowedFields = new Set([
    "schemaVersion",
    "code",
    "severity",
    "message",
    "sequence",
    "active",
    "at",
  ]);
  const excessField = Object.keys(value).find(
    (field) => !allowedFields.has(field),
  );
  if (excessField !== undefined) {
    throw new Error(`Unexpected fake ESP last-error field ${excessField}`);
  }
  if (
    typeof value.code !== "string" ||
    !/^[a-z0-9_]{1,48}$/u.test(value.code) ||
    (value.severity !== "warning" && value.severity !== "error") ||
    typeof value.message !== "string" ||
    value.message.length < 1 ||
    value.message.length > 160 ||
    !Number.isSafeInteger(value.sequence) ||
    (value.sequence as number) < 1 ||
    (value.sequence as number) > 0xffff_ffff ||
    typeof value.active !== "boolean" ||
    !Number.isSafeInteger(value.at) ||
    (value.at as number) < 0 ||
    (value.at as number) > 2_147_483_647
  ) {
    throw new Error("Invalid fake ESP last-error document");
  }
  return {
    code: value.code,
    severity: value.severity,
    message: value.message,
    sequence: value.sequence as number,
    active: value.active,
    at: value.at as number,
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
