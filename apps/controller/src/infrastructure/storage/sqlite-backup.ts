import { createHash, randomUUID } from "node:crypto";
import { createReadStream } from "node:fs";
import {
  lstat,
  link,
  mkdir,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { pipeline } from "node:stream/promises";

import BetterSqlite3 from "better-sqlite3";
import { z } from "zod";

const nonnegativeSafeIntegerSchema = z
  .number()
  .int()
  .min(0)
  .max(Number.MAX_SAFE_INTEGER);

const backupFileSchema = z.strictObject({
  kind: z.enum(["state", "events"]),
  filename: z
    .string()
    .regex(/^[A-Za-z0-9._-]+\.db$/, "Backup filename must be a plain .db name"),
  bytes: nonnegativeSafeIntegerSchema,
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  integrityCheck: z.literal("ok"),
});

const backupRevisionBoundariesSchema = z
  .strictObject({
    stateRevisionAtEventsCopyStart: nonnegativeSafeIntegerSchema,
    eventsRevision: nonnegativeSafeIntegerSchema,
    stateRevision: nonnegativeSafeIntegerSchema,
  })
  .superRefine((boundaries, context) => {
    if (boundaries.eventsRevision > boundaries.stateRevision) {
      context.addIssue({
        code: "custom",
        message: "The events revision boundary must not exceed state",
      });
    }
    if (boundaries.stateRevisionAtEventsCopyStart > boundaries.stateRevision) {
      context.addIssue({
        code: "custom",
        message: "The events-copy start boundary must not exceed copied state",
      });
    }
  });

export const sqliteBackupManifestSchema = z.strictObject({
  schemaVersion: z.literal(2),
  createdAt: z.string().datetime({ offset: true }),
  revisionBoundaries: backupRevisionBoundariesSchema,
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
  /** @internal Deterministic test seam between the ordered database copies. */
  readonly afterEventsDatabaseCopy?: () => Promise<void> | void;
}

export interface ControllerBackupResult {
  readonly directory: string;
  readonly manifestFile: string;
  readonly manifest: SqliteBackupManifest;
}

export function controllerBackupDirectoryName(createdAt: Date): string {
  if (!Number.isFinite(createdAt.getTime())) {
    throw new RangeError("Backup time must be a valid date");
  }
  return `backup-${createdAt.toISOString().replaceAll(":", "-")}`;
}

interface IntegrityCheckRow {
  readonly integrity_check: string;
}

interface ForeignKeyCheckRow {
  readonly table: string;
  readonly rowid: number | null;
  readonly parent: string;
  readonly fkid: number;
}

interface JournalModeRow {
  readonly journal_mode: string;
}

interface RevisionBoundaryRow {
  readonly revision: number | null;
}

interface StateOutboxBackupRow {
  readonly revision: number;
  readonly event_type: string;
  readonly entity_type: string;
  readonly entity_id: string | null;
  readonly occurred_at_ms: number;
  readonly retention_class: string;
  readonly payload_json: string;
  readonly payload_schema_version: number;
  readonly delivery_attempts: number;
  readonly available_at_ms: number;
  readonly published_at_ms: number | null;
  readonly last_error: string | null;
}

interface StateEventBackupRow {
  readonly revision: number;
  readonly occurred_at_ms: number;
  readonly event_type: string;
  readonly entity_type: string;
  readonly entity_id: string | null;
  readonly retention_class: string;
  readonly payload_json: string;
  readonly payload_schema_version: number;
  readonly byte_count: number;
}

interface BackupPairInspection {
  readonly eventsRevision: number;
  readonly stateRevision: number;
  readonly missingEventRevisions: readonly number[];
}

const SQLITE_SIDECAR_SUFFIXES = ["-wal", "-shm", "-journal"] as const;

export async function createControllerBackup(
  request: ControllerBackupRequest,
): Promise<ControllerBackupResult> {
  const createdAt = (request.now ?? (() => new Date()))();
  if (!Number.isFinite(createdAt.getTime())) {
    throw new RangeError("Backup time must be a valid date");
  }

  const backupName = controllerBackupDirectoryName(createdAt);
  const root = resolve(request.destinationDirectory);
  const directory = resolve(root, backupName);
  await mkdir(root, { recursive: true });
  try {
    await mkdir(directory);
  } catch (error) {
    if (error instanceof Error && hasErrorCode(error, "EEXIST")) {
      throw new Error(`Backup destination already exists: ${directory}`, {
        cause: error,
      });
    }
    throw error;
  }

  try {
    const stateRevisionAtEventsCopyStart = readStateRevisionBoundaryFromSource(
      request.stateDatabaseFile,
    );
    const eventsFile = join(directory, "events.db");
    const stateFile = join(directory, "state.db");

    await createDatabaseBackupCopy(request.eventsDatabaseFile, eventsFile);
    await request.afterEventsDatabaseCopy?.();
    await createDatabaseBackupCopy(request.stateDatabaseFile, stateFile);

    const copiedBoundaries = prepareCoherentBackupPair(
      stateFile,
      eventsFile,
      stateRevisionAtEventsCopyStart,
    );
    const events = await describeBackupFile("events", eventsFile);
    const state = await describeBackupFile("state", stateFile);
    const manifest = sqliteBackupManifestSchema.parse({
      schemaVersion: 2,
      createdAt: createdAt.toISOString(),
      revisionBoundaries: {
        stateRevisionAtEventsCopyStart,
        eventsRevision: copiedBoundaries.eventsRevision,
        stateRevision: copiedBoundaries.stateRevision,
      },
      files: [events, state],
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
    const information = await lstat(databaseFile);
    if (!information.isFile() || information.isSymbolicLink()) {
      throw new Error(
        `${file.kind} backup must be a self-contained regular database file`,
      );
    }
    await assertNoSqliteSidecars(databaseFile, `${file.kind} backup`);
    if (information.size !== file.bytes) {
      throw new Error(
        `${file.kind} backup size mismatch: expected ${file.bytes}, found ${information.size}`,
      );
    }
    const hash = await sha256File(databaseFile);
    if (hash !== file.sha256) {
      throw new Error(`${file.kind} backup checksum mismatch`);
    }
    verifySqliteDatabaseIntegrity(databaseFile);
    verifySqliteForeignKeys(databaseFile);
  }

  const stateFile = backupFilePath(parsed, directory, "state");
  const eventsFile = backupFilePath(parsed, directory, "events");
  const inspection = inspectBackupPair(
    stateFile,
    eventsFile,
    parsed.revisionBoundaries.stateRevisionAtEventsCopyStart,
    true,
  );
  assertManifestBoundaries(parsed, inspection);

  return parsed;
}

export async function restoreControllerBackup(
  manifestFile: string,
  destination: {
    readonly stateDatabaseFile: string;
    readonly eventsDatabaseFile: string;
    /** @internal Deterministic test seam immediately before no-replace publish. */
    readonly beforeDatabaseFilePublish?: (
      destinationFile: string,
    ) => Promise<void> | void;
  },
): Promise<void> {
  const manifest = await verifyControllerBackup(manifestFile);
  const stateDestination = resolve(destination.stateDatabaseFile);
  const eventsDestination = resolve(destination.eventsDatabaseFile);
  if (stateDestination === eventsDestination) {
    throw new Error("Restore state and events destinations must differ");
  }
  if (
    (await databaseArtifactExists(stateDestination)) ||
    (await databaseArtifactExists(eventsDestination))
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
        file.kind === "state" ? stateDestination : eventsDestination;
      await mkdir(dirname(resolve(destinationFile)), { recursive: true });
      await restoreDatabaseFile(
        join(directory, file.filename),
        destinationFile,
        destination.beforeDatabaseFilePublish,
      );
      restoredFiles.push(destinationFile);
    }
    const restoredInspection = inspectBackupPair(
      stateDestination,
      eventsDestination,
      manifest.revisionBoundaries.stateRevisionAtEventsCopyStart,
      true,
    );
    assertManifestBoundaries(manifest, restoredInspection);
  } catch (error) {
    await Promise.all(restoredFiles.map((file) => rm(file, { force: true })));
    throw error;
  }
}

function assertManifestBoundaries(
  manifest: SqliteBackupManifest,
  inspection: BackupPairInspection,
): void {
  if (
    inspection.eventsRevision !== manifest.revisionBoundaries.eventsRevision
  ) {
    throw new Error(
      `Events revision boundary mismatch: expected ${manifest.revisionBoundaries.eventsRevision}, found ${inspection.eventsRevision}`,
    );
  }
  if (inspection.stateRevision !== manifest.revisionBoundaries.stateRevision) {
    throw new Error(
      `State revision boundary mismatch: expected ${manifest.revisionBoundaries.stateRevision}, found ${inspection.stateRevision}`,
    );
  }
}

function readStateRevisionBoundaryFromSource(sourceFile: string): number {
  const source = resolve(sourceFile);
  verifySqliteDatabaseIntegrity(source);
  const database = new BetterSqlite3(source, {
    readonly: true,
    fileMustExist: true,
  });
  try {
    return readRevisionBoundary(
      database,
      "SELECT MAX(revision) AS revision FROM state_revisions",
      "State backup source is missing the required controller revision schema",
    );
  } finally {
    database.close();
  }
}

async function createDatabaseBackupCopy(
  sourceFile: string,
  destinationFile: string,
): Promise<void> {
  const source = resolve(sourceFile);
  const destination = resolve(destinationFile);
  if (source === destination) {
    throw new Error("SQLite backup source and destination must differ");
  }
  verifySqliteDatabaseIntegrity(source);

  const temporaryFile = `${destination}.partial-${randomUUID()}`;
  const database = new BetterSqlite3(source, {
    readonly: true,
    fileMustExist: true,
  });
  try {
    try {
      await database.backup(temporaryFile);
    } finally {
      database.close();
    }
  } catch (error) {
    await removeDatabaseArtifacts(temporaryFile);
    throw error;
  }

  try {
    await canonicalizeStandaloneDatabaseFile(temporaryFile);
    verifySqliteDatabaseIntegrity(temporaryFile);
    await rename(temporaryFile, destination);
  } catch (error) {
    await removeDatabaseArtifacts(temporaryFile);
    throw error;
  }
}

async function canonicalizeStandaloneDatabaseFile(
  databaseFile: string,
): Promise<void> {
  const database = new BetterSqlite3(resolve(databaseFile), {
    fileMustExist: true,
  });
  try {
    const result = database
      .prepare<[], JournalModeRow>("PRAGMA journal_mode = DELETE")
      .get();
    if (result?.journal_mode.toLowerCase() !== "delete") {
      throw new Error(
        `SQLite backup could not be checkpointed into a standalone database: ${databaseFile}`,
      );
    }
  } finally {
    database.close();
  }
  await Promise.all(
    ["-wal", "-shm", "-journal"].map((suffix) =>
      rm(`${databaseFile}${suffix}`, { force: true }),
    ),
  );
}

async function removeDatabaseArtifacts(databaseFile: string): Promise<void> {
  await Promise.all(
    ["", "-wal", "-shm", "-journal"].map((suffix) =>
      rm(`${databaseFile}${suffix}`, { force: true }),
    ),
  );
}

async function describeBackupFile(
  kind: "state" | "events",
  filename: string,
): Promise<z.infer<typeof backupFileSchema>> {
  verifySqliteDatabaseIntegrity(filename);
  const information = await stat(filename);
  return backupFileSchema.parse({
    kind,
    filename: basename(filename),
    bytes: information.size,
    sha256: await sha256File(filename),
    integrityCheck: "ok",
  });
}

function prepareCoherentBackupPair(
  stateFile: string,
  eventsFile: string,
  stateRevisionAtEventsCopyStart: number,
): BackupPairInspection {
  verifySqliteDatabaseIntegrity(stateFile);
  verifySqliteDatabaseIntegrity(eventsFile);
  verifySqliteForeignKeys(stateFile);
  verifySqliteForeignKeys(eventsFile);

  const state = new BetterSqlite3(resolve(stateFile), { fileMustExist: true });
  const events = new BetterSqlite3(resolve(eventsFile), {
    readonly: true,
    fileMustExist: true,
  });
  try {
    const inspection = inspectOpenBackupPair(
      state,
      events,
      stateRevisionAtEventsCopyStart,
      false,
    );
    const resetPublication = state.prepare<[number]>(
      `UPDATE state_outbox
       SET published_at_ms = NULL,
           available_at_ms = occurred_at_ms,
           last_error = NULL
       WHERE revision = ?`,
    );
    state.transaction((revisions: readonly number[]) => {
      for (const revision of revisions) {
        resetPublication.run(revision);
      }
    })(inspection.missingEventRevisions);

    inspectOpenBackupPair(state, events, stateRevisionAtEventsCopyStart, true);
    return inspection;
  } finally {
    events.close();
    state.close();
  }
}

function inspectBackupPair(
  stateFile: string,
  eventsFile: string,
  stateRevisionAtEventsCopyStart: number,
  requireRecoveryCheckpoints: boolean,
): BackupPairInspection {
  const state = new BetterSqlite3(resolve(stateFile), {
    readonly: true,
    fileMustExist: true,
  });
  const events = new BetterSqlite3(resolve(eventsFile), {
    readonly: true,
    fileMustExist: true,
  });
  try {
    return inspectOpenBackupPair(
      state,
      events,
      stateRevisionAtEventsCopyStart,
      requireRecoveryCheckpoints,
    );
  } finally {
    events.close();
    state.close();
  }
}

function inspectOpenBackupPair(
  state: BetterSqlite3.Database,
  events: BetterSqlite3.Database,
  stateRevisionAtEventsCopyStart: number,
  requireRecoveryCheckpoints: boolean,
): BackupPairInspection {
  const startRevision = nonnegativeSafeIntegerSchema.parse(
    stateRevisionAtEventsCopyStart,
  );
  const stateRevision = readRevisionBoundary(
    state,
    "SELECT MAX(revision) AS revision FROM state_revisions",
    "State backup is missing the required controller revision schema",
  );
  const eventsRevision = readRevisionBoundary(
    events,
    "SELECT MAX(revision) AS revision FROM state_events",
    "Events backup is missing the required controller event schema",
  );
  if (eventsRevision > stateRevision) {
    throw new Error(
      `Incoherent controller backup: events revision ${eventsRevision} exceeds state revision ${stateRevision}`,
    );
  }
  if (startRevision > stateRevision) {
    throw new Error(
      `Incoherent controller backup: events-copy start revision ${startRevision} exceeds copied state revision ${stateRevision}`,
    );
  }

  const outboxRows = readStateOutboxRows(state);
  assertCaptureBoundaryCoverage(outboxRows, startRevision, stateRevision);
  const readEvent = prepareStateEventReader(events);
  const missingEventRevisions: number[] = [];
  for (const outbox of outboxRows) {
    const event = readEvent.get(outbox.revision);
    if (event === undefined) {
      missingEventRevisions.push(outbox.revision);
      if (
        requireRecoveryCheckpoints &&
        (outbox.published_at_ms !== null ||
          outbox.available_at_ms !== outbox.occurred_at_ms ||
          outbox.last_error !== null)
      ) {
        throw new Error(
          `State outbox revision ${outbox.revision} is absent from events but is not reset for replay`,
        );
      }
      continue;
    }
    assertMirroredEventMatches(outbox, event);
  }

  return { eventsRevision, stateRevision, missingEventRevisions };
}

function readRevisionBoundary(
  database: BetterSqlite3.Database,
  query: string,
  missingSchemaMessage: string,
): number {
  let row: RevisionBoundaryRow | undefined;
  try {
    row = database.prepare<[], RevisionBoundaryRow>(query).get();
  } catch (error) {
    throw new Error(missingSchemaMessage, { cause: error });
  }
  if (row === undefined) {
    throw new Error(`${missingSchemaMessage}: boundary query returned no row`);
  }
  return nonnegativeSafeIntegerSchema.parse(row.revision ?? 0);
}

function readStateOutboxRows(
  state: BetterSqlite3.Database,
): readonly StateOutboxBackupRow[] {
  try {
    return state
      .prepare<[], StateOutboxBackupRow>(
        `SELECT revision, event_type, entity_type, entity_id,
                occurred_at_ms, retention_class, payload_json,
                payload_schema_version, delivery_attempts, available_at_ms,
                published_at_ms, last_error
         FROM state_outbox
         ORDER BY revision`,
      )
      .all();
  } catch (error) {
    throw new Error(
      "State backup is missing the required controller outbox schema",
      { cause: error },
    );
  }
}

function prepareStateEventReader(
  events: BetterSqlite3.Database,
): BetterSqlite3.Statement<[number], StateEventBackupRow> {
  try {
    return events.prepare<[number], StateEventBackupRow>(
      `SELECT revision, occurred_at_ms, event_type, entity_type, entity_id,
              retention_class, payload_json, payload_schema_version, byte_count
       FROM state_events
       WHERE revision = ?`,
    );
  } catch (error) {
    throw new Error(
      "Events backup is missing the required controller state-event schema",
      { cause: error },
    );
  }
}

function assertCaptureBoundaryCoverage(
  outboxRows: readonly StateOutboxBackupRow[],
  stateRevisionAtEventsCopyStart: number,
  stateRevision: number,
): void {
  if (stateRevision === 0) return;
  const requiredStart =
    stateRevisionAtEventsCopyStart === 0 ? 1 : stateRevisionAtEventsCopyStart;
  const requiredRows = outboxRows.filter(
    ({ revision }) => revision >= requiredStart && revision <= stateRevision,
  );
  let previous = requiredStart - 1;
  for (const row of requiredRows) {
    const revision = nonnegativeSafeIntegerSchema.parse(row.revision);
    if (revision !== previous + 1) {
      throw new Error(
        `Incoherent controller backup: state_outbox is missing required revision ${previous + 1}`,
      );
    }
    previous = revision;
  }
  if (previous !== stateRevision) {
    throw new Error(
      `Incoherent controller backup: state_outbox is missing required revision ${previous + 1}`,
    );
  }
}

function assertMirroredEventMatches(
  outbox: StateOutboxBackupRow,
  event: StateEventBackupRow,
): void {
  const mismatches: string[] = [];
  const comparableFields = [
    "revision",
    "occurred_at_ms",
    "event_type",
    "entity_type",
    "entity_id",
    "retention_class",
    "payload_json",
    "payload_schema_version",
  ] as const;
  for (const field of comparableFields) {
    if (outbox[field] !== event[field]) mismatches.push(field);
  }
  if (Buffer.byteLength(outbox.payload_json, "utf8") !== event.byte_count) {
    mismatches.push("byte_count");
  }
  if (mismatches.length > 0) {
    throw new Error(
      `Incoherent controller backup: state event revision ${outbox.revision} conflicts with its outbox row (${mismatches.join(", ")})`,
    );
  }
}

function backupFilePath(
  manifest: SqliteBackupManifest,
  directory: string,
  kind: "state" | "events",
): string {
  const file = manifest.files.find((candidate) => candidate.kind === kind);
  if (file === undefined) {
    throw new Error(`Controller backup manifest is missing ${kind}.db`);
  }
  return join(directory, file.filename);
}

async function restoreDatabaseFile(
  sourceFile: string,
  destinationFile: string,
  beforePublish?: (destinationFile: string) => Promise<void> | void,
): Promise<void> {
  const destination = resolve(destinationFile);
  const temporaryFile = `${destination}.partial-${randomUUID()}`;
  const database = new BetterSqlite3(resolve(sourceFile), {
    readonly: true,
    fileMustExist: true,
  });
  try {
    try {
      await database.backup(temporaryFile);
    } finally {
      database.close();
    }
  } catch (error) {
    await removeDatabaseArtifacts(temporaryFile);
    throw error;
  }

  let destinationPublished = false;
  try {
    await canonicalizeStandaloneDatabaseFile(temporaryFile);
    verifySqliteDatabaseIntegrity(temporaryFile);
    verifySqliteForeignKeys(temporaryFile);
    await beforePublish?.(destination);
    await assertNoSqliteSidecars(destination, "Restore destination");
    await link(temporaryFile, destination);
    destinationPublished = true;
    await removeDatabaseArtifacts(temporaryFile);
  } catch (error) {
    await removeDatabaseArtifacts(temporaryFile);
    if (destinationPublished) {
      await rm(destination, { force: true });
    }
    throw error;
  }
}

export function verifySqliteDatabaseIntegrity(databaseFile: string): void {
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

function verifySqliteForeignKeys(databaseFile: string): void {
  const database = new BetterSqlite3(resolve(databaseFile), {
    readonly: true,
    fileMustExist: true,
  });
  try {
    const violation = database
      .prepare<[], ForeignKeyCheckRow>("PRAGMA foreign_key_check")
      .get();
    if (violation !== undefined) {
      throw new Error(
        `SQLite foreign key check failed for ${databaseFile}: ${violation.table} row ${violation.rowid ?? "unknown"} references ${violation.parent}`,
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

async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (error instanceof Error && hasErrorCode(error, "ENOENT")) return false;
    throw error;
  }
}

async function databaseArtifactExists(databaseFile: string): Promise<boolean> {
  if (await pathExists(databaseFile)) return true;
  for (const suffix of SQLITE_SIDECAR_SUFFIXES) {
    if (await pathExists(`${databaseFile}${suffix}`)) return true;
  }
  return false;
}

async function assertNoSqliteSidecars(
  databaseFile: string,
  description: string,
): Promise<void> {
  for (const suffix of SQLITE_SIDECAR_SUFFIXES) {
    if (await pathExists(`${databaseFile}${suffix}`)) {
      throw new Error(
        `${description} must not have a ${suffix} sidecar: ${databaseFile}${suffix}`,
      );
    }
  }
}

function hasErrorCode(error: Error, code: string): boolean {
  return "code" in error && error.code === code;
}
