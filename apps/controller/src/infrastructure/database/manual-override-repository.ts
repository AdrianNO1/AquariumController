import {
  gainSchema,
  identifierSchema,
  manualOverrideTargetSchema,
  mutationResultSchema,
  nonnegativeSafeIntegerSchema,
  percentageSchema,
  type ManualOverrideTarget,
  type MutationResult,
} from "@aquarium/contracts";
import {
  evaluateSchedulePercent,
  scheduleGraphFromPoints,
  toHostPwm,
  validateScheduleGraph,
  type SchedulePoint,
} from "@aquarium/domain";
import { isSupportedEspFirmwareVersion } from "@aquarium/esp-protocol";
import { sql, type Kysely, type Selectable } from "kysely";
import { z } from "zod";

import {
  InvalidManualOverrideTransitionError,
  ManualOverrideConflictError,
  ManualOverrideNotFoundError,
  ManualOverrideRevisionConflictError,
} from "../../application/overrides/manual-override-errors.js";
import {
  DEVICE_OPERATION_REQUEST_SCHEMA_VERSION,
  DEVICE_OPERATION_RESULT_SCHEMA_VERSION,
  deviceOperationRequestSchema,
  deviceOperationResultSchema,
} from "../../application/operations/device-operation-types.js";
import {
  MANUAL_OVERRIDE_DURATION_MS,
  MANUAL_OVERRIDE_OPERATION_SCHEMA_VERSION,
  manualOverrideOperationRequestSchema,
  manualOverrideOperationResultSchema,
  type ManualOverrideOperationRequest,
  type ManualOverrideOperationResult,
  type ManualOverrideOverlayOutput,
  type ManualOverridePinCommand,
  type ManualOverrideRepositoryPort,
  type PreparedManualOverrideOperation,
  type StoredManualOverride,
  type StoredManualOverrideOperation,
  type StoredManualOverrideStateMutation,
} from "../../application/overrides/manual-override-types.js";
import { parseJsonDocument } from "../import/strict-json.js";
import {
  commitConditionalStateChange,
  commitStateChange,
  toCommittedStateEvent,
  type StateDatabaseTransaction,
} from "./state-outbox.js";
import type {
  ControlOperationsTable,
  OverridesTable,
  StateDatabaseSchema,
} from "./types.js";

const startMappingRowSchema = z.strictObject({
  deviceId: identifierSchema,
  mappingId: identifierSchema,
  pin: z.number().int().min(0).max(63),
  profileGain: gainSchema,
  outputGain: gainSchema.nullable(),
  firmwareVersion: z.string().min(1).nullable(),
});

const releaseMappingRowSchema = z.strictObject({
  deviceId: identifierSchema,
  mappingId: identifierSchema,
  pin: z.number().int().min(0).max(63),
  channelId: identifierSchema.nullable(),
  channelEnabled: z.union([z.literal(0), z.literal(1)]).nullable(),
  throttlePercent: percentageSchema.nullable(),
  profileGain: gainSchema,
  scheduleId: identifierSchema.nullable(),
  firmwareVersion: z.string().min(1).nullable(),
});

const releasePointRowSchema = z.strictObject({
  minute: z.number().int().min(0).max(1_439),
  percent: percentageSchema,
});

const MANUAL_OPERATION_KINDS = [
  "manual_override_start",
  "manual_override_cancel",
  "manual_override_expire",
] as const satisfies readonly ManualOverrideOperationRequest["kind"][];

export class ManualOverrideRepository implements ManualOverrideRepositoryPort {
  readonly #database: Kysely<StateDatabaseSchema>;
  #operationTail: Promise<void> = Promise.resolve();

  constructor(database: Kysely<StateDatabaseSchema>) {
    this.#database = database;
  }

  createStart(input: {
    readonly overrideId: string;
    readonly operationId: string;
    readonly expectedRevision: number;
    readonly replaceOverrideId?: string;
    readonly target: ManualOverrideTarget;
    readonly valuePercentage: number;
    readonly requestedAtMs: number;
    readonly expiresAtMs: number;
    readonly deadlineAtMs: number;
  }): Promise<PreparedManualOverrideOperation> {
    const parsed = {
      overrideId: identifierSchema.parse(input.overrideId),
      operationId: identifierSchema.parse(input.operationId),
      expectedRevision: nonnegativeSafeIntegerSchema.parse(
        input.expectedRevision,
      ),
      replaceOverrideId:
        input.replaceOverrideId === undefined
          ? null
          : identifierSchema.parse(input.replaceOverrideId),
      target: manualOverrideTargetSchema.parse(input.target),
      valuePercentage: percentageSchema.parse(input.valuePercentage),
      requestedAtMs: nonnegativeSafeIntegerSchema.parse(input.requestedAtMs),
      expiresAtMs: nonnegativeSafeIntegerSchema.parse(input.expiresAtMs),
      deadlineAtMs: nonnegativeSafeIntegerSchema.parse(input.deadlineAtMs),
    };
    if (parsed.expiresAtMs <= parsed.requestedAtMs) {
      throw new RangeError("Manual override expiry must follow its request");
    }
    if (parsed.deadlineAtMs < parsed.requestedAtMs) {
      throw new RangeError("Manual override deadline must follow its request");
    }

    return this.#serialize(async () => {
      const committed = await commitConditionalStateChange(
        this.#database,
        {
          actor: "runtime.manual-overrides",
          mutationType: "override.start-requested",
          summary: `Requested manual override ${parsed.overrideId}`,
          eventType: "override.pending",
          entityType: "override",
          entityId: parsed.overrideId,
          occurredAtMs: parsed.requestedAtMs,
          retentionClass: "audit",
          payloadJson: JSON.stringify({
            schemaVersion: 1,
            action: "start",
            operationId: parsed.operationId,
            target: parsed.target,
          }),
          payloadSchemaVersion: 1,
          invalidations: [
            { resource: "override", id: parsed.overrideId },
            { resource: "operation", id: parsed.operationId },
          ],
        },
        async (transaction) => {
          await assertEnabledTarget(transaction, parsed.target);
          await assertNoLiveTargetOverride(
            transaction,
            parsed.target,
            parsed.replaceOverrideId,
          );
          const commands = await resolveStartCommands(
            transaction,
            parsed.target,
            parsed.valuePercentage,
          );
          const request = manualOverrideOperationRequestSchema.parse({
            kind: "manual_override_start",
            overrideId: parsed.overrideId,
            ...(parsed.replaceOverrideId === null
              ? {}
              : { replacesOverrideId: parsed.replaceOverrideId }),
            target: parsed.target,
            valuePercentage: parsed.valuePercentage,
            expiresAtMs: parsed.expiresAtMs,
            commands,
          });
          await insertPendingOperation(transaction, {
            id: parsed.operationId,
            requestedAtMs: parsed.requestedAtMs,
            deadlineAtMs: parsed.deadlineAtMs,
            request,
          });
          await transaction
            .insertInto("overrides")
            .values({
              id: parsed.overrideId,
              channel_id:
                parsed.target.targetType === "channel"
                  ? parsed.target.targetId
                  : null,
              output_id:
                parsed.target.targetType === "output"
                  ? parsed.target.targetId
                  : null,
              value_percentage: parsed.valuePercentage,
              status: "pending",
              requested_at_ms: parsed.requestedAtMs,
              starts_at_ms: null,
              expires_at_ms: parsed.expiresAtMs,
              completed_at_ms: null,
              operation_id: parsed.operationId,
            })
            .executeTakeFirstOrThrow();
          return { changed: true, result: { created: true } };
        },
        undefined,
        manualOverrideOperatorGuard(parsed.expectedRevision),
      );
      if (!committed.changed || committed.outboxEvent === null) {
        throw new Error("Manual override start unexpectedly made no change");
      }
      return {
        override: await this.#getOverride(parsed.overrideId),
        operation: await this.#getOperation(parsed.operationId),
        mutation: {
          changed: true,
          revision: committed.revision,
          event: toCommittedStateEvent(committed.outboxEvent),
        },
      };
    });
  }

  extend(input: {
    readonly overrideId: string;
    readonly expectedRevision: number;
    readonly atMs: number;
    readonly expiresAtMs: number;
  }): Promise<StoredManualOverrideStateMutation> {
    const overrideId = identifierSchema.parse(input.overrideId);
    const expectedRevision = nonnegativeSafeIntegerSchema.parse(
      input.expectedRevision,
    );
    const atMs = nonnegativeSafeIntegerSchema.parse(input.atMs);
    const expiresAtMs = nonnegativeSafeIntegerSchema.parse(input.expiresAtMs);
    if (expiresAtMs <= atMs) {
      throw new RangeError("Extended expiry must follow server time");
    }
    return this.#serialize(async () => {
      const committed = await commitConditionalStateChange(
        this.#database,
        {
          actor: "runtime.manual-overrides",
          mutationType: "override.extend",
          summary: `Extended manual override ${overrideId}`,
          eventType: "override.extended",
          entityType: "override",
          entityId: overrideId,
          occurredAtMs: atMs,
          retentionClass: "audit",
          payloadJson: JSON.stringify({
            schemaVersion: 1,
            action: "extend",
            expiresAtMs,
          }),
          payloadSchemaVersion: 1,
        },
        async (transaction) => {
          const row = await getOverrideRow(transaction, overrideId);
          const override = parseStoredOverride(row);
          if (override.status !== "active" || atMs >= override.expiresAtMs) {
            throw new ManualOverrideConflictError(
              "override",
              overrideId,
              "status",
              `Override ${overrideId} is not active and cannot be extended`,
            );
          }
          if (expiresAtMs <= override.expiresAtMs) {
            return { changed: false, result: { extended: false } };
          }
          await transaction
            .updateTable("overrides")
            .set({ expires_at_ms: expiresAtMs })
            .where("id", "=", overrideId)
            .where("status", "=", "active")
            .executeTakeFirstOrThrow();
          return { changed: true, result: { extended: true } };
        },
        undefined,
        manualOverrideOperatorGuard(expectedRevision),
      );
      const mutation: MutationResult = committed.changed
        ? {
            changed: true,
            revision: committed.revision,
            event: toCommittedStateEvent(committed.outboxEvent),
          }
        : { changed: false, revision: committed.revision, event: null };
      return {
        override: await this.#getOverride(overrideId),
        mutation: mutationResultSchema.parse(mutation),
      };
    });
  }

  createRelease(input: {
    readonly overrideId: string;
    readonly operationId: string;
    readonly action: "cancel" | "expire";
    readonly expectedRevision: number | null;
    readonly requestedAtMs: number;
    readonly deadlineAtMs: number;
    readonly utcMinuteOfDay: number;
  }): Promise<PreparedManualOverrideOperation | null> {
    const parsed = {
      overrideId: identifierSchema.parse(input.overrideId),
      operationId: identifierSchema.parse(input.operationId),
      action: input.action,
      expectedRevision:
        input.expectedRevision === null
          ? null
          : nonnegativeSafeIntegerSchema.parse(input.expectedRevision),
      requestedAtMs: nonnegativeSafeIntegerSchema.parse(input.requestedAtMs),
      deadlineAtMs: nonnegativeSafeIntegerSchema.parse(input.deadlineAtMs),
      utcMinuteOfDay: z
        .number()
        .int()
        .min(0)
        .max(1_439)
        .parse(input.utcMinuteOfDay),
    } as const;
    if (parsed.deadlineAtMs < parsed.requestedAtMs) {
      throw new RangeError("Manual override deadline must follow its request");
    }

    return this.#serialize(async () => {
      const eventType =
        parsed.action === "cancel"
          ? "override.cancellation-pending"
          : "override.expiry-pending";
      const committed = await commitConditionalStateChange(
        this.#database,
        {
          actor: "runtime.manual-overrides",
          mutationType: `override.${parsed.action}-requested`,
          summary: `Requested ${parsed.action} for manual override ${parsed.overrideId}`,
          eventType,
          entityType: "override",
          entityId: parsed.overrideId,
          occurredAtMs: parsed.requestedAtMs,
          retentionClass: "audit",
          payloadJson: JSON.stringify({
            schemaVersion: 1,
            action: parsed.action,
            operationId: parsed.operationId,
          }),
          payloadSchemaVersion: 1,
          invalidations: [
            { resource: "override", id: parsed.overrideId },
            { resource: "operation", id: parsed.operationId },
          ],
        },
        async (transaction) => {
          const row = await getOverrideRow(transaction, parsed.overrideId);
          const override = parseStoredOverride(row);
          if (parsed.action === "expire") {
            if (
              override.status !== "active" ||
              override.expiresAtMs > parsed.requestedAtMs
            ) {
              return { changed: false, result: { created: false } };
            }
          } else if (
            override.status !== "active" ||
            parsed.requestedAtMs >= override.expiresAtMs
          ) {
            throw new ManualOverrideConflictError(
              "override",
              parsed.overrideId,
              "status",
              `Override ${parsed.overrideId} is not active and cannot be cancelled`,
            );
          }
          if (override.operationId === null) {
            throw new InvalidManualOverrideTransitionError(
              `Active override ${parsed.overrideId} has no start operation`,
            );
          }
          const origin = await getOperationRow(
            transaction,
            override.operationId,
          );
          const startOperation = parseStoredManualOperation(origin);
          const acceptedStartOutcome =
            startOperation.status === "succeeded" ||
            startOperation.status === "outcome_unknown";
          if (
            startOperation.request.kind !== "manual_override_start" ||
            !acceptedStartOutcome
          ) {
            throw new InvalidManualOverrideTransitionError(
              `Active override ${parsed.overrideId} does not reference a completed start operation`,
            );
          }
          const commands = await resolveReleaseCommands(
            transaction,
            startOperation.request.commands,
            parsed.utcMinuteOfDay,
          );
          const request = manualOverrideOperationRequestSchema.parse({
            kind:
              parsed.action === "cancel"
                ? "manual_override_cancel"
                : "manual_override_expire",
            overrideId: parsed.overrideId,
            target: override.target,
            originStartOperationId: startOperation.id,
            commands,
          });
          await insertPendingOperation(transaction, {
            id: parsed.operationId,
            requestedAtMs: parsed.requestedAtMs,
            deadlineAtMs: parsed.deadlineAtMs,
            request,
          });
          const update = await transaction
            .updateTable("overrides")
            .set({ status: "pending", operation_id: parsed.operationId })
            .where("id", "=", parsed.overrideId)
            .where("status", "=", "active")
            .executeTakeFirst();
          if (update.numUpdatedRows !== 1n) {
            throw new InvalidManualOverrideTransitionError(
              `Override ${parsed.overrideId} changed while requesting ${parsed.action}`,
            );
          }
          return { changed: true, result: { created: true } };
        },
        undefined,
        parsed.expectedRevision === null
          ? undefined
          : manualOverrideOperatorGuard(parsed.expectedRevision),
      );
      if (!committed.changed) {
        return null;
      }
      if (committed.outboxEvent === null) {
        throw new Error("Changed manual override release lacks an event");
      }
      return {
        override: await this.#getOverride(parsed.overrideId),
        operation: await this.#getOperation(parsed.operationId),
        mutation: {
          changed: true,
          revision: committed.revision,
          event: toCommittedStateEvent(committed.outboxEvent),
        },
      };
    });
  }

  markInFlight(
    operationId: string,
    atMs: number,
  ): Promise<StoredManualOverrideOperation> {
    const parsedId = identifierSchema.parse(operationId);
    const parsedAtMs = nonnegativeSafeIntegerSchema.parse(atMs);
    return this.#serialize(async () => {
      const operation = await this.#getOperation(parsedId);
      if (operation.status !== "pending") {
        throw new InvalidManualOverrideTransitionError(
          `Manual override operation ${parsedId} cannot enter flight from ${operation.status}`,
        );
      }
      if (parsedAtMs < operation.requestedAtMs) {
        throw new RangeError("Attempt time must not precede request time");
      }
      await commitStateChange(
        this.#database,
        operationEvent(operation, "in_flight", parsedAtMs, "audit"),
        async (transaction) => {
          const update = await transaction
            .updateTable("control_operations")
            .set({ status: "in_flight" })
            .where("id", "=", parsedId)
            .where("status", "=", "pending")
            .executeTakeFirst();
          if (update.numUpdatedRows !== 1n) {
            throw new InvalidManualOverrideTransitionError(
              `Manual override operation ${parsedId} changed before dispatch`,
            );
          }
        },
      );
      return this.#getOperation(parsedId);
    });
  }

  completeSucceeded(
    operationId: string,
    completedAtMs: number,
    childOperationIds: readonly string[],
  ): Promise<void> {
    const result = manualOverrideOperationResultSchema.parse({
      status: "succeeded",
      childOperationIds,
    });
    return this.#completeTerminal(
      operationId,
      completedAtMs,
      result,
      "succeeded",
    );
  }

  completeFailed(input: {
    readonly operationId: string;
    readonly completedAtMs: number;
    readonly childOperationIds: readonly string[];
    readonly status: "failed" | "timed_out";
    readonly code: string;
    readonly message: string;
  }): Promise<void> {
    const result =
      input.status === "failed"
        ? manualOverrideOperationResultSchema.parse({
            status: "failed",
            childOperationIds: input.childOperationIds,
            code: input.code,
            message: input.message,
          })
        : manualOverrideOperationResultSchema.parse({
            status: "timed_out",
            childOperationIds: input.childOperationIds,
            reason: "deadline_before_attempt",
          });
    return this.#completeTerminal(
      input.operationId,
      input.completedAtMs,
      result,
      input.status,
    );
  }

  completeOutcomeUnknown(input: {
    readonly operationId: string;
    readonly completedAtMs: number;
    readonly childOperationIds: readonly string[];
    readonly reason: Extract<
      ManualOverrideOperationResult,
      { readonly status: "outcome_unknown" }
    >["reason"];
    readonly unknownChildOperationIds: readonly string[];
    readonly safetyReconcileAtMs: number;
  }): Promise<void> {
    const result = manualOverrideOperationResultSchema.parse({
      status: "outcome_unknown",
      childOperationIds: input.childOperationIds,
      reason: input.reason,
      unknownChildOperationIds: input.unknownChildOperationIds,
      safetyReconcileAtMs: input.safetyReconcileAtMs,
      reconciledAtMs: null,
    });
    return this.#completeTerminal(
      input.operationId,
      input.completedAtMs,
      result,
      "outcome_unknown",
    );
  }

  async #completeTerminal(
    operationId: string,
    completedAtMs: number,
    result: ManualOverrideOperationResult,
    status: "succeeded" | "failed" | "timed_out" | "outcome_unknown",
  ): Promise<void> {
    const parsedId = identifierSchema.parse(operationId);
    const parsedCompletedAtMs =
      nonnegativeSafeIntegerSchema.parse(completedAtMs);
    await this.#serialize(async () => {
      const operation = await this.#getOperation(parsedId);
      if (operation.status !== "in_flight") {
        throw new InvalidManualOverrideTransitionError(
          `Manual override operation ${parsedId} cannot complete from ${operation.status}`,
        );
      }
      if (parsedCompletedAtMs < operation.requestedAtMs) {
        throw new RangeError("Completion must not precede request time");
      }
      const override = await this.#getOverride(operation.request.overrideId);
      if (
        override.operationId !== operation.id ||
        override.status !== "pending"
      ) {
        throw new InvalidManualOverrideTransitionError(
          `Override ${override.id} no longer references operation ${operation.id}`,
        );
      }
      if (
        (status === "failed" || status === "timed_out") &&
        operation.request.kind !== "manual_override_start"
      ) {
        throw new InvalidManualOverrideTransitionError(
          "A release operation may not claim failure after an active override stopped refreshing",
        );
      }
      if (
        status === "succeeded" &&
        operation.request.kind === "manual_override_start" &&
        parsedCompletedAtMs >= override.expiresAtMs
      ) {
        throw new InvalidManualOverrideTransitionError(
          "A start operation completed after its logical expiry",
        );
      }
      const nextOverride = terminalOverrideState(
        override,
        operation.request,
        status,
        parsedCompletedAtMs,
      );
      await commitStateChange(
        this.#database,
        {
          actor: "runtime.manual-overrides",
          mutationType: `override.operation-${status}`,
          summary: `Completed ${operation.request.kind} operation ${operation.id} as ${status}`,
          eventType: `override.${nextOverride.status.replaceAll("_", "-")}`,
          entityType: "override",
          entityId: override.id,
          occurredAtMs: parsedCompletedAtMs,
          retentionClass: status === "outcome_unknown" ? "critical" : "audit",
          payloadJson: JSON.stringify({
            schemaVersion: 1,
            action: operation.request.kind,
            operationId: operation.id,
            operationStatus: status,
            overrideStatus: nextOverride.status,
            ...(operation.request.kind === "manual_override_start" &&
            operation.request.replacesOverrideId !== undefined
              ? { replacesOverrideId: operation.request.replacesOverrideId }
              : {}),
          }),
          payloadSchemaVersion: 1,
          invalidations: [
            { resource: "override", id: override.id },
            { resource: "operation", id: operation.id },
          ],
        },
        async (transaction) => {
          const operationUpdate = await transaction
            .updateTable("control_operations")
            .set({
              status,
              completed_at_ms: parsedCompletedAtMs,
              result_json: JSON.stringify(result),
              result_schema_version: MANUAL_OVERRIDE_OPERATION_SCHEMA_VERSION,
            })
            .where("id", "=", operation.id)
            .where("status", "=", "in_flight")
            .executeTakeFirst();
          if (operationUpdate.numUpdatedRows !== 1n) {
            throw new InvalidManualOverrideTransitionError(
              `Operation ${operation.id} changed during completion`,
            );
          }
          const overrideUpdate = await transaction
            .updateTable("overrides")
            .set({
              status: nextOverride.status,
              starts_at_ms: nextOverride.startsAtMs,
              completed_at_ms: nextOverride.completedAtMs,
            })
            .where("id", "=", override.id)
            .where("status", "=", "pending")
            .where("operation_id", "=", operation.id)
            .executeTakeFirst();
          if (overrideUpdate.numUpdatedRows !== 1n) {
            throw new InvalidManualOverrideTransitionError(
              `Override ${override.id} changed during completion`,
            );
          }
          if (
            operation.request.kind === "manual_override_start" &&
            operation.request.replacesOverrideId !== undefined &&
            (status === "succeeded" || status === "outcome_unknown")
          ) {
            await transaction
              .updateTable("overrides")
              .set({
                status: "cancelled",
                completed_at_ms: parsedCompletedAtMs,
              })
              .where("id", "=", operation.request.replacesOverrideId)
              .where("status", "=", "active")
              .executeTakeFirst();
          }
        },
      );
    });
  }

  async recoverInterrupted(nowMs: number): Promise<void> {
    const parsedNowMs = nonnegativeSafeIntegerSchema.parse(nowMs);
    const rows = await this.#database
      .selectFrom("control_operations")
      .selectAll()
      .where("kind", "in", [...MANUAL_OPERATION_KINDS])
      .where("status", "in", ["pending", "in_flight"])
      .orderBy("requested_at_ms", "asc")
      .orderBy("id", "asc")
      .execute();
    for (const row of rows) {
      const operation = parseStoredManualOperation(row);
      if (parsedNowMs < operation.requestedAtMs) {
        throw new RangeError(
          `Recovery time precedes operation ${operation.id}`,
        );
      }
      await this.#serialize(() =>
        this.#recoverOperation(operation, parsedNowMs),
      );
    }
  }

  async #recoverOperation(
    operation: StoredManualOverrideOperation,
    nowMs: number,
  ): Promise<void> {
    const override = await this.#getOverride(operation.request.overrideId);
    if (
      override.operationId !== operation.id ||
      override.status !== "pending"
    ) {
      throw new InvalidManualOverrideTransitionError(
        `Interrupted operation ${operation.id} is not owned by its pending override`,
      );
    }
    const pendingStart =
      operation.status === "pending" &&
      operation.request.kind === "manual_override_start";
    const interruptedStart =
      operation.status === "in_flight" &&
      operation.request.kind === "manual_override_start";
    const interruptedChildOperationIds =
      operation.status === "in_flight"
        ? await this.#findInterruptedUnknownChildren(operation, nowMs)
        : [];
    const status = pendingStart ? "cancelled" : "outcome_unknown";
    const result = pendingStart
      ? manualOverrideOperationResultSchema.parse({
          status: "cancelled",
          childOperationIds: [],
          reason: "controller_restart_before_attempt",
        })
      : manualOverrideOperationResultSchema.parse({
          status: "outcome_unknown",
          childOperationIds: interruptedChildOperationIds,
          reason:
            operation.status === "pending"
              ? "controller_restart_before_release"
              : "controller_restart",
          unknownChildOperationIds: interruptedChildOperationIds,
          safetyReconcileAtMs: safeAdd(nowMs, MANUAL_OVERRIDE_DURATION_MS),
          reconciledAtMs: null,
        });
    const recoveredOverrideStatus = pendingStart
      ? "failed"
      : interruptedStart
        ? nowMs >= override.expiresAtMs
          ? "expired"
          : "active"
        : null;
    await commitStateChange(
      this.#database,
      {
        actor: "runtime.manual-overrides",
        mutationType: "override.recover-interrupted",
        summary: `Recovered interrupted manual override operation ${operation.id}`,
        eventType: pendingStart
          ? "override.failed"
          : "override.outcome-unknown",
        entityType: "override",
        entityId: override.id,
        occurredAtMs: nowMs,
        retentionClass: pendingStart ? "audit" : "critical",
        payloadJson: JSON.stringify({
          schemaVersion: 1,
          operationId: operation.id,
          priorStatus: operation.status,
          recoveredStatus: status,
        }),
        payloadSchemaVersion: 1,
        invalidations: [
          { resource: "override", id: override.id },
          { resource: "operation", id: operation.id },
        ],
      },
      async (transaction) => {
        const operationUpdate = await transaction
          .updateTable("control_operations")
          .set({
            status,
            completed_at_ms: nowMs,
            result_json: JSON.stringify(result),
            result_schema_version: MANUAL_OVERRIDE_OPERATION_SCHEMA_VERSION,
          })
          .where("id", "=", operation.id)
          .where("status", "=", operation.status)
          .executeTakeFirst();
        if (operationUpdate.numUpdatedRows !== 1n) {
          throw new InvalidManualOverrideTransitionError(
            `Operation ${operation.id} changed during recovery`,
          );
        }
        if (recoveredOverrideStatus !== null) {
          const overrideUpdate = await transaction
            .updateTable("overrides")
            .set({
              status: recoveredOverrideStatus,
              ...(interruptedStart ? { starts_at_ms: nowMs } : {}),
              completed_at_ms:
                recoveredOverrideStatus === "active" ? null : nowMs,
            })
            .where("id", "=", override.id)
            .where("status", "=", "pending")
            .where("operation_id", "=", operation.id)
            .executeTakeFirst();
          if (overrideUpdate.numUpdatedRows !== 1n) {
            throw new InvalidManualOverrideTransitionError(
              `Override ${override.id} changed during recovery`,
            );
          }
          if (
            interruptedStart &&
            operation.request.kind === "manual_override_start" &&
            operation.request.replacesOverrideId !== undefined
          ) {
            await transaction
              .updateTable("overrides")
              .set({ status: "cancelled", completed_at_ms: nowMs })
              .where("id", "=", operation.request.replacesOverrideId)
              .where("status", "=", "active")
              .executeTakeFirst();
          }
        }
      },
    );
  }

  async #findInterruptedUnknownChildren(
    operation: StoredManualOverrideOperation,
    recoveredAtMs: number,
  ): Promise<readonly string[]> {
    const rows = await this.#database
      .selectFrom("control_operations")
      .selectAll()
      .where("kind", "=", "set_pwm")
      .where("status", "in", ["in_flight", "outcome_unknown"])
      .where("requested_at_ms", ">=", operation.requestedAtMs)
      .where("requested_at_ms", "<=", recoveredAtMs)
      .orderBy("requested_at_ms", "asc")
      .orderBy("id", "asc")
      .execute();
    const matches = rows.filter((row) => {
      if (row.device_id === null) {
        return false;
      }
      const request = parseDeviceOperationRequest(row);
      if (request.kind !== "set_pwm") {
        return false;
      }
      if (row.status === "outcome_unknown") {
        const result = parseDeviceOperationResult(row);
        if (
          result?.status !== "outcome_unknown" ||
          result.reconciledAtMs !== null
        ) {
          return false;
        }
      }
      return operation.request.commands.some(
        (command) =>
          command.deviceId === row.device_id &&
          command.pin === request.pin &&
          command.value === request.value &&
          command.overwrite === request.overwrite,
      );
    });
    return matches.map((row) => row.id);
  }

  async listDueActiveOverrideIds(nowMs: number): Promise<readonly string[]> {
    const parsedNowMs = nonnegativeSafeIntegerSchema.parse(nowMs);
    const rows = await this.#database
      .selectFrom("overrides")
      .select("id")
      .where("status", "=", "active")
      .where("expires_at_ms", "<=", parsedNowMs)
      .orderBy("expires_at_ms", "asc")
      .orderBy("id", "asc")
      .execute();
    return rows.map((row) => row.id);
  }

  async listDueUnknownOperationIds(nowMs: number): Promise<readonly string[]> {
    const parsedNowMs = nonnegativeSafeIntegerSchema.parse(nowMs);
    const rows = await this.#database
      .selectFrom("control_operations")
      .selectAll()
      .where("kind", "in", [...MANUAL_OPERATION_KINDS])
      .where("status", "=", "outcome_unknown")
      .orderBy("completed_at_ms", "asc")
      .orderBy("id", "asc")
      .execute();
    return rows.flatMap((row) => {
      const operation = parseStoredManualOperation(row);
      if (operation.result?.status !== "outcome_unknown") {
        throw new Error(
          `Unknown manual override operation ${operation.id} lacks its typed result`,
        );
      }
      return operation.result.reconciledAtMs === null &&
        operation.result.safetyReconcileAtMs <= parsedNowMs
        ? [operation.id]
        : [];
    });
  }

  getManualOperation(
    operationId: string,
  ): Promise<StoredManualOverrideOperation> {
    return this.#getOperation(identifierSchema.parse(operationId));
  }

  finalizeReconciledOutcome(input: {
    readonly operationId: string;
    readonly expectedRevision: number | null;
    readonly reconciledAtMs: number;
  }): Promise<StoredManualOverrideStateMutation> {
    const operationId = identifierSchema.parse(input.operationId);
    const expectedRevision =
      input.expectedRevision === null
        ? null
        : nonnegativeSafeIntegerSchema.parse(input.expectedRevision);
    const reconciledAtMs = nonnegativeSafeIntegerSchema.parse(
      input.reconciledAtMs,
    );
    return this.#serialize(async () => {
      const operation = await this.#getOperation(operationId);
      if (
        operation.status !== "outcome_unknown" ||
        operation.result?.status !== "outcome_unknown" ||
        operation.result.reconciledAtMs !== null
      ) {
        throw new InvalidManualOverrideTransitionError(
          `Operation ${operationId} does not have an unresolved unknown outcome`,
        );
      }
      if (reconciledAtMs < operation.result.safetyReconcileAtMs) {
        throw new ManualOverrideConflictError(
          "override",
          operation.request.overrideId,
          "firmware_safety_window",
          `Override ${operation.request.overrideId} cannot be reconciled before the firmware safety window ends`,
        );
      }
      const override = await this.#getOverride(operation.request.overrideId);
      const nextStatus =
        operation.request.kind === "manual_override_start"
          ? await this.#assertStartReconciliationLineage(override, operation)
          : operation.request.kind === "manual_override_cancel"
            ? "cancelled"
            : "expired";
      if (
        operation.request.kind !== "manual_override_start" &&
        (override.status !== "pending" || override.operationId !== operationId)
      ) {
        throw new InvalidManualOverrideTransitionError(
          `Override ${override.id} is not waiting for operation ${operationId}`,
        );
      }
      const result = manualOverrideOperationResultSchema.parse({
        ...operation.result,
        reconciledAtMs,
      });
      const committed = await commitConditionalStateChange(
        this.#database,
        {
          actor: "runtime.manual-overrides",
          mutationType: "override.reconcile-outcome",
          summary: `Reconciled unknown manual override operation ${operationId}`,
          eventType: "override.outcome-reconciled",
          entityType: "override",
          entityId: override.id,
          occurredAtMs: reconciledAtMs,
          retentionClass: "critical",
          payloadJson: JSON.stringify({
            schemaVersion: 1,
            operationId,
            status: nextStatus,
          }),
          payloadSchemaVersion: 1,
          invalidations: [
            { resource: "override", id: override.id },
            { resource: "operation", id: operationId },
          ],
        },
        async (transaction) => {
          const operationUpdate = await transaction
            .updateTable("control_operations")
            .set({
              result_json: JSON.stringify(result),
              result_schema_version: MANUAL_OVERRIDE_OPERATION_SCHEMA_VERSION,
            })
            .where("id", "=", operationId)
            .where("status", "=", "outcome_unknown")
            .executeTakeFirst();
          if (operationUpdate.numUpdatedRows !== 1n) {
            throw new InvalidManualOverrideTransitionError(
              `Operation ${operationId} changed during reconciliation`,
            );
          }
          if (operation.request.kind !== "manual_override_start") {
            const overrideUpdate = await transaction
              .updateTable("overrides")
              .set({ status: nextStatus, completed_at_ms: reconciledAtMs })
              .where("id", "=", override.id)
              .where("status", "=", "pending")
              .where("operation_id", "=", operationId)
              .executeTakeFirst();
            if (overrideUpdate.numUpdatedRows !== 1n) {
              throw new InvalidManualOverrideTransitionError(
                `Override ${override.id} changed during reconciliation`,
              );
            }
          }
          return { changed: true, result: { reconciled: true } };
        },
        undefined,
        expectedRevision === null
          ? undefined
          : manualOverrideOperatorGuard(expectedRevision),
      );
      if (!committed.changed || committed.outboxEvent === null) {
        throw new Error("Manual override reconciliation made no change");
      }
      return {
        override: await this.#getOverride(override.id),
        mutation: {
          changed: true,
          revision: committed.revision,
          event: toCommittedStateEvent(committed.outboxEvent),
        },
      };
    });
  }

  async #assertStartReconciliationLineage(
    override: StoredManualOverride,
    startOperation: StoredManualOverrideOperation,
  ): Promise<StoredManualOverride["status"]> {
    if (override.operationId === startOperation.id) {
      if (!["active", "expired"].includes(override.status)) {
        throw new InvalidManualOverrideTransitionError(
          `Override ${override.id} has invalid state ${override.status} for start operation ${startOperation.id}`,
        );
      }
      return override.status;
    }
    if (override.operationId === null) {
      throw new InvalidManualOverrideTransitionError(
        `Override ${override.id} lost the lineage of start operation ${startOperation.id}`,
      );
    }
    const releaseOperation = await this.#getOperation(override.operationId);
    if (
      releaseOperation.request.kind === "manual_override_start" ||
      releaseOperation.request.overrideId !== override.id ||
      releaseOperation.request.originStartOperationId !== startOperation.id
    ) {
      throw new InvalidManualOverrideTransitionError(
        `Override ${override.id} does not descend from start operation ${startOperation.id}`,
      );
    }
    const expectedOverrideStatus =
      releaseOperation.status === "pending" ||
      releaseOperation.status === "in_flight"
        ? "pending"
        : releaseOperation.status === "succeeded" ||
            (releaseOperation.status === "outcome_unknown" &&
              releaseOperation.result?.status === "outcome_unknown" &&
              releaseOperation.result.reconciledAtMs !== null)
          ? releaseOperation.request.kind === "manual_override_cancel"
            ? "cancelled"
            : "expired"
          : releaseOperation.status === "outcome_unknown"
            ? "pending"
            : null;
    if (
      expectedOverrideStatus === null ||
      override.status !== expectedOverrideStatus
    ) {
      throw new InvalidManualOverrideTransitionError(
        `Override ${override.id} state does not match release operation ${releaseOperation.id}`,
      );
    }
    return override.status;
  }

  async nextDeadlineMs(): Promise<number | null> {
    const active = await this.#database
      .selectFrom("overrides")
      .select("expires_at_ms")
      .where("status", "=", "active")
      .orderBy("expires_at_ms", "asc")
      .limit(1)
      .executeTakeFirst();
    const unknownRows = await this.#database
      .selectFrom("control_operations")
      .selectAll()
      .where("kind", "in", [...MANUAL_OPERATION_KINDS])
      .where("status", "=", "outcome_unknown")
      .execute();
    const unknownDeadlines = unknownRows.flatMap((row) => {
      const operation = parseStoredManualOperation(row);
      return operation.result?.status === "outcome_unknown" &&
        operation.result.reconciledAtMs === null
        ? [operation.result.safetyReconcileAtMs]
        : [];
    });
    const deadlines = [
      ...(active === undefined ? [] : [active.expires_at_ms]),
      ...unknownDeadlines,
    ];
    return deadlines.length === 0 ? null : Math.min(...deadlines);
  }

  async readActiveManualOverrideOutputs(
    atMs: number,
  ): Promise<readonly ManualOverrideOverlayOutput[]> {
    const parsedAtMs = nonnegativeSafeIntegerSchema.parse(atMs);
    const [rows, eligibleDevices] = await Promise.all([
      this.#database
        .selectFrom("overrides")
        .selectAll()
        .where("status", "=", "active")
        .where("expires_at_ms", ">", parsedAtMs)
        .orderBy("id", "asc")
        .execute(),
      this.#database
        .selectFrom("devices")
        .select("id")
        .where("enabled", "=", 1)
        .where("status", "in", ["online", "stale", "offline"])
        .execute(),
    ]);
    const eligibleDeviceIds = new Set(eligibleDevices.map(({ id }) => id));
    const outputs: ManualOverrideOverlayOutput[] = [];
    const mappingKeys = new Set<string>();
    const pinKeys = new Set<string>();
    for (const row of rows) {
      const override = parseStoredOverride(row);
      if (
        override.startsAtMs === null ||
        override.startsAtMs > parsedAtMs ||
        override.operationId === null
      ) {
        continue;
      }
      const operation = await this.#getOperation(override.operationId);
      const acceptedStartOutcome =
        (operation.status === "succeeded" &&
          operation.result?.status === "succeeded") ||
        (operation.status === "outcome_unknown" &&
          operation.result?.status === "outcome_unknown");
      if (
        operation.request.kind !== "manual_override_start" ||
        !acceptedStartOutcome
      ) {
        throw new InvalidManualOverrideTransitionError(
          `Active override ${override.id} lacks a completed start operation`,
        );
      }
      for (const command of operation.request.commands) {
        if (!command.overwrite) {
          throw new InvalidManualOverrideTransitionError(
            `Active override ${override.id} contains a non-overwrite start command`,
          );
        }
        if (!eligibleDeviceIds.has(command.deviceId)) {
          continue;
        }
        const mappingKey = `${command.deviceId}\0${command.mappingId}`;
        const pinKey = `${command.deviceId}\0${command.pin}`;
        if (mappingKeys.has(mappingKey) || pinKeys.has(pinKey)) {
          throw new InvalidManualOverrideTransitionError(
            `Active manual overrides overlap at ${command.deviceId} pin ${command.pin}`,
          );
        }
        mappingKeys.add(mappingKey);
        pinKeys.add(pinKey);
        outputs.push({
          overrideId: override.id,
          deviceId: command.deviceId,
          mappingId: command.mappingId,
          pin: command.pin,
          value: command.value,
          overwrite: true,
          expiresAtMs: override.expiresAtMs,
        });
      }
    }
    return outputs.sort(
      (left, right) =>
        left.deviceId.localeCompare(right.deviceId) ||
        left.mappingId.localeCompare(right.mappingId) ||
        left.pin - right.pin ||
        left.overrideId.localeCompare(right.overrideId),
    );
  }

  getOverride(overrideId: string): Promise<StoredManualOverride> {
    return this.#getOverride(identifierSchema.parse(overrideId));
  }

  async #getOverride(id: string): Promise<StoredManualOverride> {
    const row = await this.#database
      .selectFrom("overrides")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst();
    if (row === undefined) {
      throw new ManualOverrideNotFoundError("override", id);
    }
    return parseStoredOverride(row);
  }

  async #getOperation(id: string): Promise<StoredManualOverrideOperation> {
    const row = await this.#database
      .selectFrom("control_operations")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirst();
    if (row === undefined) {
      throw new ManualOverrideNotFoundError("operation", id);
    }
    return parseStoredManualOperation(row);
  }

  #serialize<Result>(operation: () => Promise<Result>): Promise<Result> {
    const result = this.#operationTail.then(operation, operation);
    this.#operationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

async function assertEnabledTarget(
  transaction: StateDatabaseTransaction,
  target: ManualOverrideTarget,
): Promise<void> {
  const row =
    target.targetType === "channel"
      ? await transaction
          .selectFrom("channels")
          .select(["id", "enabled"])
          .where("id", "=", target.targetId)
          .executeTakeFirst()
      : await transaction
          .selectFrom("outputs")
          .select(["id", "enabled"])
          .where("id", "=", target.targetId)
          .executeTakeFirst();
  if (row === undefined) {
    throw new ManualOverrideNotFoundError(target.targetType, target.targetId);
  }
  if (row.enabled !== 1) {
    throw new ManualOverrideConflictError(
      target.targetType,
      target.targetId,
      "enabled",
      `${target.targetType} ${target.targetId} is disabled`,
    );
  }
}

async function assertNoLiveTargetOverride(
  transaction: StateDatabaseTransaction,
  target: ManualOverrideTarget,
  replaceOverrideId: string | null,
): Promise<void> {
  const query = transaction
    .selectFrom("overrides")
    .select(["id", "status"])
    .where("status", "in", ["pending", "active"]);
  const existing =
    target.targetType === "channel"
      ? await query.where("channel_id", "=", target.targetId).execute()
      : await query.where("output_id", "=", target.targetId).execute();
  if (replaceOverrideId !== null) {
    const replaceable = existing.some(
      ({ id, status }) => id === replaceOverrideId && status === "active",
    );
    const conflicting = existing.some(({ id }) => id !== replaceOverrideId);
    if (replaceable && !conflicting) return;
    throw new ManualOverrideConflictError(
      target.targetType,
      target.targetId,
      "live_override",
      `Override ${replaceOverrideId} is not the sole live override for ${target.targetType} ${target.targetId}`,
    );
  }
  if (existing.length > 0) {
    throw new ManualOverrideConflictError(
      target.targetType,
      target.targetId,
      "live_override",
      `${target.targetType} ${target.targetId} already has live override ${existing[0]?.id}`,
    );
  }
}

async function resolveStartCommands(
  transaction: StateDatabaseTransaction,
  target: ManualOverrideTarget,
  valuePercentage: number,
): Promise<readonly ManualOverridePinCommand[]> {
  const baseQuery = transaction
    .selectFrom("devices as device")
    .innerJoin(
      "mapping_profiles as profile",
      "profile.id",
      "device.mapping_profile_id",
    )
    .innerJoin(
      "pin_mappings as mapping",
      "mapping.mapping_profile_id",
      "profile.id",
    )
    .leftJoin("outputs as output", "output.id", "mapping.output_id")
    .select([
      "device.id as deviceId",
      "mapping.id as mappingId",
      "mapping.pin as pin",
      "profile.output_gain as profileGain",
      "output.output_gain as outputGain",
      "device.firmware_version as firmwareVersion",
    ])
    .where("device.enabled", "=", 1)
    .where("device.status", "in", ["online", "stale", "offline"])
    .where("mapping.enabled", "=", 1)
    .orderBy(
      sql<number>`CASE ${sql.ref("device.status")}
        WHEN 'online' THEN 0
        WHEN 'stale' THEN 1
        ELSE 2
      END`,
      "asc",
    )
    .orderBy("device.id", "asc")
    .orderBy("mapping.display_order", "asc")
    .orderBy("mapping.pin", "asc");
  const rows =
    target.targetType === "channel"
      ? await baseQuery
          .where("mapping.channel_id", "=", target.targetId)
          .execute()
      : await baseQuery
          .where("mapping.output_id", "=", target.targetId)
          .execute();
  const eligibleRows = rows
    .map((row) => startMappingRowSchema.parse(row))
    .filter(
      (row) =>
        row.firmwareVersion !== null &&
        isSupportedEspFirmwareVersion(row.firmwareVersion),
    );
  if (eligibleRows.length === 0) {
    throw new ManualOverrideConflictError(
      target.targetType,
      target.targetId,
      "enabled_pin_mapping",
      `This ${target.targetType} has no enabled online device pin mappings`,
    );
  }
  return eligibleRows.map((row) => {
    const outputGain =
      target.targetType === "output"
        ? (row.outputGain ?? failMissingOutputGain(row.mappingId))
        : 1;
    return {
      deviceId: row.deviceId,
      mappingId: row.mappingId,
      pin: row.pin,
      value: toHostPwm(valuePercentage, 100, row.profileGain * outputGain),
      overwrite: true,
    };
  });
}

async function resolveReleaseCommands(
  transaction: StateDatabaseTransaction,
  startCommands: readonly ManualOverridePinCommand[],
  utcMinuteOfDay: number,
): Promise<readonly ManualOverridePinCommand[]> {
  const commands: ManualOverridePinCommand[] = [];
  for (const startCommand of startCommands) {
    const rawMapping = await transaction
      .selectFrom("pin_mappings as mapping")
      .innerJoin(
        "mapping_profiles as profile",
        "profile.id",
        "mapping.mapping_profile_id",
      )
      .innerJoin("devices as device", "device.mapping_profile_id", "profile.id")
      .leftJoin("channels as channel", "channel.id", "mapping.channel_id")
      .leftJoin("throttles as throttle", "throttle.id", "channel.throttle_id")
      .leftJoin("schedules as schedule", (join) =>
        join
          .onRef("schedule.channel_id", "=", "channel.id")
          .on("schedule.enabled", "=", 1),
      )
      .select([
        "device.id as deviceId",
        "mapping.id as mappingId",
        "mapping.pin as pin",
        "mapping.channel_id as channelId",
        "channel.enabled as channelEnabled",
        "throttle.percentage as throttlePercent",
        "profile.output_gain as profileGain",
        "schedule.id as scheduleId",
        "device.firmware_version as firmwareVersion",
      ])
      .where("mapping.id", "=", startCommand.mappingId)
      .where("device.id", "=", startCommand.deviceId)
      .where("device.enabled", "=", 1)
      .where("mapping.enabled", "=", 1)
      .executeTakeFirst();
    let value = 0;
    if (rawMapping !== undefined) {
      const mapping = releaseMappingRowSchema.parse(rawMapping);
      if (
        mapping.firmwareVersion === null ||
        !isSupportedEspFirmwareVersion(mapping.firmwareVersion)
      ) {
        continue;
      }
      const stillSamePin = mapping.pin === startCommand.pin;
      const hasScheduledChannel =
        stillSamePin &&
        mapping.channelId !== null &&
        mapping.channelEnabled === 1 &&
        mapping.throttlePercent !== null &&
        mapping.scheduleId !== null;
      if (hasScheduledChannel && mapping.scheduleId !== null) {
        const rawPoints = await transaction
          .selectFrom("schedule_points")
          .select(["minute_of_day as minute", "percentage as percent"])
          .where("schedule_id", "=", mapping.scheduleId)
          .orderBy("position", "asc")
          .execute();
        const points: SchedulePoint[] = rawPoints.map((point) =>
          releasePointRowSchema.parse(point),
        );
        const validation = validateScheduleGraph(
          scheduleGraphFromPoints(points),
        );
        if (!validation.ok) {
          throw new TypeError(
            `Cannot release mapping ${mapping.mappingId} to an invalid schedule`,
          );
        }
        value = toHostPwm(
          evaluateSchedulePercent(validation.graph, utcMinuteOfDay),
          mapping.throttlePercent ?? 100,
          mapping.profileGain,
        );
      }
    }
    commands.push({
      deviceId: startCommand.deviceId,
      mappingId: startCommand.mappingId,
      pin: startCommand.pin,
      value,
      overwrite: true,
    });
  }
  return commands;
}

function failMissingOutputGain(mappingId: string): never {
  throw new TypeError(`Output mapping ${mappingId} has no output gain`);
}

async function insertPendingOperation(
  transaction: StateDatabaseTransaction,
  input: {
    readonly id: string;
    readonly requestedAtMs: number;
    readonly deadlineAtMs: number;
    readonly request: ManualOverrideOperationRequest;
  },
): Promise<void> {
  await transaction
    .insertInto("control_operations")
    .values({
      id: input.id,
      device_id: null,
      kind: input.request.kind,
      status: "pending",
      requested_at_ms: input.requestedAtMs,
      deadline_at_ms: input.deadlineAtMs,
      completed_at_ms: null,
      request_json: JSON.stringify(input.request),
      request_schema_version: MANUAL_OVERRIDE_OPERATION_SCHEMA_VERSION,
      result_json: null,
      result_schema_version: null,
    })
    .executeTakeFirstOrThrow();
}

function terminalOverrideState(
  override: StoredManualOverride,
  request: ManualOverrideOperationRequest,
  operationStatus: "succeeded" | "failed" | "timed_out" | "outcome_unknown",
  completedAtMs: number,
): Pick<StoredManualOverride, "status" | "startsAtMs" | "completedAtMs"> {
  if (operationStatus === "outcome_unknown") {
    if (request.kind === "manual_override_start") {
      if (completedAtMs >= override.expiresAtMs) {
        return {
          status: "expired",
          startsAtMs: completedAtMs,
          completedAtMs,
        };
      }
      return {
        status: "active",
        startsAtMs: completedAtMs,
        completedAtMs: null,
      };
    }
    return {
      status: "pending",
      startsAtMs: override.startsAtMs,
      completedAtMs: null,
    };
  }
  if (operationStatus === "failed" || operationStatus === "timed_out") {
    return {
      status: "failed",
      startsAtMs: null,
      completedAtMs,
    };
  }
  switch (request.kind) {
    case "manual_override_start":
      return {
        status: "active",
        startsAtMs: completedAtMs,
        completedAtMs: null,
      };
    case "manual_override_cancel":
      return {
        status: "cancelled",
        startsAtMs: override.startsAtMs,
        completedAtMs,
      };
    case "manual_override_expire":
      return {
        status: "expired",
        startsAtMs: override.startsAtMs,
        completedAtMs,
      };
  }
}

function operationEvent(
  operation: StoredManualOverrideOperation,
  status: "in_flight",
  occurredAtMs: number,
  retentionClass: "audit",
) {
  return {
    actor: "runtime.manual-overrides",
    mutationType: `operation.${status}`,
    summary: `Transitioned manual override operation ${operation.id} to ${status}`,
    eventType: `operation.${status.replaceAll("_", "-")}`,
    entityType: "operation" as const,
    entityId: operation.id,
    occurredAtMs,
    retentionClass,
    payloadJson: JSON.stringify({
      schemaVersion: 1,
      status,
      kind: operation.request.kind,
      overrideId: operation.request.overrideId,
    }),
    payloadSchemaVersion: 1,
    invalidations: [
      { resource: "operation" as const, id: operation.id },
      { resource: "override" as const, id: operation.request.overrideId },
    ],
  };
}

function parseStoredOverride(
  row: Selectable<OverridesTable>,
): StoredManualOverride {
  if ((row.channel_id === null) === (row.output_id === null)) {
    throw new Error(`Override ${row.id} has an invalid target`);
  }
  return {
    id: identifierSchema.parse(row.id),
    target: manualOverrideTargetSchema.parse(
      row.channel_id === null
        ? { targetType: "output", targetId: row.output_id }
        : { targetType: "channel", targetId: row.channel_id },
    ),
    valuePercentage: percentageSchema.parse(row.value_percentage),
    status: row.status,
    requestedAtMs: nonnegativeSafeIntegerSchema.parse(row.requested_at_ms),
    startsAtMs:
      row.starts_at_ms === null
        ? null
        : nonnegativeSafeIntegerSchema.parse(row.starts_at_ms),
    expiresAtMs: nonnegativeSafeIntegerSchema.parse(row.expires_at_ms),
    completedAtMs:
      row.completed_at_ms === null
        ? null
        : nonnegativeSafeIntegerSchema.parse(row.completed_at_ms),
    operationId:
      row.operation_id === null
        ? null
        : identifierSchema.parse(row.operation_id),
  };
}

function parseStoredManualOperation(
  row: Selectable<ControlOperationsTable>,
): StoredManualOverrideOperation {
  if (row.device_id !== null) {
    throw new Error(`Manual override operation ${row.id} must be aggregate`);
  }
  if (row.request_schema_version !== MANUAL_OVERRIDE_OPERATION_SCHEMA_VERSION) {
    throw new Error(
      `Unsupported request schema version for manual override operation ${row.id}`,
    );
  }
  const requestDocument = parseJsonDocument(
    row.request_json,
    `manual override operation ${row.id} request`,
  );
  if (requestDocument.duplicateKeys.length > 0) {
    throw new Error(
      `Manual override operation ${row.id} request contains duplicate keys`,
    );
  }
  const request = manualOverrideOperationRequestSchema.parse(
    requestDocument.value,
  );
  if (request.kind !== row.kind) {
    throw new Error(
      `Manual override operation ${row.id} kind does not match its request`,
    );
  }
  let result: ManualOverrideOperationResult | null = null;
  if (row.result_json !== null || row.result_schema_version !== null) {
    if (
      row.result_json === null ||
      row.result_schema_version !== MANUAL_OVERRIDE_OPERATION_SCHEMA_VERSION
    ) {
      throw new Error(
        `Manual override operation ${row.id} has an invalid result envelope`,
      );
    }
    const resultDocument = parseJsonDocument(
      row.result_json,
      `manual override operation ${row.id} result`,
    );
    if (resultDocument.duplicateKeys.length > 0) {
      throw new Error(
        `Manual override operation ${row.id} result contains duplicate keys`,
      );
    }
    result = manualOverrideOperationResultSchema.parse(resultDocument.value);
  }
  const terminal = !["pending", "in_flight"].includes(row.status);
  if (terminal !== (row.completed_at_ms !== null && result !== null)) {
    throw new Error(
      `Manual override operation ${row.id} completion does not match ${row.status}`,
    );
  }
  if (result !== null && result.status !== row.status) {
    throw new Error(
      `Manual override operation ${row.id} result does not match ${row.status}`,
    );
  }
  return {
    id: identifierSchema.parse(row.id),
    status: row.status,
    requestedAtMs: nonnegativeSafeIntegerSchema.parse(row.requested_at_ms),
    deadlineAtMs: nonnegativeSafeIntegerSchema.parse(row.deadline_at_ms),
    completedAtMs:
      row.completed_at_ms === null
        ? null
        : nonnegativeSafeIntegerSchema.parse(row.completed_at_ms),
    request,
    result,
  };
}

function parseDeviceOperationRequest(row: Selectable<ControlOperationsTable>) {
  if (row.request_schema_version !== DEVICE_OPERATION_REQUEST_SCHEMA_VERSION) {
    throw new Error(
      `Unsupported request schema version for device operation ${row.id}`,
    );
  }
  const document = parseJsonDocument(
    row.request_json,
    `device operation ${row.id} request`,
  );
  if (document.duplicateKeys.length > 0) {
    throw new Error(
      `Device operation ${row.id} request contains duplicate keys`,
    );
  }
  return deviceOperationRequestSchema.parse(document.value);
}

function parseDeviceOperationResult(row: Selectable<ControlOperationsTable>) {
  if (row.result_json === null || row.result_schema_version === null) {
    return null;
  }
  if (row.result_schema_version !== DEVICE_OPERATION_RESULT_SCHEMA_VERSION) {
    throw new Error(
      `Unsupported result schema version for device operation ${row.id}`,
    );
  }
  const document = parseJsonDocument(
    row.result_json,
    `device operation ${row.id} result`,
  );
  if (document.duplicateKeys.length > 0) {
    throw new Error(
      `Device operation ${row.id} result contains duplicate keys`,
    );
  }
  return deviceOperationResultSchema.parse(document.value);
}

async function getOverrideRow(
  transaction: StateDatabaseTransaction,
  id: string,
): Promise<Selectable<OverridesTable>> {
  const row = await transaction
    .selectFrom("overrides")
    .selectAll()
    .where("id", "=", id)
    .executeTakeFirst();
  if (row === undefined) {
    throw new ManualOverrideNotFoundError("override", id);
  }
  return row;
}

async function getOperationRow(
  transaction: StateDatabaseTransaction,
  id: string,
): Promise<Selectable<ControlOperationsTable>> {
  const row = await transaction
    .selectFrom("control_operations")
    .selectAll()
    .where("id", "=", id)
    .executeTakeFirst();
  if (row === undefined) {
    throw new ManualOverrideNotFoundError("operation", id);
  }
  return row;
}

function manualOverrideOperatorGuard(expectedRevision: number) {
  return {
    expectedRevision,
    conflictError: (expected: number, current: number) =>
      new ManualOverrideRevisionConflictError(expected, current),
  };
}

function safeAdd(left: number, right: number): number {
  const result = left + right;
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new RangeError("Manual override timestamp exceeds safe range");
  }
  return result;
}
