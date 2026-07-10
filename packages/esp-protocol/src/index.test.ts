import { describe, expect, it } from "vitest";

import {
  assertLegacyScheduleFits,
  batchLegacyCommands,
  createEspTopicSet,
  encodeLegacyMessage,
  LEGACY_CHUNK_DATA_BYTES,
  utf8ByteLength,
} from "./index.js";

describe("legacy ESP protocol", () => {
  it("keeps payloads at the 256-byte boundary unchunked", () => {
    const payload = "x".repeat(256);

    expect(encodeLegacyMessage(payload)).toEqual([payload]);
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

  it("rejects schedules larger than the firmware JSON buffer", () => {
    expect(() => assertLegacyScheduleFits("x".repeat(4097))).toThrow(/4096/);
  });

  it("keeps test topics isolated", () => {
    expect(createEspTopicSet(true)).toEqual({
      command: "test/aquarium/command",
      announce: "test/aquarium/announce",
      response: "test/aquarium/response",
    });
  });
});
