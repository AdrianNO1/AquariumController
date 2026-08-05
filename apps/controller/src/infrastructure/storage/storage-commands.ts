import { randomUUID } from "node:crypto";
import {
  link,
  lstat,
  mkdir,
  open,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { openEventsDatabase } from "../database/index.js";
import {
  decodeEventArchiveBytes,
  encodeEventArchiveRecords,
  verifyCompleteEventArchive,
  verifyEventArchiveSet,
  type EventArchiveSetManifest,
  type StoredEventArchive,
} from "./event-archive.js";
import {
  runEventRetention,
  type EventRetentionRunResult,
} from "./event-retention.js";
import { seedDefaultRetentionPolicies } from "./retention-policies.js";
import {
  createControllerBackup,
  restoreControllerBackup,
  verifyControllerBackup,
  verifySqliteDatabaseIntegrity,
  type SqliteBackupManifest,
} from "./sqlite-backup.js";
import {
  InteractionRepository,
  serializeCanonicalJson,
} from "./interaction-repository.js";

export type StorageCommand =
  | { readonly kind: "initialize-events"; readonly eventsDatabaseFile: string }
  | {
      readonly kind: "backup";
      readonly stateDatabaseFile: string;
      readonly eventsDatabaseFile: string;
      readonly destinationDirectory: string;
    }
  | { readonly kind: "verify-backup"; readonly manifestFile: string }
  | {
      readonly kind: "restore";
      readonly manifestFile: string;
      readonly stateDatabaseFile: string;
      readonly eventsDatabaseFile: string;
    }
  | {
      readonly kind: "retention";
      readonly eventsDatabaseFile: string;
      readonly archiveDirectory: string;
      readonly nowMs?: number;
    }
  | {
      readonly kind: "verify-archive";
      readonly eventsDatabaseFile: string;
      readonly archiveDirectory: string;
      readonly archiveId: string;
    }
  | {
      readonly kind: "verify-archive-set";
      readonly eventsDatabaseFile: string;
      readonly archiveDirectory: string;
      readonly outputFile: string;
    }
  | {
      readonly kind: "decode-archive";
      readonly archiveFile: string;
      readonly outputFile: string;
    }
  | {
      readonly kind: "integrity";
      readonly stateDatabaseFile: string;
      readonly eventsDatabaseFile: string;
    };

export type StorageCommandResult =
  | {
      readonly command: "initialize-events";
      readonly details: {
        readonly eventsDatabaseFile: string;
        readonly integrityCheck: "ok";
      };
    }
  | {
      readonly command: "backup";
      readonly details: {
        readonly directory: string;
        readonly manifestFile: string;
        readonly manifest: SqliteBackupManifest;
      };
    }
  | {
      readonly command: "verify-backup";
      readonly details: {
        readonly manifestFile: string;
        readonly manifest: SqliteBackupManifest;
      };
    }
  | {
      readonly command: "restore";
      readonly details: {
        readonly stateDatabaseFile: string;
        readonly eventsDatabaseFile: string;
      };
    }
  | {
      readonly command: "retention";
      readonly details: EventRetentionRunResult;
    }
  | {
      readonly command: "verify-archive";
      readonly details: {
        readonly archive: StoredEventArchive;
        readonly recordCount: number;
      };
    }
  | {
      readonly command: "verify-archive-set";
      readonly details: {
        readonly manifestFile: string;
        readonly manifest: EventArchiveSetManifest;
      };
    }
  | {
      readonly command: "decode-archive";
      readonly details: {
        readonly outputFile: string;
        readonly recordCount: number;
        readonly byteCount: number;
      };
    }
  | {
      readonly command: "integrity";
      readonly details: {
        readonly stateDatabaseFile: string;
        readonly eventsDatabaseFile: string;
        readonly integrityCheck: "ok";
      };
    };

const COMMAND_FLAGS = {
  "initialize-events": ["events-db"],
  backup: ["state-db", "events-db", "destination"],
  "verify-backup": ["manifest"],
  restore: ["manifest", "state-db", "events-db"],
  retention: ["events-db", "archive-dir", "now-ms"],
  "verify-archive": ["events-db", "archive-dir", "archive-id"],
  "verify-archive-set": ["events-db", "archive-dir", "output"],
  "decode-archive": ["archive-file", "output"],
  integrity: ["state-db", "events-db"],
} as const satisfies Readonly<
  Record<StorageCommand["kind"], readonly string[]>
>;

export function parseStorageCommandArguments(
  arguments_: readonly string[],
): StorageCommand {
  const [rawCommand, ...rawFlags] = arguments_;
  if (rawCommand === undefined || !(rawCommand in COMMAND_FLAGS)) {
    throw new TypeError(
      `Storage command must be one of: ${Object.keys(COMMAND_FLAGS).join(", ")}`,
    );
  }
  const command = rawCommand as StorageCommand["kind"];
  const flags = parseFlags(rawFlags, COMMAND_FLAGS[command]);

  switch (command) {
    case "initialize-events":
      return {
        kind: command,
        eventsDatabaseFile: requiredPath(flags, "events-db"),
      };
    case "backup":
      return {
        kind: command,
        stateDatabaseFile: requiredPath(flags, "state-db"),
        eventsDatabaseFile: requiredPath(flags, "events-db"),
        destinationDirectory: requiredPath(flags, "destination"),
      };
    case "verify-backup":
      return { kind: command, manifestFile: requiredPath(flags, "manifest") };
    case "restore":
      return {
        kind: command,
        manifestFile: requiredPath(flags, "manifest"),
        stateDatabaseFile: requiredPath(flags, "state-db"),
        eventsDatabaseFile: requiredPath(flags, "events-db"),
      };
    case "retention": {
      const rawNowMs = flags.get("now-ms");
      const nowMs = rawNowMs === undefined ? undefined : Number(rawNowMs);
      if (nowMs !== undefined && (!Number.isSafeInteger(nowMs) || nowMs < 0)) {
        throw new RangeError("--now-ms must be a non-negative safe integer");
      }
      return {
        kind: command,
        eventsDatabaseFile: requiredPath(flags, "events-db"),
        archiveDirectory: requiredPath(flags, "archive-dir"),
        ...(nowMs === undefined ? {} : { nowMs }),
      };
    }
    case "verify-archive":
      return {
        kind: command,
        eventsDatabaseFile: requiredPath(flags, "events-db"),
        archiveDirectory: requiredPath(flags, "archive-dir"),
        archiveId: requiredText(flags, "archive-id"),
      };
    case "verify-archive-set":
      return {
        kind: command,
        eventsDatabaseFile: requiredPath(flags, "events-db"),
        archiveDirectory: requiredPath(flags, "archive-dir"),
        outputFile: requiredPath(flags, "output"),
      };
    case "decode-archive":
      return {
        kind: command,
        archiveFile: requiredPath(flags, "archive-file"),
        outputFile: requiredPath(flags, "output"),
      };
    case "integrity":
      return {
        kind: command,
        stateDatabaseFile: requiredPath(flags, "state-db"),
        eventsDatabaseFile: requiredPath(flags, "events-db"),
      };
  }
}

export async function executeStorageCommand(
  command: StorageCommand,
): Promise<StorageCommandResult> {
  switch (command.kind) {
    case "initialize-events":
      await initializeEventsDatabase(command.eventsDatabaseFile);
      return {
        command: command.kind,
        details: {
          eventsDatabaseFile: command.eventsDatabaseFile,
          integrityCheck: "ok",
        },
      };
    case "backup": {
      await Promise.all([
        assertRegularFile(command.stateDatabaseFile),
        assertRegularFile(command.eventsDatabaseFile),
      ]);
      let result: Awaited<ReturnType<typeof createControllerBackup>>;
      try {
        result = await createControllerBackup({
          stateDatabaseFile: command.stateDatabaseFile,
          eventsDatabaseFile: command.eventsDatabaseFile,
          destinationDirectory: command.destinationDirectory,
        });
      } catch (backupError) {
        try {
          await recordBackupOutcome(command.eventsDatabaseFile, "failed", null);
        } catch (recordingError) {
          throw new AggregateError(
            [backupError, recordingError],
            "Backup failed and its outcome could not be recorded",
            { cause: recordingError },
          );
        }
        throw backupError;
      }
      await recordBackupOutcome(
        command.eventsDatabaseFile,
        "succeeded",
        result.manifest.createdAt,
      );
      return {
        command: command.kind,
        details: {
          directory: result.directory,
          manifestFile: result.manifestFile,
          manifest: result.manifest,
        },
      };
    }
    case "verify-backup": {
      await assertRegularFile(command.manifestFile);
      return {
        command: command.kind,
        details: {
          manifestFile: command.manifestFile,
          manifest: await verifyControllerBackup(command.manifestFile),
        },
      };
    }
    case "restore": {
      await assertRegularFile(command.manifestFile);
      await restoreControllerBackup(command.manifestFile, {
        stateDatabaseFile: command.stateDatabaseFile,
        eventsDatabaseFile: command.eventsDatabaseFile,
      });
      return {
        command: command.kind,
        details: {
          stateDatabaseFile: command.stateDatabaseFile,
          eventsDatabaseFile: command.eventsDatabaseFile,
        },
      };
    }
    case "retention": {
      await assertRegularFile(command.eventsDatabaseFile);
      const database = await openEventsDatabase({
        filename: command.eventsDatabaseFile,
      });
      try {
        const nowMs = command.nowMs ?? Date.now();
        await seedDefaultRetentionPolicies(database, nowMs);
        return {
          command: command.kind,
          details: await runEventRetention({
            database,
            archiveDirectory: command.archiveDirectory,
            nowMs,
          }),
        };
      } finally {
        await database.destroy();
      }
    }
    case "verify-archive": {
      await assertRegularFile(command.eventsDatabaseFile);
      const database = await openEventsDatabase({
        filename: command.eventsDatabaseFile,
        migrate: false,
        readOnly: true,
      });
      try {
        const verified = await verifyCompleteEventArchive(
          database,
          command.archiveDirectory,
          command.archiveId,
        );
        return {
          command: command.kind,
          details: {
            archive: verified.archive,
            recordCount: verified.records.length,
          },
        };
      } finally {
        await database.destroy();
      }
    }
    case "verify-archive-set": {
      await assertRegularFile(command.eventsDatabaseFile);
      const database = await openEventsDatabase({
        filename: command.eventsDatabaseFile,
        migrate: false,
        readOnly: true,
      });
      let manifest: EventArchiveSetManifest;
      try {
        manifest = await verifyEventArchiveSet(
          database,
          command.archiveDirectory,
        );
      } finally {
        await database.destroy();
      }
      await mkdir(dirname(command.outputFile), { recursive: true });
      await writeFile(
        command.outputFile,
        `${serializeCanonicalJson(manifest)}\n`,
        { encoding: "utf8", flag: "wx" },
      );
      return {
        command: command.kind,
        details: { manifestFile: command.outputFile, manifest },
      };
    }
    case "decode-archive": {
      await assertRegularFile(command.archiveFile);
      const records = decodeEventArchiveBytes(
        await readFile(command.archiveFile),
      );
      const output = encodeEventArchiveRecords(records);
      await mkdir(dirname(command.outputFile), { recursive: true });
      await writeFile(command.outputFile, output, {
        encoding: "utf8",
        flag: "wx",
      });
      return {
        command: command.kind,
        details: {
          outputFile: command.outputFile,
          recordCount: records.length,
          byteCount: Buffer.byteLength(output, "utf8"),
        },
      };
    }
    case "integrity":
      await Promise.all([
        assertRegularFile(command.stateDatabaseFile),
        assertRegularFile(command.eventsDatabaseFile),
      ]);
      verifySqliteDatabaseIntegrity(command.stateDatabaseFile);
      verifySqliteDatabaseIntegrity(command.eventsDatabaseFile);
      return {
        command: command.kind,
        details: {
          stateDatabaseFile: command.stateDatabaseFile,
          eventsDatabaseFile: command.eventsDatabaseFile,
          integrityCheck: "ok",
        },
      };
  }
}

async function recordBackupOutcome(
  eventsDatabaseFile: string,
  outcome: "succeeded" | "failed",
  createdAt: string | null,
): Promise<void> {
  const database = await openEventsDatabase({
    filename: eventsDatabaseFile,
    migrate: false,
  });
  try {
    await new InteractionRepository(database).log({
      occurredAtMs: Date.now(),
      direction: "internal",
      kind: "maintenance.backup",
      severity: outcome === "failed" ? "error" : "info",
      outcome,
      byteCount: 0,
      retentionClass: "audit",
      ...(createdAt === null
        ? {}
        : {
            payload: { source: "storage-cli", createdAt },
            payloadSchemaVersion: 1,
          }),
    });
  } finally {
    await database.destroy();
  }
}

async function initializeEventsDatabase(
  eventsDatabaseFile: string,
): Promise<void> {
  const destination = resolve(eventsDatabaseFile);
  const parent = dirname(destination);
  const parentInformation = await stat(parent);
  if (!parentInformation.isDirectory()) {
    throw new TypeError(`Expected an existing database directory: ${parent}`);
  }
  await assertDatabaseArtifactsAbsent(destination, "Events database target");

  const temporaryFile = `${destination}.partial-${randomUUID()}`;
  const claim = await open(temporaryFile, "wx", 0o600);
  try {
    await claim.close();
  } catch (error) {
    await removeDatabaseArtifacts(temporaryFile);
    throw error;
  }
  try {
    const database = await openEventsDatabase({ filename: temporaryFile });
    try {
      await seedDefaultRetentionPolicies(database, Date.now());
    } finally {
      await database.destroy();
    }
    await assertDatabaseSidecarsAbsent(
      temporaryFile,
      "Initialized events database",
    );
    verifySqliteDatabaseIntegrity(temporaryFile);
    const temporaryInformation = await lstat(temporaryFile);
    if (!temporaryInformation.isFile()) {
      throw new TypeError(
        `Initialized events database is not a regular file: ${temporaryFile}`,
      );
    }
    await assertDatabaseArtifactsAbsent(destination, "Events database target");
    await link(temporaryFile, destination);
    try {
      const publishedInformation = await lstat(destination);
      if (
        !publishedInformation.isFile() ||
        publishedInformation.dev !== temporaryInformation.dev ||
        publishedInformation.ino !== temporaryInformation.ino
      ) {
        throw new Error(
          `Events database target changed during initialization: ${destination}`,
        );
      }
      await assertDatabaseSidecarsAbsent(
        destination,
        "Published events database",
      );
      verifySqliteDatabaseIntegrity(destination);
    } catch (error) {
      try {
        const currentInformation = await lstat(destination);
        if (
          currentInformation.dev === temporaryInformation.dev &&
          currentInformation.ino === temporaryInformation.ino
        ) {
          await rm(destination, { force: true });
        }
      } catch (cleanupError) {
        if (!(
          typeof cleanupError === "object" &&
          cleanupError !== null &&
          isErrorWithCode(cleanupError, "ENOENT")
        )) {
          throw new AggregateError(
            [error, cleanupError],
            "Events database initialization failed and its published link could not be inspected",
            { cause: cleanupError },
          );
        }
      }
      throw error;
    }
  } finally {
    await removeDatabaseArtifacts(temporaryFile);
  }
}

async function assertDatabaseArtifactsAbsent(
  databaseFile: string,
  label: string,
): Promise<void> {
  for (const suffix of ["", "-wal", "-shm", "-journal"]) {
    const artifact = `${databaseFile}${suffix}`;
    try {
      await lstat(artifact);
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        isErrorWithCode(error, "ENOENT")
      ) {
        continue;
      }
      throw error;
    }
    throw new Error(`${label} already exists: ${artifact}`);
  }
}

async function assertDatabaseSidecarsAbsent(
  databaseFile: string,
  label: string,
): Promise<void> {
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    const artifact = `${databaseFile}${suffix}`;
    try {
      await lstat(artifact);
    } catch (error) {
      if (
        typeof error === "object" &&
        error !== null &&
        isErrorWithCode(error, "ENOENT")
      ) {
        continue;
      }
      throw error;
    }
    throw new Error(`${label} has an unexpected SQLite sidecar: ${artifact}`);
  }
}

async function removeDatabaseArtifacts(databaseFile: string): Promise<void> {
  await Promise.all(
    ["", "-wal", "-shm", "-journal"].map((suffix) =>
      rm(`${databaseFile}${suffix}`, { force: true }),
    ),
  );
}

function isErrorWithCode(error: object, code: string): boolean {
  return "code" in error && error.code === code;
}

function parseFlags(
  rawFlags: readonly string[],
  allowedFlags: readonly string[],
): ReadonlyMap<string, string> {
  if (rawFlags.length % 2 !== 0) {
    throw new TypeError("Every storage command flag requires a value");
  }
  const parsed = new Map<string, string>();
  for (let index = 0; index < rawFlags.length; index += 2) {
    const rawName = rawFlags[index];
    const value = rawFlags[index + 1];
    if (
      rawName === undefined ||
      value === undefined ||
      !rawName.startsWith("--")
    ) {
      throw new TypeError("Storage command flags must use --name value syntax");
    }
    const name = rawName.slice(2);
    if (!allowedFlags.includes(name)) {
      throw new TypeError(`Unexpected --${name} flag`);
    }
    if (parsed.has(name)) {
      throw new TypeError(`Duplicate --${name} flag`);
    }
    if (value.trim().length === 0 || value.startsWith("--")) {
      throw new TypeError(`--${name} requires a non-empty value`);
    }
    parsed.set(name, value);
  }
  return parsed;
}

function requiredText(
  flags: ReadonlyMap<string, string>,
  name: string,
): string {
  const value = flags.get(name);
  if (value === undefined) {
    throw new TypeError(`Missing required --${name} flag`);
  }
  return value;
}

function requiredPath(
  flags: ReadonlyMap<string, string>,
  name: string,
): string {
  return resolve(requiredText(flags, name));
}

async function assertRegularFile(filename: string): Promise<void> {
  const information = await stat(filename);
  if (!information.isFile()) {
    throw new TypeError(`Expected a regular file: ${filename}`);
  }
}
