import type { Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  openEventsDatabase,
  type EventsDatabaseSchema,
} from "../database/index.js";
import {
  EventStorageHealthMetricReader,
  type EventStorageHealthMetricReaderOptions,
} from "./controller-storage-health-repository.js";
import { InteractionRepository } from "./interaction-repository.js";
import type { FilesystemFreeSpacePort } from "./node-filesystem-free-space.js";

class StubVerifiedBackups {
  latestVerifiedBackupAtMs: number | null = null;

  async readLatestVerifiedBackupAtMs(): Promise<number | null> {
    return this.latestVerifiedBackupAtMs;
  }
}

class StubFreeSpace implements FilesystemFreeSpacePort {
  readonly paths: string[] = [];

  async readAvailableBytes(path: string): Promise<number> {
    this.paths.push(path);
    return path.endsWith("archives") ? 123_456 : 234_567;
  }
}

let database: Kysely<EventsDatabaseSchema>;

beforeEach(async () => {
  database = await openEventsDatabase({ filename: ":memory:" });
});

afterEach(async () => {
  await database.destroy();
});

describe("EventStorageHealthMetricReader", () => {
  it("combines statfs free space with projected usage and failure counts", async () => {
    await database
      .insertInto("event_archives")
      .values({
        id: "failed-archive",
        range_start_ms: 0,
        range_end_ms: 1,
        created_at_ms: 1,
        codec: "zstd",
        storage_path: "failed.zst",
        sha256: "0".repeat(64),
        event_count: 0,
        uncompressed_bytes: 0,
        compressed_bytes: 0,
        status: "failed",
      })
      .executeTakeFirstOrThrow();
    await database
      .insertInto("retention_runs")
      .values({
        id: "failed-run",
        started_at_ms: 1,
        completed_at_ms: 2,
        status: "failed",
        bytes_before: 0,
        bytes_after: 0,
      })
      .executeTakeFirstOrThrow();
    const filesystem = new StubFreeSpace();
    const verifiedBackups = new StubVerifiedBackups();
    const reader = new EventStorageHealthMetricReader(database, filesystem, {
      storagePaths: ["C:\\storage", "C:\\storage\\archives"],
      projectionWindowMs: 1_000,
      backupFreshnessThresholdMs: 1_000,
      verifiedBackups,
    });

    const metrics = await reader.read({ observedAtMs: 2_000 });

    expect(metrics).toMatchObject({
      filesystemFreeBytes: 123_456,
      failedRetentionRunCount: 1,
      failedArchiveCount: 1,
      latestBackupOutcomeFailed: 0,
      successfulBackupMissingOrStale: 1,
    });
    expect(metrics.projectedUpperBoundStorageBytesAfterOneYear).toBeGreaterThan(
      0,
    );
    expect(filesystem.paths).toEqual(["C:\\storage", "C:\\storage\\archives"]);
  });

  it("reports only failures newer than the latest successful maintenance outcome", async () => {
    await database
      .insertInto("event_archives")
      .values({
        id: "archive-failed",
        range_start_ms: 0,
        range_end_ms: 1,
        created_at_ms: 1,
        codec: "zstd",
        storage_path: "failed.zst",
        sha256: "0".repeat(64),
        event_count: 0,
        uncompressed_bytes: 0,
        compressed_bytes: 0,
        status: "failed",
      })
      .executeTakeFirstOrThrow();
    await database
      .insertInto("retention_runs")
      .values({
        id: "retention-failed",
        started_at_ms: 1,
        completed_at_ms: 2,
        status: "failed",
        bytes_before: 0,
        bytes_after: 0,
      })
      .executeTakeFirstOrThrow();
    const interactions = new InteractionRepository(database);
    const verifiedBackups = new StubVerifiedBackups();
    await interactions.log({
      occurredAtMs: 3,
      direction: "internal",
      kind: "maintenance.backup",
      severity: "error",
      outcome: "failed",
      byteCount: 0,
      retentionClass: "audit",
    });
    const reader = new EventStorageHealthMetricReader(
      database,
      new StubFreeSpace(),
      {
        storagePaths: ["C:\\storage"],
        projectionWindowMs: 1_000,
        backupFreshnessThresholdMs: 1_000,
        verifiedBackups,
      },
    );

    await expect(reader.read({ observedAtMs: 4 })).resolves.toMatchObject({
      failedRetentionRunCount: 1,
      failedArchiveCount: 1,
      latestBackupOutcomeFailed: 1,
      successfulBackupMissingOrStale: 1,
    });

    await database
      .insertInto("event_archives")
      .values({
        id: "archive-complete",
        range_start_ms: 0,
        range_end_ms: 4,
        created_at_ms: 5,
        codec: "zstd",
        storage_path: "complete.zst",
        sha256: "1".repeat(64),
        event_count: 0,
        uncompressed_bytes: 0,
        compressed_bytes: 0,
        status: "complete",
      })
      .executeTakeFirstOrThrow();
    await database
      .insertInto("retention_runs")
      .values({
        id: "retention-succeeded",
        started_at_ms: 5,
        completed_at_ms: 6,
        status: "succeeded",
        bytes_before: 0,
        bytes_after: 0,
      })
      .executeTakeFirstOrThrow();
    await interactions.log({
      occurredAtMs: 5,
      direction: "internal",
      kind: "maintenance.backup",
      severity: "info",
      outcome: "succeeded",
      byteCount: 0,
      retentionClass: "audit",
    });
    verifiedBackups.latestVerifiedBackupAtMs = 5;

    await expect(reader.read({ observedAtMs: 7 })).resolves.toMatchObject({
      failedRetentionRunCount: 0,
      failedArchiveCount: 0,
      latestBackupOutcomeFailed: 0,
      successfulBackupMissingOrStale: 0,
    });

    await database
      .insertInto("event_archives")
      .values({
        id: "archive-failed-same-time",
        range_start_ms: 4,
        range_end_ms: 5,
        created_at_ms: 5,
        codec: "zstd",
        storage_path: "failed-same-time.zst",
        sha256: "2".repeat(64),
        event_count: 0,
        uncompressed_bytes: 0,
        compressed_bytes: 0,
        status: "failed",
      })
      .executeTakeFirstOrThrow();
    await database
      .insertInto("retention_runs")
      .values({
        id: "retention-failed-same-time",
        started_at_ms: 5,
        completed_at_ms: 6,
        status: "failed",
        bytes_before: 0,
        bytes_after: 0,
      })
      .executeTakeFirstOrThrow();
    await expect(reader.read({ observedAtMs: 8 })).resolves.toMatchObject({
      failedRetentionRunCount: 1,
      failedArchiveCount: 1,
    });

    await database
      .insertInto("event_archives")
      .values({
        id: "archive-complete-same-time",
        range_start_ms: 4,
        range_end_ms: 5,
        created_at_ms: 5,
        codec: "zstd",
        storage_path: "complete-same-time.zst",
        sha256: "3".repeat(64),
        event_count: 0,
        uncompressed_bytes: 0,
        compressed_bytes: 0,
        status: "complete",
      })
      .executeTakeFirstOrThrow();
    await database
      .insertInto("retention_runs")
      .values({
        id: "retention-succeeded-same-time",
        started_at_ms: 5,
        completed_at_ms: 6,
        status: "succeeded",
        bytes_before: 0,
        bytes_after: 0,
      })
      .executeTakeFirstOrThrow();
    await expect(reader.read({ observedAtMs: 9 })).resolves.toMatchObject({
      failedRetentionRunCount: 0,
      failedArchiveCount: 0,
    });
    await expect(reader.read({ observedAtMs: 1_006 })).resolves.toMatchObject({
      latestBackupOutcomeFailed: 0,
      successfulBackupMissingOrStale: 1,
    });
  });

  it("strictly validates reader options", () => {
    const filesystem = new StubFreeSpace();
    expect(
      () =>
        new EventStorageHealthMetricReader(database, filesystem, {
          storagePaths: [" "],
          backupFreshnessThresholdMs: 1_000,
          verifiedBackups: new StubVerifiedBackups(),
        }),
    ).toThrow(/must not be empty/u);
    expect(
      () =>
        new EventStorageHealthMetricReader(database, filesystem, {
          storagePaths: [],
          backupFreshnessThresholdMs: 1_000,
          verifiedBackups: new StubVerifiedBackups(),
        }),
    ).toThrow(/at least one/u);

    const invalidOptions: readonly EventStorageHealthMetricReaderOptions[] = [
      {
        storagePaths: ["C:\\storage"],
        projectionWindowMs: 0,
        backupFreshnessThresholdMs: 1_000,
        verifiedBackups: new StubVerifiedBackups(),
      },
      {
        storagePaths: ["C:\\storage"],
        projectionWindowMs: 1.5,
        backupFreshnessThresholdMs: 1_000,
        verifiedBackups: new StubVerifiedBackups(),
      },
      {
        storagePaths: ["C:\\storage"],
        projectionWindowMs: Number.MAX_SAFE_INTEGER + 1,
        backupFreshnessThresholdMs: 1_000,
        verifiedBackups: new StubVerifiedBackups(),
      },
      {
        storagePaths: ["C:\\storage"],
        backupFreshnessThresholdMs: 0,
        verifiedBackups: new StubVerifiedBackups(),
      },
    ];
    for (const options of invalidOptions) {
      expect(
        () => new EventStorageHealthMetricReader(database, filesystem, options),
      ).toThrow(/positive safe integer/u);
    }
  });
});
