import { describe, expect, it } from "vitest";

import {
  assertLegacyScheduleFits,
  batchLegacyCommands,
  createEspTopicSet,
  CURRENT_ESP_FIRMWARE_VERSION,
  encodeCorrelatedLegacyRequest,
  encodeLegacyMessage,
  ESP_FIRMWARE_ARTIFACT,
  ESP32_PWM_OVERWRITE_DURATION_MS,
  espAnnouncementSchema,
  espCommandResponseSchema,
  isSupportedEsp32PwmConfiguration,
  isCurrentEspFirmwareVersion,
  supportsPullOta,
  LEGACY_CHUNK_DATA_BYTES,
  utf8ByteLength,
} from "./index.js";

describe("legacy ESP protocol", () => {
  it("requires the pull-OTA firmware exactly", () => {
    expect(CURRENT_ESP_FIRMWARE_VERSION).toBe("5.0.0");
    expect(ESP_FIRMWARE_ARTIFACT).toMatchObject({
      version: "5.0.0",
      sizeBytes: 1_174_576,
      sha256:
        "f655a0a1bc067c24ebec9578c2f638d1221bfbf6d3c4679785dd6e8851bfbee5",
    });
    expect(ESP32_PWM_OVERWRITE_DURATION_MS).toBe(120_000);
    expect(isCurrentEspFirmwareVersion("5.0.0")).toBe(true);
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
      version: "5.0.0",
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
          targetVersion: "5.0.1",
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

  it("keeps payloads at the 256-byte boundary unchunked", () => {
    const payload = "x".repeat(256);

    expect(encodeLegacyMessage(payload)).toEqual([payload]);
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

  it("uses the deployed chunk framing above 256 bytes", () => {
    const frames = encodeLegacyMessage("x".repeat(401));

    expect(frames).toHaveLength(3);
    expect(frames[0]).toBe(`chunk:0:3:0:${"x".repeat(200)}`);
    expect(frames[1]).toBe(`chunk:1:3:0:${"x".repeat(200)}`);
    expect(frames[2]).toBe("chunk:2:3:1:x");
  });

  it("never splits a UTF-8 code point or exceeds the ESP data buffer", () => {
    const frames = encodeLegacyMessage("🐠".repeat(70));

    for (const frame of frames) {
      const data = frame.split(":", 5)[4];
      expect(data).toBeDefined();
      expect(utf8ByteLength(data ?? "")).toBeLessThanOrEqual(
        LEGACY_CHUNK_DATA_BYTES,
      );
    }
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
