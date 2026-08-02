import { describe, expect, it } from "vitest";

import { FAKE_ESP_MAX_COMMAND_PAYLOAD_BYTES, FakeEspHarness } from "./index.js";

const DEVICE_ID = "A1B2C3D4";

describe("independent fake ESP MQTT message limit", () => {
  it("accepts one complete message at the 5120-byte limit", () => {
    const harness = createHarness();
    const prefix = `${DEVICE_ID} p `;

    harness.publishCommand(
      prefix.padEnd(FAKE_ESP_MAX_COMMAND_PAYLOAD_BYTES, "x"),
    );

    expect(responseEntries(harness)).toEqual([{ index: 0, response: "o" }]);
  });

  it("rejects a message one byte above the limit", () => {
    const harness = createHarness();
    const prefix = `${DEVICE_ID} p `;

    harness.publishCommand(
      prefix.padEnd(FAKE_ESP_MAX_COMMAND_PAYLOAD_BYTES + 1, "x"),
    );

    expect(responseEntries(harness)).toEqual([]);
  });
});

function createHarness(): FakeEspHarness {
  const harness = new FakeEspHarness([
    { key: "alpha", deviceName: "Alpha", deviceId: DEVICE_ID },
  ]);
  harness.connectAll();
  harness.bus.clearPublications();
  return harness;
}

function responseEntries(
  harness: FakeEspHarness,
): readonly { readonly index: number; readonly response: string }[] {
  return harness.bus
    .publications()
    .filter(
      (publication) =>
        publication.origin === "actor" &&
        publication.topic === harness.topics.response &&
        publication.payload.startsWith("{"),
    )
    .flatMap((publication) => {
      const parsed = JSON.parse(publication.payload) as {
        readonly responses: readonly {
          readonly index: number;
          readonly response: string;
        }[];
      };
      return parsed.responses;
    });
}
