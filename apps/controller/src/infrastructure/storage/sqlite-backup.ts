import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { createReadStream } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";

import BetterSqlite3 from "better-sqlite3";
import { z } from "zod";

const backupFileSchema = z.strictObject({
  kind: z.enum(["state", "events"]),
  filename: z
    .string()
    .regex(/^[A-Za-z0-9._-]+\.db$/, "Backup filename must be a plain .db name"),
  bytes: z.number().int().nonnegative(),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  integrityCheck: z.literal("ok"),
});

export const sqliteBackupManifestSchema = z.strictObject({
  schemaVersion: z.literal(1),
  createdAt: z.string().datetime({ offset: true }),
  files: z
    .tuple([backupFileSchema, backupFileSchema])
    .superRefine((files, context) => {
      if (files[0].kind === files[1].kind) {
        context.addIssue({
          code: "custom",
          message:
            "A controller backup needs one state and one events database",
        });
      }
    }),
});

export type SqliteBackupManifest = z.infer<typeof sqliteBackupManifestSchema>;

export interface ControllerBackupRequest {
  readonly stateDatabaseFile: string;
  readonly eventsDatabaseFile: string;
  readonly destinationDirectory: string;
  readonly now?: () => Date;
}

export interface ControllerBackupResult {
  readonly directory: string;
  readonly manifestFile: string;
  readonly manifest: SqliteBackupManifest;
}

interface IntegrityCheckRow {
  readonly integrity_check: string;
}

export async function createControllerBackup(
  request: ControllerBackupRequest,
): Promise<ControllerBackupResult> {
  const createdAt = (request.now ?? (() => new Date()))();
  if (!Number.isFinite(createdAt.getTime())) {
    throw new RangeError("Backup time must be a valid date");
  }

  const backupName = `backup-${createdAt.toISOString().replaceAll(":", "-")}`;
  const directory = resolve(request.destinationDirectory, backupName);
  if (await pathExists(directory)) {
    throw new Error(`Backup destination already exists: ${directory}`);
  }
  await mkdir(directory, { recursive: true });

  try {
    const state = await createDatabaseBackupFile(
      "state",
      request.stateDatabaseFile,
      join(directory, "state.db"),
    );
    const events = await createDatabaseBackupFile(
      "events",
      request.eventsDatabaseFile,
      join(directory, "events.db"),
    );
    const manifest = sqliteBackupManifestSchema.parse({
      schemaVersion: 1,
      createdAt: createdAt.toISOString(),
      files: [state, events],
    });
    const manifestFile = join(directory, "manifest.json");
    const temporaryManifest = `${manifestFile}.partial-${randomUUID()}`;
    await writeFile(
      temporaryManifest,
      `${JSON.stringify(manifest, null, 2)}\n`,
      "utf8",
    );
    await rename(temporaryManifest, manifestFile);
    return { directory, manifestFile, manifest };
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }
}

export async function verifyControllerBackup(
  manifestFile: string,
): Promise<SqliteBackupManifest> {
  const parsed = sqliteBackupManifestSchema.parse(
    JSON.parse(await readFile(manifestFile, "utf8")),
  );
  const directory = dirname(resolve(manifestFile));

  for (const file of parsed.files) {
    const databaseFile = join(directory, file.filename);
    const information = await stat(databaseFile);
    if (information.size !== file.bytes) {
      throw new Error(
        `${file.kind} backup size mismatch: expected ${file.bytes}, found ${information.size}`,
      );
    }
    const hash = await sha256File(databaseFile);
    if (hash !== file.sha256) {
      throw new Error(`${file.kind} backup checksum mismatch`);
    }
    assertSqliteIntegrity(databaseFile);
  }

  return parsed;
}

export async function restoreControllerBackup(
  manifestFile: string,
  destination: {
    readonly stateDatabaseFile: string;
    readonly eventsDatabaseFile: string;
  },
): Promise<void> {
  const manifest = await verifyControllerBackup(manifestFile);
  if (
    (await pathExists(destination.stateDatabaseFile)) ||
    (await pathExists(destination.eventsDatabaseFile))
  ) {
    throw new Error(
      "Restore destinations must not exist; move the verified files into service only during a controlled outage",
    );
  }

  const directory = dirname(resolve(manifestFile));
  const restoredFiles: string[] = [];
  try {
    for (const file of manifest.files) {
      const destinationFile =
        file.kind === "state"
          ? destination.stateDatabaseFile
          : destination.eventsDatabaseFile;
      await mkdir(dirname(resolve(destinationFile)), { recursive: true });
      await restoreDatabaseFile(
        join(directory, file.filename),
        destinationFile,
      );
      restoredFiles.push(destinationFile);
    }
  } catch (error) {
    await Promise.all(restoredFiles.map((file) => rm(file, { force: true })));
    throw error;
  }
}

async function createDatabaseBackupFile(
  kind: "state" | "events",
  sourceFile: string,
  destinationFile: string,
): Promise<z.infer<typeof backupFileSchema>> {
  const source = resolve(sourceFile);
  const destination = resolve(destinationFile);
  if (source === destination) {
    throw new Error("SQLite backup source and destination must differ");
  }
  assertSqliteIntegrity(source);

  const temporaryFile = `${destination}.partial-${randomUUID()}`;
  const database = new BetterSqlite3(source, {
    readonly: true,
    fileMustExist: true,
  });
  try {
    await database.backup(temporaryFile);
  } finally {
    database.close();
  }

  try {
    assertSqliteIntegrity(temporaryFile);
    await rename(temporaryFile, destination);
  } catch (error) {
    await rm(temporaryFile, { force: true });
    throw error;
  }

  const information = await stat(destination);
  return backupFileSchema.parse({
    kind,
    filename: basename(destination),
    bytes: information.size,
    sha256: await sha256File(destination),
    integrityCheck: "ok",
  });
}

async function restoreDatabaseFile(
  sourceFile: string,
  destinationFile: string,
): Promise<void> {
  const destination = resolve(destinationFile);
  const temporaryFile = `${destination}.partial-${randomUUID()}`;
  const database = new BetterSqlite3(resolve(sourceFile), {
    readonly: true,
    fileMustExist: true,
  });
  try {
    await database.backup(temporaryFile);
  } finally {
    database.close();
  }

  try {
    assertSqliteIntegrity(temporaryFile);
    await rename(temporaryFile, destination);
  } catch (error) {
    await rm(temporaryFile, { force: true });
    throw error;
  }
}

function assertSqliteIntegrity(databaseFile: string): void {
  const database = new BetterSqlite3(resolve(databaseFile), {
    readonly: true,
    fileMustExist: true,
  });
  try {
    const result = database
      .prepare<[], IntegrityCheckRow>("PRAGMA integrity_check")
      .get();
    if (result?.integrity_check !== "ok") {
      throw new Error(
        `SQLite integrity check failed for ${databaseFile}: ${result?.integrity_check ?? "no result"}`,
      );
    }
  } finally {
    database.close();
  }
}

async function sha256File(filename: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(filename), hash);
  return hash.digest("hex");
}

function pathExists(path: string): Promise<boolean> {
  return stat(path).then(
    () => true,
    () => false,
  );
}
