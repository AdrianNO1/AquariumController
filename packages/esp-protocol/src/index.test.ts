import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import {
  hardwareProfileById,
  NODEMCU_ESP32S_V1_1_HARDWARE_MODEL,
  NODEMCU_ESP32S_V1_1_HARDWARE_PROFILE_ID,
} from "@aquarium/contracts";
import { describe, expect, it } from "vitest";

import {
  assertLegacyScheduleFits,
  createEspTopicSet,
  createEspTopicSetForNamespace,
  CURRENT_ESP_FIRMWARE_VERSION,
  encodeEspCommandRequest,
  encodeEspDiscoveryRequest,
  ESP_FIRMWARE_ARTIFACT,
  ESP_MQTT_PROTOCOL_VERSION,
  ESP32_PWM_OVERWRITE_DURATION_MS,
  espAnnouncementSchema,
  espCommandRequestSchema,
  espCommandResponseSchema,
  isCurrentEspFirmwareVersion,
  isSupportedEsp32PwmConfiguration,
  isSupportedEspFirmwareVersion,
  matchEspCommandResult,
  MINIMUM_SUPPORTED_ESP_FIRMWARE_VERSION,
  supportsPullOta,
  supportsSmoothOta,
} from "./index.js";

const baseAnnouncement = {
  id: "A1",
  name: "Main",
  freq: 5_000,
  res: 8,
  status: "online",
  version: CURRENT_ESP_FIRMWARE_VERSION,
  scheduleHash: "0",
};

describe("ESP MQTT protocol", () => {
  it("keeps production firmware out of test mode and aligned with hardware", () => {
    const source = readFileSync(
      new URL(
        "../../../firmware/esp32/ESP32Code/ESP32Code.ino",
        import.meta.url,
      ),
      "utf8",
    );
    const safeConfiguration = readFileSync(
      new URL(
        "../../../firmware/esp32/ESP32Code/firmware-config.example.h",
        import.meta.url,
      ),
      "utf8",
    );

    expect(source).toMatch(/const bool TEST = false;/u);
    expect(source).not.toMatch(/const bool TEST = true;/u);
    expect(source).toContain(
      `const char* HARDWARE_PROFILE = "${NODEMCU_ESP32S_V1_1_HARDWARE_PROFILE_ID}";`,
    );
    expect(source).toContain(
      `const char* HARDWARE_MODEL = "${NODEMCU_ESP32S_V1_1_HARDWARE_MODEL}";`,
    );
    const pwmPins = /const int ALLOWED_PWM_PINS\[\] = \{([^}]+)\}/u.exec(
      source,
    )?.[1];
    expect(pwmPins?.match(/\d+/gu)?.map(Number)).toEqual(
      hardwareProfileById(NODEMCU_ESP32S_V1_1_HARDWARE_PROFILE_ID).pwmPins,
    );
    expect(source).toContain("SPIFFS.begin(false)");
    expect(source).not.toContain("SPIFFS.begin(true)");
    expect(source).toContain("const unsigned char maximumRepairFailures = 2;");
    expect(source).not.toContain('message == "clear"');
    expect(source).not.toContain("clearEEPROM");
    expect(source).toContain("esp_ota_mark_app_valid_cancel_rollback();");
    expect(source).toContain('String clientId = "Aquarium-" + deviceId;');
    expect(source).toContain(
      "transitionSeconds == 0 || allOutputsAreOff()",
    );
    expect(source).toContain("const unsigned long STARTUP_OUTPUT_HOLD_MS = 15000;");
    expect(source).toContain('preferences.putUInt("otaFade", otaRequest.transitionSeconds)');
    expect(safeConfiguration).toContain(
      "#define AQUARIUM_REPROVISION_NETWORK_CONFIG false",
    );
  });

  it("keeps pull-OTA metadata synchronized with the bundled binary", () => {
    const artifact = readFileSync(
      new URL(
        `../../../firmware/esp32/artifacts/${ESP_FIRMWARE_ARTIFACT.fileName}`,
        import.meta.url,
      ),
    );
    expect(ESP_FIRMWARE_ARTIFACT.version).toBe(CURRENT_ESP_FIRMWARE_VERSION);
    expect(ESP_FIRMWARE_ARTIFACT.sizeBytes).toBe(artifact.byteLength);
    expect(ESP_FIRMWARE_ARTIFACT.sha256).toBe(
      createHash("sha256").update(artifact).digest("hex"),
    );
    expect(ESP32_PWM_OVERWRITE_DURATION_MS).toBe(120_000);
  });

  it("uses the protocol major as the compatibility boundary", () => {
    expect(MINIMUM_SUPPORTED_ESP_FIRMWARE_VERSION).toBe("6.0.0");
    expect(isCurrentEspFirmwareVersion(CURRENT_ESP_FIRMWARE_VERSION)).toBe(true);
    expect(isSupportedEspFirmwareVersion("6.0.0")).toBe(true);
    expect(isSupportedEspFirmwareVersion("7.1.2")).toBe(false);
    expect(isSupportedEspFirmwareVersion("5.99.0")).toBe(false);
    expect(supportsPullOta("6.0.0")).toBe(true);
    expect(supportsPullOta("6.9.0")).toBe(true);
    expect(supportsPullOta("5.0.6")).toBe(false);
    expect(supportsPullOta("4.9.9")).toBe(false);
    expect(supportsSmoothOta("6.0.1")).toBe(false);
    expect(supportsSmoothOta("6.0.2")).toBe(true);
    expect(supportsSmoothOta("6.1.0")).toBe(true);
    expect(supportsSmoothOta("6.0.2-beta.1")).toBe(false);
  });

  it("normalizes passive legacy announcements but requires v1 on device topics", () => {
    const legacy = espAnnouncementSchema.parse(baseAnnouncement);
    expect(legacy.protocolVersion).toBe(0);
    expect(espAnnouncementSchema.parse(legacy)).toEqual(legacy);
    expect(
      espAnnouncementSchema.safeParse({
        ...baseAnnouncement,
        protocolVersion: ESP_MQTT_PROTOCOL_VERSION,
        diagnosticStorageHealthy: true,
        startupHold: true,
        outputsOff: false,
        outputs: [
          [16, 40],
          [17, 0],
        ],
      }).success,
    ).toBe(true);
    expect(
      espAnnouncementSchema.safeParse({
        ...baseAnnouncement,
        protocolVersion: ESP_MQTT_PROTOCOL_VERSION,
        outputs: [
          [16, 0],
          [16, 0],
        ],
      }).success,
    ).toBe(false);
  });

  it("rejects PWM pairs the ESP32 LEDC source clock cannot represent", () => {
    const announcement = {
      ...baseAnnouncement,
      protocolVersion: ESP_MQTT_PROTOCOL_VERSION,
      freq: 40_000,
      res: 10,
    };
    expect(isSupportedEsp32PwmConfiguration(announcement.freq, 10)).toBe(true);
    expect(espAnnouncementSchema.safeParse(announcement).success).toBe(true);
    expect(
      espAnnouncementSchema.safeParse({ ...announcement, res: 11 }).success,
    ).toBe(false);
  });

  it("encodes correlated structured commands and validates typed results", () => {
    const command = {
      index: 0,
      kind: "set_pwm" as const,
      pin: 16,
      value: 128,
      overwrite: true,
    };
    const payload = encodeEspCommandRequest({
      deviceId: "A1",
      requestId: "wire-1",
      commands: [command],
    });
    expect(espCommandRequestSchema.parse(JSON.parse(payload))).toMatchObject({
      protocolVersion: ESP_MQTT_PROTOCOL_VERSION,
      deviceId: "A1",
      requestId: "wire-1",
      commands: [command],
    });

    const result = espCommandResponseSchema.parse({
      protocolVersion: ESP_MQTT_PROTOCOL_VERSION,
      deviceId: "A1",
      name: "Main",
      requestId: "wire-1",
      results: [{ ...command, ok: true }],
    }).results[0];
    if (result === undefined) {
      throw new Error("Expected one command result");
    }
    expect(matchEspCommandResult(command, result)).toEqual({
      status: "succeeded",
      analogValue: null,
    });
  });

  it("distinguishes device failures from protocol mismatches", () => {
    const command = { index: 0, kind: "ping" as const };
    expect(
      matchEspCommandResult(command, {
        index: 0,
        kind: "ping",
        ok: false,
        error: { code: "busy", message: "Device is busy" },
      }),
    ).toEqual({
      status: "device_error",
      code: "busy",
      message: "Device is busy",
    });
    expect(
      matchEspCommandResult(command, {
        index: 0,
        kind: "schedule",
        ok: true,
      }),
    ).toMatchObject({ status: "protocol_error" });
  });

  it("uses isolated per-device topics and rejects unsafe namespaces", () => {
    const topics = createEspTopicSet(true);
    expect(topics.discoveryRequest).toBe("test/aquarium/v1/discovery/request");
    expect(topics.command("A1")).toBe(
      "test/aquarium/v1/devices/A1/command",
    );
    expect(topics.legacyCommand).toBe("test/aquarium/command");
    expect(topics.announcement("A1")).toBe(
      "test/aquarium/v1/devices/A1/announce",
    );
    expect(topics.response("A1")).toBe(
      "test/aquarium/v1/devices/A1/response",
    );
    expect(topics.announcementDeviceId(topics.announcement("A1"))).toBe("A1");
    expect(topics.responseDeviceId(topics.response("A1"))).toBe("A1");
    expect(() => createEspTopicSetForNamespace("test/+/unsafe")).toThrow();
    expect(JSON.parse(encodeEspDiscoveryRequest())).toEqual({
      protocolVersion: ESP_MQTT_PROTOCOL_VERSION,
      kind: "discover",
    });
  });

  it("reserves the terminating NUL byte in the firmware schedule buffer", () => {
    expect(() => assertLegacyScheduleFits("x".repeat(4095))).not.toThrow();
    expect(() => assertLegacyScheduleFits("x".repeat(4096))).toThrow(/4095/u);
  });
});
