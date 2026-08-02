import {
  boundedTextSchema,
  isSupportedEsp32PwmConfiguration,
  nonnegativeSafeIntegerSchema,
} from "@aquarium/contracts";
import {
  assertLegacyScheduleFits,
  legacyScheduleDocumentSchema,
  serializeLegacyScheduleDocument,
} from "@aquarium/esp-protocol";
import { z } from "zod";

export const DEVICE_OPERATION_REQUEST_SCHEMA_VERSION = 1;
export const DEVICE_OPERATION_RESULT_SCHEMA_VERSION = 1;

const setPwmRequestSchema = z.strictObject({
  kind: z.literal("set_pwm"),
  pin: z.number().int().min(0).max(63),
  value: z.number().int().min(0).max(255),
  overwrite: z.boolean(),
});

const pingRequestSchema = z.strictObject({
  kind: z.literal("ping"),
});

const editConfigurationRequestSchema = z
  .strictObject({
    kind: z.literal("edit_configuration"),
    name: z
      .string()
      .min(1)
      .max(31)
      .regex(/^[\x21-\x7e]+$/u)
      .refine((value) => !/[;\s]/u.test(value), {
        message: "Device name must be one printable wire token",
      }),
    pwmFrequencyHz: z.number().int().min(1).max(40_000),
    pwmResolutionBits: z.number().int().min(1).max(16),
  })
  .superRefine((configuration, context) => {
    if (
      !isSupportedEsp32PwmConfiguration(
        configuration.pwmFrequencyHz,
        configuration.pwmResolutionBits,
      )
    ) {
      context.addIssue({
        code: "custom",
        path: ["pwmResolutionBits"],
        message:
          "PWM frequency and resolution exceed the ESP32 LEDC source-clock limit",
      });
    }
  });

const scheduleRequestSchema = z.strictObject({
  kind: z.literal("schedule"),
  scheduleJson: z
    .string()
    .min(1)
    .superRefine((value, context) => {
      try {
        assertLegacyScheduleFits(value);
      } catch (error) {
        context.addIssue({
          code: "custom",
          message:
            error instanceof Error
              ? error.message
              : "Schedule exceeds the legacy firmware limit",
        });
        return;
      }

      let parsedJson: object;
      try {
        parsedJson = JSON.parse(value) as object;
      } catch (error) {
        context.addIssue({
          code: "custom",
          message:
            error instanceof Error
              ? `Invalid legacy schedule JSON: ${error.message}`
              : "Invalid legacy schedule JSON",
        });
        return;
      }

      const parsedSchedule = legacyScheduleDocumentSchema.safeParse(parsedJson);
      if (!parsedSchedule.success) {
        context.addIssue({
          code: "custom",
          message: `Invalid legacy schedule: ${parsedSchedule.error.message}`,
        });
        return;
      }
      const canonicalJson = serializeLegacyScheduleDocument(
        { c: parsedSchedule.data.c },
        parsedSchedule.data.syncTime,
      );
      if (value !== canonicalJson) {
        context.addIssue({
          code: "custom",
          message: "Legacy schedule JSON must use canonical wire encoding",
        });
      }
    }),
});

const syncTimeRequestSchema = z.strictObject({
  kind: z.literal("sync_time"),
  epochSeconds: z.number().int().min(1).max(2_147_483_647),
});

const analogReadRequestSchema = z.strictObject({
  kind: z.literal("analog_read"),
  pin: z.number().int().min(0).max(63),
});

const firmwareUpdateRequestSchema = z.strictObject({
  kind: z.literal("firmware_update"),
  version: z
    .string()
    .min(1)
    .max(31)
    .regex(/^[A-Za-z0-9._-]+$/u),
  url: z
    .string()
    .url()
    .max(240)
    .refine((value) => value.startsWith("http://"), {
      message: "ESP32 firmware URLs must use local HTTP",
    }),
  size: z.number().int().min(100_000).max(1_900_000),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
});

export const deviceOperationRequestSchema = z.discriminatedUnion("kind", [
  setPwmRequestSchema,
  pingRequestSchema,
  editConfigurationRequestSchema,
  scheduleRequestSchema,
  syncTimeRequestSchema,
  analogReadRequestSchema,
  firmwareUpdateRequestSchema,
]);

const succeededResultSchema = z.strictObject({
  status: z.literal("succeeded"),
  wireOperationId: boundedTextSchema,
  analogValue: z.number().int().min(0).max(4_095).nullable(),
});

const failedResultSchema = z.strictObject({
  status: z.literal("failed"),
  wireOperationId: boundedTextSchema.nullable(),
  code: boundedTextSchema,
  message: boundedTextSchema,
});

const timedOutResultSchema = z.strictObject({
  status: z.literal("timed_out"),
  reason: z.enum(["deadline_before_attempt", "controller_restart"]),
});

const outcomeUnknownResultSchema = z.strictObject({
  status: z.literal("outcome_unknown"),
  wireOperationId: boundedTextSchema.nullable(),
  reason: z.enum([
    "timeout",
    "publish_failed",
    "disconnected",
    "transport_stopped",
    "controller_restart",
    "transport_error_after_attempt",
    "persistence_failed_after_attempt",
  ]),
  reconciledAtMs: nonnegativeSafeIntegerSchema.nullable(),
});

const cancelledResultSchema = z.strictObject({
  status: z.literal("cancelled"),
  reason: z.enum([
    "controller_restart_before_attempt",
    "cancelled_by_owner",
    "device_command_cooldown",
    "device_command_in_flight",
  ]),
});

export const deviceOperationResultSchema = z.discriminatedUnion("status", [
  succeededResultSchema,
  failedResultSchema,
  timedOutResultSchema,
  outcomeUnknownResultSchema,
  cancelledResultSchema,
]);

export type DeviceOperationRequest = z.infer<
  typeof deviceOperationRequestSchema
>;
export type DeviceOperationResult = z.infer<typeof deviceOperationResultSchema>;
export type DeviceOperationTerminalStatus = DeviceOperationResult["status"];
export type DeviceOperationPriority = "interactive" | "background";

export interface DeviceOperationExecutionOptions {
  readonly priority?: DeviceOperationPriority;
}

export function assertDeviceOperationResultMatchesRequest(
  request: DeviceOperationRequest,
  result: DeviceOperationResult,
): void {
  if (result.status !== "succeeded") {
    return;
  }
  const expectsAnalogValue = request.kind === "analog_read";
  if (expectsAnalogValue !== (result.analogValue !== null)) {
    throw new TypeError(
      expectsAnalogValue
        ? "A successful analog_read result requires an analog value"
        : "Only a successful analog_read result may contain an analog value",
    );
  }
}
