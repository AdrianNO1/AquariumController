import { mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, isAbsolute, join, resolve, sep } from "node:path";

import type { Kysely } from "kysely";
import { afterEach, describe, expect, it } from "vitest";

import {
  openEventsDatabase,
  type EventsDatabaseSchema,
} from "../database/index.js";
import {
  createEventArchive,
  deleteVerifiedEventArchiveRecords,
  resolveEventArchiveStoragePath,
  verifyCompleteEventArchive,
  verifyEventArchiveSet,
} from "./event-archive.js";
import { InteractionRepository } from "./interaction-repository.js";

interface TestStorage {
  readonly database: Kysely<EventsDatabaseSchema>;
  readonly directory: string;
  readonly archiveDirectory: string;
}

const testStorages: TestStorage[] = [];

afterEach(async () => {
  const temporaryRoot = `${resolve(tmpdir())}${sep}`;
  for (const storage of testStorages.splice(0)) {
    await storage.database.destroy();
    const resolvedDirectory = resolve(storage.directory);
    if (
      !resolvedDirectory.startsWith(temporaryRoot) ||
      !basename(resolvedDirectory).startsWith("aquarium-archive-portability-")
    ) {
      throw new Error(
        `Refusing to remove unexpected test directory ${resolvedDirectory}`,
      );
    }
    await rm(resolvedDirectory, { recursive: true, force: true });
  }
});

describe("event archive portability", () => {
  it("stores direct filenames and resolves relocated legacy absolute rows inside the explicit archive directory", async () => {
    const { database, directory, archiveDirectory } = await createTestStorage();
    const interaction = await new InteractionRepository(database).log({
      occurredAtMs: 10,
      direction: "internal",
      kind: "portable-archive",
      severity: "info",
      outcome: "succeeded",
      byteCount: 1,
      retentionClass: "audit",
    });
    const created = await createEventArchive({
      database,
      archiveDirectory,
      rangeStartMs: 0,
      rangeEndMs: 11,
      nowMs: 11,
      selection: { interactionIds: [interaction.id] },
    });

    expect(isAbsolute(created.archive.storagePath)).toBe(false);
    expect(basename(created.archive.storagePath)).toBe(
      created.archive.storagePath,
    );
    await expect(
      readFile(join(archiveDirectory, created.archive.storagePath)),
    ).resolves.not.toHaveLength(0);
    await expect(
      database
        .selectFrom("event_archives")
        .select("storage_path")
        .where("id", "=", created.archive.id)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ storage_path: created.archive.storagePath });

    const retiredHostPath = join(
      directory,
      "retired-host",
      created.archive.storagePath,
    );
    await database
      .updateTable("event_archives")
      .set({ storage_path: retiredHostPath })
      .where("id", "=", created.archive.id)
      .executeTakeFirstOrThrow();

    const verified = await verifyCompleteEventArchive(
      database,
      archiveDirectory,
      created.archive.id,
    );
    expect(verified.records).toEqual(created.records);
    expect(verified.archive.storagePath).toBe(retiredHostPath);
    await expect(
      database
        .selectFrom("event_archives")
        .select("storage_path")
        .where("id", "=", created.archive.id)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ storage_path: retiredHostPath });
    await expect(
      deleteVerifiedEventArchiveRecords(
        database,
        archiveDirectory,
        created.archive.id,
      ),
    ).resolves.toMatchObject({ interactionsDeleted: 1 });

    expect(
      resolveEventArchiveStoragePath(
        archiveDirectory,
        "C:\\legacy-host\\archives\\portable.ndjson.zst",
      ),
    ).toBe(join(archiveDirectory, "portable.ndjson.zst"));
    expect(
      resolveEventArchiveStoragePath(
        archiveDirectory,
        "/legacy-host/archives/portable.ndjson.zst",
      ),
    ).toBe(join(archiveDirectory, "portable.ndjson.zst"));
    for (const invalidPath of [
      "../escape.ndjson.zst",
      "nested/archive.ndjson.zst",
      "nested\\archive.ndjson.zst",
      "",
    ]) {
      expect(() =>
        resolveEventArchiveStoragePath(archiveDirectory, invalidPath),
      ).toThrow(/direct filename|must not be empty/u);
    }
  });

  it("builds a deterministic portable manifest and fails loudly without mutating archive status", async () => {
    const { database, directory, archiveDirectory } = await createTestStorage();
    const repository = new InteractionRepository(database);
    const first = await repository.log({
      occurredAtMs: 10,
      direction: "internal",
      kind: "archive-set-first",
      severity: "info",
      outcome: "succeeded",
      byteCount: 10,
      retentionClass: "audit",
    });
    const second = await repository.log({
      occurredAtMs: 20,
      direction: "internal",
      kind: "archive-set-second",
      severity: "info",
      outcome: "succeeded",
      byteCount: 20,
      retentionClass: "operational",
    });
    const firstArchive = await createEventArchive({
      database,
      archiveDirectory,
      rangeStartMs: 0,
      rangeEndMs: 11,
      nowMs: 11,
      selection: { interactionIds: [first.id] },
    });
    const secondArchive = await createEventArchive({
      database,
      archiveDirectory,
      rangeStartMs: 11,
      rangeEndMs: 21,
      nowMs: 21,
      selection: { interactionIds: [second.id] },
    });

    const firstManifest = await verifyEventArchiveSet(
      database,
      archiveDirectory,
    );
    const secondManifest = await verifyEventArchiveSet(
      database,
      archiveDirectory,
    );
    expect(secondManifest).toEqual(firstManifest);
    expect(firstManifest).toMatchObject({
      schemaVersion: 1,
      content: "aquarium-event-archive-set",
    });
    expect(firstManifest.archives.map((archive) => archive.id)).toEqual(
      [...firstManifest.archives.map((archive) => archive.id)].sort(),
    );
    expect(firstManifest.archives).toHaveLength(2);
    expect(JSON.stringify(firstManifest)).not.toContain(directory);
    expect(
      firstManifest.archives.every(
        (archive) => basename(archive.filename) === archive.filename,
      ),
    ).toBe(true);

    await database
      .updateTable("event_archives")
      .set({ storage_path: "wrong-archive.ndjson.zst" })
      .where("id", "=", firstArchive.archive.id)
      .executeTakeFirstOrThrow();
    await expect(
      verifyEventArchiveSet(database, archiveDirectory),
    ).rejects.toThrow(/filename does not match/u);
    await database
      .updateTable("event_archives")
      .set({ storage_path: firstArchive.archive.storagePath })
      .where("id", "=", firstArchive.archive.id)
      .executeTakeFirstOrThrow();

    const missingArchiveFile = join(
      archiveDirectory,
      firstArchive.archive.storagePath,
    );
    const parkedArchiveFile = `${missingArchiveFile}.parked`;
    await rename(missingArchiveFile, parkedArchiveFile);
    await expect(
      verifyEventArchiveSet(database, archiveDirectory),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      database
        .selectFrom("event_archives")
        .select("status")
        .where("id", "=", firstArchive.archive.id)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ status: "complete" });

    await rename(parkedArchiveFile, missingArchiveFile);
    await writeFile(
      join(archiveDirectory, secondArchive.archive.storagePath),
      "mismatched archive bytes",
      "utf8",
    );
    await expect(
      verifyEventArchiveSet(database, archiveDirectory),
    ).rejects.toThrow(/byte count|checksum/u);
    await expect(
      database
        .selectFrom("event_archives")
        .select("status")
        .where("id", "=", secondArchive.archive.id)
        .executeTakeFirstOrThrow(),
    ).resolves.toEqual({ status: "complete" });
  });
});

async function createTestStorage(): Promise<TestStorage> {
  const directory = await mkdtemp(
    join(tmpdir(), "aquarium-archive-portability-"),
  );
  const storage = {
    database: await openEventsDatabase({
      filename: join(directory, "events.db"),
    }),
    directory,
    archiveDirectory: join(directory, "archives"),
  };
  testStorages.push(storage);
  return storage;
}
