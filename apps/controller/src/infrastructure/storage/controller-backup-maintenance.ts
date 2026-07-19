import type { BigIntStats } from "node:fs";
import { lstat, mkdir, readdir, realpath, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";

import type { Kysely } from "kysely";
import { z } from "zod";

import type { ControllerBackupMaintenancePort } from "../../application/maintenance/daily-controller-backup-coordinator.js";
import type { EventsDatabaseSchema } from "../database/types.js";
import { parseJsonDocument } from "../import/strict-json.js";
import type { InteractionLogInput } from "./interaction-repository.js";
import {
  controllerBackupDirectoryName,
  createControllerBackup,
  verifyControllerBackup,
  type ControllerBackupResult,
} from "./sqlite-backup.js";

export const CONTROLLER_BACKUP_RETENTION_COUNT = 3;

const BACKUP_DIRECTORY_NAME =
  /^backup-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}\.\d{3}Z$/u;
const SAFE_ERROR_IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]{0,127}$/u;
const backupSuccessReferenceSchema = z.object({
  createdAt: z.string().datetime({ offset: true }),
});

interface InteractionWriter {
  log(input: InteractionLogInput): Promise<object>;
}

export interface ControllerBackupMaintenanceOptions {
  readonly stateDatabaseFile: string;
  readonly eventsDatabaseFile: string;
  readonly destinationDirectory: string;
}

export interface VerifiedBackupRetentionResult {
  readonly recognizedBackupCount: number;
  readonly retainedBackupCount: number;
  readonly prunedBackupCount: number;
}

export interface ControllerBackupRunResult {
  readonly backup: ControllerBackupResult;
  readonly retention: VerifiedBackupRetentionResult;
}

interface VerifiedBackupDirectory {
  readonly directory: string;
  readonly name: string;
  readonly createdAtMs: number;
}

interface BackupPathIdentity {
  readonly kind: "directory" | "file";
  readonly device: bigint;
  readonly inode: bigint;
  readonly size: bigint;
  readonly modifiedAtNs: bigint;
  readonly changedAtNs: bigint;
}

interface BackupArtifactIdentity {
  readonly root: BackupPathIdentity;
  readonly directory: BackupPathIdentity;
  readonly manifest: BackupPathIdentity;
  readonly stateDatabase: BackupPathIdentity;
  readonly eventsDatabase: BackupPathIdentity;
}

interface TrustedBackupRoot {
  readonly identity: BackupPathIdentity;
  readonly realPath: string;
}

interface BackupVerificationCache {
  readonly createdAt: string;
  readonly identity: BackupArtifactIdentity;
  readonly verifiedBackupAtMs: number | null;
}

/**
 * Performs one verified online backup and applies retention only to directories
 * that match the controller's canonical name and pass full manifest, checksum,
 * and SQLite integrity verification. Unknown and damaged entries are preserved
 * for explicit operator inspection.
 */
export class ControllerBackupMaintenance implements ControllerBackupMaintenancePort {
  readonly #stateDatabaseFile: string;
  readonly #eventsDatabaseFile: string;
  readonly #destinationDirectory: string;
  #verificationCache: BackupVerificationCache | null = null;
  #operationTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly database: Kysely<EventsDatabaseSchema>,
    private readonly interactions: InteractionWriter,
    options: ControllerBackupMaintenanceOptions,
  ) {
    this.#stateDatabaseFile = requiredResolvedPath(
      options.stateDatabaseFile,
      "Backup state database path",
    );
    this.#eventsDatabaseFile = requiredResolvedPath(
      options.eventsDatabaseFile,
      "Backup events database path",
    );
    this.#destinationDirectory = requiredResolvedPath(
      options.destinationDirectory,
      "Backup destination directory",
    );
    if (this.#stateDatabaseFile === this.#eventsDatabaseFile) {
      throw new Error("Backup state and events database paths must differ");
    }
  }

  readLatestVerifiedBackupAtMs(): Promise<number | null> {
    return this.#serialize(() => this.#readLatestVerifiedBackupAtMs());
  }

  async #readLatestVerifiedBackupAtMs(): Promise<number | null> {
    const latest = await this.database
      .selectFrom("interactions")
      .select(["payload_json", "payload_schema_version"])
      .where("kind", "=", "maintenance.backup")
      .where("outcome", "=", "succeeded")
      .orderBy("occurred_at_ms", "desc")
      .orderBy("id", "desc")
      .executeTakeFirst();
    if (latest === undefined) {
      this.#verificationCache = null;
      return null;
    }
    const createdAt = parseBackupSuccessReference(
      latest.payload_json,
      latest.payload_schema_version,
    );
    if (createdAt === null) {
      this.#verificationCache = null;
      return null;
    }

    const createdAtDate = new Date(createdAt);
    const backupName = controllerBackupDirectoryName(createdAtDate);
    const directory = resolve(this.#destinationDirectory, backupName);
    if (dirname(directory) !== this.#destinationDirectory) {
      throw new Error("Referenced backup escaped its configured destination");
    }
    const rootBefore = await readTrustedBackupRoot(this.#destinationDirectory);
    if (rootBefore === null) {
      this.#verificationCache = null;
      return null;
    }
    const identityBefore = await tryReadBackupArtifactIdentity(
      rootBefore,
      directory,
    );
    if (identityBefore === null) {
      this.#verificationCache = null;
      return null;
    }
    if (
      this.#verificationCache?.createdAt === createdAt &&
      backupArtifactIdentitiesEqual(
        this.#verificationCache.identity,
        identityBefore,
      )
    ) {
      return this.#verificationCache.verifiedBackupAtMs;
    }

    let verifiedBackupAtMs: number | null = null;
    try {
      const manifest = await verifyControllerBackup(
        join(directory, "manifest.json"),
      );
      if (
        manifest.createdAt !== createdAt ||
        controllerBackupDirectoryName(new Date(manifest.createdAt)) !==
          backupName ||
        manifest.files.find(({ kind }) => kind === "state")?.filename !==
          "state.db" ||
        manifest.files.find(({ kind }) => kind === "events")?.filename !==
          "events.db"
      ) {
        throw new Error(
          "Verified backup manifest does not match its canonical success reference",
        );
      }
      verifiedBackupAtMs = createdAtDate.getTime();
    } catch {
      // An artifact that cannot pass full verification is intentionally
      // represented as absent so startup replaces it and health alerts.
    }

    const rootAfter = await readTrustedBackupRoot(this.#destinationDirectory);
    if (rootAfter === null) {
      this.#verificationCache = null;
      return null;
    }
    const identityAfter = await tryReadBackupArtifactIdentity(
      rootAfter,
      directory,
    );
    if (
      identityAfter === null ||
      !backupArtifactIdentitiesEqual(identityBefore, identityAfter)
    ) {
      this.#verificationCache = null;
      return null;
    }
    this.#verificationCache = {
      createdAt,
      identity: identityAfter,
      verifiedBackupAtMs,
    };
    return verifiedBackupAtMs;
  }

  run(input: {
    readonly runAtMs: number;
    readonly trigger: "startup" | "scheduled";
  }): Promise<ControllerBackupRunResult> {
    return this.#serialize(() => this.#run(input));
  }

  async #run(input: {
    readonly runAtMs: number;
    readonly trigger: "startup" | "scheduled";
  }): Promise<ControllerBackupRunResult> {
    assertTimestamp(input.runAtMs, "Backup run time");
    let backup: ControllerBackupResult;
    try {
      await mkdir(this.#destinationDirectory, { recursive: true });
      if ((await readTrustedBackupRoot(this.#destinationDirectory)) === null) {
        throw new Error("Backup destination could not be created");
      }
      backup = await createControllerBackup({
        stateDatabaseFile: this.#stateDatabaseFile,
        eventsDatabaseFile: this.#eventsDatabaseFile,
        destinationDirectory: this.#destinationDirectory,
        now: () => new Date(input.runAtMs),
      });
      await verifyControllerBackup(backup.manifestFile);
      const retention = await pruneVerifiedControllerBackups(
        this.#destinationDirectory,
      );
      const byteCount = sumBackupBytes(backup);
      await this.interactions.log({
        occurredAtMs: input.runAtMs,
        direction: "internal",
        kind: "maintenance.backup",
        severity: "info",
        outcome: "succeeded",
        byteCount,
        retentionClass: "audit",
        payload: {
          trigger: input.trigger,
          createdAt: backup.manifest.createdAt,
          retainedBackupCount: retention.retainedBackupCount,
          prunedBackupCount: retention.prunedBackupCount,
        },
        payloadSchemaVersion: 1,
      });
      return { backup, retention };
    } catch (error) {
      try {
        await this.interactions.log({
          occurredAtMs: input.runAtMs,
          direction: "internal",
          kind: "maintenance.backup",
          severity: "error",
          outcome: "failed",
          byteCount: 0,
          retentionClass: "audit",
          payload: {
            trigger: input.trigger,
            errorClass: sanitizeErrorIdentifier(
              toError(error).constructor.name,
            ),
            errorName: sanitizeErrorIdentifier(toError(error).name),
          },
          payloadSchemaVersion: 1,
        });
      } catch (recordingError) {
        throw new AggregateError(
          [toError(error), toError(recordingError)],
          "Controller backup failed and its outcome could not be recorded",
          { cause: recordingError },
        );
      }
      throw error;
    }
  }

  #serialize<Result>(operation: () => Promise<Result>): Promise<Result> {
    const task = this.#operationTail.then(operation);
    this.#operationTail = task.then(
      () => undefined,
      () => undefined,
    );
    return task;
  }
}

export async function pruneVerifiedControllerBackups(
  destinationDirectory: string,
  retainCount = CONTROLLER_BACKUP_RETENTION_COUNT,
): Promise<VerifiedBackupRetentionResult> {
  const root = requiredResolvedPath(
    destinationDirectory,
    "Backup destination directory",
  );
  if (!Number.isSafeInteger(retainCount) || retainCount <= 0) {
    throw new RangeError(
      "Backup retention count must be a positive safe integer",
    );
  }

  const entries = await readdir(root, { withFileTypes: true });
  const verified: VerifiedBackupDirectory[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !BACKUP_DIRECTORY_NAME.test(entry.name)) {
      continue;
    }
    const directory = join(root, entry.name);
    if (dirname(directory) !== root) {
      throw new Error("Resolved backup candidate escaped its destination");
    }
    try {
      const manifest = await verifyControllerBackup(
        join(directory, "manifest.json"),
      );
      const createdAt = new Date(manifest.createdAt);
      if (controllerBackupDirectoryName(createdAt) !== entry.name) {
        continue;
      }
      verified.push({
        directory,
        name: entry.name,
        createdAtMs: createdAt.getTime(),
      });
    } catch {
      // A malformed or damaged directory is not recognized and is never pruned.
    }
  }

  verified.sort(
    (left, right) =>
      right.createdAtMs - left.createdAtMs ||
      right.name.localeCompare(left.name),
  );
  const toPrune = verified.slice(retainCount);
  for (const candidate of toPrune) {
    const information = await lstat(candidate.directory);
    if (!information.isDirectory() || information.isSymbolicLink()) {
      throw new Error("Verified backup candidate changed before pruning");
    }
    const manifest = await verifyControllerBackup(
      join(candidate.directory, "manifest.json"),
    );
    if (
      controllerBackupDirectoryName(new Date(manifest.createdAt)) !==
      candidate.name
    ) {
      throw new Error("Verified backup candidate changed before pruning");
    }
    await rm(candidate.directory, { recursive: true });
  }

  return {
    recognizedBackupCount: verified.length,
    retainedBackupCount: Math.min(verified.length, retainCount),
    prunedBackupCount: toPrune.length,
  };
}

function parseBackupSuccessReference(
  payloadJson: string | null,
  payloadSchemaVersion: number | null,
): string | null {
  if (payloadJson === null || payloadSchemaVersion !== 1) return null;
  try {
    const document = parseJsonDocument(
      payloadJson,
      "maintenance.backup success payload",
    );
    if (document.duplicateKeys.length > 0) return null;
    return backupSuccessReferenceSchema.parse(document.value).createdAt;
  } catch {
    return null;
  }
}

async function readTrustedBackupRoot(
  root: string,
): Promise<TrustedBackupRoot | null> {
  let information: BigIntStats;
  try {
    information = await lstat(root, { bigint: true });
  } catch (error) {
    if (isErrorCode(error, "ENOENT")) return null;
    throw error;
  }
  if (!information.isDirectory() || information.isSymbolicLink()) {
    throw new Error(
      "Backup destination must be a real directory, not a file or symbolic link",
    );
  }
  const resolvedRealPath = resolve(await realpath(root));
  if (!pathsEqual(resolvedRealPath, root)) {
    throw new Error(
      "Backup destination or one of its ancestors resolves through a symbolic link",
    );
  }
  return {
    identity: toBackupPathIdentity(information, "directory"),
    realPath: resolvedRealPath,
  };
}

async function tryReadBackupArtifactIdentity(
  root: TrustedBackupRoot,
  directory: string,
): Promise<BackupArtifactIdentity | null> {
  try {
    const resolvedDirectory = resolve(directory);
    if (!pathsEqual(dirname(resolvedDirectory), root.realPath)) {
      throw new Error(
        "Backup artifact is not a direct child of its trusted root",
      );
    }
    const directoryInformation = await lstat(resolvedDirectory, {
      bigint: true,
    });
    assertPathType(
      directoryInformation,
      "directory",
      "Backup artifact directory",
    );
    if (
      !pathsEqual(resolve(await realpath(resolvedDirectory)), resolvedDirectory)
    ) {
      throw new Error(
        "Backup artifact directory resolves through a symbolic link",
      );
    }

    const manifestFile = join(resolvedDirectory, "manifest.json");
    const stateDatabaseFile = join(resolvedDirectory, "state.db");
    const eventsDatabaseFile = join(resolvedDirectory, "events.db");
    const [manifest, stateDatabase, eventsDatabase] = await Promise.all([
      readTrustedFileIdentity(manifestFile),
      readTrustedFileIdentity(stateDatabaseFile),
      readTrustedFileIdentity(eventsDatabaseFile),
    ]);
    const identity: BackupArtifactIdentity = {
      root: root.identity,
      directory: toBackupPathIdentity(directoryInformation, "directory"),
      manifest,
      stateDatabase,
      eventsDatabase,
    };
    const rootAfter = await readTrustedBackupRoot(root.realPath);
    if (
      rootAfter === null ||
      !backupPathIdentitiesEqual(root.identity, rootAfter.identity)
    ) {
      return null;
    }
    return identity;
  } catch {
    return null;
  }
}

async function readTrustedFileIdentity(
  path: string,
): Promise<BackupPathIdentity> {
  const information = await lstat(path, { bigint: true });
  assertPathType(information, "file", "Backup artifact file");
  if (!pathsEqual(resolve(await realpath(path)), resolve(path))) {
    throw new Error("Backup artifact file resolves through a symbolic link");
  }
  return toBackupPathIdentity(information, "file");
}

function assertPathType(
  information: BigIntStats,
  expected: "directory" | "file",
  label: string,
): void {
  const matches =
    expected === "directory" ? information.isDirectory() : information.isFile();
  if (!matches || information.isSymbolicLink()) {
    throw new Error(`${label} must be a regular ${expected}`);
  }
}

function toBackupPathIdentity(
  information: BigIntStats,
  kind: "directory" | "file",
): BackupPathIdentity {
  return {
    kind,
    device: information.dev,
    inode: information.ino,
    size: information.size,
    modifiedAtNs: information.mtimeNs,
    changedAtNs: information.ctimeNs,
  };
}

function backupArtifactIdentitiesEqual(
  left: BackupArtifactIdentity,
  right: BackupArtifactIdentity,
): boolean {
  return (
    backupPathIdentitiesEqual(left.root, right.root) &&
    backupPathIdentitiesEqual(left.directory, right.directory) &&
    backupPathIdentitiesEqual(left.manifest, right.manifest) &&
    backupPathIdentitiesEqual(left.stateDatabase, right.stateDatabase) &&
    backupPathIdentitiesEqual(left.eventsDatabase, right.eventsDatabase)
  );
}

function backupPathIdentitiesEqual(
  left: BackupPathIdentity,
  right: BackupPathIdentity,
): boolean {
  return (
    left.kind === right.kind &&
    left.device === right.device &&
    left.inode === right.inode &&
    left.size === right.size &&
    left.modifiedAtNs === right.modifiedAtNs &&
    left.changedAtNs === right.changedAtNs
  );
}

function pathsEqual(left: string, right: string): boolean {
  const resolvedLeft = resolve(left);
  const resolvedRight = resolve(right);
  return process.platform === "win32"
    ? resolvedLeft.toLocaleLowerCase("en-US") ===
        resolvedRight.toLocaleLowerCase("en-US")
    : resolvedLeft === resolvedRight;
}

function requiredResolvedPath(path: string, label: string): string {
  if (path.trim().length === 0) {
    throw new TypeError(`${label} must not be empty`);
  }
  return resolve(path);
}

function sumBackupBytes(backup: ControllerBackupResult): number {
  return backup.manifest.files.reduce((total, file) => {
    const next = total + file.bytes;
    if (!Number.isSafeInteger(next)) {
      throw new RangeError("Backup byte count exceeds safe integer range");
    }
    return next;
  }, 0);
}

function assertTimestamp(value: number, label: string): void {
  if (
    !Number.isSafeInteger(value) ||
    value < 0 ||
    !Number.isFinite(new Date(value).getTime())
  ) {
    throw new RangeError(`${label} must be a valid non-negative timestamp`);
  }
}

function sanitizeErrorIdentifier(identifier: string): string {
  return SAFE_ERROR_IDENTIFIER.test(identifier) ? identifier : "Error";
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}

function isErrorCode(error: unknown, code: string): boolean {
  return error instanceof Error && "code" in error && error.code === code;
}
