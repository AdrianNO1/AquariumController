import { createHash } from "node:crypto";

import type { Kysely, Transaction } from "kysely";
import { z } from "zod";

import {
  acquireOperatorConcurrencyFloor,
  advanceOperatorConcurrencyFloor,
  serializeStateOutboxEnvelope,
  STATE_OUTBOX_ENVELOPE_SCHEMA_VERSION,
  type StateDatabaseSchema,
} from "../database/index.js";
import {
  analyzeLegacySource,
  type LegacyImportIssue,
  type LegacyImportPlan,
  type LegacyImportReport,
} from "./legacy-import-analyzer.js";

export interface LegacyImportOptions {
  readonly sourceDirectory: string;
  readonly dryRun: boolean;
  readonly database?: Kysely<StateDatabaseSchema>;
  readonly nowMs?: number;
  readonly actor?: string;
}

export interface LegacyImportResult {
  readonly report: LegacyImportReport;
  readonly committed: boolean;
  readonly importRunId: string | null;
  readonly revision: number | null;
}

export class LegacyImportAlreadyAppliedError extends Error {
  readonly sourceFingerprint: string;

  constructor(sourceFingerprint: string) {
    super(
      `Legacy source ${sourceFingerprint} has already been imported successfully.`,
    );
    this.name = "LegacyImportAlreadyAppliedError";
    this.sourceFingerprint = sourceFingerprint;
  }
}

const importCompletedPayloadSchema = z.strictObject({
  schemaVersion: z.literal(1),
  importRunId: z.string().min(1),
  sourceFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  normalizedCounts: z.strictObject({
    throttles: z.number().int().nonnegative(),
    channels: z.number().int().nonnegative(),
    schedules: z.number().int().nonnegative(),
    schedulePoints: z.number().int().nonnegative(),
    mappingProfiles: z.number().int().nonnegative(),
    pinMappings: z.number().int().nonnegative(),
  }),
  warningCount: z.number().int().nonnegative(),
});

export async function importLegacyDirectory(
  options: LegacyImportOptions,
): Promise<LegacyImportResult> {
  const analysis = await analyzeLegacySource(options.sourceDirectory);
  if (options.dryRun || !analysis.report.canCommit) {
    return {
      report: analysis.report,
      committed: false,
      importRunId: null,
      revision: null,
    };
  }
  if (options.database === undefined) {
    throw new TypeError(
      "A state database is required for a committed legacy import.",
    );
  }

  const nowMs = options.nowMs ?? Date.now();
  assertTimestamp(nowMs);
  const actor = options.actor?.trim() || "legacy-import-cli";
  const importRunId = stableId("import", analysis.report.sourceFingerprint);

  const revision = await options.database
    .transaction()
    .execute(async (transaction) => {
      const lockedOperatorFloor =
        await acquireOperatorConcurrencyFloor(transaction);
      const existing = await transaction
        .selectFrom("import_runs")
        .select("id")
        .where("source_fingerprint", "=", analysis.report.sourceFingerprint)
        .where("dry_run", "=", 0)
        .where("status", "=", "succeeded")
        .executeTakeFirst();
      if (existing !== undefined) {
        throw new LegacyImportAlreadyAppliedError(
          analysis.report.sourceFingerprint,
        );
      }

      await transaction
        .insertInto("import_runs")
        .values({
          id: importRunId,
          source_kind: "legacy-json-v1",
          source_fingerprint: analysis.report.sourceFingerprint,
          dry_run: 0,
          status: "validating",
          started_at_ms: nowMs,
        })
        .executeTakeFirstOrThrow();

      await insertImportPlan(transaction, analysis.plan, nowMs);
      await insertImportIssues(
        transaction,
        importRunId,
        analysis.report.issues,
      );

      const stateRevision = await transaction
        .insertInto("state_revisions")
        .values({
          committed_at_ms: nowMs,
          actor,
          mutation_type: "legacy-import",
          summary: `Imported ${analysis.report.normalizedCounts.channels} channels and ${analysis.report.normalizedCounts.mappingProfiles} mapping profiles.`,
        })
        .returning("revision")
        .executeTakeFirstOrThrow();

      const outboxPayload = importCompletedPayloadSchema.parse({
        schemaVersion: 1,
        importRunId,
        sourceFingerprint: analysis.report.sourceFingerprint,
        normalizedCounts: analysis.report.normalizedCounts,
        warningCount: analysis.report.warningCount,
      });
      await transaction
        .insertInto("state_outbox")
        .values({
          revision: stateRevision.revision,
          event_type: "legacy-import.completed",
          entity_type: "import_run",
          entity_id: importRunId,
          occurred_at_ms: nowMs,
          retention_class: "audit",
          payload_json: serializeStateOutboxEnvelope(
            JSON.stringify(outboxPayload),
            outboxPayload.schemaVersion,
            [
              { resource: "import_run", id: importRunId },
              { resource: "controller", id: null },
            ],
          ),
          payload_schema_version: STATE_OUTBOX_ENVELOPE_SCHEMA_VERSION,
          available_at_ms: nowMs,
        })
        .executeTakeFirstOrThrow();

      await advanceOperatorConcurrencyFloor(
        transaction,
        lockedOperatorFloor,
        stateRevision.revision,
      );

      await transaction
        .updateTable("import_runs")
        .set({
          status: "succeeded",
          completed_at_ms: nowMs,
          report_json: JSON.stringify(z.json().parse(analysis.report)),
          report_schema_version: analysis.report.schemaVersion,
        })
        .where("id", "=", importRunId)
        .executeTakeFirstOrThrow();

      return stateRevision.revision;
    });

  return {
    report: analysis.report,
    committed: true,
    importRunId,
    revision,
  };
}

async function insertImportPlan(
  transaction: Transaction<StateDatabaseSchema>,
  plan: LegacyImportPlan,
  nowMs: number,
): Promise<void> {
  const throttleIds = new Map(
    plan.throttles.map((throttle) => [
      throttle.typeKey,
      stableId("throttle", throttle.typeKey),
    ]),
  );
  await transaction
    .insertInto("throttles")
    .values(
      plan.throttles.map((throttle) => ({
        id: requiredMapValue(throttleIds, throttle.typeKey),
        type_key: throttle.typeKey,
        percentage: throttle.percentage,
        created_at_ms: nowMs,
        updated_at_ms: nowMs,
      })),
    )
    .execute();

  const channelIds = new Map(
    plan.channels.map((channel) => [
      channel.name,
      stableId("channel", channel.name),
    ]),
  );
  if (plan.channels.length > 0) {
    await transaction
      .insertInto("channels")
      .values(
        plan.channels.map((channel) => ({
          id: requiredMapValue(channelIds, channel.name),
          name: channel.name,
          kind: channel.kind,
          throttle_id: requiredMapValue(throttleIds, channel.kind),
          display_order: channel.displayOrder,
          created_at_ms: nowMs,
          updated_at_ms: nowMs,
        })),
      )
      .execute();

    await transaction
      .insertInto("schedules")
      .values(
        plan.channels.map((channel) => ({
          id: stableId("schedule", channel.name),
          channel_id: requiredMapValue(channelIds, channel.name),
          name: channel.name,
          timezone: "UTC" as const,
          created_at_ms: nowMs,
          updated_at_ms: nowMs,
        })),
      )
      .execute();

    await transaction
      .insertInto("schedule_points")
      .values(
        plan.channels.flatMap((channel) => {
          const scheduleId = stableId("schedule", channel.name);
          return channel.points.map((point, position) => ({
            id: stableId("point", `${channel.name}\0${position}`),
            schedule_id: scheduleId,
            position,
            minute_of_day: point.minuteOfDay,
            percentage: point.percentage,
            editor_x: null,
            editor_y: null,
            created_at_ms: nowMs,
            updated_at_ms: nowMs,
          }));
        }),
      )
      .execute();
  }

  const profileIds = new Map(
    plan.mappingProfiles.map((profile) => [
      profile.deviceNamePrefix,
      stableId("profile", profile.deviceNamePrefix),
    ]),
  );
  if (plan.mappingProfiles.length > 0) {
    await transaction
      .insertInto("mapping_profiles")
      .values(
        plan.mappingProfiles.map((profile) => ({
          id: requiredMapValue(profileIds, profile.deviceNamePrefix),
          name: profile.name,
          device_name_prefix: profile.deviceNamePrefix,
          output_gain: profile.outputGain,
          created_at_ms: nowMs,
          updated_at_ms: nowMs,
        })),
      )
      .execute();

    const mappings = plan.mappingProfiles.flatMap((profile) =>
      profile.mappings.map((mapping) => ({
        id: stableId(
          "mapping",
          `${profile.deviceNamePrefix}\0${mapping.pin}\0${mapping.channelName}`,
        ),
        mapping_profile_id: requiredMapValue(
          profileIds,
          profile.deviceNamePrefix,
        ),
        channel_id: requiredMapValue(channelIds, mapping.channelName),
        pin: mapping.pin,
        display_order: mapping.displayOrder,
        created_at_ms: nowMs,
        updated_at_ms: nowMs,
      })),
    );
    if (mappings.length > 0) {
      await transaction.insertInto("pin_mappings").values(mappings).execute();
    }
  }
}

async function insertImportIssues(
  transaction: Transaction<StateDatabaseSchema>,
  importRunId: string,
  issues: readonly LegacyImportIssue[],
): Promise<void> {
  if (issues.length === 0) return;
  await transaction
    .insertInto("import_issues")
    .values(
      issues.map((issue) => ({
        import_run_id: importRunId,
        severity: issue.severity,
        code: issue.code,
        source_file: issue.sourceFile,
        source_path: issue.sourcePath,
        message: issue.message,
        details_json:
          issue.details === undefined
            ? null
            : JSON.stringify(z.json().parse(issue.details)),
        details_schema_version: issue.details === undefined ? null : 1,
      })),
    )
    .execute();
}

function stableId(kind: string, identity: string): string {
  const digest = createHash("sha256")
    .update(identity)
    .digest("hex")
    .slice(0, 24);
  return `${kind}_${digest}`;
}

function requiredMapValue<Key>(
  map: ReadonlyMap<Key, string>,
  key: Key,
): string {
  const value = map.get(key);
  if (value === undefined) {
    throw new Error("Internal importer error: normalized identity is missing.");
  }
  return value;
}

function assertTimestamp(nowMs: number): void {
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) {
    throw new RangeError(
      "Legacy import timestamp must be a nonnegative safe integer.",
    );
  }
  if (!Number.isFinite(new Date(nowMs).getTime())) {
    throw new RangeError(
      "Legacy import timestamp must be representable as a date.",
    );
  }
}
