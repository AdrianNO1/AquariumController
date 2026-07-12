import { appendFile, mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import BetterSqlite3 from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import {
  createControllerBackup,
  restoreControllerBackup,
  verifyControllerBackup,
} from "./sqlite-backup.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  const { rm } = await import("node:fs/promises");
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("SQLite controller backup", () => {
  it("backs up both databases, verifies them, and restores to empty paths", async () => {
    const directory = await createTemporaryDirectory();
    const state = join(directory, "live-state.db");
    const events = join(directory, "live-events.db");
    seedDatabase(state, "devices", "state-before-backup");
    seedDatabase(events, "interactions", "events-before-backup");

    const backup = await createControllerBackup({
      stateDatabaseFile: state,
      eventsDatabaseFile: events,
      destinationDirectory: join(directory, "backups"),
      now: () => new Date("2026-07-10T20:00:00.000Z"),
    });

    expect(backup.manifest.files.map((file) => file.kind).sort()).toEqual([
      "events",
      "state",
    ]);
    await expect(verifyControllerBackup(backup.manifestFile)).resolves.toEqual(
      backup.manifest,
    );

    const restoredState = join(directory, "restore", "state.db");
    const restoredEvents = join(directory, "restore", "events.db");
    await restoreControllerBackup(backup.manifestFile, {
      stateDatabaseFile: restoredState,
      eventsDatabaseFile: restoredEvents,
    });

    expect(readValue(restoredState, "devices")).toBe("state-before-backup");
    expect(readValue(restoredEvents, "interactions")).toBe(
      "events-before-backup",
    );
  });

  it("does not overwrite an existing backup or restore destination", async () => {
    const directory = await createTemporaryDirectory();
    const state = join(directory, "state.db");
    const events = join(directory, "events.db");
    seedDatabase(state, "devices", "state");
    seedDatabase(events, "interactions", "events");
    const request = {
      stateDatabaseFile: state,
      eventsDatabaseFile: events,
      destinationDirectory: join(directory, "backups"),
      now: () => new Date("2026-07-10T20:00:00.000Z"),
    };
    const backup = await createControllerBackup(request);

    await expect(createControllerBackup(request)).rejects.toThrow(
      /already exists/,
    );
    await expect(
      restoreControllerBackup(backup.manifestFile, {
        stateDatabaseFile: state,
        eventsDatabaseFile: join(directory, "new-events.db"),
      }),
    ).rejects.toThrow(/must not exist/);
  });

  it("rejects a corrupted backup before restoration", async () => {
    const directory = await createTemporaryDirectory();
    const state = join(directory, "state.db");
    const events = join(directory, "events.db");
    seedDatabase(state, "devices", "state");
    seedDatabase(events, "interactions", "events");
    const backup = await createControllerBackup({
      stateDatabaseFile: state,
      eventsDatabaseFile: events,
      destinationDirectory: join(directory, "backups"),
      now: () => new Date("2026-07-10T20:00:00.000Z"),
    });
    const manifest = JSON.parse(
      await readFile(backup.manifestFile, "utf8"),
    ) as typeof backup.manifest;
    const stateFile = manifest.files.find((file) => file.kind === "state");
    if (stateFile === undefined) {
      throw new Error("Test backup is missing state.db");
    }
    await appendFile(join(backup.directory, stateFile.filename), "corrupt");

    await expect(verifyControllerBackup(backup.manifestFile)).rejects.toThrow(
      /size mismatch|checksum mismatch/,
    );
  });
});

async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "aquarium-backup-"));
  temporaryDirectories.push(directory);
  return directory;
}

function seedDatabase(filename: string, table: string, value: string): void {
  const database = new BetterSqlite3(filename);
  try {
    database.exec(
      `CREATE TABLE ${table} (id INTEGER PRIMARY KEY, value TEXT NOT NULL) STRICT`,
    );
    database.prepare(`INSERT INTO ${table} (value) VALUES (?)`).run(value);
  } finally {
    database.close();
  }
}

function readValue(filename: string, table: string): string {
  const database = new BetterSqlite3(filename, {
    readonly: true,
    fileMustExist: true,
  });
  try {
    const row = database
      .prepare<[], { readonly value: string }>(
        `SELECT value FROM ${table} LIMIT 1`,
      )
      .get();
    if (row === undefined) {
      throw new Error(`No value in ${table}`);
    }
    return row.value;
  } finally {
    database.close();
  }
}
