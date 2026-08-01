import { z } from "zod";

import {
  mutationResultSchema,
  operationSummarySchema,
  overrideSchema,
} from "./controller.js";
import {
  identifierSchema,
  nonnegativeSafeIntegerSchema,
  percentageSchema,
} from "./primitives.js";

export const manualOverrideTargetSchema = z.discriminatedUnion("targetType", [
  z.strictObject({
    targetType: z.literal("channel"),
    targetId: identifierSchema,
  }),
  z.strictObject({
    targetType: z.literal("output"),
    targetId: identifierSchema,
  }),
]);

export const manualOverrideParamsSchema = z.strictObject({
  overrideId: identifierSchema,
});

export const manualOverrideDurationSecondsSchema = z
  .number()
  .int()
  .min(60)
  .max(600);

export const startManualOverrideRequestSchema = z.strictObject({
  expectedRevision: nonnegativeSafeIntegerSchema,
  replaceOverrideId: identifierSchema.optional(),
  target: manualOverrideTargetSchema,
  valuePercentage: percentageSchema,
  durationSeconds: manualOverrideDurationSecondsSchema,
});

export const extendManualOverrideRequestSchema = z.strictObject({
  expectedRevision: nonnegativeSafeIntegerSchema,
});

export const cancelManualOverrideRequestSchema = z.strictObject({
  expectedRevision: nonnegativeSafeIntegerSchema,
});

export const reconcileManualOverrideRequestSchema = z.strictObject({
  expectedRevision: nonnegativeSafeIntegerSchema,
});

export const manualOverrideCommandResponseSchema = z
  .strictObject({
    override: overrideSchema,
    operation: operationSummarySchema,
    mutation: mutationResultSchema,
  })
  .superRefine((response, context) => {
    if (!response.mutation.changed) {
      context.addIssue({
        code: "custom",
        path: ["mutation", "changed"],
        message: "Manual override commands must commit a state change",
      });
    }
    if (response.override.operationId !== response.operation.id) {
      context.addIssue({
        code: "custom",
        path: ["override", "operationId"],
        message: "Manual override must reference the returned operation",
      });
    }
  });

export const manualOverrideStateResponseSchema = z.strictObject({
  override: overrideSchema,
  mutation: mutationResultSchema,
});

export type ManualOverrideTarget = z.infer<typeof manualOverrideTargetSchema>;
export type StartManualOverrideRequest = z.infer<
  typeof startManualOverrideRequestSchema
>;
export type ExtendManualOverrideRequest = z.infer<
  typeof extendManualOverrideRequestSchema
>;
export type CancelManualOverrideRequest = z.infer<
  typeof cancelManualOverrideRequestSchema
>;
export type ReconcileManualOverrideRequest = z.infer<
  typeof reconcileManualOverrideRequestSchema
>;
export type ManualOverrideCommandResponse = z.infer<
  typeof manualOverrideCommandResponseSchema
>;
export type ManualOverrideStateResponse = z.infer<
  typeof manualOverrideStateResponseSchema
>;
