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
      '{"protocolVersion":1,"name":"Alpha","freq":5000,"res":8,"id":"A1B2C3D4","status":"online","version":"6.0.2","hardwareProfile":"nodemcu-esp32s-v1.1","hardwareModel":"Ai-Thinker NodeMCU-32S V1.1","diagnosticStorageHealthy":true,"scheduleHash":"0"}',
    ]);

    harness.publishCommand("discover");
    expect(actorPayloads(harness, harness.topics.announce)).toHaveLength(2);
  });

  it("echoes a correlated request ID without changing command indexes", () => {
    const harness = createConnectedHarness();
    harness.bus.clearPublications();

    harness.publishCommand(
      `request:operation_1|${DEVICE_ID} p;${DEVICE_ID} s 4 128 1`,
    );

    expect(jsonActorPayloads(harness, harness.topics.response)).toEqual([
      {
        protocolVersion: 1,
        deviceId: DEVICE_ID,
        name: "Alpha",
        requestId: "operation_1",
        results: [
          { index: 0, kind: "ping", ok: true },
          {
            index: 1,
            kind: "set_pwm",
            ok: true,
            pin: 4,
            value: 128,
            overwrite: true,
          },
        ],
      },
    ]);
  });

  it("keeps response indexes local to a multi-actor batch", () => {
    const harness = new FakeEspHarness([
      { key: "alpha", deviceName: "Alpha", deviceId: DEVICE_ID },
      { key: "beta", deviceName: "Beta", deviceId: "B1C2D3E4" },
    ]);
    harness.actor("alpha").setAnalogValue(34, 321);
    harness.connectAll();
    harness.bus.clearPublications();

    harness.publishCommand(
      `${DEVICE_ID} p;B1C2D3E4 p;Other p;${DEVICE_ID} s 4 128 1;${DEVICE_ID} r 34`,
    );

    expect(allJsonActorResponses(harness)).toEqual([
      {
        protocolVersion: 1,
        deviceId: DEVICE_ID,
        name: "Alpha",
        requestId: "harness-1",
        results: [
          { index: 0, kind: "ping", ok: true },
          {
            index: 1,
            kind: "set_pwm",
            ok: true,
            pin: 4,
            value: 128,
            overwrite: true,
          },
          { index: 2, kind: "analog_read", ok: true, pin: 34, value: 321 },
        ],
      },
      {
        protocolVersion: 1,
        deviceId: "B1C2D3E4",
        name: "Beta",
        requestId: "harness-2",
        results: [{ index: 0, kind: "ping", ok: true }],
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
      `${DEVICE_ID} e Alpha 5000 12;${DEVICE_ID} s 4 0 0;${DEVICE_ID} s 12 128 1;${DEVICE_ID} s 13 255 0`,
    );

    expect(allCommandResults(harness)).toEqual([
      {
        index: 0,
        kind: "edit_configuration",
        ok: true,
        name: "Alpha",
        pwmFrequencyHz: 5000,
        pwmResolutionBits: 12,
      },
      { index: 1, kind: "set_pwm", ok: true, pin: 4, value: 0, overwrite: false },
      { index: 2, kind: "set_pwm", ok: true, pin: 12, value: 128, overwrite: true },
      { index: 0, kind: "set_pwm", ok: true, pin: 13, value: 255, overwrite: false },
    ]);
    expect(harness.actor("alpha").pinSnapshot(4).outputValue).toBe(0);
    expect(harness.actor("alpha").pinSnapshot(12)).toMatchObject({
      outputValue: 2_055,
      lastManualValue: 2_055,
      overwritten: true,
    });
    expect(harness.actor("alpha").pinSnapshot(13).outputValue).toBe(4_095);
  });

  it("returns typed device errors without preventing valid commands", () => {
    const harness = createConnectedHarness();
    harness.actor("alpha").setAnalogValue(34, 777);
    harness.bus.clearPublications();

    publishRawRequest(harness, [
      { index: 0, kind: "set_pwm", pin: 34, value: 255, overwrite: true },
      {
        index: 1,
        kind: "edit_configuration",
        name: "Renamed",
        pwmFrequencyHz: 40_000,
        pwmResolutionBits: 16,
      },
      { index: 2, kind: "analog_read", pin: 34 },
    ]);

    expect(allCommandResults(harness)).toEqual([
      {
        index: 0,
        kind: "set_pwm",
        ok: false,
        error: { code: "invalid_pin", message: "Invalid pin" },
      },
      {
        index: 1,
        kind: "edit_configuration",
        ok: false,
        error: { code: "invalid_configuration", message: "Invalid configuration" },
      },
      { index: 2, kind: "analog_read", ok: true, pin: 34, value: 777 },
    ]);
    expect(harness.actor("alpha").identity()).toMatchObject({
      deviceName: "Alpha",
      frequency: 5_000,
      resolution: 8,
    });
  });

  it("rejects an invalid structured request before changing actuator state", () => {
    const harness = createConnectedHarness();
    harness.bus.clearPublications();

    publishRawRequest(harness, [
      { index: 0, kind: "set_pwm", pin: -1, value: 255, overwrite: true },
    ]);

    expect(allJsonActorResponses(harness)).toEqual([]);
    expect(harness.actor("alpha").pinSnapshot(-1).attached).toBe(false);
    expect(harness.actor("alpha").persistenceSnapshot().lastError).toEqual({
      code: "invalid_mqtt_request",
      severity: "warning",
      message: "Invalid or misaddressed MQTT command request",
      sequence: 1,
      active: true,
      at: 0,
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

  it("rejects an EEPROM timestamp outside the firmware time_t range", () => {
    const persistence = new MemoryFakeEspPersistence({
      deviceName: "Alpha",
      deviceId: DEVICE_ID,
      time: { lastSavedEpochSeconds: 2_147_483_648 },
    });
    const harness = new FakeEspHarness([
      {
        key: "alpha",
        deviceName: "Alpha",
        deviceId: DEVICE_ID,
        persistence,
      },
    ]);

    expect(harness.actor("alpha").currentEpochSeconds()).toBe(0);
    expect(persistence.read().time).toBeUndefined();
  });

  it("saves elapsed synchronized time to EEPROM on the firmware hourly loop", () => {
    const harness = createConnectedHarness();
    harness.publishCommand(`${DEVICE_ID} sync 1735689600`);
    harness.clock.advanceBy(3_599_999);
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

  it("immediately checkpoints the first fresh clock after an hourly EEPROM fallback checkpoint", () => {
    const persistence = new MemoryFakeEspPersistence({
      deviceName: "Alpha",
      deviceId: DEVICE_ID,
      time: { lastSavedEpochSeconds: 1_735_689_600 },
    });
    const harness = new FakeEspHarness([
      {
        key: "alpha",
        deviceName: "Alpha",
        deviceId: DEVICE_ID,
        persistence,
      },
    ]);
    harness.connectAll();
    harness.advanceBy(3_600_000);
    expect(persistence.read().time).toEqual({
      lastSavedEpochSeconds: 1_735_693_200,
    });

    harness.publishCommand(`${DEVICE_ID} sync 1735700000`);

    expect(persistence.read().time).toEqual({
      lastSavedEpochSeconds: 1_735_700_000,
    });
  });

  it("retains a backward clock correction in RAM and checkpoints it at the hourly bound", () => {
    const harness = createConnectedHarness();
    harness.publishCommand(`${DEVICE_ID} sync 1735693200`);
    harness.advanceBy(1_000);
    harness.publishCommand(`${DEVICE_ID} sync 1735689600`);

    expect(harness.actor("alpha").currentEpochSeconds()).toBe(1_735_689_600);
    expect(harness.actor("alpha").persistenceSnapshot().time).toEqual({
      lastSavedEpochSeconds: 1_735_693_200,
    });

    harness.advanceBy(3_598_999);
    expect(harness.actor("alpha").persistenceSnapshot().time).toEqual({
      lastSavedEpochSeconds: 1_735_693_200,
    });
    harness.advanceBy(1);
    expect(harness.actor("alpha").persistenceSnapshot().time).toEqual({
      lastSavedEpochSeconds: 1_735_693_199,
    });
  });

  it("ignores legacy broadcasts and rejects unknown structured commands without erasing state", () => {
    const harness = createConnectedHarness();
    harness.publishCommand(`${DEVICE_ID} sc ${FIRMWARE_FLAT_DOCUMENT_JSON}`);
    harness.publishCommand(`${DEVICE_ID} e Renamed 6000 10`);
    harness.bus.clearPublications();

    publishRawRequest(harness, [{ index: 0, kind: "clear" }]);
    expect(allJsonActorResponses(harness)).toEqual([]);

    harness.bus.clearPublications();
    expect(() =>
      harness.bus.publishFromHost("test/aquarium/command", "clear"),
    ).toThrow(/structured test namespace/iu);
    expect(actorPayloads(harness, harness.topics.response)).toEqual([]);
    expect(harness.actor("alpha").identity()).toEqual({
      deviceName: "Renamed",
      deviceId: DEVICE_ID,
      frequency: 6000,
      resolution: 10,
    });
    expect(harness.actor("alpha").persistenceSnapshot().schedule).toBe(
      FIRMWARE_FLAT_DOCUMENT_JSON,
    );
  });

  it("does not let a bare clear broadcast affect any connected actor", () => {
    const harness = new FakeEspHarness([
      { key: "alpha", deviceName: "Alpha", deviceId: DEVICE_ID },
      { key: "beta", deviceName: "Beta", deviceId: "B1C2D3E4" },
    ]);
    harness.connectAll();
    harness.bus.clearPublications();

    expect(() =>
      harness.bus.publishFromHost("test/aquarium/command", "clear"),
    ).toThrow(/structured test namespace/iu);
    expect(actorPayloads(harness, harness.topics.response)).toEqual([]);
    expect(harness.actor("alpha").identity().deviceName).toBe("Alpha");
    expect(harness.actor("beta").identity().deviceName).toBe("Beta");
  });

  it("injects drop, malformed, duplicate, delay, and reconnect response faults", () => {
    const harness = createConnectedHarness();

    harness.setResponseFaults("alpha", { drop: true });
    harness.bus.clearPublications();
    harness.publishCommand(`${DEVICE_ID} p`);
    expect(actorPayloads(harness, harness.topics.response)).toEqual([]);

    harness.setResponseFaults("alpha", {
      dropNextResponseForCommand: "edit_configuration",
    });
    harness.publishCommand(`${DEVICE_ID} p`);
    expect(actorPayloads(harness, harness.topics.response)).toHaveLength(1);
    harness.publishCommand(`${DEVICE_ID} e Renamed 5000 8`);
    expect(actorPayloads(harness, harness.topics.response)).toHaveLength(1);
    harness.publishCommand(`${DEVICE_ID} p`);
    expect(actorPayloads(harness, harness.topics.response)).toHaveLength(2);
    expect(() =>
      harness.setResponseFaults("alpha", {
        dropNextResponseForCommand: "edit configuration!",
      }),
    ).toThrow(/one-shot response fault command/iu);

    harness.bus.clearPublications();
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

function allJsonActorResponses(harness: FakeEspHarness): readonly object[] {
  return harness.bus
    .publications()
    .filter(
      ({ origin, topic }) => origin === "actor" && topic.endsWith("/response"),
    )
    .map(({ payload }) => JSON.parse(payload) as object);
}

function allCommandResults(harness: FakeEspHarness): readonly object[] {
  return allJsonActorResponses(harness).flatMap((response) => {
    const typed = response as { readonly results?: readonly object[] };
    return typed.results ?? [];
  });
}

function publishRawRequest(
  harness: FakeEspHarness,
  commands: readonly object[],
): void {
  harness.bus.publishFromHost(
    harness.topics.command,
    JSON.stringify({
      protocolVersion: 1,
      deviceId: DEVICE_ID,
      requestId: "raw-test",
      commands,
    }),
  );
}
