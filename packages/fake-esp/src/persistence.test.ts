import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { FileFakeEspPersistence } from "./file-persistence.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("file-backed fake ESP persistence", () => {
  it("persists EEPROM and SPIFFS schedule independently", () => {
    const directory = temporaryDirectory();
    const persistence = new FileFakeEspPersistence(directory);
    persistence.writeEeprom({
      deviceName: "Alpha",
      deviceId: "A1B2C3D4",
      frequency: 6_000,
      resolution: 10,
      time: { lastSavedEpochSeconds: 1_735_689_600 },
    });
    persistence.writeSchedule('{"c":[]}');

    expect(new FileFakeEspPersistence(directory).read()).toEqual({
      deviceName: "Alpha",
      deviceId: "A1B2C3D4",
      frequency: 6_000,
      resolution: 10,
      time: { lastSavedEpochSeconds: 1_735_689_600 },
      schedule: '{"c":[]}',
    });

    persistence.clearEeprom();
    expect(new FileFakeEspPersistence(directory).read()).toEqual({
      schedule: '{"c":[]}',
    });
  });

  it("writes UTF-8 without a BOM", () => {
    const directory = temporaryDirectory();
    const persistence = new FileFakeEspPersistence(directory);
    persistence.writeEeprom({ deviceName: "Alpha", deviceId: "A1B2C3D4" });

    const bytes = readFileSync(join(directory, "eeprom.json"));
    expect([...bytes.subarray(0, 3)]).not.toEqual([0xef, 0xbb, 0xbf]);
  });

  it("fails loudly on malformed or unsupported EEPROM state", () => {
    const directory = temporaryDirectory();
    writeFileSync(join(directory, "eeprom.json"), "{", "utf8");
    expect(() => new FileFakeEspPersistence(directory).read()).toThrow();

    writeFileSync(
      join(directory, "eeprom.json"),
      '{"schemaVersion":2}',
      "utf8",
    );
    expect(() => new FileFakeEspPersistence(directory).read()).toThrow(
      /Unsupported/,
    );

    writeFileSync(
      join(directory, "eeprom.json"),
      '{"schemaVersion":1,"unexpected":true}',
      "utf8",
    );
    expect(() => new FileFakeEspPersistence(directory).read()).toThrow(
      /Unexpected/,
    );
  });

  it("requires an explicit absolute storage directory", () => {
    expect(() => new FileFakeEspPersistence("relative/device")).toThrow(
      /absolute/,
    );
  });
});

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "aquarium-fake-esp-"));
  temporaryDirectories.push(directory);
  return directory;
}
