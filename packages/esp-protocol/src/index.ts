import { z } from "zod";
import { hardwareProfileIdSchema } from "@aquarium/contracts";

import {
  ESP_COMMANDS_PER_REQUEST,
  ESP_MQTT_MAX_COMMAND_PAYLOAD_BYTES,
  LEGACY_SCHEDULE_BYTES,
  isSupportedEsp32PwmConfiguration,
  utf8ByteLength,
} from "./limits.js";
import { legacyScheduleDocumentSchema } from "./schedule.js";

export * from "./limits.js";
export * from "./schedule.js";

export const CURRENT_ESP_FIRMWARE_VERSION = "6.0.0";
export const MINIMUM_SUPPORTED_ESP_FIRMWARE_VERSION = "6.0.0";
export const MINIMUM_PULL_OTA_FIRMWARE_VERSION =
  MINIMUM_SUPPORTED_ESP_FIRMWARE_VERSION;
export const ESP_MQTT_PROTOCOL_VERSION = 1 as const;
export const ESP_FIRMWARE_ARTIFACT = {
  version: CURRENT_ESP_FIRMWARE_VERSION,
  fileName: "ESP32Code-6.0.0.bin",
  sizeBytes: 1_192_720,
  sha256: "422d1ec248b0677efd8fcb3167407f6c68f5055745ecf75e35ead1d542237636",
} as const;

export function isCurrentEspFirmwareVersion(version: string): boolean {
  return version === CURRENT_ESP_FIRMWARE_VERSION;
}

export function isSupportedEspFirmwareVersion(version: string): boolean {
  const [major] = version.split(".");
  return /^\d+$/u.test(major ?? "") && Number(major) === 6;
}

export function supportsPullOta(version: string): boolean {
  return isSupportedEspFirmwareVersion(version);
}

export const espDeviceIdSchema = z
  .string()
  .min(1)
  .max(128)
  .regex(/^[A-Za-z0-9][A-Za-z0-9_-]*$/u);

export const espRequestIdSchema = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/u);

export const espDeviceNameSchema = z.string().regex(/^[!-~]{1,31}$/u);

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

const announcementFields = {
  id: espDeviceIdSchema,
  name: espDeviceNameSchema,
  freq: z.number().int().min(1).max(40_000),
  res: z.number().int().min(1).max(16),
  status: z.literal("online"),
  version: z.string().regex(/^[A-Za-z0-9._-]{1,31}$/u),
  hardwareProfile: hardwareProfileIdSchema.optional(),
  hardwareModel: z.string().regex(/^[\x20-\x7e]{1,256}$/u).optional(),
  scheduleHash: z.string().regex(/^\d+$/u),
  outputsOff: z.boolean().optional(),
  outputs: espOutputStateSchema.optional(),
  ota: espOtaStatusSchema.optional(),
  lastError: espFirmwareDiagnosticSchema.optional(),
  diagnosticStorageHealthy: z.boolean().optional(),
} as const;

const currentAnnouncementSchema = z.strictObject({
  protocolVersion: z.literal(ESP_MQTT_PROTOCOL_VERSION),
  ...announcementFields,
});
const legacyAnnouncementSchema = z.strictObject(announcementFields);

export const espAnnouncementSchema = z
  .union([currentAnnouncementSchema, legacyAnnouncementSchema])
  .transform((announcement) =>
    "protocolVersion" in announcement
      ? announcement
      : { ...announcement, protocolVersion: 0 as const },
  )
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

const commandIndexSchema = z
  .number()
  .int()
  .min(0)
  .max(ESP_COMMANDS_PER_REQUEST - 1);

const setPwmCommandSchema = z.strictObject({
  index: commandIndexSchema,
  kind: z.literal("set_pwm"),
  pin: z.number().int().min(0).max(63),
  value: z.number().int().min(0).max(255),
  overwrite: z.boolean(),
});
const pingCommandSchema = z.strictObject({
  index: commandIndexSchema,
  kind: z.literal("ping"),
});
const editConfigurationCommandSchema = z.strictObject({
  index: commandIndexSchema,
  kind: z.literal("edit_configuration"),
  name: espDeviceNameSchema,
  pwmFrequencyHz: z.number().int().min(1).max(40_000),
  pwmResolutionBits: z.number().int().min(1).max(16),
});
const wireScheduleDocumentSchema = legacyScheduleDocumentSchema.refine(
  (schedule) => utf8ByteLength(JSON.stringify(schedule)) <= LEGACY_SCHEDULE_BYTES,
  `Schedule JSON must fit within ${LEGACY_SCHEDULE_BYTES} UTF-8 bytes`,
);
const scheduleCommandSchema = z.strictObject({
  index: commandIndexSchema,
  kind: z.literal("schedule"),
  schedule: wireScheduleDocumentSchema,
});
const syncTimeCommandSchema = z.strictObject({
  index: commandIndexSchema,
  kind: z.literal("sync_time"),
  epochSeconds: z.number().int().min(1).max(2_147_483_647),
});
const analogReadCommandSchema = z.strictObject({
  index: commandIndexSchema,
  kind: z.literal("analog_read"),
  pin: z.number().int().min(0).max(63),
});
const firmwareUpdateCommandSchema = z.strictObject({
  index: commandIndexSchema,
  kind: z.literal("firmware_update"),
  version: z.string().min(1).max(31).regex(/^[A-Za-z0-9._-]+$/u),
  url: z.string().url().max(240).refine((value) => value.startsWith("http://"), {
    message: "ESP32 firmware URLs must use local HTTP",
  }),
  size: z.number().int().min(100_000).max(1_900_000),
  sha256: z.string().regex(/^[a-f0-9]{64}$/u),
});

export const espCommandSchema = z.discriminatedUnion("kind", [
  setPwmCommandSchema,
  pingCommandSchema,
  editConfigurationCommandSchema,
  scheduleCommandSchema,
  syncTimeCommandSchema,
  analogReadCommandSchema,
  firmwareUpdateCommandSchema,
]);
export type EspCommand = z.infer<typeof espCommandSchema>;
export type EspCommandKind = EspCommand["kind"];
export type EspCommandInput = EspCommand extends infer Command
  ? Command extends { readonly index: number }
    ? Omit<Command, "index">
    : never
  : never;

export const espCommandRequestSchema = z
  .strictObject({
    protocolVersion: z.literal(ESP_MQTT_PROTOCOL_VERSION),
    deviceId: espDeviceIdSchema,
    requestId: espRequestIdSchema,
    commands: z
      .array(espCommandSchema)
      .min(1)
      .max(ESP_COMMANDS_PER_REQUEST),
  })
  .superRefine((request, context) => {
    request.commands.forEach((command, index) => {
      if (command.index !== index) {
        context.addIssue({
          code: "custom",
          path: ["commands", index, "index"],
          message: "Command indexes must be contiguous and zero-based",
        });
      }
    });
  });
export type EspCommandRequest = z.infer<typeof espCommandRequestSchema>;

const resultBase = {
  index: commandIndexSchema,
  ok: z.literal(true),
} as const;
const successfulResultSchemas = [
  z.strictObject({ ...resultBase, kind: z.literal("ping") }),
  z.strictObject({
    ...resultBase,
    kind: z.literal("set_pwm"),
    pin: z.number().int().min(0).max(63),
    value: z.number().int().min(0).max(255),
    overwrite: z.boolean(),
  }),
  z.strictObject({
    ...resultBase,
    kind: z.literal("edit_configuration"),
    name: espDeviceNameSchema,
    pwmFrequencyHz: z.number().int().min(1).max(40_000),
    pwmResolutionBits: z.number().int().min(1).max(16),
  }),
  z.strictObject({ ...resultBase, kind: z.literal("schedule") }),
  z.strictObject({
    ...resultBase,
    kind: z.literal("sync_time"),
    epochSeconds: z.number().int().min(1).max(2_147_483_647),
  }),
  z.strictObject({
    ...resultBase,
    kind: z.literal("analog_read"),
    pin: z.number().int().min(0).max(63),
    value: z.number().int().min(0).max(4_095),
  }),
  z.strictObject({
    ...resultBase,
    kind: z.literal("firmware_update"),
    status: z.literal("accepted"),
  }),
] as const;

export const espCommandErrorSchema = z.strictObject({
  code: z.string().regex(/^[a-z0-9_]{1,48}$/u),
  message: z.string().min(1).max(160),
});
const failedResultSchema = z.strictObject({
  index: commandIndexSchema,
  kind: z.enum([
    "set_pwm",
    "ping",
    "edit_configuration",
    "schedule",
    "sync_time",
    "analog_read",
    "firmware_update",
  ]),
  ok: z.literal(false),
  error: espCommandErrorSchema,
});

export const espCommandResultSchema = z.union([
  ...successfulResultSchemas,
  failedResultSchema,
]);
export type EspCommandResult = z.infer<typeof espCommandResultSchema>;

export const espCommandResponseSchema = z
  .strictObject({
    protocolVersion: z.literal(ESP_MQTT_PROTOCOL_VERSION),
    deviceId: espDeviceIdSchema,
    name: espDeviceNameSchema,
    requestId: espRequestIdSchema,
    results: z
      .array(espCommandResultSchema)
      .min(1)
      .max(ESP_COMMANDS_PER_REQUEST),
  })
  .superRefine((response, context) => {
    const indexes = new Set<number>();
    for (const [arrayIndex, result] of response.results.entries()) {
      if (indexes.has(result.index)) {
        context.addIssue({
          code: "custom",
          path: ["results", arrayIndex, "index"],
          message: "Command result indexes must be unique",
        });
      }
      indexes.add(result.index);
    }
  });
export type EspCommandResponse = z.infer<typeof espCommandResponseSchema>;

export const espDiscoveryRequestSchema = z.strictObject({
  protocolVersion: z.literal(ESP_MQTT_PROTOCOL_VERSION),
  kind: z.literal("discover"),
});

export type EspCommandResultMatch =
  | { readonly status: "succeeded"; readonly analogValue: number | null }
  | {
      readonly status: "device_error";
      readonly code: string;
      readonly message: string;
    }
  | { readonly status: "protocol_error"; readonly detail: string };

export function matchEspCommandResult(
  command: EspCommand,
  result: EspCommandResult,
): EspCommandResultMatch {
  if (result.index !== command.index || result.kind !== command.kind) {
    return {
      status: "protocol_error",
      detail: `Expected ${command.kind} result at index ${command.index}`,
    };
  }
  if (!result.ok) {
    return {
      status: "device_error",
      code: result.error.code,
      message: result.error.message,
    };
  }

  switch (command.kind) {
    case "ping":
    case "schedule":
      return { status: "succeeded", analogValue: null };
    case "set_pwm":
      return result.kind === command.kind &&
        result.pin === command.pin &&
        result.value === command.value &&
        result.overwrite === command.overwrite
        ? { status: "succeeded", analogValue: null }
        : mismatchedResult(command.kind);
    case "edit_configuration":
      return result.kind === command.kind &&
        result.name === command.name &&
        result.pwmFrequencyHz === command.pwmFrequencyHz &&
        result.pwmResolutionBits === command.pwmResolutionBits
        ? { status: "succeeded", analogValue: null }
        : mismatchedResult(command.kind);
    case "sync_time":
      return result.kind === command.kind &&
        result.epochSeconds === command.epochSeconds
        ? { status: "succeeded", analogValue: null }
        : mismatchedResult(command.kind);
    case "analog_read":
      return result.kind === command.kind && result.pin === command.pin
        ? { status: "succeeded", analogValue: result.value }
        : mismatchedResult(command.kind);
    case "firmware_update":
      return result.kind === command.kind && result.status === "accepted"
        ? { status: "succeeded", analogValue: null }
        : mismatchedResult(command.kind);
  }
}

export interface EspTopicSet {
  readonly namespace: string;
  readonly discoveryRequest: string;
  readonly announcementFilter: string;
  readonly responseFilter: string;
  readonly legacyCommand: string;
  readonly legacyAnnouncement: string;
  command(deviceId: string): string;
  announcement(deviceId: string): string;
  response(deviceId: string): string;
  announcementDeviceId(topic: string): string | null;
  responseDeviceId(topic: string): string | null;
}

export function createEspTopicSet(testMode: boolean): EspTopicSet {
  const namespace = testMode ? "test/aquarium" : "aquarium";
  return createEspTopicSetForNamespace(namespace);
}

export function createEspTopicSetForNamespace(namespace: string): EspTopicSet {
  if (
    namespace.length === 0 ||
    namespace.includes("\0") ||
    namespace.includes("+") ||
    namespace.includes("#") ||
    namespace.split("/").some((segment) => segment.length === 0)
  ) {
    throw new TypeError("MQTT namespace must contain explicit non-empty segments");
  }
  const protocolRoot = `${namespace}/v1`;
  const deviceRoot = `${protocolRoot}/devices`;
  const topicFor = (deviceId: string, kind: "command" | "announce" | "response"): string =>
    `${deviceRoot}/${espDeviceIdSchema.parse(deviceId)}/${kind}`;
  return {
    namespace,
    discoveryRequest: `${protocolRoot}/discovery/request`,
    announcementFilter: `${deviceRoot}/+/announce`,
    responseFilter: `${deviceRoot}/+/response`,
    legacyCommand: `${namespace}/command`,
    legacyAnnouncement: `${namespace}/announce`,
    command: (deviceId) => topicFor(deviceId, "command"),
    announcement: (deviceId) => topicFor(deviceId, "announce"),
    response: (deviceId) => topicFor(deviceId, "response"),
    announcementDeviceId: (topic) =>
      parseDeviceTopic(topic, deviceRoot, "announce"),
    responseDeviceId: (topic) =>
      parseDeviceTopic(topic, deviceRoot, "response"),
  };
}

export function encodeEspDiscoveryRequest(): string {
  return JSON.stringify(
    espDiscoveryRequestSchema.parse({
      protocolVersion: ESP_MQTT_PROTOCOL_VERSION,
      kind: "discover",
    }),
  );
}

export function encodeEspCommandRequest(input: {
  readonly deviceId: string;
  readonly requestId: string;
  readonly commands: readonly EspCommand[];
}): string {
  const request = espCommandRequestSchema.parse({
    protocolVersion: ESP_MQTT_PROTOCOL_VERSION,
    deviceId: input.deviceId,
    requestId: input.requestId,
    commands: input.commands,
  });
  const payload = JSON.stringify(request);
  const payloadBytes = utf8ByteLength(payload);
  if (payloadBytes > ESP_MQTT_MAX_COMMAND_PAYLOAD_BYTES) {
    throw new RangeError(
      `MQTT command payload is ${payloadBytes} bytes; firmware supports at most ${ESP_MQTT_MAX_COMMAND_PAYLOAD_BYTES}`,
    );
  }
  return payload;
}

function mismatchedResult(kind: EspCommandKind): EspCommandResultMatch {
  return {
    status: "protocol_error",
    detail: `Successful ${kind} result did not echo the accepted values`,
  };
}

function parseDeviceTopic(
  topic: string,
  deviceRoot: string,
  kind: "announce" | "response",
): string | null {
  const prefix = `${deviceRoot}/`;
  const suffix = `/${kind}`;
  if (!topic.startsWith(prefix) || !topic.endsWith(suffix)) {
    return null;
  }
  const deviceId = topic.slice(prefix.length, -suffix.length);
  return espDeviceIdSchema.safeParse(deviceId).success ? deviceId : null;
}
