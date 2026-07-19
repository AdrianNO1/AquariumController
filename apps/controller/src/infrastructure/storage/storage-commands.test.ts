import {
  mkdtemp,
  lstat,
  readFile,
  readdir,
  rename,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join, resolve, sep } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { openEventsDatabase, openStateDatabase } from "../database/index.js";
import { createEventArchive } from "./event-archive.js";
import { InteractionRepository } from "./interaction-repository.js";
import {
  executeStorageCommand,
  parseStorageCommandArguments,
} from "./storage-commands.js";

const temporaryDirectories: string[] = [];

afterEach(async () => {
  const temporaryRoot = `${resolve(tmpdir())}${sep}`;
  for (const directory of temporaryDirectories.splice(0)) {
    const resolvedDirectory = resolve(directory);
    if (
      !resolvedDirectory.startsWith(temporaryRoot) ||
      !basename(resolvedDirectory).startsWith("aquarium-storage-command-")
    ) {
      throw new Error(
        `Refusing to remove unexpected path ${resolvedDirectory}`,
      );
    }
    await rm(resolvedDirectory, { recursive: true, force: true });
  }
});

describe("storage command arguments", () => {
  it("requires explicit paths and rejects malformed, unknown, and duplicate flags", () => {
    expect(
      parseStorageCommandArguments([
        "initialize-events",
        "--events-db",
        "events.db",
      ]),
    ).toEqual({
      kind: "initialize-events",
      eventsDatabaseFile: resolve("events.db"),
    });
    expect(
      parseStorageCommandArguments([
        "backup",
        "--state-db",
        "state.db",
        "--events-db",
        "events.db",
        "--destination",
        "backups",
      ]),
    ).toEqual({
      kind: "backup",
      stateDatabaseFile: resolve("state.db"),
      eventsDatabaseFile: resolve("events.db"),
      destinationDirectory: resolve("backups"),
    });
    expect(() => parseStorageCommandArguments([])).toThrow(/must be one of/);
    expect(() =>
      parseStorageCommandArguments(["integrity", "--state-db", "state.db"]),
    ).toThrow(/Missing required/);
    expect(() =>
      parseStorageCommandArguments([
        "verify-backup",
        "--manifest",
        "one.json",
        "--manifest",
        "two.json",
      ]),
    ).toThrow(/Duplicate/);
    expect(() =>
      parseStorageCommandArguments([
        "verify-backup",
        "--manifest",
        "manifest.json",
        "--force",
        "true",
      ]),
    ).toThrow(/Unexpected/);
    expect(() =>
      parseStorageCommandArguments([
        "retention",
        "--events-db",
        "events.db",
        "--archive-dir",
        "archives",
        "--now-ms",
        "-1",
      ]),
    ).toThrow(/non-negative safe integer/);
    expect(
      parseStorageCommandArguments([
        "verify-archive-set",
        "--events-db",
        "events.db",
        "--archive-dir",
        "archives",
        "--output",
        "archive-set.json",
      ]),
    ).toEqual({
      kind: "verify-archive-set",
      eventsDatabaseFile: resolve("events.db"),
      archiveDirectory: resolve("archives"),
      outputFile: resolve("archive-set.json"),
    });
    expect(() =>
      parseStorageCommandArguments([
        "verify-archive",
        "--events-db",
        "events.db",
        "--archive-id",
        "archive-1",
      ]),
    ).toThrow(/Missing required --archive-dir/u);
  });
});

describe("storage command execution", () => {
  it("atomically initializes only a new events database target", async () => {
    const directory = await createTemporaryDirectory();
    const eventsFile = join(directory, "events.db");

    await expect(
      executeStorageCommand({
        kind: "initialize-events",
        eventsDatabaseFile: eventsFile,
      }),
    ).resolves.toEqual({
      command: "initialize-events",
      details: { eventsDatabaseFile: eventsFile, integrityCheck: "ok" },
    });

    const events = await openEventsDatabase({
      filename: eventsFile,
      migrate: false,
    });
    await expect(
      events
        .selectFrom("retention_policies")
        .select(({ fn }) => fn.countAll<number>().as("count"))
        .executeTakeFirstOrThrow(),
    ).resolves.toMatchObject({ count: expect.any(Number) });
    await events.destroy();

    const initializedBytes = await readFile(eventsFile);
    await expect(
      executeStorageCommand({
        kind: "initialize-events",
        eventsDatabaseFile: eventsFile,
      }),
    ).rejects.toThrow(/Events database target already exists/u);
    expect(await readFile(eventsFile)).toEqual(initializedBytes);
    expect(
      (await readdir(directory)).filter((name) => name.includes(".partial-")),
    ).toEqual([]);

    const blockedEventsFile = join(directory, "blocked-events.db");
    await writeFile(`${blockedEventsFile}-wal`, "do-not-overwrite", "utf8");
    await expect(
      executeStorageCommand({
        kind: "initialize-events",
        eventsDatabaseFile: blockedEventsFile,
      }),
    ).rejects.toThrow(/Events database target already exists/u);
    await expect(readFile(blockedEventsFile)).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(readFile(`${blockedEventsFile}-wal`, "utf8")).resolves.toBe(
      "do-not-overwrite",
    );
  });

  it("refuses broken database and sidecar symlinks without replacing them", async () => {
    const directory = await createTemporaryDirectory();
    const linkType = process.platform === "win32" ? "junction" : "file";

    for (const suffix of ["", "-wal"]) {
      const eventsFile = join(
        directory,
        suffix === "" ? "linked-events.db" : "sidecar-linked-events.db",
      );
      const artifact = `${eventsFile}${suffix}`;
      await symlink(
        join(directory, `missing-target${suffix}`),
        artifact,
        linkType,
      );

      await expect(
        executeStorageCommand({
          kind: "initialize-events",
          eventsDatabaseFile: eventsFile,
        }),
      ).rejects.toThrow(/Events database target already exists/u);
      expect((await lstat(artifact)).isSymbolicLink()).toBe(true);
      expect(
        (await readdir(directory)).filter((name) => name.includes(".partial-")),
      ).toEqual([]);
    }
  });

  it("backs up, verifies, restores, checks integrity, verifies an archive, and decodes without overwrite", async () => {
    const directory = await createTemporaryDirectory();
    const stateFile = join(directory, "state.db");
    const eventsFile = join(directory, "events.db");
    const archiveDirectory = join(directory, "archives");
    await createStateFixture(stateFile);
    const events = await openEventsDatabase({ filename: eventsFile });
    const interaction = await new InteractionRepository(events).log({
      occurredAtMs: 10,
      direction: "internal",
      kind: "storage-command-test",
      severity: "info",
      outcome: "succeeded",
      byteCount: 12,
      retentionClass: "raw",
    });
    const created = await createEventArchive({
      database: events,
      archiveDirectory,
      rangeStartMs: 0,
      rangeEndMs: 11,
      nowMs: 11,
      selection: { interactionIds: [interaction.id] },
    });
    await events.destroy();

    const archiveVerification = await executeStorageCommand({
      kind: "verify-archive",
      eventsDatabaseFile: eventsFile,
      archiveDirectory,
      archiveId: created.archive.id,
    });
    expect(archiveVerification).toMatchObject({
      command: "verify-archive",
      details: { recordCount: 1 },
    });

    const firstArchiveSetManifest = join(directory, "archive-set-one.json");
    const secondArchiveSetManifest = join(directory, "archive-set-two.json");
    const archiveSetVerification = await executeStorageCommand({
      kind: "verify-archive-set",
      eventsDatabaseFile: eventsFile,
      archiveDirectory,
      outputFile: firstArchiveSetManifest,
    });
    expect(archiveSetVerification).toMatchObject({
      command: "verify-archive-set",
      details: {
        manifestFile: firstArchiveSetManifest,
        manifest: {
          schemaVersion: 1,
          content: "aquarium-event-archive-set",
          archives: [{ id: created.archive.id }],
        },
      },
    });
    await executeStorageCommand({
      kind: "verify-archive-set",
      eventsDatabaseFile: eventsFile,
      archiveDirectory,
      outputFile: secondArchiveSetManifest,
    });
    expect(await readFile(secondArchiveSetManifest)).toEqual(
      await readFile(firstArchiveSetManifest),
    );
    expect(await readFile(firstArchiveSetManifest, "utf8")).not.toContain(
      directory,
    );
    await expect(
      executeStorageCommand({
        kind: "verify-archive-set",
        eventsDatabaseFile: eventsFile,
        archiveDirectory,
        outputFile: firstArchiveSetManifest,
      }),
    ).rejects.toMatchObject({ code: "EEXIST" });

    const decodedFile = join(directory, "decoded", "events.ndjson");
    await expect(
      executeStorageCommand({
        kind: "decode-archive",
        archiveFile: join(archiveDirectory, created.archive.storagePath),
        outputFile: decodedFile,
      }),
    ).resolves.toMatchObject({
      command: "decode-archive",
      details: { outputFile: decodedFile, recordCount: 1 },
    });
    expect(await readFile(decodedFile, "utf8")).toContain(
      '"kind":"storage-command-test"',
    );
    await expect(
      executeStorageCommand({
        kind: "decode-archive",
        archiveFile: join(archiveDirectory, created.archive.storagePath),
        outputFile: decodedFile,
      }),
    ).rejects.toMatchObject({ code: "EEXIST" });

    const backup = await executeStorageCommand({
      kind: "backup",
      stateDatabaseFile: stateFile,
      eventsDatabaseFile: eventsFile,
      destinationDirectory: join(directory, "backups"),
    });
    if (backup.command !== "backup") {
      throw new Error("Expected a backup result");
    }
    const loggedEvents = await openEventsDatabase({
      filename: eventsFile,
      migrate: false,
    });
    const backupInteraction = await loggedEvents
      .selectFrom("interactions")
      .selectAll()
      .where("kind", "=", "maintenance.backup")
      .orderBy("occurred_at_ms", "desc")
      .orderBy("id", "desc")
      .executeTakeFirstOrThrow();
    expect(backupInteraction).toMatchObject({
      direction: "internal",
      kind: "maintenance.backup",
      severity: "info",
      outcome: "succeeded",
      byte_count: 0,
      retention_class: "audit",
      payload_json: JSON.stringify({
        createdAt: backup.details.manifest.createdAt,
        source: "storage-cli",
      }),
      payload_schema_version: 1,
      topic: null,
      device_id: null,
      correlation_id: null,
      operation_id: null,
    });
    await loggedEvents.destroy();
    await expect(
      executeStorageCommand({
        kind: "verify-backup",
        manifestFile: backup.details.manifestFile,
      }),
    ).resolves.toMatchObject({ command: "verify-backup" });

    const restoredState = join(directory, "restored", "state.db");
    const restoredEvents = join(directory, "restored", "events.db");
    await expect(
      executeStorageCommand({
        kind: "restore",
        manifestFile: backup.details.manifestFile,
        stateDatabaseFile: restoredState,
        eventsDatabaseFile: restoredEvents,
      }),
    ).resolves.toEqual({
      command: "restore",
      details: {
        stateDatabaseFile: restoredState,
        eventsDatabaseFile: restoredEvents,
      },
    });
    await expect(
      executeStorageCommand({
        kind: "integrity",
        stateDatabaseFile: restoredState,
        eventsDatabaseFile: restoredEvents,
      }),
    ).resolves.toMatchObject({
      command: "integrity",
      details: { integrityCheck: "ok" },
    });

    await expect(
      executeStorageCommand({
        kind: "retention",
        eventsDatabaseFile: eventsFile,
        archiveDirectory,
        nowMs: Date.now(),
      }),
    ).resolves.toMatchObject({
      command: "retention",
      details: { status: "succeeded" },
    });
  });

  it("records a sanitized failure while preserving the backup error and source data", async () => {
    const directory = await createTemporaryDirectory();
    const stateFile = join(directory, "state.db");
    const eventsFile = join(directory, "events.db");
    const blockedDestination = join(directory, "blocked-destination");
    await createStateFixture(stateFile);
    const events = await openEventsDatabase({ filename: eventsFile });
    await new InteractionRepository(events).log({
      occurredAtMs: 1,
      direction: "internal",
      kind: "source-marker",
      severity: "info",
      outcome: "succeeded",
      byteCount: 0,
      retentionClass: "audit",
    });
    await events.destroy();
    await writeFile(blockedDestination, "do-not-overwrite", "utf8");
    const stateBefore = await readFile(stateFile);

    await expect(
      executeStorageCommand({
        kind: "backup",
        stateDatabaseFile: stateFile,
        eventsDatabaseFile: eventsFile,
        destinationDirectory: blockedDestination,
      }),
    ).rejects.toMatchObject({ code: "EEXIST" });

    expect(await readFile(stateFile)).toEqual(stateBefore);
    await expect(readFile(blockedDestination, "utf8")).resolves.toBe(
      "do-not-overwrite",
    );
    const loggedEvents = await openEventsDatabase({
      filename: eventsFile,
      migrate: false,
    });
    const interactions = await loggedEvents
      .selectFrom("interactions")
      .select([
        "kind",
        "severity",
        "outcome",
        "byte_count",
        "payload_json",
        "topic",
      ])
      .orderBy("id")
      .execute();
    expect(interactions).toEqual([
      expect.objectContaining({
        kind: "source-marker",
        outcome: "succeeded",
      }),
      {
        kind: "maintenance.backup",
        severity: "error",
        outcome: "failed",
        byte_count: 0,
        payload_json: null,
        topic: null,
      },
    ]);
    await loggedEvents.destroy();
  });

  it("does not create a missing event database while validating backup inputs", async () => {
    const directory = await createTemporaryDirectory();
    const stateFile = join(directory, "state.db");
    const missingEventsFile = join(directory, "missing-events.db");
    await createStateFixture(stateFile);

    await expect(
      executeStorageCommand({
        kind: "backup",
        stateDatabaseFile: stateFile,
        eventsDatabaseFile: missingEventsFile,
        destinationDirectory: join(directory, "backups"),
      }),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(missingEventsFile)).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("does not emit a manifest when a complete archive is missing", async () => {
    const directory = await createTemporaryDirectory();
    const eventsFile = join(directory, "events.db");
    const archiveDirectory = join(directory, "archives");
    const outputFile = join(directory, "archive-set.json");
    const events = await openEventsDatabase({ filename: eventsFile });
    const interaction = await new InteractionRepository(events).log({
      occurredAtMs: 10,
      direction: "internal",
      kind: "missing-archive-command-test",
      severity: "error",
      outcome: "failed",
      byteCount: 1,
      retentionClass: "audit",
    });
    const created = await createEventArchive({
      database: events,
      archiveDirectory,
      rangeStartMs: 0,
      rangeEndMs: 11,
      nowMs: 11,
      selection: { interactionIds: [interaction.id] },
    });
    await events.destroy();
    const archiveFile = join(archiveDirectory, created.archive.storagePath);
    await rename(archiveFile, `${archiveFile}.missing`);

    await expect(
      executeStorageCommand({
        kind: "verify-archive-set",
        eventsDatabaseFile: eventsFile,
        archiveDirectory,
        outputFile,
      }),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(outputFile)).rejects.toMatchObject({
      code: "ENOENT",
    });

    const unchangedEvents = await openEventsDatabase({
      filename: eventsFile,
      migrate: false,
    });
    await expect(
      unchangedEvents
        .selectFrom("event_archives")
        .select("status")
        .where("id", "=", created.archive.id)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ status: "complete" });
    await unchangedEvents.destroy();
  });
});

async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "aquarium-storage-command-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function createStateFixture(filename: string): Promise<void> {
  const database = await openStateDatabase({ filename });
  await database.destroy();
}
