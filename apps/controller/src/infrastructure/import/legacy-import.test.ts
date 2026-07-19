import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { basename, join, resolve, sep } from "node:path";
import { tmpdir } from "node:os";

import {
  openStateDatabase,
  parseStoredStateOutboxEnvelope,
} from "../database/index.js";
import {
  analyzeLegacyDirectory,
  type LegacyImportReport,
} from "./legacy-import-analyzer.js";
import {
  importLegacyDirectory,
  LegacyImportAlreadyAppliedError,
} from "./legacy-import-service.js";

const temporaryDirectories = new Set<string>();

afterEach(async () => {
  const temporaryRoot = `${resolve(tmpdir())}${sep}`;
  for (const directory of temporaryDirectories) {
    const resolvedDirectory = resolve(directory);
    if (
      !resolvedDirectory.startsWith(temporaryRoot) ||
      !basename(resolvedDirectory).startsWith("aquarium-import-")
    ) {
      throw new Error(
        `Refusing to remove unexpected test directory: ${resolvedDirectory}`,
      );
    }
    await rm(resolvedDirectory, { recursive: true, force: true });
    temporaryDirectories.delete(directory);
  }
});

describe("legacy JSON import", () => {
  it("accepts the audited production snapshot with only explicit safe normalizations", async () => {
    const report = await analyzeLegacyDirectory(resolve(".old/data"));

    expect(report).toMatchObject({
      importerVersion: "legacy-json-v2",
      sourceFingerprint:
        "15580a1ec55c1181db2a5d78f494ba18bc195f47a135b4b700028d5854033275",
      valid: true,
      canCommit: true,
      errorCount: 0,
      warningCount: 85,
    });
    expect(countIssues(report, "implicit-zero-tail-materialized")).toBe(30);
    expect(countIssues(report, "duplicate-initial-segment-removed")).toBe(1);
    expect(countIssues(report, "duplicate-terminal-segment-removed")).toBe(5);
    expect(countIssues(report, "orphan-schedule-preserved")).toBe(37);
    expect(countIssues(report, "legacy-throttle-default-materialized")).toBe(5);
    expect(countIssues(report, "inconsistent-editor-coordinate")).toBe(2);
    expect(countIssues(report, "skipped-legacy-file")).toBe(4);
    expect(report.normalizedCounts).toEqual({
      throttles: 11,
      channels: 66,
      schedules: 66,
      schedulePoints: 318,
      mappingProfiles: 7,
      pinMappings: 34,
    });
    expect(
      report.files.map(({ fileName, rootRecordCount, nestedRecordCount }) => ({
        fileName,
        rootRecordCount,
        nestedRecordCount,
      })),
    ).toEqual([
      { fileName: "links.json", rootRecordCount: 66, nestedRecordCount: 228 },
      { fileName: "channels.json", rootRecordCount: 7, nestedRecordCount: 34 },
      {
        fileName: "throttle.json",
        rootRecordCount: 6,
        nestedRecordCount: null,
      },
      {
        fileName: "temporaryoverwritesliders.json",
        rootRecordCount: 2,
        nestedRecordCount: 6,
      },
      {
        fileName: "device_memory.json",
        rootRecordCount: 2,
        nestedRecordCount: null,
      },
      {
        fileName: "espstatuses.json",
        rootRecordCount: 6,
        nestedRecordCount: 32,
      },
      {
        fileName: "homepagedata.json",
        rootRecordCount: 4,
        nestedRecordCount: 54,
      },
    ]);
  });

  it("produces byte-for-byte deterministic reports for unchanged source", async () => {
    const first = await analyzeLegacyDirectory(resolve(".old/data"));
    const second = await analyzeLegacyDirectory(resolve(".old/data"));

    expect(JSON.stringify(second)).toBe(JSON.stringify(first));
  });

  it("detects exact duplicate JSON keys before normalization", async () => {
    const directory = await createValidFixture();
    await writeFile(
      join(directory, "throttle.json"),
      '{"badthrottle":75,"badthrottle":75}',
      "utf8",
    );

    const report = await analyzeLegacyDirectory(directory);

    expect(report.valid).toBe(false);
    expect(countIssues(report, "duplicate-json-key")).toBe(1);
    expect(
      report.issues.find((issue) => issue.code === "duplicate-json-key"),
    ).toMatchObject({
      sourceFile: "throttle.json",
      sourcePath: "$",
      details: { key: "badthrottle" },
    });
  });

  it("does not execute deferred DSL/WIP text", async () => {
    const directory = await createValidFixture();
    const marker = "__aquariumLegacyImportExecuted";
    Reflect.deleteProperty(globalThis, marker);
    await writeJson(join(directory, "homepagedata.json"), {
      codegroups: {
        deferred: {
          code: `globalThis.${marker} = true`,
        },
      },
    });

    const report = await analyzeLegacyDirectory(directory);

    expect(report.valid).toBe(true);
    expect(Reflect.get(globalThis, marker)).toBeUndefined();
    expect(
      report.issues.find(
        (issue) =>
          issue.code === "skipped-legacy-file" &&
          issue.sourceFile === "homepagedata.json",
      )?.message,
    ).toContain("never executed");
  });

  it("normalizes only output-equivalent zero boundary segments and tails", async () => {
    const directory = await createValidFixture();
    const zero = { time: 0, percentage: 0, x: 0, y: 250 };
    const end = { time: 1439, percentage: 0, x: 930, y: 250 };
    await writeJson(join(directory, "links.json"), {
      "bad Blue": {
        type: "bad",
        links: [
          { source: zero, target: zero },
          {
            source: zero,
            target: { time: 274, percentage: 0, x: 177, y: 250 },
          },
        ],
      },
      "Bad Blue": {
        type: "bad",
        links: [
          { source: zero, target: end },
          { source: end, target: end },
        ],
      },
    });

    const report = await analyzeLegacyDirectory(directory);

    expect(report.valid).toBe(true);
    expect(countIssues(report, "duplicate-initial-segment-removed")).toBe(1);
    expect(countIssues(report, "duplicate-terminal-segment-removed")).toBe(1);
    expect(countIssues(report, "implicit-zero-tail-materialized")).toBe(1);
    expect(report.normalizedCounts.schedulePoints).toBe(5);
  });

  it("keeps dry-run completely read-only even when a database is supplied", async () => {
    const directory = await createValidFixture();
    const database = await openStateDatabase({
      filename: join(directory, "state.db"),
    });
    try {
      const result = await importLegacyDirectory({
        sourceDirectory: directory,
        dryRun: true,
        database,
        nowMs: 100,
      });

      expect(result.committed).toBe(false);
      expect(result.report.valid).toBe(true);
      await expectTableCount(database, "import_runs", 0);
      await expectTableCount(database, "throttles", 0);
      await expectTableCount(database, "channels", 0);
      await expectTableCount(database, "state_revisions", 0);
      await expectTableCount(database, "state_outbox", 0);
      await expect(
        database
          .selectFrom("operator_concurrency")
          .select("last_operator_revision")
          .executeTakeFirstOrThrow(),
      ).resolves.toEqual({ last_operator_revision: 0 });
    } finally {
      await database.destroy();
    }
  });

  it("aborts an invalid requested commit without recording partial audit rows", async () => {
    const directory = await createValidFixture();
    await writeJson(join(directory, "links.json"), {
      "bad Blue": {
        type: "bad",
        links: [
          {
            source: { time: 0, percentage: 0 },
            target: { time: 274, percentage: 50 },
          },
        ],
      },
      "Bad Blue": {
        type: "bad",
        links: [
          {
            source: { time: 0, percentage: 0 },
            target: { time: 1439, percentage: 0 },
          },
        ],
      },
    });
    const database = await openStateDatabase({
      filename: join(directory, "state.db"),
    });
    try {
      const result = await importLegacyDirectory({
        sourceDirectory: directory,
        dryRun: false,
        database,
        nowMs: 100,
      });

      expect(result.committed).toBe(false);
      expect(countIssues(result.report, "schedule-end-minute")).toBe(1);
      await expectTableCount(database, "import_runs", 0);
      await expectTableCount(database, "throttles", 0);
      await expectTableCount(database, "channels", 0);
      await expectTableCount(database, "state_revisions", 0);
    } finally {
      await database.destroy();
    }
  });

  it("commits normalized state, provenance warnings, revision, and outbox atomically", async () => {
    const directory = await createValidFixture();
    const database = await openStateDatabase({
      filename: join(directory, "state.db"),
    });
    try {
      const result = await importLegacyDirectory({
        sourceDirectory: directory,
        dryRun: false,
        database,
        nowMs: 1234,
        actor: "test-importer",
      });

      expect(result.committed).toBe(true);
      expect(result.revision).toBe(1);
      expect(result.importRunId).not.toBeNull();
      await expect(
        database
          .selectFrom("operator_concurrency")
          .select("last_operator_revision")
          .executeTakeFirstOrThrow(),
      ).resolves.toEqual({ last_operator_revision: 1 });
      expect(
        await database
          .selectFrom("channels")
          .select(["name", "kind", "display_order"])
          .orderBy("display_order")
          .execute(),
      ).toEqual([
        { name: "bad Blue", kind: "bad", display_order: 0 },
        { name: "Bad Blue", kind: "bad", display_order: 1 },
      ]);
      expect(
        await database
          .selectFrom("mapping_profiles")
          .select(["device_name_prefix", "output_gain"])
          .executeTakeFirstOrThrow(),
      ).toEqual({ device_name_prefix: "mainLys", output_gain: 0.7 });
      expect(
        await database
          .selectFrom("throttles")
          .select(["type_key", "percentage"])
          .where("type_key", "=", "qt4")
          .executeTakeFirstOrThrow(),
      ).toEqual({ type_key: "qt4", percentage: 100 });
      expect(
        await database
          .selectFrom("schedule_points")
          .select(["minute_of_day", "percentage", "editor_x", "editor_y"])
          .orderBy("schedule_id")
          .orderBy("position")
          .execute(),
      ).toEqual([
        { minute_of_day: 0, percentage: 0, editor_x: null, editor_y: null },
        { minute_of_day: 1439, percentage: 0, editor_x: null, editor_y: null },
        { minute_of_day: 0, percentage: 0, editor_x: null, editor_y: null },
        { minute_of_day: 1439, percentage: 0, editor_x: null, editor_y: null },
      ]);
      const outbox = await database
        .selectFrom("state_outbox")
        .selectAll()
        .executeTakeFirstOrThrow();
      expect(outbox).toMatchObject({
        revision: 1,
        event_type: "legacy-import.completed",
        retention_class: "audit",
      });
      expect(parseStoredStateOutboxEnvelope(outbox).invalidations).toEqual([
        { resource: "import_run", id: result.importRunId },
        { resource: "controller", id: null },
      ]);
      const importRun = await database
        .selectFrom("import_runs")
        .select(["status", "dry_run", "report_json"])
        .executeTakeFirstOrThrow();
      expect(importRun.status).toBe("succeeded");
      expect(importRun.dry_run).toBe(0);
      expect(JSON.parse(importRun.report_json ?? "null")).toEqual(
        result.report,
      );
      await expectTableCount(
        database,
        "import_issues",
        result.report.warningCount,
      );

      await expect(
        importLegacyDirectory({
          sourceDirectory: directory,
          dryRun: false,
          database,
          nowMs: 1235,
        }),
      ).rejects.toBeInstanceOf(LegacyImportAlreadyAppliedError);
      await expectTableCount(database, "import_runs", 1);
      await expectTableCount(database, "channels", 2);
      await expectTableCount(database, "state_revisions", 1);
      await expect(
        database
          .selectFrom("operator_concurrency")
          .select("last_operator_revision")
          .executeTakeFirstOrThrow(),
      ).resolves.toEqual({ last_operator_revision: 1 });
    } finally {
      await database.destroy();
    }
  });

  it("rolls back every inserted row when a late relational conflict occurs", async () => {
    const directory = await createValidFixture();
    const database = await openStateDatabase({
      filename: join(directory, "state.db"),
    });
    try {
      await database
        .insertInto("mapping_profiles")
        .values({
          id: "preexisting",
          name: "mainLys",
          device_name_prefix: "DifferentPrefix",
          created_at_ms: 1,
          updated_at_ms: 1,
        })
        .executeTakeFirstOrThrow();

      await expect(
        importLegacyDirectory({
          sourceDirectory: directory,
          dryRun: false,
          database,
          nowMs: 1234,
        }),
      ).rejects.toThrow(/UNIQUE constraint/i);

      await expectTableCount(database, "mapping_profiles", 1);
      await expectTableCount(database, "import_runs", 0);
      await expectTableCount(database, "import_issues", 0);
      await expectTableCount(database, "throttles", 0);
      await expectTableCount(database, "channels", 0);
      await expectTableCount(database, "schedules", 0);
      await expectTableCount(database, "schedule_points", 0);
      await expectTableCount(database, "state_revisions", 0);
      await expectTableCount(database, "state_outbox", 0);
      await expect(
        database
          .selectFrom("operator_concurrency")
          .select("last_operator_revision")
          .executeTakeFirstOrThrow(),
      ).resolves.toEqual({ last_operator_revision: 0 });
    } finally {
      await database.destroy();
    }
  });
});

async function createTemporaryDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "aquarium-import-"));
  temporaryDirectories.add(directory);
  return directory;
}

async function createValidFixture(): Promise<string> {
  const directory = await createTemporaryDirectory();
  const segment = {
    source: { time: 0, percentage: 0, x: 0, y: 250 },
    target: { time: 1439, percentage: 0, x: 930, y: 250 },
  };
  await Promise.all([
    writeJson(join(directory, "links.json"), {
      "bad Blue": { type: "bad", links: [segment] },
      "Bad Blue": { type: "bad", links: [segment] },
    }),
    writeJson(join(directory, "channels.json"), {
      mainLys: [{ channel: "bad Blue", pin: 12 }],
    }),
    writeJson(join(directory, "throttle.json"), {
      lightthrottle: 100,
      pumpthrottle: 100,
      testlightthrottle: 100,
      badthrottle: 75,
      loftthrottle: 100,
      biljardthrottle: 100,
      fragthrottle: 100,
      qt1throttle: 100,
      qt2throttle: 100,
      qt3throttle: 100,
    }),
    writeJson(join(directory, "temporaryoverwritesliders.json"), {
      values: [{ name: "bad Blue", value: "100" }],
      updated_at: 1,
    }),
    writeJson(join(directory, "device_memory.json"), {}),
    writeJson(join(directory, "espstatuses.json"), { codegroups: {} }),
    writeJson(join(directory, "homepagedata.json"), { codegroups: {} }),
  ]);
  return directory;
}

function writeJson(path: string, value: object): Promise<void> {
  return writeFile(path, JSON.stringify(value, null, 2), "utf8");
}

function countIssues(report: LegacyImportReport, code: string): number {
  return report.issues.filter((issue) => issue.code === code).length;
}

async function expectTableCount(
  database: Awaited<ReturnType<typeof openStateDatabase>>,
  table:
    | "channels"
    | "import_issues"
    | "import_runs"
    | "mapping_profiles"
    | "schedule_points"
    | "schedules"
    | "state_outbox"
    | "state_revisions"
    | "throttles",
  expected: number,
): Promise<void> {
  const result = await database
    .selectFrom(table)
    .select((expression) => expression.fn.countAll<number>().as("count"))
    .executeTakeFirstOrThrow();
  expect(result.count).toBe(expected);
}
