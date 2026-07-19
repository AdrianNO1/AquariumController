import {
  appendFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import BetterSqlite3 from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import {
  closeControllerDatabases,
  commitStateChange,
  mirrorPendingStateEvents,
  openControllerDatabases,
  type ControllerDatabases,
  type StateChangeEvent,
} from "../database/index.js";
import {
  controllerBackupDirectoryName,
  createControllerBackup,
  restoreControllerBackup,
  sqliteBackupManifestSchema,
  verifyControllerBackup,
} from "./sqlite-backup.js";

const BACKUP_TIME = new Date("2026-07-10T20:00:00.000Z");
const temporaryDirectories: string[] = [];
const openDatabases: ControllerDatabases[] = [];

afterEach(async () => {
  await Promise.all(openDatabases.splice(0).map(closeControllerDatabases));
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("SQLite controller backup", () => {
  it("backs up real controller schemas, verifies boundaries, and restores to empty paths", async () => {
    const directory = await createTemporaryDirectory();
    const source = await createControllerDatabases(directory, "live");
    const first = await commitTestEvent(source, 10, "first");
    await mirrorPendingStateEvents(source.state, source.events, { nowMs: 20 });

    const backup = await createControllerBackup({
      stateDatabaseFile: join(directory, "live-state.db"),
      eventsDatabaseFile: join(directory, "live-events.db"),
      destinationDirectory: join(directory, "backups"),
      now: () => BACKUP_TIME,
    });

    expect(backup.manifest).toMatchObject({
      schemaVersion: 2,
      revisionBoundaries: {
        stateRevisionAtEventsCopyStart: first.revision,
        eventsRevision: first.revision,
        stateRevision: first.revision,
      },
    });
    expect(backup.manifest.files.map((file) => file.kind)).toEqual([
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
    const restored = await openControllerDatabases({
      state: { filename: restoredState, migrate: false },
      events: { filename: restoredEvents, migrate: false },
    });
    openDatabases.push(restored);

    await expect(readRevisions(restored)).resolves.toEqual({
      state: [first.revision],
      events: [first.revision],
    });
  });

  it("recovers an interleaved commit and mirror, then continues the revision stream after restore", async () => {
    const directory = await createTemporaryDirectory();
    const source = await createControllerDatabases(directory, "live");
    const first = await commitTestEvent(source, 10, "first-pending");
    let secondRevision: number | null = null;

    const backup = await createControllerBackup({
      stateDatabaseFile: join(directory, "live-state.db"),
      eventsDatabaseFile: join(directory, "live-events.db"),
      destinationDirectory: join(directory, "backups"),
      now: () => BACKUP_TIME,
      afterEventsDatabaseCopy: async () => {
        await mirrorPendingStateEvents(source.state, source.events, {
          nowMs: 20,
        });
        const second = await commitTestEvent(source, 30, "second-interleaved");
        secondRevision = second.revision;
        await mirrorPendingStateEvents(source.state, source.events, {
          nowMs: 40,
        });
      },
    });

    expect(secondRevision).toBe(2);
    expect(backup.manifest.revisionBoundaries).toEqual({
      stateRevisionAtEventsCopyStart: first.revision,
      eventsRevision: 0,
      stateRevision: 2,
    });
    expect((await readdir(backup.directory)).sort()).toEqual([
      "events.db",
      "manifest.json",
      "state.db",
    ]);
    expect(readOutboxRecoveryRows(join(backup.directory, "state.db"))).toEqual([
      {
        revision: 1,
        available_at_ms: 10,
        published_at_ms: null,
        last_error: null,
      },
      {
        revision: 2,
        available_at_ms: 30,
        published_at_ms: null,
        last_error: null,
      },
    ]);

    const restoredState = join(directory, "restored", "state.db");
    const restoredEvents = join(directory, "restored", "events.db");
    await restoreControllerBackup(backup.manifestFile, {
      stateDatabaseFile: restoredState,
      eventsDatabaseFile: restoredEvents,
    });
    const restored = await openControllerDatabases({
      state: { filename: restoredState, migrate: false },
      events: { filename: restoredEvents, migrate: false },
    });
    openDatabases.push(restored);

    await expect(
      mirrorPendingStateEvents(restored.state, restored.events, {
        nowMs: 100,
        batchSize: 1_000,
      }),
    ).resolves.toEqual({ mirroredRevisions: [1, 2] });
    const third = await commitTestEvent(restored, 110, "third-after-restore");
    expect(third.revision).toBe(3);
    await expect(
      mirrorPendingStateEvents(restored.state, restored.events, {
        nowMs: 120,
      }),
    ).resolves.toEqual({ mirroredRevisions: [3] });
    await expect(readRevisions(restored)).resolves.toEqual({
      state: [1, 2, 3],
      events: [1, 2, 3],
    });
  });

  it("rejects missing capture-boundary outbox coverage and removes the failed backup", async () => {
    const directory = await createTemporaryDirectory();
    const source = await createControllerDatabases(directory, "live");
    await commitTestEvent(source, 10, "missing-outbox");
    await source.state
      .deleteFrom("state_outbox")
      .where("revision", "=", 1)
      .executeTakeFirstOrThrow();
    const destinationDirectory = join(directory, "backups");

    await expect(
      createControllerBackup({
        stateDatabaseFile: join(directory, "live-state.db"),
        eventsDatabaseFile: join(directory, "live-events.db"),
        destinationDirectory,
        now: () => BACKUP_TIME,
      }),
    ).rejects.toThrow(/state_outbox is missing required revision 1/u);
    await expect(
      stat(
        join(destinationDirectory, controllerBackupDirectoryName(BACKUP_TIME)),
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("rejects a copied event boundary that leads authoritative state", async () => {
    const directory = await createTemporaryDirectory();
    const source = await createControllerDatabases(directory, "live");
    await source.events
      .insertInto("state_events")
      .values({
        revision: 1,
        occurred_at_ms: 10,
        event_type: "impossible.leading-event",
        entity_type: "controller",
        entity_id: null,
        retention_class: "audit",
        payload_json: "{}",
        payload_schema_version: 1,
        byte_count: 2,
      })
      .executeTakeFirstOrThrow();

    await expect(
      createControllerBackup({
        stateDatabaseFile: join(directory, "live-state.db"),
        eventsDatabaseFile: join(directory, "live-events.db"),
        destinationDirectory: join(directory, "backups"),
        now: () => BACKUP_TIME,
      }),
    ).rejects.toThrow(/events revision 1 exceeds state revision 0/u);
  });

  it("rejects a retained event that conflicts with its authoritative outbox row", async () => {
    const directory = await createTemporaryDirectory();
    const source = await createControllerDatabases(directory, "live");
    await commitTestEvent(source, 10, "conflict");
    await mirrorPendingStateEvents(source.state, source.events, { nowMs: 20 });
    await source.events
      .updateTable("state_events")
      .set({ event_type: "conflicting.event" })
      .where("revision", "=", 1)
      .executeTakeFirstOrThrow();

    await expect(
      createControllerBackup({
        stateDatabaseFile: join(directory, "live-state.db"),
        eventsDatabaseFile: join(directory, "live-events.db"),
        destinationDirectory: join(directory, "backups"),
        now: () => BACKUP_TIME,
      }),
    ).rejects.toThrow(/conflicts with its outbox row/u);
  });

  it("rejects a tampered revision boundary during verification and restore", async () => {
    const directory = await createTemporaryDirectory();
    const source = await createControllerDatabases(directory, "live");
    await commitTestEvent(source, 10, "boundary-tamper");
    await mirrorPendingStateEvents(source.state, source.events, { nowMs: 20 });
    const backup = await createControllerBackup({
      stateDatabaseFile: join(directory, "live-state.db"),
      eventsDatabaseFile: join(directory, "live-events.db"),
      destinationDirectory: join(directory, "backups"),
      now: () => BACKUP_TIME,
    });
    const manifest = sqliteBackupManifestSchema.parse(
      JSON.parse(await readFile(backup.manifestFile, "utf8")),
    );
    await writeFile(
      backup.manifestFile,
      `${JSON.stringify(
        {
          ...manifest,
          revisionBoundaries: {
            ...manifest.revisionBoundaries,
            stateRevision: manifest.revisionBoundaries.stateRevision + 1,
          },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );

    await expect(verifyControllerBackup(backup.manifestFile)).rejects.toThrow(
      /State revision boundary mismatch/u,
    );
    const restoredState = join(directory, "restore", "state.db");
    const restoredEvents = join(directory, "restore", "events.db");
    await expect(
      restoreControllerBackup(backup.manifestFile, {
        stateDatabaseFile: restoredState,
        eventsDatabaseFile: restoredEvents,
      }),
    ).rejects.toThrow(/State revision boundary mismatch/u);
    await expect(stat(restoredState)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(restoredEvents)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("rejects legacy manifest schema v1 instead of weakening coherence checks", async () => {
    const directory = await createTemporaryDirectory();
    await createControllerDatabases(directory, "live");
    const backup = await createControllerBackup({
      stateDatabaseFile: join(directory, "live-state.db"),
      eventsDatabaseFile: join(directory, "live-events.db"),
      destinationDirectory: join(directory, "backups"),
      now: () => BACKUP_TIME,
    });
    const legacyManifest = {
      schemaVersion: 1,
      createdAt: backup.manifest.createdAt,
      files: backup.manifest.files,
    };
    await writeFile(
      backup.manifestFile,
      `${JSON.stringify(legacyManifest, null, 2)}\n`,
      "utf8",
    );

    await expect(verifyControllerBackup(backup.manifestFile)).rejects.toThrow(
      /schemaVersion/u,
    );
  });

  it("atomically reserves a timestamped directory under concurrent collision", async () => {
    const directory = await createTemporaryDirectory();
    await createControllerDatabases(directory, "live");
    const request = {
      stateDatabaseFile: join(directory, "live-state.db"),
      eventsDatabaseFile: join(directory, "live-events.db"),
      destinationDirectory: join(directory, "backups"),
      now: () => BACKUP_TIME,
    };

    const results = await Promise.allSettled([
      createControllerBackup(request),
      createControllerBackup(request),
    ]);
    const fulfilled = results.filter(
      (
        result,
      ): result is PromiseFulfilledResult<
        Awaited<ReturnType<typeof createControllerBackup>>
      > => result.status === "fulfilled",
    );
    const rejected = results.filter(
      (result): result is PromiseRejectedResult => result.status === "rejected",
    );
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    expect(rejected[0]?.reason).toBeInstanceOf(Error);
    expect(String(rejected[0]?.reason)).toMatch(/already exists/u);
    const winner = fulfilled[0];
    if (winner === undefined) throw new Error("Expected one backup winner");
    await expect(
      verifyControllerBackup(winner.value.manifestFile),
    ).resolves.toEqual(winner.value.manifest);
  });

  it("rejects missing controller schemas and removes the incomplete directory", async () => {
    const directory = await createTemporaryDirectory();
    const state = join(directory, "state.db");
    const events = join(directory, "events.db");
    seedNonControllerDatabase(state, "state_fixture");
    seedNonControllerDatabase(events, "events_fixture");
    const destinationDirectory = join(directory, "backups");

    await expect(
      createControllerBackup({
        stateDatabaseFile: state,
        eventsDatabaseFile: events,
        destinationDirectory,
        now: () => BACKUP_TIME,
      }),
    ).rejects.toThrow(/missing the required controller revision schema/u);
    await expect(
      stat(
        join(destinationDirectory, controllerBackupDirectoryName(BACKUP_TIME)),
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not overwrite an existing backup or restore destination", async () => {
    const directory = await createTemporaryDirectory();
    await createControllerDatabases(directory, "live");
    const request = {
      stateDatabaseFile: join(directory, "live-state.db"),
      eventsDatabaseFile: join(directory, "live-events.db"),
      destinationDirectory: join(directory, "backups"),
      now: () => BACKUP_TIME,
    };
    const backup = await createControllerBackup(request);

    await expect(createControllerBackup(request)).rejects.toThrow(
      /already exists/u,
    );
    await expect(
      restoreControllerBackup(backup.manifestFile, {
        stateDatabaseFile: request.stateDatabaseFile,
        eventsDatabaseFile: join(directory, "new-events.db"),
      }),
    ).rejects.toThrow(/must not exist/u);
    const sameDestination = join(directory, "same-destination.db");
    await expect(
      restoreControllerBackup(backup.manifestFile, {
        stateDatabaseFile: sameDestination,
        eventsDatabaseFile: sameDestination,
      }),
    ).rejects.toThrow(/destinations must differ/u);
    await expect(stat(sameDestination)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("rejects SQLite sidecars beside a backup or restore destination", async () => {
    const directory = await createTemporaryDirectory();
    await createControllerDatabases(directory, "live");
    const backup = await createControllerBackup({
      stateDatabaseFile: join(directory, "live-state.db"),
      eventsDatabaseFile: join(directory, "live-events.db"),
      destinationDirectory: join(directory, "backups"),
      now: () => BACKUP_TIME,
    });
    const eventsFile = backup.manifest.files.find(
      (file) => file.kind === "events",
    );
    if (eventsFile === undefined)
      throw new Error("Backup is missing events.db");
    const backupSidecar = join(backup.directory, `${eventsFile.filename}-wal`);
    await writeFile(backupSidecar, "stale-wal", "utf8");

    await expect(verifyControllerBackup(backup.manifestFile)).rejects.toThrow(
      /must not have a -wal sidecar/u,
    );
    await rm(backupSidecar);

    const restoredState = join(directory, "restore", "state.db");
    const restoredEvents = join(directory, "restore", "events.db");
    await mkdir(join(directory, "restore"), { recursive: true });
    await writeFile(`${restoredState}-journal`, "stale-journal", "utf8");

    await expect(
      restoreControllerBackup(backup.manifestFile, {
        stateDatabaseFile: restoredState,
        eventsDatabaseFile: restoredEvents,
      }),
    ).rejects.toThrow(/must not exist/u);
    await expect(readFile(`${restoredState}-journal`, "utf8")).resolves.toBe(
      "stale-journal",
    );
    await expect(stat(restoredState)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(restoredEvents)).rejects.toMatchObject({
      code: "ENOENT",
    });

    await rm(`${restoredState}-journal`);
    await expect(
      restoreControllerBackup(backup.manifestFile, {
        stateDatabaseFile: restoredState,
        eventsDatabaseFile: restoredEvents,
        beforeDatabaseFilePublish: async (destinationFile) => {
          if (destinationFile === restoredState) {
            await writeFile(`${destinationFile}-wal`, "concurrent-wal", {
              encoding: "utf8",
              flag: "wx",
            });
          }
        },
      }),
    ).rejects.toThrow(/must not have a -wal sidecar/u);
    await expect(readFile(`${restoredState}-wal`, "utf8")).resolves.toBe(
      "concurrent-wal",
    );
    await expect(stat(restoredState)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(stat(restoredEvents)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("does not replace a destination created in the restore publish window", async () => {
    const directory = await createTemporaryDirectory();
    await createControllerDatabases(directory, "live");
    const backup = await createControllerBackup({
      stateDatabaseFile: join(directory, "live-state.db"),
      eventsDatabaseFile: join(directory, "live-events.db"),
      destinationDirectory: join(directory, "backups"),
      now: () => BACKUP_TIME,
    });
    const restoredState = join(directory, "restore", "state.db");
    const restoredEvents = join(directory, "restore", "events.db");

    await expect(
      restoreControllerBackup(backup.manifestFile, {
        stateDatabaseFile: restoredState,
        eventsDatabaseFile: restoredEvents,
        beforeDatabaseFilePublish: async (destinationFile) => {
          if (destinationFile === restoredState) {
            await writeFile(destinationFile, "operator-created", {
              encoding: "utf8",
              flag: "wx",
            });
          }
        },
      }),
    ).rejects.toMatchObject({ code: "EEXIST" });
    await expect(readFile(restoredState, "utf8")).resolves.toBe(
      "operator-created",
    );
    await expect(stat(restoredEvents)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("rejects a corrupted backup before restoration", async () => {
    const directory = await createTemporaryDirectory();
    await createControllerDatabases(directory, "live");
    const backup = await createControllerBackup({
      stateDatabaseFile: join(directory, "live-state.db"),
      eventsDatabaseFile: join(directory, "live-events.db"),
      destinationDirectory: join(directory, "backups"),
      now: () => BACKUP_TIME,
    });
    const stateFile = backup.manifest.files.find(
      (file) => file.kind === "state",
    );
    if (stateFile === undefined) throw new Error("Backup is missing state.db");
    await appendFile(join(backup.directory, stateFile.filename), "corrupt");

    await expect(verifyControllerBackup(backup.manifestFile)).rejects.toThrow(
      /size mismatch|checksum mismatch/u,
    );
  });
});

async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "aquarium-backup-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function createControllerDatabases(
  directory: string,
  prefix: string,
): Promise<ControllerDatabases> {
  const databases = await openControllerDatabases({
    state: { filename: join(directory, `${prefix}-state.db`) },
    events: { filename: join(directory, `${prefix}-events.db`) },
  });
  openDatabases.push(databases);
  return databases;
}

async function commitTestEvent(
  databases: ControllerDatabases,
  occurredAtMs: number,
  id: string,
): ReturnType<typeof commitStateChange<void>> {
  return commitStateChange(
    databases.state,
    createTestEvent(occurredAtMs, id),
    async () => undefined,
  );
}

function createTestEvent(occurredAtMs: number, id: string): StateChangeEvent {
  return {
    actor: "backup-test",
    mutationType: "backup.fixture",
    summary: `Commit backup fixture ${id}`,
    eventType: "backup.fixture-committed",
    occurredAtMs,
    retentionClass: "audit",
    payloadJson: JSON.stringify({ id }),
    payloadSchemaVersion: 1,
    entityType: "controller",
  };
}

async function readRevisions(databases: ControllerDatabases): Promise<{
  readonly state: readonly number[];
  readonly events: readonly number[];
}> {
  const [state, events] = await Promise.all([
    databases.state
      .selectFrom("state_revisions")
      .select("revision")
      .orderBy("revision")
      .execute(),
    databases.events
      .selectFrom("state_events")
      .select("revision")
      .orderBy("revision")
      .execute(),
  ]);
  return {
    state: state.map(({ revision }) => revision),
    events: events.map(({ revision }) => revision),
  };
}

function readOutboxRecoveryRows(filename: string): readonly {
  readonly revision: number;
  readonly available_at_ms: number;
  readonly published_at_ms: number | null;
  readonly last_error: string | null;
}[] {
  const database = new BetterSqlite3(filename, {
    readonly: true,
    fileMustExist: true,
  });
  try {
    return database
      .prepare<
        [],
        {
          readonly revision: number;
          readonly available_at_ms: number;
          readonly published_at_ms: number | null;
          readonly last_error: string | null;
        }
      >(
        `SELECT revision, available_at_ms, published_at_ms, last_error
         FROM state_outbox
         ORDER BY revision`,
      )
      .all();
  } finally {
    database.close();
  }
}

function seedNonControllerDatabase(filename: string, table: string): void {
  const database = new BetterSqlite3(filename);
  try {
    database.exec(
      `CREATE TABLE ${table} (id INTEGER PRIMARY KEY, value TEXT NOT NULL) STRICT`,
    );
  } finally {
    database.close();
  }
}
