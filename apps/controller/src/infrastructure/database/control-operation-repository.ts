import {
  identifierSchema,
  nonnegativeSafeIntegerSchema,
  type MutationResult,
} from "@aquarium/contracts";
import { ESP32_PWM_OVERWRITE_DURATION_MS } from "@aquarium/esp-protocol";
import { sql, type Kysely, type Selectable } from "kysely";

import {
  DEVICE_OPERATION_REQUEST_SCHEMA_VERSION,
  DEVICE_OPERATION_RESULT_SCHEMA_VERSION,
  assertDeviceOperationResultMatchesRequest,
  deviceOperationRequestSchema,
  deviceOperationResultSchema,
  type DeviceOperationRequest,
  type DeviceOperationResult,
} from "../../application/operations/device-operation-types.js";
import {
  MANUAL_OVERRIDE_OPERATION_SCHEMA_VERSION,
  manualOverrideOperationRequestSchema,
  manualOverrideOperationResultSchema,
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
  DevicesTable,
  OperationStatus,
  StateDatabaseSchema,
} from "./types.js";

export interface CreatePendingDeviceOperationInput {
  readonly id: string;
  readonly deviceId: string;
  readonly requestedAtMs: number;
  readonly deadlineAtMs: number;
  readonly request: DeviceOperationRequest;
}

export interface DeviceOperationLifecycleOptions {
  /**
   * Internal operations are persisted for crash recovery while pending or in
   * flight, but do not advance public state unless they end unsuccessfully.
   */
  readonly visibility?: "public" | "internal";
}

export interface CreatePendingUserConfigurationOperationInput extends CreatePendingDeviceOperationInput {
  readonly expectedRevision: number;
  readonly request: Extract<
    DeviceOperationRequest,
    { kind: "edit_configuration" }
  >;
}

export type CreatedUserConfigurationOperation =
  | {
      readonly changed: false;
      readonly operation: null;
      readonly mutation: Extract<MutationResult, { changed: false }>;
    }
  | {
      readonly changed: true;
      readonly operation: StoredDeviceOperation;
      readonly mutation: Extract<MutationResult, { changed: true }>;
    };

export interface StoredDeviceOperation {
  readonly id: string;
  readonly deviceId: string;
  readonly kind: DeviceOperationRequest["kind"];
  readonly status: OperationStatus;
  readonly requestedAtMs: number;
  readonly deadlineAtMs: number;
  readonly completedAtMs: number | null;
  readonly request: DeviceOperationRequest;
  readonly result: DeviceOperationResult | null;
}

export interface InterruptedOperationRecovery {
  readonly recoveredOperationIds: readonly string[];
}

export class InvalidDeviceOperationTransitionError extends Error {
  override readonly name = "InvalidDeviceOperationTransitionError";
}

export class DeviceOperationRevisionConflictError extends Error {
  override readonly name = "DeviceOperationRevisionConflictError";

  constructor(
    readonly expectedRevision: number,
    readonly currentRevision: number,
  ) {
    super(
      `Expected state revision ${expectedRevision}, but current revision is ${currentRevision}`,
    );
  }
}

export class DeviceOperationDeviceNotFoundError extends Error {
  override readonly name = "DeviceOperationDeviceNotFoundError";

  constructor(readonly deviceId: string) {
    super(`Device ${deviceId} does not exist`);
  }
}

export class DeviceOperationNotFoundError extends Error {
  override readonly name = "DeviceOperationNotFoundError";

  constructor(readonly operationId: string) {
    super(`Operation ${operationId} does not exist`);
  }
}

export type DeviceOperationReconciliationConflictRelation =
  | "firmware_safety_window"
  | "manual_override_owns_operation"
  | "not_device_operation"
  | "outcome_not_unknown";

export class DeviceOperationReconciliationConflictError extends Error {
  override readonly name = "DeviceOperationReconciliationConflictError";

  constructor(
    readonly operationId: string,
    readonly relation: DeviceOperationReconciliationConflictRelation,
    message: string,
  ) {
    super(message);
  }
}

export class ControlOperationRepository {
  readonly #database: Kysely<StateDatabaseSchema>;
  #operationTail: Promise<void> = Promise.resolve();

  constructor(database: Kysely<StateDatabaseSchema>) {
    this.#database = database;
  }

  createPending(
    input: CreatePendingDeviceOperationInput,
    options: DeviceOperationLifecycleOptions = {},
  ): Promise<StoredDeviceOperation> {
    const parsed = parseCreateInput(input);
    return this.#serialize(async () => {
      if (options.visibility === "internal") {
        assertInternalOperation(parsed.request);
        await this.#createInternalPending(parsed);
        return this.#getById(parsed.id);
      }
      const created = await this.#createPending(parsed, null);
      if (!created.changed) {
        throw new Error(
          "Background operation creation unexpectedly made no change",
        );
      }
      return created.operation;
    });
  }

  createPendingUserConfiguration(
    input: CreatePendingUserConfigurationOperationInput,
  ): Promise<CreatedUserConfigurationOperation> {
    const parsed = parseCreateInput(input);
    const expectedRevision = nonnegativeSafeIntegerSchema.parse(
      input.expectedRevision,
    );
    if (parsed.request.kind !== "edit_configuration") {
      throw new TypeError(
        "User device configuration operation requires edit_configuration",
      );
    }
    return this.#serialize(() =>
      this.#createPending(
        {
          ...parsed,
          request: parsed.request,
        },
        expectedRevision,
      ),
    );
  }

  async #createPending(
    parsed: CreatePendingDeviceOperationInput,
    expectedRevision: number | null,
  ): Promise<CreatedUserConfigurationOperation> {
    const updatesDesiredConfiguration =
      parsed.request.kind === "edit_configuration";
    const committed = await commitConditionalStateChange(
      this.#database,
      {
        actor: "runtime.device-operations",
        mutationType: "operation.create",
        summary: `Created pending ${parsed.request.kind} operation ${parsed.id}`,
        eventType: "operation.pending",
        entityType: "operation",
        entityId: parsed.id,
        occurredAtMs: parsed.requestedAtMs,
        retentionClass: "audit",
        payloadJson: JSON.stringify({
          schemaVersion: 1,
          status: "pending",
          kind: parsed.request.kind,
          deviceId: parsed.deviceId,
        }),
        payloadSchemaVersion: 1,
        invalidations: [
          { resource: "operation", id: parsed.id },
          ...(updatesDesiredConfiguration
            ? [{ resource: "device" as const, id: parsed.deviceId }]
            : []),
        ],
      },
      async (transaction) => {
        const existingDevice = await transaction
          .selectFrom("devices")
          .selectAll()
          .where("id", "=", parsed.deviceId)
          .executeTakeFirst();
        if (existingDevice === undefined) {
          throw new DeviceOperationDeviceNotFoundError(parsed.deviceId);
        }
        if (
          expectedRevision !== null &&
          parsed.request.kind === "edit_configuration"
        ) {
          const desiredConfigurationMatches =
            existingDevice.name === parsed.request.name &&
            existingDevice.desired_pwm_frequency_hz ===
              parsed.request.pwmFrequencyHz &&
            existingDevice.desired_pwm_resolution_bits ===
              parsed.request.pwmResolutionBits;
          const reportedConfigurationMatches =
            existingDevice.reported_name === parsed.request.name &&
            existingDevice.reported_pwm_frequency_hz ===
              parsed.request.pwmFrequencyHz &&
            existingDevice.reported_pwm_resolution_bits ===
              parsed.request.pwmResolutionBits;
          if (
            desiredConfigurationMatches &&
            reportedConfigurationMatches &&
            existingDevice.last_error_code !== "configuration_mismatch"
          ) {
            return { changed: false, result: null };
          }
        }
        await transaction
          .insertInto("control_operations")
          .values({
            id: parsed.id,
            device_id: parsed.deviceId,
            kind: parsed.request.kind,
            status: "pending",
            requested_at_ms: parsed.requestedAtMs,
            deadline_at_ms: parsed.deadlineAtMs,
            completed_at_ms: null,
            request_json: JSON.stringify(parsed.request),
            request_schema_version: DEVICE_OPERATION_REQUEST_SCHEMA_VERSION,
            result_json: null,
            result_schema_version: null,
          })
          .executeTakeFirstOrThrow();

        if (parsed.request.kind === "edit_configuration") {
          const configurationMatches =
            existingDevice.reported_name === parsed.request.name &&
            existingDevice.reported_pwm_frequency_hz ===
              parsed.request.pwmFrequencyHz &&
            existingDevice.reported_pwm_resolution_bits ===
              parsed.request.pwmResolutionBits;
          await transaction
            .updateTable("devices")
            .set({
              name: parsed.request.name,
              desired_pwm_frequency_hz: parsed.request.pwmFrequencyHz,
              desired_pwm_resolution_bits: parsed.request.pwmResolutionBits,
              last_error_code: configurationMatches
                ? existingDevice.last_error_code === "configuration_mismatch"
                  ? null
                  : existingDevice.last_error_code
                : "configuration_mismatch",
              last_error_message: configurationMatches
                ? existingDevice.last_error_code === "configuration_mismatch"
                  ? null
                  : existingDevice.last_error_message
                : "Reported configuration differs from desired configuration",
              updated_at_ms: Math.max(
                existingDevice.updated_at_ms,
                parsed.requestedAtMs,
              ),
            })
            .where("id", "=", parsed.deviceId)
            .executeTakeFirstOrThrow();
        }
        return { changed: true, result: null };
      },
      undefined,
      expectedRevision === null
        ? undefined
        : {
            expectedRevision,
            conflictError: (expected, current) =>
              new DeviceOperationRevisionConflictError(expected, current),
          },
    );
    if (!committed.changed) {
      return {
        changed: false,
        operation: null,
        mutation: {
          changed: false,
          revision: committed.revision,
          event: null,
        },
      };
    }
    if (committed.outboxEvent === null) {
      throw new Error("Changed operation creation lacks an outbox event");
    }
    return {
      changed: true,
      operation: await this.#getById(parsed.id),
      mutation: {
        changed: true,
        revision: committed.revision,
        event: toCommittedStateEvent(committed.outboxEvent),
      },
    };
  }

  markInFlight(
    id: string,
    atMs: number,
    options: DeviceOperationLifecycleOptions = {},
  ): Promise<StoredDeviceOperation> {
    const parsedId = identifierSchema.parse(id);
    const parsedAtMs = nonnegativeSafeIntegerSchema.parse(atMs);
    return this.#serialize(async () => {
      const operation = await this.#getById(parsedId);
      if (operation.status !== "pending") {
        throw new InvalidDeviceOperationTransitionError(
          `Operation ${parsedId} cannot transition from ${operation.status} to in_flight`,
        );
      }
      if (parsedAtMs < operation.requestedAtMs) {
        throw new RangeError("In-flight time must not precede request time");
      }
      if (options.visibility === "internal") {
        assertInternalOperation(operation.request);
        await this.#markInternalInFlight(operation);
      } else {
        await this.#commitTransition(
          operation,
          "in_flight",
          parsedAtMs,
          null,
          null,
        );
      }
      return this.#getById(parsedId);
    });
  }

  completeInFlight(
    id: string,
    completedAtMs: number,
    result: DeviceOperationResult,
    options: DeviceOperationLifecycleOptions = {},
  ): Promise<StoredDeviceOperation> {
    const parsedId = identifierSchema.parse(id);
    const parsedCompletedAtMs =
      nonnegativeSafeIntegerSchema.parse(completedAtMs);
    const parsedResult = deviceOperationResultSchema.parse(result);
    return this.#serialize(async () => {
      const operation = await this.#getById(parsedId);
      if (operation.status !== "in_flight") {
        throw new InvalidDeviceOperationTransitionError(
          `Operation ${parsedId} cannot complete from ${operation.status}`,
        );
      }
      if (
        parsedResult.status === "timed_out" ||
        parsedResult.status === "cancelled"
      ) {
        throw new InvalidDeviceOperationTransitionError(
          "An attempted operation cannot become an unattempted terminal state",
        );
      }
      assertDeviceOperationResultMatchesRequest(
        operation.request,
        parsedResult,
      );
      if (
        options.visibility === "internal" &&
        parsedResult.status === "succeeded"
      ) {
        assertInternalOperation(operation.request);
        await this.#deleteInternalSuccess(operation);
        return {
          ...operation,
          status: "succeeded",
          completedAtMs: parsedCompletedAtMs,
          result: parsedResult,
        };
      }
      await this.#commitTransition(
        operation,
        parsedResult.status,
        parsedCompletedAtMs,
        parsedCompletedAtMs,
        parsedResult,
      );
      return this.#getById(parsedId);
    });
  }

  completePendingWithoutAttempt(
    id: string,
    completedAtMs: number,
    result: Extract<
      DeviceOperationResult,
      { status: "timed_out" | "cancelled" }
    >,
  ): Promise<StoredDeviceOperation> {
    const parsedId = identifierSchema.parse(id);
    const parsedCompletedAtMs =
      nonnegativeSafeIntegerSchema.parse(completedAtMs);
    const parsedResult = deviceOperationResultSchema.parse(result);
    if (
      parsedResult.status !== "timed_out" &&
      parsedResult.status !== "cancelled"
    ) {
      throw new InvalidDeviceOperationTransitionError(
        "Pending operations may only terminate timed_out or cancelled",
      );
    }
    return this.#serialize(async () => {
      const operation = await this.#getById(parsedId);
      if (operation.status !== "pending") {
        throw new InvalidDeviceOperationTransitionError(
          `Operation ${parsedId} cannot complete without attempt from ${operation.status}`,
        );
      }
      await this.#commitTransition(
        operation,
        parsedResult.status,
        parsedCompletedAtMs,
        parsedCompletedAtMs,
        parsedResult,
      );
      return this.#getById(parsedId);
    });
  }

  reconcileOutcome(input: {
    readonly operationId: string;
    readonly expectedRevision: number | null;
    readonly origin:
      | "manual_override"
      | "schedule_reconciliation"
      | "routine_expiry"
      | "operator";
    readonly reconciledAtMs: number;
  }): Promise<MutationResult> {
    const operationId = identifierSchema.parse(input.operationId);
    const expectedRevision =
      input.expectedRevision === null
        ? null
        : nonnegativeSafeIntegerSchema.parse(input.expectedRevision);
    const reconciledAtMs = nonnegativeSafeIntegerSchema.parse(
      input.reconciledAtMs,
    );
    if ((input.origin === "operator") !== (expectedRevision !== null)) {
      throw new TypeError(
        "Operator reconciliation requires a revision and runtime reconciliation must not provide one",
      );
    }
    return this.#serialize(async () => {
      const alreadyReconciled = await this.#readIdempotentReconciliation(
        operationId,
        input.origin,
        expectedRevision,
      );
      if (alreadyReconciled !== null) {
        return alreadyReconciled;
      }
      try {
        const committed = await commitConditionalStateChange(
          this.#database,
          {
            actor:
              input.origin === "operator"
                ? "controller-api"
                : "runtime.device-operations",
            mutationType: "operation.reconcile-outcome",
            summary: `Reconciled unknown outcome for operation ${operationId}`,
            eventType: "operation.outcome-reconciled",
            entityType: "operation",
            entityId: operationId,
            occurredAtMs: reconciledAtMs,
            retentionClass: "critical",
            payloadJson: JSON.stringify({
              schemaVersion: 1,
              origin: input.origin,
              status: "outcome_unknown",
              reconciled: true,
            }),
            payloadSchemaVersion: 1,
          },
          async (transaction) => {
            const row = await transaction
              .selectFrom("control_operations")
              .selectAll()
              .where("id", "=", operationId)
              .executeTakeFirst();
            if (row === undefined) {
              throw new DeviceOperationNotFoundError(operationId);
            }
            const operation = parseReconciliationDeviceOperation(row);
            if (
              operation.status !== "outcome_unknown" ||
              operation.result?.status !== "outcome_unknown"
            ) {
              throw new DeviceOperationReconciliationConflictError(
                operationId,
                "outcome_not_unknown",
                `Operation ${operationId} does not have an unknown outcome`,
              );
            }
            if (
              input.origin === "operator" ||
              input.origin === "routine_expiry"
            ) {
              await assertNotOwnedByUnresolvedManualOverride(
                transaction,
                operationId,
              );
            }
            if (operation.result.reconciledAtMs !== null) {
              return { changed: false, result: { reconciled: true } };
            }
            if (
              operation.completedAtMs === null ||
              reconciledAtMs < operation.completedAtMs
            ) {
              throw new RangeError(
                "Reconciliation time must not precede operation completion",
              );
            }
            if (
              operation.request.kind === "set_pwm" &&
              operation.request.overwrite &&
              reconciledAtMs <
                safeAdd(
                  operation.completedAtMs,
                  ESP32_PWM_OVERWRITE_DURATION_MS,
                  "Firmware overwrite safety window exceeds the safe integer range",
                )
            ) {
              throw new DeviceOperationReconciliationConflictError(
                operationId,
                "firmware_safety_window",
                `Operation ${operationId} cannot be reconciled before the firmware safety window ends`,
              );
            }
            const result = deviceOperationResultSchema.parse({
              ...operation.result,
              reconciledAtMs,
            });
            const update = await transaction
              .updateTable("control_operations")
              .set({
                result_json: JSON.stringify(result),
                result_schema_version: DEVICE_OPERATION_RESULT_SCHEMA_VERSION,
              })
              .where("id", "=", operationId)
              .where("status", "=", "outcome_unknown")
              .executeTakeFirst();
            if (update.numUpdatedRows !== 1n) {
              throw new InvalidDeviceOperationTransitionError(
                `Operation ${operationId} changed during reconciliation`,
              );
            }
            return { changed: true, result: { reconciled: true } };
          },
          undefined,
          expectedRevision === null
            ? undefined
            : {
                expectedRevision,
                conflictError: (expected, current) =>
                  new DeviceOperationRevisionConflictError(expected, current),
              },
        );
        if (!committed.changed) {
          return {
            changed: false,
            revision: committed.revision,
            event: null,
          };
        }
        if (committed.outboxEvent === null) {
          throw new Error(
            "Changed operation reconciliation lacks an outbox event",
          );
        }
        return {
          changed: true,
          revision: committed.revision,
          event: toCommittedStateEvent(committed.outboxEvent),
        };
      } catch (error) {
        if (error instanceof DeviceOperationRevisionConflictError) {
          const racedReconciliation = await this.#readIdempotentReconciliation(
            operationId,
            input.origin,
            expectedRevision,
          );
          if (racedReconciliation !== null) {
            return racedReconciliation;
          }
        }
        throw error;
      }
    });
  }

  async recoverInterrupted(
    nowMs: number,
  ): Promise<InterruptedOperationRecovery> {
    const parsedNowMs = nonnegativeSafeIntegerSchema.parse(nowMs);
    const interrupted = await this.#database
      .selectFrom("control_operations")
      .selectAll()
      .where("kind", "in", [...DEVICE_OPERATION_KINDS])
      .where("status", "in", ["pending", "in_flight"])
      .orderBy("requested_at_ms")
      .orderBy("id")
      .execute();
    const recoveredOperationIds: string[] = [];
    for (const row of interrupted) {
      const operation = parseStoredOperation(row);
      if (parsedNowMs < operation.requestedAtMs) {
        throw new RangeError(
          `Recovery time precedes request time for operation ${operation.id}`,
        );
      }
      if (operation.status === "pending") {
        await this.completePendingWithoutAttempt(
          operation.id,
          parsedNowMs,
          operation.deadlineAtMs <= parsedNowMs
            ? {
                status: "timed_out",
                reason: "deadline_before_attempt",
              }
            : {
                status: "cancelled",
                reason: "controller_restart_before_attempt",
              },
        );
      } else {
        await this.completeInFlight(operation.id, parsedNowMs, {
          status: "outcome_unknown",
          wireOperationId: null,
          reason: "controller_restart",
          reconciledAtMs: null,
        });
      }
      recoveredOperationIds.push(operation.id);
    }
    return {
      recoveredOperationIds,
    };
  }

  async reconcileExpiredRoutinePwmOutcomes(
    rawDeviceId: string,
    rawReconciledAtMs: number,
  ): Promise<readonly string[]> {
    const deviceId = identifierSchema.parse(rawDeviceId);
    const reconciledAtMs =
      nonnegativeSafeIntegerSchema.parse(rawReconciledAtMs);
    const safetyCutoffMs = Math.max(
      0,
      reconciledAtMs - ESP32_PWM_OVERWRITE_DURATION_MS,
    );
    const rows = await this.#database
      .selectFrom("control_operations")
      .selectAll()
      .where("device_id", "=", deviceId)
      .where("kind", "=", "set_pwm")
      .where("status", "=", "outcome_unknown")
      .where("completed_at_ms", "<=", safetyCutoffMs)
      .orderBy("requested_at_ms")
      .orderBy("id")
      .execute();
    const reconciledIds: string[] = [];
    for (const row of rows) {
      const operation = parseStoredOperation(row);
      if (
        operation.request.kind !== "set_pwm" ||
        operation.result?.status !== "outcome_unknown"
      ) {
        throw new Error(
          `Routine PWM reconciliation candidate ${operation.id} has invalid persisted state`,
        );
      }
      if (!operation.request.overwrite) {
        continue;
      }
      if (operation.result.reconciledAtMs !== null) {
        continue;
      }
      try {
        await this.reconcileOutcome({
          operationId: operation.id,
          expectedRevision: null,
          origin: "routine_expiry",
          reconciledAtMs,
        });
        reconciledIds.push(operation.id);
      } catch (error) {
        if (
          error instanceof DeviceOperationReconciliationConflictError &&
          error.relation === "manual_override_owns_operation"
        ) {
          continue;
        }
        throw error;
      }
    }
    return reconciledIds;
  }

  getById(id: string): Promise<StoredDeviceOperation> {
    const parsedId = identifierSchema.parse(id);
    return this.#getById(parsedId);
  }

  async getDeviceById(id: string): Promise<Selectable<DevicesTable>> {
    const parsedId = identifierSchema.parse(id);
    const device = await this.#database
      .selectFrom("devices")
      .selectAll()
      .where("id", "=", parsedId)
      .executeTakeFirst();
    if (device === undefined) {
      throw new DeviceOperationDeviceNotFoundError(parsedId);
    }
    return device;
  }

  async #readIdempotentReconciliation(
    operationId: string,
    origin:
      | "manual_override"
      | "schedule_reconciliation"
      | "routine_expiry"
      | "operator",
    expectedRevision: number | null,
  ): Promise<Extract<MutationResult, { readonly changed: false }> | null> {
    return this.#database.transaction().execute(async (transaction) => {
      const row = await transaction
        .selectFrom("control_operations")
        .selectAll()
        .where("id", "=", operationId)
        .executeTakeFirst();
      if (row === undefined) {
        throw new DeviceOperationNotFoundError(operationId);
      }
      const operation = parseReconciliationDeviceOperation(row);
      if (
        operation.status !== "outcome_unknown" ||
        operation.result?.status !== "outcome_unknown" ||
        operation.result.reconciledAtMs === null
      ) {
        return null;
      }
      if (origin === "operator") {
        await assertNotOwnedByUnresolvedManualOverride(
          transaction,
          operationId,
        );
      }
      const revisionRow = await transaction
        .selectFrom("state_revisions")
        .select(({ fn }) => fn.max<number>("revision").as("revision"))
        .executeTakeFirstOrThrow();
      const currentRevision = revisionRow.revision ?? 0;
      if (expectedRevision !== null && expectedRevision > currentRevision) {
        throw new DeviceOperationRevisionConflictError(
          expectedRevision,
          currentRevision,
        );
      }
      return {
        changed: false,
        revision: currentRevision,
        event: null,
      };
    });
  }

  async #commitTransition(
    operation: StoredDeviceOperation,
    status: OperationStatus,
    occurredAtMs: number,
    completedAtMs: number | null,
    result: DeviceOperationResult | null,
  ): Promise<void> {
    if (occurredAtMs < operation.requestedAtMs) {
      throw new RangeError("Operation transition cannot precede its request");
    }
    const reportsConfiguration =
      status === "succeeded" && operation.request.kind === "edit_configuration";
    await commitStateChange(
      this.#database,
      {
        actor: "runtime.device-operations",
        mutationType: `operation.${status}`,
        summary: `Transitioned operation ${operation.id} to ${status}`,
        eventType: `operation.${status.replaceAll("_", "-")}`,
        entityType: "operation",
        entityId: operation.id,
        occurredAtMs,
        retentionClass:
          status === "outcome_unknown" || status === "failed"
            ? "critical"
            : "audit",
        payloadJson: JSON.stringify({
          schemaVersion: 1,
          status,
          kind: operation.kind,
          deviceId: operation.deviceId,
        }),
        payloadSchemaVersion: 1,
        invalidations: [
          { resource: "operation", id: operation.id },
          ...(reportsConfiguration
            ? [{ resource: "device" as const, id: operation.deviceId }]
            : []),
        ],
      },
      async (transaction) => {
        const update = await transaction
          .updateTable("control_operations")
          .set({
            status,
            completed_at_ms: completedAtMs,
            result_json: result === null ? null : JSON.stringify(result),
            result_schema_version:
              result === null ? null : DEVICE_OPERATION_RESULT_SCHEMA_VERSION,
          })
          .where("id", "=", operation.id)
          .where("status", "=", operation.status)
          .executeTakeFirst();
        if (update.numUpdatedRows !== 1n) {
          throw new InvalidDeviceOperationTransitionError(
            `Operation ${operation.id} changed concurrently from ${operation.status}`,
          );
        }

        if (
          reportsConfiguration &&
          operation.request.kind === "edit_configuration"
        ) {
          await transaction
            .updateTable("devices")
            .set({
              reported_name: operation.request.name,
              reported_pwm_frequency_hz: operation.request.pwmFrequencyHz,
              reported_pwm_resolution_bits: operation.request.pwmResolutionBits,
              last_error_code: null,
              last_error_message: null,
              updated_at_ms: sql<number>`MAX(updated_at_ms, ${occurredAtMs})`,
            })
            .where("id", "=", operation.deviceId)
            .executeTakeFirstOrThrow();
        }
      },
    );
  }

  async #createInternalPending(
    parsed: CreatePendingDeviceOperationInput,
  ): Promise<void> {
    await this.#database.transaction().execute(async (transaction) => {
      const device = await transaction
        .selectFrom("devices")
        .select("id")
        .where("id", "=", parsed.deviceId)
        .executeTakeFirst();
      if (device === undefined) {
        throw new DeviceOperationDeviceNotFoundError(parsed.deviceId);
      }
      await transaction
        .insertInto("control_operations")
        .values({
          id: parsed.id,
          device_id: parsed.deviceId,
          kind: parsed.request.kind,
          status: "pending",
          requested_at_ms: parsed.requestedAtMs,
          deadline_at_ms: parsed.deadlineAtMs,
          completed_at_ms: null,
          request_json: JSON.stringify(parsed.request),
          request_schema_version: DEVICE_OPERATION_REQUEST_SCHEMA_VERSION,
          result_json: null,
          result_schema_version: null,
        })
        .executeTakeFirstOrThrow();
    });
  }

  async #markInternalInFlight(operation: StoredDeviceOperation): Promise<void> {
    const update = await this.#database
      .updateTable("control_operations")
      .set({
        status: "in_flight",
        completed_at_ms: null,
        result_json: null,
        result_schema_version: null,
      })
      .where("id", "=", operation.id)
      .where("status", "=", operation.status)
      .executeTakeFirst();
    if (update.numUpdatedRows !== 1n) {
      throw new InvalidDeviceOperationTransitionError(
        `Operation ${operation.id} changed concurrently from ${operation.status}`,
      );
    }
  }

  async #deleteInternalSuccess(
    operation: StoredDeviceOperation,
  ): Promise<void> {
    const deleted = await this.#database
      .deleteFrom("control_operations")
      .where("id", "=", operation.id)
      .where("status", "=", operation.status)
      .executeTakeFirst();
    if (deleted.numDeletedRows !== 1n) {
      throw new InvalidDeviceOperationTransitionError(
        `Operation ${operation.id} changed concurrently from ${operation.status}`,
      );
    }
  }

  async #getById(id: string): Promise<StoredDeviceOperation> {
    const row = await this.#database
      .selectFrom("control_operations")
      .selectAll()
      .where("id", "=", id)
      .executeTakeFirstOrThrow();
    return parseStoredOperation(row);
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

const DEVICE_OPERATION_KINDS = [
  "set_pwm",
  "ping",
  "edit_configuration",
  "schedule",
  "sync_time",
  "analog_read",
] as const satisfies readonly DeviceOperationRequest["kind"][];

const MANUAL_OVERRIDE_OPERATION_KINDS = [
  "manual_override_start",
  "manual_override_cancel",
  "manual_override_expire",
] as const;

function parseCreateInput(
  input: CreatePendingDeviceOperationInput,
): CreatePendingDeviceOperationInput {
  const id = identifierSchema.parse(input.id);
  const deviceId = identifierSchema.parse(input.deviceId);
  const requestedAtMs = nonnegativeSafeIntegerSchema.parse(input.requestedAtMs);
  const deadlineAtMs = nonnegativeSafeIntegerSchema.parse(input.deadlineAtMs);
  if (deadlineAtMs < requestedAtMs) {
    throw new RangeError("Operation deadline must not precede its request");
  }
  return {
    id,
    deviceId,
    requestedAtMs,
    deadlineAtMs,
    request: deviceOperationRequestSchema.parse(input.request),
  };
}

function assertInternalOperation(request: DeviceOperationRequest): void {
  if (request.kind !== "set_pwm") {
    throw new TypeError("Only routine PWM operations may be internal");
  }
}

function parseStoredOperation(
  row: Selectable<ControlOperationsTable>,
): StoredDeviceOperation {
  if (row.request_schema_version !== DEVICE_OPERATION_REQUEST_SCHEMA_VERSION) {
    throw new Error(
      `Unsupported request schema version for operation ${row.id}`,
    );
  }
  const requestDocument = parseJsonDocument(
    row.request_json,
    `operation ${row.id} request`,
  );
  if (requestDocument.duplicateKeys.length > 0) {
    throw new Error(`Operation ${row.id} request contains duplicate JSON keys`);
  }
  const request = deviceOperationRequestSchema.parse(requestDocument.value);
  if (request.kind !== row.kind) {
    throw new Error(`Operation ${row.id} kind does not match its request`);
  }

  let result: DeviceOperationResult | null = null;
  if (row.result_json !== null || row.result_schema_version !== null) {
    if (
      row.result_json === null ||
      row.result_schema_version !== DEVICE_OPERATION_RESULT_SCHEMA_VERSION
    ) {
      throw new Error(`Operation ${row.id} has an invalid result envelope`);
    }
    const resultDocument = parseJsonDocument(
      row.result_json,
      `operation ${row.id} result`,
    );
    if (resultDocument.duplicateKeys.length > 0) {
      throw new Error(
        `Operation ${row.id} result contains duplicate JSON keys`,
      );
    }
    result = deviceOperationResultSchema.parse(resultDocument.value);
  }
  const terminal = !["pending", "in_flight"].includes(row.status);
  if (terminal !== (row.completed_at_ms !== null && result !== null)) {
    throw new Error(
      `Operation ${row.id} completion fields do not match status ${row.status}`,
    );
  }
  if (result !== null && result.status !== row.status) {
    throw new Error(`Operation ${row.id} result does not match its status`);
  }
  if (result !== null) {
    assertDeviceOperationResultMatchesRequest(request, result);
  }
  if (row.device_id === null) {
    throw new Error(`Device operation ${row.id} has no device`);
  }
  return {
    id: row.id,
    deviceId: row.device_id,
    kind: request.kind,
    status: row.status,
    requestedAtMs: row.requested_at_ms,
    deadlineAtMs: row.deadline_at_ms,
    completedAtMs: row.completed_at_ms,
    request,
    result,
  };
}

function parseReconciliationDeviceOperation(
  row: Selectable<ControlOperationsTable>,
): StoredDeviceOperation {
  if (row.device_id !== null) {
    return parseStoredOperation(row);
  }
  if (!MANUAL_OVERRIDE_OPERATION_KINDS.some((kind) => kind === row.kind)) {
    throw new Error(`Operation ${row.id} has no device`);
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
      `Manual override operation ${row.id} request contains duplicate JSON keys`,
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
  let result: ReturnType<
    typeof manualOverrideOperationResultSchema.parse
  > | null = null;
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
        `Manual override operation ${row.id} result contains duplicate JSON keys`,
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
      `Manual override operation ${row.id} result does not match its status`,
    );
  }
  throw new DeviceOperationReconciliationConflictError(
    row.id,
    "not_device_operation",
    `Operation ${row.id} is a manual-override aggregate and cannot be reconciled as a device operation`,
  );
}

async function assertNotOwnedByUnresolvedManualOverride(
  transaction: StateDatabaseTransaction,
  operationId: string,
): Promise<void> {
  const unresolvedManualOperations = await transaction
    .selectFrom("control_operations")
    .select(["id", "result_json", "result_schema_version"])
    .where("kind", "in", [...MANUAL_OVERRIDE_OPERATION_KINDS])
    .where("status", "=", "outcome_unknown")
    .execute();
  for (const owner of unresolvedManualOperations) {
    if (
      owner.result_json === null ||
      owner.result_schema_version !== MANUAL_OVERRIDE_OPERATION_SCHEMA_VERSION
    ) {
      throw new Error(
        `Manual override operation ${owner.id} has an invalid result envelope`,
      );
    }
    const document = parseJsonDocument(
      owner.result_json,
      `manual override operation ${owner.id} result`,
    );
    if (document.duplicateKeys.length > 0) {
      throw new Error(
        `Manual override operation ${owner.id} result contains duplicate JSON keys`,
      );
    }
    const result = manualOverrideOperationResultSchema.parse(document.value);
    if (
      result.status === "outcome_unknown" &&
      result.reconciledAtMs === null &&
      result.unknownChildOperationIds.includes(operationId)
    ) {
      throw new DeviceOperationReconciliationConflictError(
        operationId,
        "manual_override_owns_operation",
        `Operation ${operationId} must be reconciled through manual override operation ${owner.id}`,
      );
    }
  }
}

function safeAdd(left: number, right: number, message: string): number {
  const result = left + right;
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new RangeError(message);
  }
  return result;
}
