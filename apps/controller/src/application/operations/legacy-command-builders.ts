import { isSupportedEsp32PwmConfiguration } from "@aquarium/contracts";
import {
  LEGACY_MAX_SYNC_TIME,
  legacyScheduleDocumentSchema,
  serializeLegacyScheduleDocument,
  type EspCommandInput,
} from "@aquarium/esp-protocol";

import type {
  LegacyDeviceTarget,
  LegacyWireCommand,
} from "../../infrastructure/mqtt/legacy-mqtt-transport.js";
import type { DeviceOperationRequest } from "./device-operation-types.js";

const MIN_PIN = 0;
const MAX_PIN = 63;
const MIN_PWM_VALUE = 0;
const MAX_PWM_VALUE = 255;
const MIN_PWM_FREQUENCY_HZ = 1;
const MAX_PWM_FREQUENCY_HZ = 40_000;
const MIN_PWM_RESOLUTION_BITS = 1;
const MAX_PWM_RESOLUTION_BITS = 16;
const MAX_DEVICE_NAME_BYTES = 31;

export type { DeviceOperationRequest } from "./device-operation-types.js";

export function buildLegacyWireCommand(
  target: LegacyDeviceTarget,
  request: DeviceOperationRequest,
): LegacyWireCommand {
  switch (request.kind) {
    case "set_pwm":
      return buildSetPwmCommand(
        target,
        request.pin,
        request.value,
        request.overwrite,
      );
    case "ping":
      return buildPingCommand(target);
    case "edit_configuration":
      return buildEditConfigurationCommand(
        target,
        request.name,
        request.pwmFrequencyHz,
        request.pwmResolutionBits,
      );
    case "schedule":
      return buildScheduleCommand(target, request.scheduleJson);
    case "sync_time":
      return buildSyncTimeCommand(target, request.epochSeconds);
    case "analog_read":
      return buildAnalogReadCommand(target, request.pin);
    case "firmware_update":
      return buildFirmwareUpdateCommand(
        target,
        request.version,
        request.url,
        request.size,
        request.sha256,
      );
  }
}

export function buildSetPwmCommand(
  target: LegacyDeviceTarget,
  pin: number,
  value: number,
  overwrite: boolean,
): LegacyWireCommand {
  assertIntegerInRange(pin, MIN_PIN, MAX_PIN, "PWM pin");
  // Firmware 4.1.0 interprets this wire value as normalized 8-bit duty and
  // scales it to the device's configured LEDC resolution.
  assertIntegerInRange(value, MIN_PWM_VALUE, MAX_PWM_VALUE, "PWM value");
  const overwriteFlag = overwrite ? 1 : 0;
  const operation = `s ${pin} ${value} ${overwriteFlag}`;
  return command(target, operation, {
    kind: "set_pwm",
    pin,
    value,
    overwrite,
  });
}

export function buildPingCommand(
  target: LegacyDeviceTarget,
): LegacyWireCommand {
  return command(target, "p", { kind: "ping" });
}

export function buildEditConfigurationCommand(
  target: LegacyDeviceTarget,
  name: string,
  pwmFrequencyHz: number,
  pwmResolutionBits: number,
): LegacyWireCommand {
  assertDeviceName(name);
  assertIntegerInRange(
    pwmFrequencyHz,
    MIN_PWM_FREQUENCY_HZ,
    MAX_PWM_FREQUENCY_HZ,
    "PWM frequency",
  );
  assertIntegerInRange(
    pwmResolutionBits,
    MIN_PWM_RESOLUTION_BITS,
    MAX_PWM_RESOLUTION_BITS,
    "PWM resolution",
  );
  if (!isSupportedEsp32PwmConfiguration(pwmFrequencyHz, pwmResolutionBits)) {
    throw new RangeError(
      "PWM frequency and resolution exceed the ESP32 LEDC source-clock limit",
    );
  }
  return command(target, `e ${name} ${pwmFrequencyHz} ${pwmResolutionBits}`, {
    kind: "edit_configuration",
    name,
    pwmFrequencyHz,
    pwmResolutionBits,
  });
}

export function buildScheduleCommand(
  target: LegacyDeviceTarget,
  scheduleJson: string,
): LegacyWireCommand {
  const parsedJson = parseJson(scheduleJson);
  const parsedSchedule = legacyScheduleDocumentSchema.safeParse(parsedJson);
  if (!parsedSchedule.success) {
    throw new TypeError(
      `Invalid legacy schedule: ${parsedSchedule.error.message}`,
    );
  }
  assertIntegerInRange(
    parsedSchedule.data.syncTime,
    1,
    LEGACY_MAX_SYNC_TIME,
    "Schedule sync time",
  );
  const canonicalJson = serializeLegacyScheduleDocument(
    { c: parsedSchedule.data.c },
    parsedSchedule.data.syncTime,
  );
  if (scheduleJson !== canonicalJson) {
    throw new TypeError(
      "Legacy schedule JSON must use canonical wire encoding",
    );
  }
  return command(target, `sc ${canonicalJson}`, {
    kind: "schedule",
    schedule: parsedSchedule.data,
  });
}

export function buildSyncTimeCommand(
  target: LegacyDeviceTarget,
  epochSeconds: number,
): LegacyWireCommand {
  assertIntegerInRange(
    epochSeconds,
    1,
    LEGACY_MAX_SYNC_TIME,
    "Sync epoch seconds",
  );
  return command(target, `sync ${epochSeconds}`, {
    kind: "sync_time",
    epochSeconds,
  });
}

export function buildAnalogReadCommand(
  target: LegacyDeviceTarget,
  pin: number,
): LegacyWireCommand {
  assertIntegerInRange(pin, MIN_PIN, MAX_PIN, "Analog-read pin");
  return command(target, `r ${pin}`, { kind: "analog_read", pin });
}

export function buildFirmwareUpdateCommand(
  target: LegacyDeviceTarget,
  version: string,
  url: string,
  size: number,
  sha256: string,
): LegacyWireCommand {
  assertWireToken(version, "firmware version", 31);
  assertIntegerInRange(size, 100_000, 1_900_000, "firmware image size");
  if (!/^http:\/\/\S+$/u.test(url) || url.length > 240) {
    throw new TypeError(
      "Firmware URL must be a local HTTP URL without whitespace",
    );
  }
  if (!/^[a-f0-9]{64}$/u.test(sha256)) {
    throw new TypeError("Firmware SHA-256 must be lowercase hexadecimal");
  }
  return command(
    target,
    `ota ${version} ${size} ${sha256} ${url}`,
    {
      kind: "firmware_update",
      version,
      url,
      size,
      sha256,
    },
  );
}

function command(
  target: LegacyDeviceTarget,
  operation: string,
  structuredOperation: EspCommandInput,
): LegacyWireCommand {
  assertWireToken(target.id, "target id");
  for (const alias of target.aliases ?? []) {
    assertWireToken(alias, "target alias");
  }
  return {
    command: `${target.id} ${operation}`,
    target: {
      id: target.id,
      ...(target.aliases === undefined ? {} : { aliases: [...target.aliases] }),
    },
    operation: structuredOperation,
  };
}

function assertDeviceName(name: string): void {
  const bytes = new TextEncoder().encode(name);
  const printable = [...name].every((character) => {
    const code = character.charCodeAt(0);
    return code >= 33 && code <= 126;
  });
  if (name.length === 0 || !printable || bytes.byteLength > MAX_DEVICE_NAME_BYTES) {
    throw new TypeError(
      `device name must be a non-empty printable ASCII token up to ${MAX_DEVICE_NAME_BYTES} bytes`,
    );
  }
}

function assertWireToken(
  value: string,
  description: string,
  maximumBytes?: number,
): void {
  const bytes = new TextEncoder().encode(value);
  const validCharacters = [...value].every((character) => {
    const code = character.charCodeAt(0);
    return code >= 33 && code <= 126 && character !== ";";
  });
  if (
    value.length === 0 ||
    !validCharacters ||
    (maximumBytes !== undefined && bytes.byteLength > maximumBytes)
  ) {
    const limit =
      maximumBytes === undefined ? "" : ` up to ${maximumBytes} bytes`;
    throw new TypeError(
      `${description} must be a non-empty printable ASCII token${limit}`,
    );
  }
}

function assertIntegerInRange(
  value: number,
  minimum: number,
  maximum: number,
  description: string,
): void {
  if (!Number.isSafeInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(
      `${description} must be an integer from ${minimum} to ${maximum}`,
    );
  }
}

type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

function parseJson(value: string): JsonValue {
  try {
    return JSON.parse(value) as JsonValue;
  } catch (error) {
    throw new TypeError(
      `Invalid legacy schedule JSON: ${error instanceof Error ? error.message : String(error)}`,
      { cause: error },
    );
  }
}
