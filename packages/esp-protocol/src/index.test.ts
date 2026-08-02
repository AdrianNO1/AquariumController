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
  batchLegacyCommands,
  createEspTopicSet,
  CURRENT_ESP_FIRMWARE_VERSION,
  encodeCorrelatedLegacyRequest,
  encodeLegacyMessage,
  ESP_FIRMWARE_ARTIFACT,
  ESP_MQTT_MAX_COMMAND_PAYLOAD_BYTES,
  ESP32_PWM_OVERWRITE_DURATION_MS,
  espAnnouncementSchema,
  espCommandResponseSchema,
  isSupportedEspFirmwareVersion,
  isSupportedEsp32PwmConfiguration,
  isCurrentEspFirmwareVersion,
  MINIMUM_SUPPORTED_ESP_FIRMWARE_VERSION,
  supportsPullOta,
} from "./index.js";

describe("legacy ESP protocol", () => {
  it("keeps the tracked release firmware out of test mode", () => {
    const source = readFileSync(
      new URL(
        "../../../firmware/esp32/ESP32Code/ESP32Code.ino",
        import.meta.url,
      ),
      "utf8",
    );

    expect(source).toMatch(/const bool TEST = false;/u);
    expect(source).not.toMatch(/const bool TEST = true;/u);
    expect(source).toContain(
      `const char* VERSION = "${CURRENT_ESP_FIRMWARE_VERSION}";`,
    );
    expect(source).toContain(
      `const char* HARDWARE_PROFILE = "${NODEMCU_ESP32S_V1_1_HARDWARE_PROFILE_ID}";`,
    );
    expect(source).toContain(
      `const char* HARDWARE_MODEL = "${NODEMCU_ESP32S_V1_1_HARDWARE_MODEL}";`,
    );
    const pwmPins = /const int ALLOWED_PWM_PINS\[\] = \{([^}]+)\}/u.exec(
      source,
    )?.[1];
    expect(pwmPins).toBeDefined();
    expect(pwmPins?.match(/\d+/gu)?.map(Number)).toEqual(
      hardwareProfileById(NODEMCU_ESP32S_V1_1_HARDWARE_PROFILE_ID).pwmPins,
    );
    expect(source).toContain("SPIFFS.begin(false)");
    expect(source).not.toContain("SPIFFS.begin(true)");
    expect(source).toContain("const unsigned char maximumRepairFailures = 2;");
    expect(source).not.toContain('message == "clear"');
    expect(source).not.toContain("clearEEPROM");
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
    expect(isCurrentEspFirmwareVersion(CURRENT_ESP_FIRMWARE_VERSION)).toBe(
      true,
    );
    expect(isCurrentEspFirmwareVersion("not-current")).toBe(false);
    expect(isCurrentEspFirmwareVersion("5.0.0")).toBe(false);
    expect(MINIMUM_SUPPORTED_ESP_FIRMWARE_VERSION).toBe("5.0.0");
    expect(isSupportedEspFirmwareVersion("5.0.0")).toBe(true);
    expect(isSupportedEspFirmwareVersion("5.0.2")).toBe(true);
    expect(isSupportedEspFirmwareVersion("4.2.1")).toBe(false);
    expect(supportsPullOta("5.0.0")).toBe(true);
    expect(supportsPullOta("6.1.0")).toBe(true);
    expect(supportsPullOta("4.2.1")).toBe(false);
    expect(isCurrentEspFirmwareVersion("4.0.0")).toBe(false);
    expect(isCurrentEspFirmwareVersion("3.2w")).toBe(false);
  });

  it("accepts output and OTA telemetry while preserving legacy announcements", () => {
    const base = {
      id: "A1",
      name: "Main",
      freq: 5_000,
      res: 8,
      status: "online",
      version: CURRENT_ESP_FIRMWARE_VERSION,
      scheduleHash: "0",
    };

    expect(espAnnouncementSchema.safeParse(base).success).toBe(true);
    expect(
      espAnnouncementSchema.safeParse({
        ...base,
        outputsOff: false,
        outputs: [
          [16, 40],
          [17, 0],
        ],
        ota: {
          status: "downloading",
          targetVersion: CURRENT_ESP_FIRMWARE_VERSION,
          progress: 48,
        },
      }).success,
    ).toBe(true);
    expect(
      espAnnouncementSchema.safeParse({
        ...base,
        outputsOff: true,
        outputs: [
          [16, 0],
          [16, 0],
        ],
      }).success,
    ).toBe(false);
  });

  it("rejects PWM pairs the ESP32 LEDC source clock cannot represent", () => {
    const announcement = {
      id: "A1",
      name: "Main",
      freq: 40_000,
      res: 10,
      status: "online",
      version: "4.1.0",
      scheduleHash: "0",
    };

    expect(isSupportedEsp32PwmConfiguration(announcement.freq, 10)).toBe(true);
    expect(espAnnouncementSchema.safeParse(announcement).success).toBe(true);
    expect(
      espAnnouncementSchema.safeParse({ ...announcement, res: 11 }).success,
    ).toBe(false);
  });

  it("sends the maximum command payload as one MQTT message", () => {
    const payload = "x".repeat(ESP_MQTT_MAX_COMMAND_PAYLOAD_BYTES);

    expect(encodeLegacyMessage(payload)).toBe(payload);
  });

  it("correlates command batches and requires the ESP to echo the request", () => {
    expect(encodeCorrelatedLegacyRequest("wire-1-0", "A1 p")).toBe(
      "request:wire-1-0|A1 p",
    );
    expect(
      espCommandResponseSchema.safeParse({
        id: "A1",
        name: "Main",
        requestId: "wire-1-0",
        responses: [{ index: 0, response: "o" }],
      }).success,
    ).toBe(true);
    expect(
      espCommandResponseSchema.safeParse({
        id: "A1",
        name: "Main",
        responses: [{ index: 0, response: "o" }],
      }).success,
    ).toBe(false);
  });

  it("rejects payloads above the firmware MQTT command limit by UTF-8 byte length", () => {
    expect(() =>
      encodeLegacyMessage("x".repeat(ESP_MQTT_MAX_COMMAND_PAYLOAD_BYTES + 1)),
    ).toThrow(/5121 bytes/u);
    expect(() =>
      encodeLegacyMessage("🐠".repeat(ESP_MQTT_MAX_COMMAND_PAYLOAD_BYTES / 4)),
    ).not.toThrow();
    expect(() =>
      encodeLegacyMessage(
        `🐠${"x".repeat(ESP_MQTT_MAX_COMMAND_PAYLOAD_BYTES - 3)}`,
      ),
    ).toThrow(/5121 bytes/u);
  });

  it("splits after the third command for the same target", () => {
    const batches = batchLegacyCommands([
      "ID1 p",
      "ID1 s 1 0 0",
      "ID1 s 2 0 0",
      "ID1 s 3 0 0",
      "ID2 p",
    ]);

    expect(batches.map((batch) => batch.originalIndexes)).toEqual([
      [0, 1, 2],
      [3, 4],
    ]);
  });

  it("preserves the legacy interleaved batching behavior", () => {
    const batches = batchLegacyCommands([
      "ID1 p",
      "ID2 p",
      "ID1 p",
      "ID2 p",
      "ID1 p",
      "ID2 p",
      "ID1 p",
      "ID2 p",
    ]);

    expect(batches.map((batch) => batch.originalIndexes)).toEqual([
      [0, 1, 2, 3, 4, 5],
      [6, 7],
    ]);
  });

  it("reserves the terminating NUL byte in the firmware schedule buffer", () => {
    expect(() => assertLegacyScheduleFits("x".repeat(4095))).not.toThrow();
    expect(() => assertLegacyScheduleFits("x".repeat(4096))).toThrow(/4095/);
  });

  it("keeps test topics isolated", () => {
    expect(createEspTopicSet(true)).toEqual({
      command: "test/aquarium/command",
      announce: "test/aquarium/announce",
      response: "test/aquarium/response",
    });
  });
});
