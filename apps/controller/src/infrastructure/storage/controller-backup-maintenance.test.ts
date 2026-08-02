import {
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

import type { ControllerDatabases } from "../database/connection.js";
import {
  closeControllerDatabases,
  openControllerDatabases,
} from "../database/index.js";
import { afterEach, describe, expect, it } from "vitest";

import { DailyControllerBackupCoordinator } from "../../application/maintenance/daily-controller-backup-coordinator.js";
import { ManualSchedulingTime } from "../../application/scheduling/test-scheduling-time.js";
import { EventStorageHealthMetricReader } from "./controller-storage-health-repository.js";
import { InteractionRepository } from "./interaction-repository.js";
import type { FilesystemFreeSpacePort } from "./node-filesystem-free-space.js";
import { controllerBackupDirectoryName } from "./sqlite-backup.js";
import {
  CONTROLLER_BACKUP_DAILY_RETENTION_DAYS,
  CONTROLLER_BACKUP_WEEKLY_RETENTION_DAYS,
  ControllerBackupMaintenance,
  pruneVerifiedControllerBackups,
  selectControllerBackupRetention,
} from "./controller-backup-maintenance.js";

const DAY_MS = 86_400_000;
const temporaryDirectories: string[] = [];
const openDatabases: ControllerDatabases[] = [];

class ConstantFreeSpace implements FilesystemFreeSpacePort {
  async readAvailableBytes(): Promise<number> {
    return 10_000_000_000;
  }
}

afterEach(async () => {
  await Promise.all(openDatabases.splice(0).map(closeControllerDatabases));
  await Promise.all(
    temporaryDirectories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

describe("controller backup maintenance", () => {
  // This exercises five real two-database backups plus full verification of
  // every retained candidate; parallel suite I/O can exceed Vitest's 5s default.
  it("creates, verifies, audits, and retains recognized daily backups", async () => {
    const directory = await createTemporaryDirectory();
    const stateDatabaseFile = join(directory, "state.db");
    const eventsDatabaseFile = join(directory, "events.db");
    const destinationDirectory = join(directory, "backups");
    const databases = await openControllerDatabases({
      state: { filename: stateDatabaseFile },
      events: { filename: eventsDatabaseFile },
    });
    openDatabases.push(databases);
    await mkdir(join(destinationDirectory, "operator-managed"), {
      recursive: true,
    });
    await writeFile(join(destinationDirectory, "operator-note.txt"), "keep\n", {
      encoding: "utf8",
    });
    const damagedName = "backup-2020-01-01T00-00-00.000Z";
    await mkdir(join(destinationDirectory, damagedName), { recursive: true });
    await writeFile(
      join(destinationDirectory, damagedName, "manifest.json"),
      "not-json\n",
      { encoding: "utf8" },
    );

    const maintenance = new ControllerBackupMaintenance(
      databases.events,
      new InteractionRepository(databases.events),
      { stateDatabaseFile, eventsDatabaseFile, destinationDirectory },
    );
    const firstRunAtMs = Date.parse("2026-07-10T02:00:00.000Z");
    let finalRetention:
      | Awaited<ReturnType<ControllerBackupMaintenance["run"]>>["retention"]
      | null = null;
    for (let index = 0; index < 5; index += 1) {
      const result = await maintenance.run({
        runAtMs: firstRunAtMs + index * DAY_MS,
        trigger: index === 0 ? "startup" : "scheduled",
      });
      finalRetention = result.retention;
    }

    expect(finalRetention).toEqual({
      recognizedBackupCount: 5,
      retainedBackupCount: 5,
      prunedBackupCount: 0,
    });
    const entries = (await readdir(destinationDirectory)).sort();
    expect(entries).toEqual([
      damagedName,
      "backup-2026-07-10T02-00-00.000Z",
      "backup-2026-07-11T02-00-00.000Z",
      "backup-2026-07-12T02-00-00.000Z",
      "backup-2026-07-13T02-00-00.000Z",
      "backup-2026-07-14T02-00-00.000Z",
      "operator-managed",
      "operator-note.txt",
    ]);
    await expect(
      stat(join(destinationDirectory, "operator-managed")),
    ).resolves.toMatchObject({});
    await expect(maintenance.readLatestVerifiedBackupAtMs()).resolves.toBe(
      Date.parse("2026-07-14T02:00:00.000Z"),
    );

    const outcomes = await databases.events
      .selectFrom("interactions")
      .select(["outcome", "byte_count", "payload_json"])
      .where("kind", "=", "maintenance.backup")
      .orderBy("id")
      .execute();
    expect(outcomes).toHaveLength(5);
    expect(outcomes.every((outcome) => outcome.outcome === "succeeded")).toBe(
      true,
    );
    expect(outcomes.every((outcome) => outcome.byte_count > 0)).toBe(true);
    expect(outcomes.at(-1)?.payload_json).toContain('"retainedBackupCount":5');
    expect(outcomes.at(-1)?.payload_json).toContain('"prunedBackupCount":0');
    expect(
      outcomes.some((outcome) => outcome.payload_json?.includes(directory)),
    ).toBe(false);
  }, 15_000);

  it("keeps one daily backup for 14 days and one weekly backup for 183 days", () => {
    expect(CONTROLLER_BACKUP_DAILY_RETENTION_DAYS).toBe(14);
    expect(CONTROLLER_BACKUP_WEEKLY_RETENTION_DAYS).toBe(183);
    const nowMs = Date.parse("2026-08-03T12:00:00.000Z");
    const backup = (name: string, createdAtMs: number) => ({
      directory: name,
      name,
      createdAtMs,
    });
    const retained = selectControllerBackupRetention(
      [
        backup("future", nowMs + DAY_MS),
        backup("today-newest", nowMs - 1_000),
        backup("today-older", nowMs - 3_600_000),
        backup("day-13", nowMs - 13 * DAY_MS),
        backup("day-14", nowMs - 14 * DAY_MS),
        backup("day-15", nowMs - 15 * DAY_MS),
        backup("day-20-same-week", nowMs - 20 * DAY_MS),
        backup("day-22", nowMs - 22 * DAY_MS),
        backup("day-182", nowMs - 182 * DAY_MS),
        backup("day-183", nowMs - 183 * DAY_MS),
        backup("day-200", nowMs - 200 * DAY_MS),
      ],
      nowMs,
    );

    expect([...retained].sort()).toEqual(
      [
        "future",
        "today-newest",
        "day-13",
        "day-14",
        "day-15",
        "day-22",
        "day-182",
      ].sort(),
    );
  });

  it("replaces deleted, corrupted, or legacy-unreferenced backups and exposes invalid artifacts as unhealthy first", async () => {
    const directory = await createTemporaryDirectory();
    const stateDatabaseFile = join(directory, "state.db");
    const eventsDatabaseFile = join(directory, "events.db");
    const destinationDirectory = join(directory, "backups");
    const databases = await openControllerDatabases({
      state: { filename: stateDatabaseFile },
      events: { filename: eventsDatabaseFile },
    });
    openDatabases.push(databases);
    const interactions = new InteractionRepository(databases.events);
    const maintenance = new ControllerBackupMaintenance(
      databases.events,
      interactions,
      { stateDatabaseFile, eventsDatabaseFile, destinationDirectory },
    );
    const firstRunAtMs = Date.parse("2026-07-15T02:00:00.000Z");
    await maintenance.run({ runAtMs: firstRunAtMs, trigger: "startup" });
    const health = new EventStorageHealthMetricReader(
      databases.events,
      new ConstantFreeSpace(),
      {
        storagePaths: [directory],
        backupFreshnessThresholdMs: 36 * 60 * 60 * 1_000,
        verifiedBackups: maintenance,
      },
    );
    await expect(
      health.read({ observedAtMs: firstRunAtMs + 1 }),
    ).resolves.toMatchObject({ successfulBackupMissingOrStale: 0 });

    const firstBackupDirectory = join(
      destinationDirectory,
      controllerBackupDirectoryName(new Date(firstRunAtMs)),
    );
    await rm(join(firstBackupDirectory, "manifest.json"));
    await expect(
      health.read({ observedAtMs: firstRunAtMs + 2 }),
    ).resolves.toMatchObject({ successfulBackupMissingOrStale: 1 });

    const replacementAfterDeletionAtMs = firstRunAtMs + 60 * 60 * 1_000;
    await runStartupCoordinator(maintenance, replacementAfterDeletionAtMs);
    await expect(maintenance.readLatestVerifiedBackupAtMs()).resolves.toBe(
      replacementAfterDeletionAtMs,
    );
    await expect(
      health.read({ observedAtMs: replacementAfterDeletionAtMs + 1 }),
    ).resolves.toMatchObject({ successfulBackupMissingOrStale: 0 });

    const replacementStateFile = join(
      destinationDirectory,
      controllerBackupDirectoryName(new Date(replacementAfterDeletionAtMs)),
      "state.db",
    );
    const beforeCorruption = await readFile(replacementStateFile);
    const corrupted = Buffer.from(beforeCorruption);
    const corruptionOffset = Math.floor(corrupted.byteLength / 2);
    corrupted[corruptionOffset] = (corrupted[corruptionOffset] ?? 0) ^ 0xff;
    await writeFile(replacementStateFile, corrupted);
    expect((await stat(replacementStateFile)).size).toBe(
      beforeCorruption.byteLength,
    );
    await expect(
      health.read({ observedAtMs: replacementAfterDeletionAtMs + 2 }),
    ).resolves.toMatchObject({ successfulBackupMissingOrStale: 1 });

    const replacementAfterCorruptionAtMs = firstRunAtMs + 2 * 60 * 60 * 1_000;
    await runStartupCoordinator(maintenance, replacementAfterCorruptionAtMs);
    await expect(maintenance.readLatestVerifiedBackupAtMs()).resolves.toBe(
      replacementAfterCorruptionAtMs,
    );

    await interactions.log({
      occurredAtMs: replacementAfterCorruptionAtMs + 1,
      direction: "internal",
      kind: "maintenance.backup",
      severity: "info",
      outcome: "succeeded",
      byteCount: 0,
      retentionClass: "audit",
      payload: { source: "legacy-maintenance" },
      payloadSchemaVersion: 1,
    });
    await expect(
      maintenance.readLatestVerifiedBackupAtMs(),
    ).resolves.toBeNull();

    const replacementAfterLegacyRecordAtMs = firstRunAtMs + 3 * 60 * 60 * 1_000;
    await runStartupCoordinator(maintenance, replacementAfterLegacyRecordAtMs);
    await expect(maintenance.readLatestVerifiedBackupAtMs()).resolves.toBe(
      replacementAfterLegacyRecordAtMs,
    );
  }, 15_000);

  it("records only sanitized metadata when a backup fails", async () => {
    const directory = await createTemporaryDirectory();
    const eventsDatabaseFile = join(directory, "events.db");
    const databases = await openControllerDatabases({
      state: { filename: join(directory, "state.db") },
      events: { filename: eventsDatabaseFile },
    });
    openDatabases.push(databases);
    const missingStateFile = join(directory, "missing-sensitive-state.db");
    const maintenance = new ControllerBackupMaintenance(
      databases.events,
      new InteractionRepository(databases.events),
      {
        stateDatabaseFile: missingStateFile,
        eventsDatabaseFile,
        destinationDirectory: join(directory, "backups"),
      },
    );

    await expect(
      maintenance.run({
        runAtMs: Date.parse("2026-07-15T02:00:00.000Z"),
        trigger: "scheduled",
      }),
    ).rejects.toThrow();

    const outcome = await databases.events
      .selectFrom("interactions")
      .select(["outcome", "severity", "byte_count", "payload_json"])
      .where("kind", "=", "maintenance.backup")
      .executeTakeFirstOrThrow();
    expect(outcome).toMatchObject({
      outcome: "failed",
      severity: "error",
      byte_count: 0,
    });
    expect(outcome.payload_json).toContain('"trigger":"scheduled"');
    expect(outcome.payload_json).toContain('"errorClass":');
    expect(outcome.payload_json).not.toContain("missing-sensitive-state.db");
    expect(outcome.payload_json).not.toContain(directory);
  });

  it("fails loudly on ambiguous paths and invalid retention bounds", async () => {
    const directory = await createTemporaryDirectory();
    const databases = await openControllerDatabases({
      state: { filename: join(directory, "state.db") },
      events: { filename: join(directory, "events.db") },
    });
    openDatabases.push(databases);
    expect(
      () =>
        new ControllerBackupMaintenance(
          databases.events,
          new InteractionRepository(databases.events),
          {
            stateDatabaseFile: " ",
            eventsDatabaseFile: join(directory, "events.db"),
            destinationDirectory: join(directory, "backups"),
          },
        ),
    ).toThrow(/must not be empty/u);
    await expect(pruneVerifiedControllerBackups(directory, -1)).rejects.toThrow(
      /valid non-negative timestamp/u,
    );
  });
});

async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "aquarium-backup-runtime-"));
  temporaryDirectories.push(directory);
  return directory;
}

async function runStartupCoordinator(
  maintenance: ControllerBackupMaintenance,
  nowMs: number,
): Promise<void> {
  const time = new ManualSchedulingTime(nowMs);
  const errors: Error[] = [];
  const coordinator = new DailyControllerBackupCoordinator(maintenance, {
    clock: time,
    timer: time,
    freshnessThresholdMs: 36 * 60 * 60 * 1_000,
    onError: (error) => errors.push(error),
  });
  await coordinator.start();
  await coordinator.stop();
  expect(errors).toEqual([]);
}
