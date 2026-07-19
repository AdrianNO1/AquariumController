import { describe, expect, it } from "vitest";

import { FakeEspHarness } from "./harness.js";
import { MemoryFakeEspPersistence } from "./persistence.js";
import { FIRMWARE_FLAT_DOCUMENT_JSON } from "./test-fixtures/firmware-goldens.js";

const DEVICE_ID = "A1B2C3D4";

describe("independent fake ESP actor commands", () => {
  it("announces exact firmware identity fields on connect and discovery", () => {
    const harness = createHarness();

    harness.connectAll();
    expect(actorPayloads(harness, harness.topics.announce)).toEqual([
      '{"name":"Alpha","freq":5000,"res":8,"id":"A1B2C3D4","status":"online","version":"4.0.0","scheduleHash":"0"}',
    ]);

    harness.publishCommand("discover");
    expect(actorPayloads(harness, harness.topics.announce)).toHaveLength(2);
  });

  it("keeps response indexes local to a multi-actor batch", () => {
    const harness = new FakeEspHarness([
      { key: "alpha", deviceName: "Alpha", deviceId: DEVICE_ID },
      { key: "beta", deviceName: "Beta", deviceId: "B1C2D3E4" },
    ]);
    harness.actor("alpha").setAnalogValue(7, 321);
    harness.connectAll();
    harness.bus.clearPublications();

    harness.publishCommand(
      `${DEVICE_ID} p;B1C2D3E4 p;Other p;${DEVICE_ID} s 4 128 1;${DEVICE_ID} r 7`,
    );

    expect(jsonActorPayloads(harness, harness.topics.response)).toEqual([
      {
        id: DEVICE_ID,
        name: "Alpha",
        responses: [
          { index: 0, response: "o" },
          { index: 3, response: "s 4 128 1" },
          { index: 4, response: "r 7 321" },
        ],
      },
      {
        id: "B1C2D3E4",
        name: "Beta",
        responses: [{ index: 1, response: "o" }],
      },
    ]);
    expect(harness.actor("alpha").pinSnapshot(4)).toMatchObject({
      attached: true,
      outputValue: 128,
      lastManualValue: 128,
      overwritten: true,
    });
  });

  it("treats set values as normalized 8-bit duty at higher PWM resolutions", () => {
    const harness = createConnectedHarness();
    harness.bus.clearPublications();

    harness.publishCommand(
      `${DEVICE_ID} e Alpha 5000 12;${DEVICE_ID} s 4 0 0;${DEVICE_ID} s 5 128 1;${DEVICE_ID} s 6 255 0`,
    );

    expect(jsonActorPayloads(harness, harness.topics.response)).toEqual([
      {
        id: DEVICE_ID,
        name: "Alpha",
        responses: [
          { index: 0, response: "Alpha 5000 12" },
          { index: 1, response: "s 4 0 0" },
          { index: 2, response: "s 5 128 1" },
          { index: 3, response: "s 6 255 0" },
        ],
      },
    ]);
    expect(harness.actor("alpha").pinSnapshot(4).outputValue).toBe(0);
    expect(harness.actor("alpha").pinSnapshot(5)).toMatchObject({
      outputValue: 2_055,
      lastManualValue: 2_055,
      overwritten: true,
    });
    expect(harness.actor("alpha").pinSnapshot(6).outputValue).toBe(4_095);
  });

  it("implements command, configuration, synchronization, and analog errors", () => {
    const harness = createConnectedHarness();
    harness.actor("alpha").setAnalogValue(9, 777);
    harness.bus.clearPublications();

    harness.publishCommand(
      [
        `${DEVICE_ID} s nope`,
        `${DEVICE_ID} s 4 256 0`,
        `${DEVICE_ID} s 4 1 2`,
        `${DEVICE_ID} r nope`,
        `${DEVICE_ID} r 9 metadata`,
        `${DEVICE_ID} sc {`,
        `${DEVICE_ID} sync 0`,
        `${DEVICE_ID} sync -1`,
        `${DEVICE_ID} sync 1735689600 extra`,
        `${DEVICE_ID} sync 2147483648`,
        `${DEVICE_ID} mystery`,
      ].join(";"),
    );

    expect(jsonActorPayloads(harness, harness.topics.response)).toEqual([
      {
        id: DEVICE_ID,
        name: "Alpha",
        responses: [
          { index: 0, response: "E: Invalid arguments" },
          { index: 1, response: "E: Invalid value or overwrite parameter" },
          { index: 2, response: "E: Invalid value or overwrite parameter" },
          { index: 3, response: "E: Invalid arguments" },
          { index: 4, response: "E: Metadata not supported" },
          { index: 5, response: "E: Invalid JSON" },
          { index: 6, response: "E: Invalid time value" },
          { index: 7, response: "E: Invalid time value" },
          { index: 8, response: "E: Invalid time value" },
          { index: 9, response: "E: Invalid time value" },
          { index: 10, response: "E: Invalid command" },
        ],
      },
    ]);

    harness.bus.clearPublications();
    harness.publishCommand(
      `${DEVICE_ID} r 9 metadata extra;${DEVICE_ID} r 9metadata;${DEVICE_ID} r 9`,
    );
    expect(jsonActorPayloads(harness, harness.topics.response)).toEqual([
      {
        id: DEVICE_ID,
        name: "Alpha",
        responses: [
          { index: 0, response: "E: Metadata not supported" },
          { index: 1, response: "E: Metadata not supported" },
          { index: 2, response: "r 9 777" },
        ],
      },
    ]);

    harness.bus.clearPublications();
    harness.publishCommand(
      [
        `${DEVICE_ID} e Renamed 0 17`,
        `${DEVICE_ID} e Renamed -1 8`,
        `${DEVICE_ID} e Renamed 5000 8 extra`,
        `${DEVICE_ID} e ${"x".repeat(32)} 5000 8`,
        `${DEVICE_ID} e Renamed 40000 16`,
      ].join(";"),
    );
    expect(jsonActorPayloads(harness, harness.topics.response)).toEqual([
      {
        id: DEVICE_ID,
        name: "Alpha",
        responses: [
          { index: 0, response: "E: Invalid configuration" },
          { index: 1, response: "E: Invalid configuration" },
          { index: 2, response: "E: Invalid configuration" },
          { index: 3, response: "E: Invalid configuration" },
          { index: 4, response: "E: Invalid configuration" },
        ],
      },
    ]);
    expect(harness.actor("alpha").identity()).toEqual({
      deviceName: "Alpha",
      deviceId: DEVICE_ID,
      frequency: 5_000,
      resolution: 8,
    });
  });

  it("rejects out-of-range pins without creating actuator state", () => {
    const harness = createConnectedHarness();
    harness.bus.clearPublications();

    harness.publishCommand(
      `${DEVICE_ID} s -1 255 1;${DEVICE_ID} s 64 255 1;${DEVICE_ID} r -1;${DEVICE_ID} r 64;${DEVICE_ID} s 4 1 0 extra;${DEVICE_ID} s 999999999999999999999 1 0;${DEVICE_ID} s 4 128 0;${DEVICE_ID} r 4;${DEVICE_ID} r 999999999999999999999`,
    );

    expect(jsonActorPayloads(harness, harness.topics.response)).toEqual([
      {
        id: DEVICE_ID,
        name: "Alpha",
        responses: [
          { index: 0, response: "E: Invalid pin" },
          { index: 1, response: "E: Invalid pin" },
          { index: 2, response: "E: Invalid pin" },
          { index: 3, response: "E: Invalid pin" },
          { index: 4, response: "E: Invalid arguments" },
          { index: 5, response: "E: Invalid arguments" },
          { index: 6, response: "s 4 128 0" },
          { index: 7, response: "E: Pin is configured as output" },
          { index: 8, response: "E: Invalid arguments" },
        ],
      },
    ]);
    expect(harness.actor("alpha").pinSnapshot(-1).attached).toBe(false);
    expect(harness.actor("alpha").pinSnapshot(64).attached).toBe(false);
    expect(harness.actor("alpha").pinSnapshot(4)).toMatchObject({
      attached: true,
      outputValue: 128,
    });
  });

  it("persists schedule, time, and edited EEPROM across actor reconstruction", () => {
    const harness = createConnectedHarness();
    harness.bus.clearPublications();

    harness.publishCommand(`${DEVICE_ID} sc ${FIRMWARE_FLAT_DOCUMENT_JSON}`);
    harness.publishCommand(`${DEVICE_ID} sync 1735689600`);
    harness.publishCommand(`${DEVICE_ID} e Renamed 6000 10`);
    expect(harness.actor("alpha").persistenceSnapshot()).toMatchObject({
      deviceName: "Renamed",
      deviceId: DEVICE_ID,
      frequency: 6000,
      resolution: 10,
      time: { lastSavedEpochSeconds: 1735689600 },
      schedule: FIRMWARE_FLAT_DOCUMENT_JSON,
    });

    const restarted = harness.restartActor("alpha");
    expect(restarted.identity()).toEqual({
      deviceName: "Renamed",
      deviceId: DEVICE_ID,
      frequency: 6000,
      resolution: 10,
    });
    expect(restarted.currentEpochSeconds()).toBe(1735689600);
    expect(restarted.persistenceSnapshot().schedule).toBe(
      FIRMWARE_FLAT_DOCUMENT_JSON,
    );
  });

  it("restores defaults for an impossible persisted PWM pair", () => {
    const persistence = new MemoryFakeEspPersistence({
      deviceName: "Alpha",
      deviceId: DEVICE_ID,
      frequency: 40_000,
      resolution: 16,
    });
    const harness = new FakeEspHarness([
      {
        key: "alpha",
        deviceName: "Alpha",
        deviceId: DEVICE_ID,
        persistence,
      },
    ]);

    expect(harness.actor("alpha").identity()).toEqual({
      deviceName: "Alpha",
      deviceId: DEVICE_ID,
      frequency: 5_000,
      resolution: 8,
    });
    expect(persistence.read()).toMatchObject({
      frequency: 5_000,
      resolution: 8,
    });
  });

  it("saves elapsed synchronized time to EEPROM on the firmware hourly loop", () => {
    const harness = createConnectedHarness();
    harness.publishCommand(`${DEVICE_ID} sync 1735689600`);
    harness.clock.advanceBy(3_600_000);
    harness.runLoops();

    expect(harness.actor("alpha").persistenceSnapshot().time).toEqual({
      lastSavedEpochSeconds: 1_735_689_600,
    });
    harness.clock.advanceBy(1);
    harness.runLoops();

    expect(harness.actor("alpha").persistenceSnapshot().time).toEqual({
      lastSavedEpochSeconds: 1_735_693_200,
    });
    expect(harness.restartActor("alpha").currentEpochSeconds()).toBe(
      1_735_693_200,
    );
  });

  it("retains SPIFFS schedule while bare clear resets EEPROM and targeted clear stays invalid", () => {
    const harness = createConnectedHarness();
    harness.publishCommand(`${DEVICE_ID} sc ${FIRMWARE_FLAT_DOCUMENT_JSON}`);
    harness.publishCommand(`${DEVICE_ID} e Renamed 6000 10`);
    harness.bus.clearPublications();

    harness.publishCommand(`${DEVICE_ID} clear`);
    expect(jsonActorPayloads(harness, harness.topics.response)).toEqual([
      {
        id: DEVICE_ID,
        name: "Renamed",
        responses: [{ index: 0, response: "E: Invalid command" }],
      },
    ]);

    harness.bus.clearPublications();
    harness.publishCommand("clear");
    expect(actorPayloads(harness, harness.topics.response)).toEqual([
      "EEPROM cleared",
    ]);
    expect(harness.actor("alpha").identity()).toEqual({
      deviceName: "Alpha",
      deviceId: DEVICE_ID,
      frequency: 5000,
      resolution: 8,
    });
    expect(harness.actor("alpha").persistenceSnapshot().schedule).toBe(
      FIRMWARE_FLAT_DOCUMENT_JSON,
    );
  });

  it("broadcasts the bare clear plaintext response from every connected actor", () => {
    const harness = new FakeEspHarness([
      { key: "alpha", deviceName: "Alpha", deviceId: DEVICE_ID },
      { key: "beta", deviceName: "Beta", deviceId: "B1C2D3E4" },
    ]);
    harness.connectAll();
    harness.bus.clearPublications();

    harness.publishCommand("clear");
    expect(actorPayloads(harness, harness.topics.response)).toEqual([
      "EEPROM cleared",
      "EEPROM cleared",
    ]);
  });

  it("injects drop, malformed, duplicate, delay, and reconnect response faults", () => {
    const harness = createConnectedHarness();

    harness.setResponseFaults("alpha", { drop: true });
    harness.bus.clearPublications();
    harness.publishCommand(`${DEVICE_ID} p`);
    expect(actorPayloads(harness, harness.topics.response)).toEqual([]);

    harness.setResponseFaults("alpha", {
      malformed: true,
      duplicateResponses: 1,
      delayMilliseconds: 10,
    });
    harness.publishCommand(`${DEVICE_ID} p`);
    harness.advanceBy(9);
    expect(actorPayloads(harness, harness.topics.response)).toEqual([]);
    harness.advanceBy(1);
    expect(actorPayloads(harness, harness.topics.response)).toEqual(["{", "{"]);

    harness.setResponseFaults("alpha", {});
    harness.bus.clearPublications();
    harness.actor("alpha").reconnect();
    expect(actorPayloads(harness, harness.topics.announce)).toHaveLength(1);
  });

  it("ignores commands while disconnected and other-target-only batches", () => {
    const harness = createHarness();
    harness.publishCommand(`${DEVICE_ID} p`);
    expect(actorPayloads(harness, harness.topics.response)).toEqual([]);

    harness.connectAll();
    harness.bus.clearPublications();
    harness.publishCommand("FFFFFFFF p");
    expect(actorPayloads(harness, harness.topics.response)).toEqual([]);
  });
});

function createHarness(): FakeEspHarness {
  return new FakeEspHarness([
    { key: "alpha", deviceName: "Alpha", deviceId: DEVICE_ID },
  ]);
}

function createConnectedHarness(): FakeEspHarness {
  const harness = createHarness();
  harness.connectAll();
  return harness;
}

function actorPayloads(
  harness: FakeEspHarness,
  topic: string,
): readonly string[] {
  return harness.bus
    .publications()
    .filter(
      (publication) =>
        publication.origin === "actor" && publication.topic === topic,
    )
    .map((publication) => publication.payload);
}

function jsonActorPayloads(
  harness: FakeEspHarness,
  topic: string,
): readonly object[] {
  return actorPayloads(harness, topic).map(
    (payload) => JSON.parse(payload) as object,
  );
}
