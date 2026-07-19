import { nonnegativeSafeIntegerSchema } from "@aquarium/contracts";
import type { Kysely } from "kysely";
import { z } from "zod";

import type { EventRetentionRunRecoveryPort } from "../../application/maintenance/daily-event-retention-coordinator.js";
import type { EventsDatabaseSchema } from "../database/types.js";
import { serializeCanonicalJson } from "./interaction-repository.js";

export const STALE_RETENTION_RUN_FAILURE_MESSAGE =
  "Retention run exceeded the stale-running threshold and was recovered as failed";

const recoveryRequestSchema = z
  .strictObject({
    recoveredAtMs: nonnegativeSafeIntegerSchema,
    staleBeforeMs: nonnegativeSafeIntegerSchema,
  })
  .superRefine((input, context) => {
    if (input.staleBeforeMs > input.recoveredAtMs) {
      context.addIssue({
        code: "custom",
        path: ["staleBeforeMs"],
        message: "Retention stale cutoff cannot follow recovery time",
      });
    }
  });

const recoveryFailureSchema = z.strictObject({
  schemaVersion: z.literal(1),
  message: z.literal(STALE_RETENTION_RUN_FAILURE_MESSAGE),
});

export class EventRetentionRunRecovery implements EventRetentionRunRecoveryPort {
  constructor(private readonly database: Kysely<EventsDatabaseSchema>) {}

  async recoverStaleRuns(
    rawInput: z.input<typeof recoveryRequestSchema>,
  ): Promise<readonly string[]> {
    const input = recoveryRequestSchema.parse(rawInput);
    const failure = recoveryFailureSchema.parse({
      schemaVersion: 1,
      message: STALE_RETENTION_RUN_FAILURE_MESSAGE,
    });
    const recovered = await this.database
      .updateTable("retention_runs")
      .set({
        completed_at_ms: input.recoveredAtMs,
        status: "failed",
        bytes_after: null,
        error_json: serializeCanonicalJson(failure),
        error_schema_version: 1,
      })
      .where("status", "=", "running")
      .where("started_at_ms", "<=", input.staleBeforeMs)
      .returning("id")
      .execute();
    return recovered.map(({ id }) => id).sort();
  }
}
