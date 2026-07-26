import { describe, expect, it } from "vitest";

import { FakeEspHarness } from "./harness.js";

const DEVICE_ID = "A1B2C3D4";

describe("independent fake ESP chunk reassembly", () => {
  it("waits for all chunks and preserves firmware out-of-order reset behavior", () => {
    const harness = createHarness();

    harness.publishCommand("chunk:1:2:1:C3D4 p");
    harness.publishCommand("chunk:0:2:0:A1B2");
    expect(responseEntries(harness)).toEqual([]);

    harness.publishCommand("chunk:1:2:1:C3D4 p");
    expect(responseEntries(harness)).toEqual([{ index: 0, response: "o" }]);
  });

  it("allows duplicate nonzero chunks but a duplicate chunk zero restarts assembly", () => {
    const harness = createHarness();
    harness.publishCommand(`chunk:0:2:0:${DEVICE_ID} `);
    harness.publishCommand(`chunk:0:2:0:${DEVICE_ID} `);
    harness.publishCommand("chunk:1:2:1:p");
    expect(responseEntries(harness)).toEqual([{ index: 0, response: "o" }]);

    harness.bus.clearPublications();
    harness.publishCommand("chunk:1:2:1:p");
    expect(responseEntries(harness)).toEqual([]);
  });

  it("preserves a correlated request ID through chunk reassembly", () => {
    const harness = createHarness();
    harness.publishCommand("chunk:0:2:0:request:chunk_request|A1");
    harness.publishCommand("chunk:1:2:1:B2C3D4 p");

    const response = harness.bus
      .publications()
      .find(
        (publication) =>
          publication.origin === "actor" &&
          publication.topic === harness.topics.response,
      );
    expect(JSON.parse(response?.payload ?? "{}")).toMatchObject({
      id: DEVICE_ID,
      requestId: "chunk_request",
      responses: [{ index: 0, response: "o" }],
    });
  });

  it("fails closed on changing totals and inconsistent final-chunk metadata", () => {
    const harness = createHarness();

    harness.publishCommand(`chunk:0:3:0:${DEVICE_ID} `);
    harness.publishCommand("chunk:1:2:1:p");
    expect(responseEntries(harness)).toEqual([]);

    harness.publishCommand(`chunk:0:2:1:${DEVICE_ID} `);
    harness.publishCommand("chunk:1:2:0:p");
    expect(responseEntries(harness)).toEqual([]);

    harness.publishCommand(`chunk:0:2:0:${DEVICE_ID} `);
    harness.publishCommand("chunk:1:2:1:p");
    expect(responseEntries(harness)).toEqual([{ index: 0, response: "o" }]);
  });

  it("safely ignores memory-unsafe indexes and totals instead of emulating corruption", () => {
    const harness = createHarness();
    for (const payload of [
      `chunk:-1:1:1:${DEVICE_ID} p`,
      `chunk:50:50:1:${DEVICE_ID} p`,
      `chunk:0:0:1:${DEVICE_ID} p`,
      `chunk:0:51:0:${DEVICE_ID} p`,
      `chunk:2:2:1:${DEVICE_ID} p`,
      `chunk:nope:1:1:${DEVICE_ID} p`,
      `chunk:0:1x:1:${DEVICE_ID} p`,
      "chunk:missing-fields",
    ]) {
      harness.publishCommand(payload);
    }
    expect(responseEntries(harness)).toEqual([]);
  });

  it("accepts exactly fifty chunks and rejects a fifty-one chunk assembly", () => {
    const harness = createHarness();
    const command = `${DEVICE_ID} p ${"x".repeat(9_989)}`;
    expect(command).toHaveLength(10_000);
    for (let index = 0; index < 50; index += 1) {
      const data = command.slice(index * 200, (index + 1) * 200);
      harness.publishCommand(
        `chunk:${index}:50:${index === 49 ? 1 : 0}:${data}`,
      );
    }
    expect(responseEntries(harness)).toEqual([{ index: 0, response: "o" }]);

    harness.bus.clearPublications();
    harness.publishCommand(`chunk:0:51:0:${DEVICE_ID} p`);
    expect(responseEntries(harness)).toEqual([]);
  });

  it("rejects data fields larger than the firmware's 200-byte buffer", () => {
    const harness = createHarness();
    const firstCommand = `${DEVICE_ID} p ${"x".repeat(189)}`;
    expect(firstCommand).toHaveLength(200);
    const hiddenSecondCommand = `;${DEVICE_ID} p`;

    harness.publishCommand(`chunk:0:1:1:${firstCommand}${hiddenSecondCommand}`);
    expect(responseEntries(harness)).toEqual([]);
  });

  it("resets after more than ten seconds of inactivity, not at exactly ten seconds", () => {
    const harness = createHarness();
    harness.publishCommand(`chunk:0:2:0:${DEVICE_ID} `);
    harness.advanceBy(10_000);
    harness.publishCommand("chunk:1:2:1:p");
    expect(responseEntries(harness)).toEqual([{ index: 0, response: "o" }]);

    harness.bus.clearPublications();
    harness.publishCommand(`chunk:0:2:0:${DEVICE_ID} `);
    harness.advanceBy(10_001);
    harness.publishCommand("chunk:1:2:1:p");
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
