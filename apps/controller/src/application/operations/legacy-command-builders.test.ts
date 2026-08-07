import { ESP32_LEDC_SOURCE_CLOCK_HZ as CONTRACT_LEDC_SOURCE_CLOCK_HZ } from "@aquarium/contracts";
import {
  ESP32_LEDC_SOURCE_CLOCK_HZ as PROTOCOL_LEDC_SOURCE_CLOCK_HZ,
  LEGACY_LIGHT_CHANNEL_TYPE,
} from "@aquarium/esp-protocol";
import { describe, expect, it } from "vitest";

import type { LegacyDeviceTarget } from "../../infrastructure/mqtt/legacy-mqtt-transport.js";
import {
  buildAnalogReadCommand,
  buildEditConfigurationCommand,
  buildLegacyWireCommand,
  buildPingCommand,
  buildScheduleCommand,
  buildSetPwmCommand,
  buildSyncTimeCommand,
  type DeviceOperationRequest,
} from "./legacy-command-builders.js";
import { deviceOperationRequestSchema } from "./device-operation-types.js";

const target: LegacyDeviceTarget = {
  id: "A1B2C3D4",
  aliases: ["DisplayTank"],
};
const scheduleJson =
  '{"c":[{"o":12,"t":108,"l":[{"s":{"t":0,"p":0},"d":{"t":1439,"p":100}}]}],"syncTime":1752192000}';

describe("legacy command builders", () => {
  it("builds every supported operation from the shared request union", () => {
    const requests: readonly DeviceOperationRequest[] = [
      { kind: "set_pwm", pin: 12, value: 128, overwrite: true },
      { kind: "ping" },
      {
        kind: "edit_configuration",
        name: "ReefTank",
        pwmFrequencyHz: 5_000,
        pwmResolutionBits: 8,
      },
      { kind: "schedule", scheduleJson },
      { kind: "sync_time", epochSeconds: 1_752_192_000 },
      { kind: "analog_read", pin: 7 },
    ];

    expect(
      requests.map((request) => buildLegacyWireCommand(target, request)),
    ).toEqual([
      {
        command: "A1B2C3D4 s 12 128 1",
        target,
        operation: { kind: "set_pwm", pin: 12, value: 128, overwrite: true },
      },
      {
        command: "A1B2C3D4 p",
        target,
        operation: { kind: "ping" },
      },
      {
        command: "A1B2C3D4 e ReefTank 5000 8",
        target,
        operation: {
          kind: "edit_configuration",
          name: "ReefTank",
          pwmFrequencyHz: 5_000,
          pwmResolutionBits: 8,
        },
      },
      {
        command: `A1B2C3D4 sc ${scheduleJson}`,
        target,
        operation: {
          kind: "schedule",
          schedule: JSON.parse(scheduleJson),
        },
      },
      {
        command: "A1B2C3D4 sync 1752192000",
        target,
        operation: { kind: "sync_time", epochSeconds: 1_752_192_000 },
      },
      {
        command: "A1B2C3D4 r 7",
        target,
        operation: { kind: "analog_read", pin: 7 },
      },
    ]);
  });

  it("uses strict firmware bounds for PWM writes and analog reads", () => {
    expect(buildSetPwmCommand(target, 0, 0, false).command).toBe(
      "A1B2C3D4 s 0 0 0",
    );
    expect(buildSetPwmCommand(target, 63, 255, true).command).toBe(
      "A1B2C3D4 s 63 255 1",
    );
    expect(buildAnalogReadCommand(target, 0).command).toBe("A1B2C3D4 r 0");
    expect(buildAnalogReadCommand(target, 63).command).toBe("A1B2C3D4 r 63");

    for (const pin of [-1, 1.5, 64]) {
      expect(() => buildSetPwmCommand(target, pin, 1, false)).toThrow(
        /0 to 63/,
      );
      expect(() => buildAnalogReadCommand(target, pin)).toThrow(/0 to 63/);
    }
    for (const value of [-1, 1.5, 256]) {
      expect(() => buildSetPwmCommand(target, 1, value, false)).toThrow(
        /0 to 255/,
      );
    }
  });

  it("bounds editable configuration to safe EEPROM and PWM values", () => {
    expect(buildEditConfigurationCommand(target, "A", 1, 1).command).toBe(
      "A1B2C3D4 e A 1 1",
    );
    expect(
      buildEditConfigurationCommand(target, "x".repeat(31), 40_000, 10).command,
    ).toBe(`A1B2C3D4 e ${"x".repeat(31)} 40000 10`);
    expect(
      buildEditConfigurationCommand(target, "Tank", 1_220, 16).command,
    ).toBe("A1B2C3D4 e Tank 1220 16");
    expect(
      buildEditConfigurationCommand(target, "semi;colon", 5_000, 8)
        .operation,
    ).toMatchObject({ kind: "edit_configuration", name: "semi;colon" });
    expect(CONTRACT_LEDC_SOURCE_CLOCK_HZ).toBe(PROTOCOL_LEDC_SOURCE_CLOCK_HZ);

    for (const name of ["", "two words", "å", "x".repeat(32)]) {
      expect(() =>
        buildEditConfigurationCommand(target, name, 5_000, 8),
      ).toThrow(/device name/);
    }
    for (const frequency of [0, 1.5, 40_001]) {
      expect(() =>
        buildEditConfigurationCommand(target, "Tank", frequency, 8),
      ).toThrow(/frequency/);
    }
    for (const resolution of [0, 1.5, 17]) {
      expect(() =>
        buildEditConfigurationCommand(target, "Tank", 5_000, resolution),
      ).toThrow(/resolution/);
    }
    expect(() =>
      buildEditConfigurationCommand(target, "Tank", 40_000, 11),
    ).toThrow(/source-clock/);
  });

  it("accepts only canonical, strictly validated schedule documents", () => {
    expect(buildScheduleCommand(target, scheduleJson)).toMatchObject({
      command: `A1B2C3D4 sc ${scheduleJson}`,
      operation: {
        kind: "schedule",
        schedule: JSON.parse(scheduleJson),
      },
    });

    const extraFieldSchedule = JSON.stringify({
      c: [{ o: 12, t: LEGACY_LIGHT_CHANNEL_TYPE, l: [], extra: true }],
      syncTime: 1,
    });
    for (const invalidSchedule of [
      "not-json",
      ` ${scheduleJson}`,
      scheduleJson.replace('"c"', '"c":[],"c"'),
      extraFieldSchedule,
      '{"c":[],"syncTime":2147483648}',
    ]) {
      expect(() => buildScheduleCommand(target, invalidSchedule)).toThrow(
        /schedule|canonical/i,
      );
      expect(
        deviceOperationRequestSchema.safeParse({
          kind: "schedule",
          scheduleJson: invalidSchedule,
        }).success,
      ).toBe(false);
    }

    expect(
      deviceOperationRequestSchema.safeParse({
        kind: "schedule",
        scheduleJson,
      }).success,
    ).toBe(true);

    const oversizedSchedule = JSON.stringify({
      c: Array.from({ length: 64 }, (_, pin) => ({
        o: pin,
        t: LEGACY_LIGHT_CHANNEL_TYPE,
        l: Array.from({ length: 4 }, () => ({
          s: { t: 0, p: 0 },
          d: { t: 1_439, p: 100 },
        })),
      })),
      syncTime: 1,
    });
    expect(() => buildScheduleCommand(target, oversizedSchedule)).toThrow(
      /4095/,
    );
  });

  it("enforces the schedule boundary in UTF-8 bytes rather than JavaScript characters", () => {
    const multibytePayload = JSON.stringify("😀".repeat(1_100));
    expect(multibytePayload.length).toBeLessThan(4_095);
    expect(
      new TextEncoder().encode(multibytePayload).byteLength,
    ).toBeGreaterThan(4_095);
    expect(
      deviceOperationRequestSchema.safeParse({
        kind: "schedule",
        scheduleJson: multibytePayload,
      }).success,
    ).toBe(false);
  });

  it("uses the deployed signed-long-safe time-sync range", () => {
    expect(buildSyncTimeCommand(target, 1).command).toBe("A1B2C3D4 sync 1");
    expect(buildSyncTimeCommand(target, 2_147_483_647).command).toBe(
      "A1B2C3D4 sync 2147483647",
    );
    for (const epochSeconds of [0, 1.5, 2_147_483_648]) {
      expect(() => buildSyncTimeCommand(target, epochSeconds)).toThrow(
        /epoch seconds/,
      );
    }
  });

  it("rejects unsafe target tokens before creating a wire command", () => {
    expect(buildPingCommand({ id: "A1" }).command).toBe("A1 p");
    for (const id of ["", "A 1", "A;1", "Å1"]) {
      expect(() => buildPingCommand({ id })).toThrow(/target id/);
    }
    expect(() =>
      buildPingCommand({ id: "A1", aliases: ["bad alias"] }),
    ).toThrow(/target alias/);
  });
});
