import {
  identifierSchema,
  nonnegativeSafeIntegerSchema,
} from "@aquarium/contracts";
import type { Kysely } from "kysely";
import { z } from "zod";

import type {
  DailySchedulerGuardPort,
  OnlineDeviceReader,
} from "../../application/scheduling/time-sync-coordinator.js";
import type { StateDatabaseSchema } from "./types.js";

const UTC_DAY_MS = 86_400_000;

const claimSchema = z
  .strictObject({
    jobKey: z.string().min(1).max(128),
    scopeKey: z.string().min(1).max(256),
    utcDayStartMs: nonnegativeSafeIntegerSchema,
    startedAtMs: nonnegativeSafeIntegerSchema,
  })
  .superRefine((input, context) => {
    validateUtcDay(input.utcDayStartMs, context);
    if (
      input.startedAtMs < input.utcDayStartMs ||
      input.startedAtMs >= input.utcDayStartMs + UTC_DAY_MS
    ) {
      context.addIssue({
        code: "custom",
        path: ["startedAtMs"],
        message: "Daily guard start must fall within its UTC day",
      });
    }
  });

const resultSchema = z
  .strictObject({
    jobKey: z.string().min(1).max(128),
    scopeKey: z.string().min(1).max(256),
    utcDayStartMs: nonnegativeSafeIntegerSchema,
    completedAtMs: nonnegativeSafeIntegerSchema,
    operationId: identifierSchema,
    succeeded: z.boolean(),
  })
  .superRefine((input, context) => {
    validateUtcDay(input.utcDayStartMs, context);
    if (
      input.succeeded &&
      (input.completedAtMs < input.utcDayStartMs ||
        input.completedAtMs >= input.utcDayStartMs + UTC_DAY_MS)
    ) {
      context.addIssue({
        code: "custom",
        path: ["completedAtMs"],
        message:
          "A successful daily guard result must finish within its UTC day",
      });
    }
  });

export class SchedulerGuardRepository implements DailySchedulerGuardPort {
  constructor(private readonly database: Kysely<StateDatabaseSchema>) {}

  async tryClaimDailyRun(
    rawInput: z.input<typeof claimSchema>,
  ): Promise<boolean> {
    const input = claimSchema.parse(rawInput);
    return this.database.transaction().execute(async (transaction) => {
      const existing = await transaction
        .selectFrom("scheduler_guards")
        .selectAll()
        .where("job_key", "=", input.jobKey)
        .where("scope_key", "=", input.scopeKey)
        .executeTakeFirst();
      if (existing === undefined) {
        await transaction
          .insertInto("scheduler_guards")
          .values({
            job_key: input.jobKey,
            scope_key: input.scopeKey,
            last_started_utc_day_start_ms: input.utcDayStartMs,
            last_started_at_ms: input.startedAtMs,
            last_operation_id: null,
            last_success_utc_day_start_ms: null,
            last_success_at_ms: null,
            created_at_ms: input.startedAtMs,
            updated_at_ms: input.startedAtMs,
          })
          .executeTakeFirstOrThrow();
        return true;
      }
      if (
        existing.last_started_utc_day_start_ms !== null &&
        existing.last_started_utc_day_start_ms > input.utcDayStartMs
      ) {
        throw new RangeError(
          `Daily guard ${input.jobKey}/${input.scopeKey} cannot move to an earlier UTC day`,
        );
      }
      if (existing.last_started_utc_day_start_ms === input.utcDayStartMs) {
        return false;
      }
      if (input.startedAtMs < existing.updated_at_ms) {
        throw new RangeError(
          `Daily guard ${input.jobKey}/${input.scopeKey} clock regressed`,
        );
      }
      const update = await transaction
        .updateTable("scheduler_guards")
        .set({
          last_started_utc_day_start_ms: input.utcDayStartMs,
          last_started_at_ms: input.startedAtMs,
          last_operation_id: null,
          updated_at_ms: input.startedAtMs,
        })
        .where("job_key", "=", input.jobKey)
        .where("scope_key", "=", input.scopeKey)
        .executeTakeFirstOrThrow();
      if (update.numUpdatedRows !== 1n) {
        throw new Error(
          `Daily guard ${input.jobKey}/${input.scopeKey} changed while claiming a run`,
        );
      }
      return true;
    });
  }

  async recordDailyRunResult(
    rawInput: z.input<typeof resultSchema>,
  ): Promise<boolean> {
    const input = resultSchema.parse(rawInput);
    return this.database.transaction().execute(async (transaction) => {
      const existing = await transaction
        .selectFrom("scheduler_guards")
        .selectAll()
        .where("job_key", "=", input.jobKey)
        .where("scope_key", "=", input.scopeKey)
        .executeTakeFirstOrThrow();
      if (existing.last_started_utc_day_start_ms !== input.utcDayStartMs) {
        return false;
      }
      if (
        existing.last_started_at_ms === null ||
        input.completedAtMs < existing.last_started_at_ms ||
        input.completedAtMs < existing.updated_at_ms
      ) {
        throw new RangeError(
          `Daily guard ${input.jobKey}/${input.scopeKey} completion clock regressed`,
        );
      }
      const update = await transaction
        .updateTable("scheduler_guards")
        .set({
          last_operation_id: input.operationId,
          ...(input.succeeded
            ? {
                last_success_utc_day_start_ms: input.utcDayStartMs,
                last_success_at_ms: input.completedAtMs,
              }
            : {}),
          updated_at_ms: input.completedAtMs,
        })
        .where("job_key", "=", input.jobKey)
        .where("scope_key", "=", input.scopeKey)
        .where("last_started_utc_day_start_ms", "=", input.utcDayStartMs)
        .executeTakeFirstOrThrow();
      if (update.numUpdatedRows !== 1n) {
        return false;
      }
      return true;
    });
  }
}

export class OnlineDeviceRepository implements OnlineDeviceReader {
  constructor(private readonly database: Kysely<StateDatabaseSchema>) {}

  async listOnlineDeviceIds(): Promise<readonly string[]> {
    const rows = await this.database
      .selectFrom("devices")
      .select("id")
      .where("enabled", "=", 1)
      .where("status", "=", "online")
      .orderBy("id", "asc")
      .execute();
    return rows.map(({ id }) => identifierSchema.parse(id));
  }
}

function validateUtcDay(utcDayStartMs: number, context: z.RefinementCtx): void {
  if (utcDayStartMs % UTC_DAY_MS !== 0) {
    context.addIssue({
      code: "custom",
      path: ["utcDayStartMs"],
      message: "Daily guard UTC day start must be aligned to midnight UTC",
    });
  }
}
