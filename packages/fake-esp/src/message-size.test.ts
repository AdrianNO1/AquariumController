import { describe, expect, it } from "vitest";

import { FAKE_ESP_MAX_COMMAND_PAYLOAD_BYTES, FakeEspHarness } from "./index.js";
import { encodeFakeEspCommandRequest } from "./structured-protocol.js";

const DEVICE_ID = "A1B2C3D4";

describe("independent fake ESP MQTT message limit", () => {
  it("accepts one complete message at the 5120-byte limit", () => {
    const harness = createHarness();
    const request = pingRequest();

    harness.bus.publishFromHost(
      harness.topics.command,
      request.padEnd(FAKE_ESP_MAX_COMMAND_PAYLOAD_BYTES, " "),
    );

    expect(responseEntries(harness)).toEqual([
      { index: 0, kind: "ping", ok: true },
    ]);
  });

  it("rejects a message one byte above the limit", () => {
    const harness = createHarness();
    const request = pingRequest();

    harness.bus.publishFromHost(
      harness.topics.command,
      request.padEnd(FAKE_ESP_MAX_COMMAND_PAYLOAD_BYTES + 1, " "),
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
): readonly { readonly index: number; readonly kind: "ping"; readonly ok: true }[] {
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
        readonly results: readonly {
          readonly index: number;
          readonly kind: "ping";
          readonly ok: true;
        }[];
      };
      return parsed.results;
    });
}

function pingRequest(): string {
  return encodeFakeEspCommandRequest({
    deviceId: DEVICE_ID,
    requestId: "size-boundary",
    commands: [{ index: 0, kind: "ping" }],
  });
}
