export const FAKE_ESP_MQTT_PROTOCOL_VERSION = 1 as const;
export const FAKE_ESP_COMMANDS_PER_REQUEST = 3;
export const FAKE_ESP_SCHEDULE_BYTES = 4_095;

type JsonValue =
  | null
  | boolean
  | number
  | string
  | JsonValue[]
  | { [key: string]: JsonValue };

export type FakeEspCommand =
  | {
      readonly index: number;
      readonly kind: "set_pwm";
      readonly pin: number;
      readonly value: number;
      readonly overwrite: boolean;
    }
  | { readonly index: number; readonly kind: "ping" }
  | {
      readonly index: number;
      readonly kind: "edit_configuration";
      readonly name: string;
      readonly pwmFrequencyHz: number;
      readonly pwmResolutionBits: number;
    }
  | {
      readonly index: number;
      readonly kind: "schedule";
      readonly schedule: { readonly [key: string]: JsonValue };
    }
  | {
      readonly index: number;
      readonly kind: "sync_time";
      readonly epochSeconds: number;
    }
  | {
      readonly index: number;
      readonly kind: "analog_read";
      readonly pin: number;
    }
  | {
      readonly index: number;
      readonly kind: "firmware_update";
      readonly version: string;
      readonly url: string;
      readonly size: number;
      readonly sha256: string;
    };

export interface FakeEspCommandRequest {
  readonly protocolVersion: 1;
  readonly deviceId: string;
  readonly requestId: string;
  readonly commands: readonly FakeEspCommand[];
}

export type FakeEspCommandResult =
  | {
      readonly index: number;
      readonly kind: FakeEspCommand["kind"];
      readonly ok: false;
      readonly error: { readonly code: string; readonly message: string };
    }
  | ({ readonly index: number; readonly kind: "ping"; readonly ok: true })
  | ({
      readonly index: number;
      readonly kind: "set_pwm";
      readonly ok: true;
      readonly pin: number;
      readonly value: number;
      readonly overwrite: boolean;
    })
  | ({
      readonly index: number;
      readonly kind: "edit_configuration";
      readonly ok: true;
      readonly name: string;
      readonly pwmFrequencyHz: number;
      readonly pwmResolutionBits: number;
    })
  | ({ readonly index: number; readonly kind: "schedule"; readonly ok: true })
  | ({
      readonly index: number;
      readonly kind: "sync_time";
      readonly ok: true;
      readonly epochSeconds: number;
    })
  | ({
      readonly index: number;
      readonly kind: "analog_read";
      readonly ok: true;
      readonly pin: number;
      readonly value: number;
    })
  | ({
      readonly index: number;
      readonly kind: "firmware_update";
      readonly ok: true;
      readonly status: "accepted";
    });

export function parseFakeEspDiscoveryRequest(payload: string): boolean {
  const value = parseJson(payload);
  return (
    isRecord(value) &&
    hasExactKeys(value, ["protocolVersion", "kind"]) &&
    value.protocolVersion === FAKE_ESP_MQTT_PROTOCOL_VERSION &&
    value.kind === "discover"
  );
}

export function parseFakeEspCommandRequest(
  payload: string,
): FakeEspCommandRequest | undefined {
  const value = parseJson(payload);
  if (
    !isRecord(value) ||
    !hasExactKeys(value, [
      "protocolVersion",
      "deviceId",
      "requestId",
      "commands",
    ]) ||
    value.protocolVersion !== FAKE_ESP_MQTT_PROTOCOL_VERSION ||
    !validToken(value.deviceId, 128) ||
    !validToken(value.requestId, 64) ||
    !Array.isArray(value.commands) ||
    value.commands.length < 1 ||
    value.commands.length > FAKE_ESP_COMMANDS_PER_REQUEST
  ) {
    return undefined;
  }
  const commands: FakeEspCommand[] = [];
  for (const [index, candidate] of value.commands.entries()) {
    const command = parseCommand(candidate, index);
    if (command === undefined) return undefined;
    commands.push(command);
  }
  return {
    protocolVersion: FAKE_ESP_MQTT_PROTOCOL_VERSION,
    deviceId: value.deviceId,
    requestId: value.requestId,
    commands,
  };
}

export function encodeFakeEspCommandRequest(input: {
  readonly deviceId: string;
  readonly requestId: string;
  readonly commands: readonly FakeEspCommand[];
}): string {
  const payload = JSON.stringify({
    protocolVersion: FAKE_ESP_MQTT_PROTOCOL_VERSION,
    ...input,
  });
  if (parseFakeEspCommandRequest(payload) === undefined) {
    throw new TypeError("Fake ESP harness request is invalid");
  }
  return payload;
}

function parseCommand(value: JsonValue, expectedIndex: number): FakeEspCommand | undefined {
  if (
    !isRecord(value) ||
    value.index !== expectedIndex ||
    typeof value.kind !== "string"
  ) {
    return undefined;
  }
  switch (value.kind) {
    case "ping":
      return hasExactKeys(value, ["index", "kind"])
        ? { index: expectedIndex, kind: value.kind }
        : undefined;
    case "set_pwm":
      return hasExactKeys(value, ["index", "kind", "pin", "value", "overwrite"]) &&
        integerInRange(value.pin, 0, 63) &&
        integerInRange(value.value, 0, 255) &&
        typeof value.overwrite === "boolean"
        ? {
            index: expectedIndex,
            kind: value.kind,
            pin: value.pin,
            value: value.value,
            overwrite: value.overwrite,
          }
        : undefined;
    case "edit_configuration":
      return hasExactKeys(value, [
        "index",
        "kind",
        "name",
        "pwmFrequencyHz",
        "pwmResolutionBits",
      ]) &&
        typeof value.name === "string" &&
        /^[!-~]{1,31}$/u.test(value.name) &&
        integerInRange(value.pwmFrequencyHz, 1, 40_000) &&
        integerInRange(value.pwmResolutionBits, 1, 16)
        ? {
            index: expectedIndex,
            kind: value.kind,
            name: value.name,
            pwmFrequencyHz: value.pwmFrequencyHz,
            pwmResolutionBits: value.pwmResolutionBits,
          }
        : undefined;
    case "schedule":
      return hasExactKeys(value, ["index", "kind", "schedule"]) &&
        isRecord(value.schedule) &&
        new TextEncoder().encode(JSON.stringify(value.schedule)).byteLength <=
          FAKE_ESP_SCHEDULE_BYTES
        ? { index: expectedIndex, kind: value.kind, schedule: value.schedule }
        : undefined;
    case "sync_time":
      return hasExactKeys(value, ["index", "kind", "epochSeconds"]) &&
        integerInRange(value.epochSeconds, 1, 2_147_483_647)
        ? {
            index: expectedIndex,
            kind: value.kind,
            epochSeconds: value.epochSeconds,
          }
        : undefined;
    case "analog_read":
      return hasExactKeys(value, ["index", "kind", "pin"]) &&
        integerInRange(value.pin, 0, 63)
        ? { index: expectedIndex, kind: value.kind, pin: value.pin }
        : undefined;
    case "firmware_update":
      return hasExactKeys(value, [
        "index",
        "kind",
        "version",
        "url",
        "size",
        "sha256",
      ]) &&
        typeof value.version === "string" &&
        /^[A-Za-z0-9._-]{1,31}$/u.test(value.version) &&
        typeof value.url === "string" &&
        value.url.startsWith("http://") &&
        value.url.length <= 240 &&
        !/\s/u.test(value.url) &&
        integerInRange(value.size, 100_000, 1_900_000) &&
        typeof value.sha256 === "string" &&
        /^[a-f0-9]{64}$/u.test(value.sha256)
        ? {
            index: expectedIndex,
            kind: value.kind,
            version: value.version,
            url: value.url,
            size: value.size,
            sha256: value.sha256,
          }
        : undefined;
  }
  return undefined;
}

function parseJson(payload: string): JsonValue | undefined {
  try {
    return JSON.parse(payload) as JsonValue;
  } catch {
    return undefined;
  }
}

function isRecord(value: JsonValue | undefined): value is { [key: string]: JsonValue } {
  return value !== undefined && value !== null && typeof value === "object" && !Array.isArray(value);
}

function hasExactKeys(
  value: { readonly [key: string]: JsonValue },
  keys: readonly string[],
): boolean {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every((key) => key in value);
}

function validToken(
  value: JsonValue | undefined,
  maximumLength: number,
): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= maximumLength &&
    /^[A-Za-z0-9_-]+$/u.test(value)
  );
}

function integerInRange(
  value: JsonValue | undefined,
  minimum: number,
  maximum: number,
): value is number {
  return Number.isInteger(value) && Number(value) >= minimum && Number(value) <= maximum;
}
