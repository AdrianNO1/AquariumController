import {
  identifierSchema,
  nonnegativeSafeIntegerSchema,
  type MutationResult,
} from "@aquarium/contracts";
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
import { parseJsonDocument } from "../import/strict-json.js";
import {
  commitConditionalStateChange,
  commitStateChange,
  toCommittedStateEvent,
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
  readonly unresolvedOutcomeUnknownIds: readonly string[];
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

export class ControlOperationRepository {
  readonly #database: Kysely<StateDatabaseSchema>;
  #operationTail: Promise<void> = Promise.resolve();

  constructor(database: Kysely<StateDatabaseSchema>) {
    this.#database = database;
  }

  createPending(
    input: CreatePendingDeviceOperationInput,
  ): Promise<StoredDeviceOperation> {
    const parsed = parseCreateInput(input);
    return this.#serialize(async () => {
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
          parsed.request.kind === "edit_configuration" &&
          existingDevice.name === parsed.request.name &&
          existingDevice.desired_pwm_frequency_hz ===
            parsed.request.pwmFrequencyHz &&
          existingDevice.desired_pwm_resolution_bits ===
            parsed.request.pwmResolutionBits
        ) {
          return { changed: false, result: null };
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

  markInFlight(id: string, atMs: number): Promise<StoredDeviceOperation> {
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
      await this.#commitTransition(
        operation,
        "in_flight",
        parsedAtMs,
        null,
        null,
      );
      return this.#getById(parsedId);
    });
  }

  completeInFlight(
    id: string,
    completedAtMs: number,
    result: DeviceOperationResult,
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

  markOutcomeReconciled(
    id: string,
    reconciledAtMs: number,
  ): Promise<StoredDeviceOperation> {
    const parsedId = identifierSchema.parse(id);
    const parsedReconciledAtMs =
      nonnegativeSafeIntegerSchema.parse(reconciledAtMs);
    return this.#serialize(async () => {
      const operation = await this.#getById(parsedId);
      if (
        operation.status !== "outcome_unknown" ||
        operation.result?.status !== "outcome_unknown"
      ) {
        throw new InvalidDeviceOperationTransitionError(
          `Operation ${parsedId} does not have an unknown outcome`,
        );
      }
      if (operation.result.reconciledAtMs !== null) {
        throw new InvalidDeviceOperationTransitionError(
          `Operation ${parsedId} was already reconciled`,
        );
      }
      if (
        operation.completedAtMs !== null &&
        parsedReconciledAtMs < operation.completedAtMs
      ) {
        throw new RangeError(
          "Reconciliation time must not precede operation completion",
        );
      }
      const result = deviceOperationResultSchema.parse({
        ...operation.result,
        reconciledAtMs: parsedReconciledAtMs,
      });
      await commitStateChange(
        this.#database,
        {
          actor: "runtime.device-operations",
          mutationType: "operation.reconcile-outcome",
          summary: `Reconciled unknown outcome for operation ${parsedId}`,
          eventType: "operation.outcome-reconciled",
          entityType: "operation",
          entityId: parsedId,
          occurredAtMs: parsedReconciledAtMs,
          retentionClass: "critical",
          payloadJson: JSON.stringify({
            schemaVersion: 1,
            status: "outcome_unknown",
            reconciled: true,
          }),
          payloadSchemaVersion: 1,
        },
        async (transaction) => {
          const update = await transaction
            .updateTable("control_operations")
            .set({
              result_json: JSON.stringify(result),
              result_schema_version: DEVICE_OPERATION_RESULT_SCHEMA_VERSION,
            })
            .where("id", "=", parsedId)
            .where("status", "=", "outcome_unknown")
            .executeTakeFirst();
          if (update.numUpdatedRows !== 1n) {
            throw new InvalidDeviceOperationTransitionError(
              `Operation ${parsedId} changed during reconciliation`,
            );
          }
        },
      );
      return this.#getById(parsedId);
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
      unresolvedOutcomeUnknownIds: await this.listUnresolvedOutcomeUnknownIds(),
    };
  }

  async listUnresolvedOutcomeUnknownIds(): Promise<readonly string[]> {
    const rows = await this.#database
      .selectFrom("control_operations")
      .selectAll()
      .where("kind", "in", [...DEVICE_OPERATION_KINDS])
      .where("status", "=", "outcome_unknown")
      .orderBy("requested_at_ms")
      .orderBy("id")
      .execute();
    return rows.flatMap((row) => {
      const operation = parseStoredOperation(row);
      if (operation.result?.status !== "outcome_unknown") {
        throw new Error(
          `Outcome-unknown operation ${operation.id} lacks its typed result`,
        );
      }
      return operation.result.reconciledAtMs === null ? [operation.id] : [];
    });
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
