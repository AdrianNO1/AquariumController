import {
  boundedTextSchema,
  identifierSchema,
  manualOverrideTargetSchema,
  nonnegativeSafeIntegerSchema,
  percentageSchema,
  type ManualOverrideTarget,
  type MutationResult,
  type OperationSummary,
  type Override,
} from "@aquarium/contracts";
import { ESP32_PWM_OVERWRITE_DURATION_MS } from "@aquarium/esp-protocol";
import { z } from "zod";

export const MANUAL_OVERRIDE_DURATION_MS = ESP32_PWM_OVERWRITE_DURATION_MS;
export const MANUAL_OVERRIDE_OPERATION_TIMEOUT_MS = 30_000;
export const MANUAL_OVERRIDE_OPERATION_SCHEMA_VERSION = 2;

export const manualOverridePinCommandSchema = z.strictObject({
  deviceId: identifierSchema,
  mappingId: identifierSchema,
  pin: z.number().int().min(0).max(63),
  value: z.number().int().min(0).max(255),
  overwrite: z.boolean(),
});

const manualOverrideOperationBaseShape = {
  overrideId: identifierSchema,
  target: manualOverrideTargetSchema,
  commands: z.array(manualOverridePinCommandSchema).min(1).max(1_000),
} as const;

export const manualOverrideOperationRequestSchema = z.discriminatedUnion(
  "kind",
  [
    z.strictObject({
      ...manualOverrideOperationBaseShape,
      kind: z.literal("manual_override_start"),
      valuePercentage: percentageSchema,
      expiresAtMs: nonnegativeSafeIntegerSchema,
    }),
    z.strictObject({
      ...manualOverrideOperationBaseShape,
      kind: z.literal("manual_override_cancel"),
      originStartOperationId: identifierSchema,
    }),
    z.strictObject({
      ...manualOverrideOperationBaseShape,
      kind: z.literal("manual_override_expire"),
      originStartOperationId: identifierSchema,
    }),
  ],
);

const manualOverrideChildOperationIdsSchema = z
  .array(identifierSchema)
  .max(1_000)
  .superRefine((ids, context) => {
    const seen = new Set<string>();
    for (const [index, id] of ids.entries()) {
      if (seen.has(id)) {
        context.addIssue({
          code: "custom",
          path: [index],
          message: "Child operation identifiers must be unique",
        });
      }
      seen.add(id);
    }
  });

export const manualOverrideOperationResultSchema = z.discriminatedUnion(
  "status",
  [
    z.strictObject({
      status: z.literal("succeeded"),
      childOperationIds: manualOverrideChildOperationIdsSchema,
    }),
    z.strictObject({
      status: z.literal("failed"),
      childOperationIds: manualOverrideChildOperationIdsSchema,
      code: boundedTextSchema,
      message: boundedTextSchema,
    }),
    z.strictObject({
      status: z.literal("timed_out"),
      childOperationIds: manualOverrideChildOperationIdsSchema,
      reason: z.literal("deadline_before_attempt"),
    }),
    z.strictObject({
      status: z.literal("outcome_unknown"),
      childOperationIds: manualOverrideChildOperationIdsSchema,
      reason: z.enum([
        "child_outcome_not_succeeded",
        "command_dispatch_blocked",
        "command_dispatch_failed",
        "completed_after_expiry",
        "controller_restart",
        "controller_restart_before_release",
      ]),
      unknownChildOperationIds: manualOverrideChildOperationIdsSchema,
      safetyReconcileAtMs: nonnegativeSafeIntegerSchema,
      reconciledAtMs: nonnegativeSafeIntegerSchema.nullable(),
    }),
    z.strictObject({
      status: z.literal("cancelled"),
      childOperationIds: manualOverrideChildOperationIdsSchema,
      reason: z.literal("controller_restart_before_attempt"),
    }),
  ],
);

export type ManualOverridePinCommand = z.infer<
  typeof manualOverridePinCommandSchema
>;
export type ManualOverrideOperationRequest = z.infer<
  typeof manualOverrideOperationRequestSchema
>;
export type ManualOverrideOperationResult = z.infer<
  typeof manualOverrideOperationResultSchema
>;

export interface StoredManualOverride {
  readonly id: string;
  readonly target: ManualOverrideTarget;
  readonly valuePercentage: number;
  readonly status: Override["status"];
  readonly requestedAtMs: number;
  readonly startsAtMs: number | null;
  readonly expiresAtMs: number;
  readonly completedAtMs: number | null;
  readonly operationId: string | null;
}

export interface StoredManualOverrideOperation {
  readonly id: string;
  readonly status: OperationSummary["status"];
  readonly requestedAtMs: number;
  readonly deadlineAtMs: number;
  readonly completedAtMs: number | null;
  readonly request: ManualOverrideOperationRequest;
  readonly result: ManualOverrideOperationResult | null;
}

export interface PreparedManualOverrideOperation {
  readonly override: StoredManualOverride;
  readonly operation: StoredManualOverrideOperation;
  readonly mutation: Extract<MutationResult, { readonly changed: true }>;
}

export interface StoredManualOverrideStateMutation {
  readonly override: StoredManualOverride;
  readonly mutation: MutationResult;
}

export interface ManualOverrideOverlayOutput {
  readonly overrideId: string;
  readonly deviceId: string;
  readonly mappingId: string;
  readonly pin: number;
  readonly value: number;
  readonly overwrite: true;
  readonly expiresAtMs: number;
}

export interface ManualOverrideOverlayReader {
  readActiveManualOverrideOutputs(
    atMs: number,
  ): Promise<readonly ManualOverrideOverlayOutput[]>;
}

export interface ManualOverrideDeviceOperationCompletion {
  readonly id: string;
  readonly status: OperationSummary["status"];
}

export type ManualOverrideDeviceDispatchResult =
  | {
      readonly kind: "completed";
      readonly operation: ManualOverrideDeviceOperationCompletion;
    }
  | {
      readonly kind: "blocked";
      readonly reason: "outcome_unknown" | "command_error";
    };

export interface ManualOverrideDeviceCommandPort {
  dispatch(
    deviceId: string,
    request: {
      readonly kind: "set_pwm";
      readonly pin: number;
      readonly value: number;
      readonly overwrite: boolean;
    },
  ): Promise<ManualOverrideDeviceDispatchResult>;
  reconcileUnknownOutcomes(operationIds: readonly string[]): Promise<void>;
}

export interface ManualOverrideRepositoryPort extends ManualOverrideOverlayReader {
  getOverride(overrideId: string): Promise<StoredManualOverride>;
  createStart(input: {
    readonly overrideId: string;
    readonly operationId: string;
    readonly expectedRevision: number;
    readonly target: ManualOverrideTarget;
    readonly valuePercentage: number;
    readonly requestedAtMs: number;
    readonly expiresAtMs: number;
    readonly deadlineAtMs: number;
  }): Promise<PreparedManualOverrideOperation>;
  extend(input: {
    readonly overrideId: string;
    readonly expectedRevision: number;
    readonly atMs: number;
    readonly expiresAtMs: number;
  }): Promise<StoredManualOverrideStateMutation>;
  createRelease(input: {
    readonly overrideId: string;
    readonly operationId: string;
    readonly action: "cancel" | "expire";
    readonly expectedRevision: number | null;
    readonly requestedAtMs: number;
    readonly deadlineAtMs: number;
    readonly utcMinuteOfDay: number;
  }): Promise<PreparedManualOverrideOperation | null>;
  markInFlight(
    operationId: string,
    atMs: number,
  ): Promise<StoredManualOverrideOperation>;
  completeSucceeded(
    operationId: string,
    completedAtMs: number,
    childOperationIds: readonly string[],
  ): Promise<void>;
  completeFailed(input: {
    readonly operationId: string;
    readonly completedAtMs: number;
    readonly childOperationIds: readonly string[];
    readonly status: "failed" | "timed_out";
    readonly code: string;
    readonly message: string;
  }): Promise<void>;
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
  }): Promise<void>;
  recoverInterrupted(nowMs: number): Promise<void>;
  listDueActiveOverrideIds(nowMs: number): Promise<readonly string[]>;
  listDueUnknownOperationIds(nowMs: number): Promise<readonly string[]>;
  getManualOperation(
    operationId: string,
  ): Promise<StoredManualOverrideOperation>;
  finalizeReconciledOutcome(input: {
    readonly operationId: string;
    readonly expectedRevision: number | null;
    readonly reconciledAtMs: number;
  }): Promise<StoredManualOverrideStateMutation>;
  nextDeadlineMs(): Promise<number | null>;
}

export function toOverrideContract(value: StoredManualOverride): Override {
  return {
    id: value.id,
    targetType: value.target.targetType,
    targetId: value.target.targetId,
    valuePercentage: value.valuePercentage,
    status: value.status,
    requestedAt: new Date(value.requestedAtMs).toISOString(),
    startsAt:
      value.startsAtMs === null
        ? null
        : new Date(value.startsAtMs).toISOString(),
    expiresAt: new Date(value.expiresAtMs).toISOString(),
    completedAt:
      value.completedAtMs === null
        ? null
        : new Date(value.completedAtMs).toISOString(),
    operationId: value.operationId,
  };
}

export function toOperationSummary(
  value: StoredManualOverrideOperation,
): OperationSummary {
  return {
    id: value.id,
    deviceId: null,
    kind: value.request.kind,
    status: value.status,
    requestedAt: new Date(value.requestedAtMs).toISOString(),
    deadlineAt: new Date(value.deadlineAtMs).toISOString(),
    completedAt:
      value.completedAtMs === null
        ? null
        : new Date(value.completedAtMs).toISOString(),
    outcomeUnresolved:
      value.status === "outcome_unknown" &&
      value.result?.status === "outcome_unknown" &&
      value.result.reconciledAtMs === null,
  };
}
