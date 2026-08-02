import { z } from "zod";

import {
  ESP_MQTT_MAX_COMMAND_PAYLOAD_BYTES,
  LEGACY_COMMANDS_PER_DEVICE_PER_BATCH,
  isSupportedEsp32PwmConfiguration,
  utf8ByteLength,
} from "./limits.js";

export * from "./limits.js";
export * from "./schedule.js";

export const CURRENT_ESP_FIRMWARE_VERSION = "5.0.4";
export const MINIMUM_SUPPORTED_ESP_FIRMWARE_VERSION = "5.0.0";
export const MINIMUM_PULL_OTA_FIRMWARE_VERSION =
  MINIMUM_SUPPORTED_ESP_FIRMWARE_VERSION;
export const ESP_FIRMWARE_ARTIFACT = {
  version: CURRENT_ESP_FIRMWARE_VERSION,
  fileName: "ESP32Code-5.0.4.bin",
  sizeBytes: 1_172_144,
  sha256: "4f1f1684d6f2fe93c7668cce2b11a56c7cb86881db08b447244f6026be30eeb7",
} as const;

export function isCurrentEspFirmwareVersion(version: string): boolean {
  return version === CURRENT_ESP_FIRMWARE_VERSION;
}

export function isSupportedEspFirmwareVersion(version: string): boolean {
  const [major] = version.split(".");
  return /^\d+$/u.test(major ?? "") && Number(major) >= 5;
}

export function supportsPullOta(version: string): boolean {
  return isSupportedEspFirmwareVersion(version);
}

export const espOtaStatusSchema = z.strictObject({
  status: z.enum([
    "idle",
    "accepted",
    "downloading",
    "verifying",
    "rebooting",
    "probation",
    "succeeded",
    "failed",
    "rolling_back",
  ]),
  targetVersion: z.string().max(31),
  progress: z.number().int().min(0).max(100),
  error: z.string().min(1).max(96).optional(),
});

export const espOutputStateSchema = z
  .array(
    z.tuple([
      z.number().int().min(0).max(63),
      z.number().int().min(0).max(100),
    ]),
  )
  .max(64)
  .superRefine((outputs, context) => {
    const pins = new Set<number>();
    for (const [index, [pin]] of outputs.entries()) {
      if (pins.has(pin)) {
        context.addIssue({
          code: "custom",
          path: [index, 0],
          message: "Reported output pins must be unique",
        });
      }
      pins.add(pin);
    }
  });

export const espFirmwareDiagnosticSchema = z.strictObject({
  code: z.string().regex(/^[a-z0-9_]{1,48}$/u),
  severity: z.enum(["warning", "error"]),
  message: z.string().min(1).max(160),
  sequence: z.number().int().min(1).max(0xffff_ffff),
  active: z.boolean(),
  at: z.number().int().min(0).max(2_147_483_647),
});

export const espAnnouncementSchema = z
  .strictObject({
    id: z.string().min(1),
    name: z.string().min(1),
    freq: z.number().int().min(1).max(40_000),
    res: z.number().int().min(1).max(16),
    status: z.string().min(1),
    version: z.string().min(1),
    scheduleHash: z.string().regex(/^\d+$/),
    outputsOff: z.boolean().optional(),
    outputs: espOutputStateSchema.optional(),
    ota: espOtaStatusSchema.optional(),
    lastError: espFirmwareDiagnosticSchema.optional(),
  })
  .superRefine((announcement, context) => {
    if (
      !isSupportedEsp32PwmConfiguration(announcement.freq, announcement.res)
    ) {
      context.addIssue({
        code: "custom",
        path: ["res"],
        message:
          "PWM frequency and resolution exceed the ESP32 LEDC source-clock limit",
      });
    }
  });

export type EspAnnouncement = z.infer<typeof espAnnouncementSchema>;

export const legacyRequestIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/u);

export const espCommandResponseSchema = z.strictObject({
  id: z.string().min(1),
  name: z.string().min(1),
  requestId: legacyRequestIdSchema,
  responses: z.array(
    z.strictObject({
      index: z.number().int().nonnegative(),
      response: z.string(),
    }),
  ),
});

export type EspCommandResponse = z.infer<typeof espCommandResponseSchema>;

export interface EspTopicSet {
  readonly command: string;
  readonly announce: string;
  readonly response: string;
}

export interface LegacyCommandBatch {
  readonly commands: readonly string[];
  readonly originalIndexes: readonly number[];
  readonly payload: string;
}

export function encodeCorrelatedLegacyRequest(
  requestId: string,
  payload: string,
): string {
  const parsedRequestId = legacyRequestIdSchema.parse(requestId);
  if (payload.length === 0 || payload.includes("\0")) {
    throw new TypeError("Legacy request payload must be non-empty text");
  }
  return `request:${parsedRequestId}|${payload}`;
}

export function createEspTopicSet(testMode: boolean): EspTopicSet {
  const prefix = testMode ? "test/aquarium" : "aquarium";

  return {
    command: `${prefix}/command`,
    announce: `${prefix}/announce`,
    response: `${prefix}/response`,
  };
}

export function encodeLegacyMessage(payload: string): string {
  if (payload.length === 0) {
    throw new TypeError("Cannot publish an empty legacy ESP payload");
  }
  if (payload.includes("\0")) {
    throw new TypeError("Legacy ESP payloads cannot contain null bytes");
  }
  const payloadBytes = utf8ByteLength(payload);
  if (payloadBytes > ESP_MQTT_MAX_COMMAND_PAYLOAD_BYTES) {
    throw new RangeError(
      `MQTT command payload is ${payloadBytes} bytes; firmware supports at most ${ESP_MQTT_MAX_COMMAND_PAYLOAD_BYTES}`,
    );
  }

  return payload;
}

export function batchLegacyCommands(
  commands: readonly string[],
): readonly LegacyCommandBatch[] {
  const batches: LegacyCommandBatch[] = [];
  let currentCommands: string[] = [];
  let currentIndexes: number[] = [];
  let deviceCounts = new Map<string, number>();

  const flush = (): void => {
    if (currentCommands.length === 0) {
      return;
    }
    batches.push({
      commands: currentCommands,
      originalIndexes: currentIndexes,
      payload: currentCommands.join(";"),
    });
    currentCommands = [];
    currentIndexes = [];
    deviceCounts = new Map<string, number>();
  };

  commands.forEach((rawCommand, originalIndex) => {
    const command = rawCommand.trim();
    if (command.length === 0 || command.includes(";")) {
      throw new TypeError(`Invalid legacy command at index ${originalIndex}`);
    }

    const [target, operation] = command.split(/\s+/, 3);
    if (target === undefined || operation === undefined) {
      throw new TypeError(
        `Legacy command at index ${originalIndex} requires a target and operation`,
      );
    }

    const targetCount = deviceCounts.get(target) ?? 0;
    if (targetCount >= LEGACY_COMMANDS_PER_DEVICE_PER_BATCH) {
      flush();
    }

    currentCommands.push(command);
    currentIndexes.push(originalIndex);
    deviceCounts.set(target, (deviceCounts.get(target) ?? 0) + 1);
  });

  flush();
  return batches;
}
