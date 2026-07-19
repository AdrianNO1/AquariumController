import { describe, expect, it } from "vitest";

import { FakeEspHarness } from "./harness.js";
import {
  FIRMWARE_FLAT_DOCUMENT_JSON,
  FIRMWARE_FLAT_HASH,
  FIRMWARE_FLOAT_TRUNCATION_DOCUMENT_JSON,
  FIRMWARE_FLOAT_TRUNCATION_PWM_AT_MINUTE_THREE,
  FIRMWARE_GOLDEN_DOCUMENT_JSON,
  FIRMWARE_GOLDEN_HASH,
} from "./test-fixtures/firmware-goldens.js";

const DEVICE_ID = "A1B2C3D4";
const ZERO_SCHEDULE =
  '{"c":[{"o":4,"t":108,"l":[{"s":{"t":0,"p":0},"d":{"t":1439,"p":0}}]}],"syncTime":1735689600}';

describe("independent fake ESP schedule behavior", () => {
  it("matches hard-coded firmware serialization and DJB2 goldens", () => {
    const harness = createConnectedHarness();
    harness.bus.clearPublications();

    harness.publishCommand(`${DEVICE_ID} sc ${FIRMWARE_GOLDEN_DOCUMENT_JSON}`);
    expect(responseStrings(harness)).toEqual(["schedule_ok"]);
    harness.bus.clearPublications();
    harness.publishCommand("discover");

    expect(latestAnnouncement(harness)).toMatchObject({
      id: DEVICE_ID,
      scheduleHash: FIRMWARE_GOLDEN_HASH,
    });
  });

  it("does not treat schedule syncTime as a clock synchronization command", () => {
    const harness = createConnectedHarness();
    harness.publishCommand(`${DEVICE_ID} sc ${FIRMWARE_FLAT_DOCUMENT_JSON}`);
    expect(harness.actor("alpha").currentEpochSeconds()).toBe(0);

    harness.publishCommand(`${DEVICE_ID} sync 1735689600`);
    expect(harness.actor("alpha").currentEpochSeconds()).toBe(1735689600);
    expect(responseStrings(harness).at(-1)).toBe("1735689600");
  });

  it("uses first-inclusive links, zero-duration source values, and UTC minutes", () => {
    const harness = createConnectedHarness();
    const schedule =
      '{"c":[{"o":4,"t":108,"l":[{"s":{"t":120,"p":37},"d":{"t":120,"p":99}},{"s":{"t":0,"p":0},"d":{"t":240,"p":100}},{"s":{"t":120,"p":80},"d":{"t":1439,"p":80}}]}],"syncTime":1735696800}';
    harness.publishCommand(`${DEVICE_ID} sc ${schedule}`);
    harness.publishCommand(`${DEVICE_ID} sync 1735696800`);
    harness.advanceBy(1_000);

    expect(harness.actor("alpha").currentMinuteOfDay()).toBe(120);
    expect(harness.actor("alpha").pinSnapshot(4).outputValue).toBe(94);
  });

  it("rounds interpolation through firmware 32-bit float before int truncation", () => {
    const harness = createConnectedHarness();
    harness.publishCommand(
      `${DEVICE_ID} sc ${FIRMWARE_FLOAT_TRUNCATION_DOCUMENT_JSON}`,
    );
    harness.publishCommand(`${DEVICE_ID} sync 1735689780`);
    harness.advanceBy(1_000);

    // Firmware float progress is 0.6000000238, making the value
    // 9.999999046 and therefore 9 after the int conversion, not JS-double 10.
    expect(harness.actor("alpha").pinSnapshot(4).outputValue).toBe(
      FIRMWARE_FLOAT_TRUNCATION_PWM_AT_MINUTE_THREE,
    );
  });

  it("scales scheduled percentages to the configured PWM resolution", () => {
    const harness = createConnectedHarness();
    harness.publishCommand(`${DEVICE_ID} e Alpha 5000 10`);
    harness.publishCommand(`${DEVICE_ID} sc ${FIRMWARE_FLAT_DOCUMENT_JSON}`);
    harness.publishCommand(`${DEVICE_ID} sync 1735689600`);
    harness.advanceBy(1_000);

    expect(harness.actor("alpha").pinSnapshot(4).outputValue).toBe(511);
  });

  it("derives minute 1439 and midnight from epoch UTC boundaries", () => {
    const harness = createConnectedHarness();
    harness.publishCommand(`${DEVICE_ID} sync 1735775999`);
    expect(harness.actor("alpha").currentMinuteOfDay()).toBe(1_439);
    harness.advanceBy(1_000);
    expect(harness.actor("alpha").currentMinuteOfDay()).toBe(0);
  });

  it("restores a flat scheduled output at the exact override expiry", () => {
    const harness = activeFlatScheduleHarness();
    expect(harness.actor("alpha").pinSnapshot(4).outputValue).toBe(127);

    harness.publishCommand(`${DEVICE_ID} s 4 255 1`);
    harness.clock.advanceBy(119_999);
    expect(harness.actor("alpha").pinSnapshot(4)).toMatchObject({
      outputValue: 255,
      overwritten: true,
    });

    harness.clock.advanceBy(1);
    harness.runLoops();
    expect(harness.actor("alpha").pinSnapshot(4)).toMatchObject({
      outputValue: 127,
      overwritten: false,
    });
    harness.advanceBy(5_000);
    expect(harness.actor("alpha").pinSnapshot(4).outputValue).toBe(127);
  });

  it("rescales an active override across resolution changes and restores its schedule", () => {
    const harness = activeFlatScheduleHarness();
    harness.publishCommand(`${DEVICE_ID} e Alpha 5000 12`);
    harness.advanceBy(1_000);
    expect(harness.actor("alpha").pinSnapshot(4).outputValue).toBe(2_047);

    harness.publishCommand(`${DEVICE_ID} s 4 128 1`);
    expect(harness.actor("alpha").pinSnapshot(4)).toMatchObject({
      outputValue: 2_055,
      lastManualValue: 2_055,
      overwritten: true,
    });

    harness.publishCommand(`${DEVICE_ID} e Alpha 5000 10`);
    expect(harness.actor("alpha").pinSnapshot(4)).toMatchObject({
      outputValue: 513,
      lastManualValue: 513,
      overwritten: true,
    });

    harness.clock.advanceBy(120_000);
    harness.runLoops();
    expect(harness.actor("alpha").pinSnapshot(4)).toMatchObject({
      outputValue: 511,
      lastManualValue: 511,
      overwritten: false,
    });
  });

  it("extends overrides and turns unscheduled pins off at exact expiry", () => {
    const harness = createConnectedHarness();
    harness.publishCommand(`${DEVICE_ID} s 5 200 1`);
    harness.clock.advanceBy(119_999);
    harness.publishCommand(`${DEVICE_ID} s 5 201 1`);
    harness.clock.advanceBy(119_999);
    expect(harness.actor("alpha").pinSnapshot(5)).toMatchObject({
      outputValue: 201,
      overwritten: true,
    });
    harness.clock.advanceBy(1);
    harness.runLoops();
    expect(harness.actor("alpha").pinSnapshot(5)).toMatchObject({
      outputValue: 0,
      overwritten: false,
    });
  });

  it("keeps override expiry rollover-safe across the uint32 boundary", () => {
    const harness = createConnectedHarness();
    const uint32Maximum = 0xffff_ffff;
    harness.clock.advanceBy(uint32Maximum - 60_001);
    harness.runLoops();

    harness.publishCommand(`${DEVICE_ID} s 5 200 1`);
    expect(harness.actor("alpha").pinSnapshot(5)).toMatchObject({
      outputValue: 200,
      overwritten: true,
      overwriteExpiryMilliseconds: 59_999,
    });

    harness.advanceBy(119_800);
    expect(harness.actor("alpha").pinSnapshot(5).overwritten).toBe(true);
    harness.advanceBy(199);
    expect(harness.actor("alpha").pinSnapshot(5).overwritten).toBe(true);
    harness.advanceBy(1);
    expect(harness.actor("alpha").pinSnapshot(5)).toMatchObject({
      outputValue: 0,
      overwritten: false,
    });
  });

  it("restores the scheduled output after frequency reattachment", () => {
    const harness = activeFlatScheduleHarness();
    harness.publishCommand(`${DEVICE_ID} e Alpha 6000 8`);
    expect(harness.actor("alpha").pinSnapshot(4).outputValue).toBe(127);

    harness.advanceBy(5_000);
    expect(harness.actor("alpha").pinSnapshot(4).outputValue).toBe(127);
  });

  it("physically applies a zero-target replacement schedule", () => {
    const harness = activeFlatScheduleHarness();
    harness.publishCommand(`${DEVICE_ID} s 4 200 0`);
    harness.publishCommand(`${DEVICE_ID} sc ${ZERO_SCHEDULE}`);
    harness.advanceBy(5_000);

    expect(harness.actor("alpha").pinSnapshot(4).outputValue).toBe(0);
  });

  it("rejects an out-of-range schedule pin and preserves the active schedule", () => {
    const harness = activeFlatScheduleHarness();
    harness.bus.clearPublications();
    const invalidSchedule =
      '{"c":[{"o":64,"t":108,"l":[]}],"syncTime":1735689600}';

    harness.publishCommand(`${DEVICE_ID} sc ${invalidSchedule}`);

    expect(responseStrings(harness)).toEqual(["E: Invalid schedule"]);
    expect(harness.actor("alpha").persistenceSnapshot().schedule).toBe(
      FIRMWARE_FLAT_DOCUMENT_JSON,
    );
    expect(harness.actor("alpha").pinSnapshot(64).attached).toBe(false);
  });

  it("rejects malformed and duplicate schedule channels before persistence", () => {
    const harness = activeFlatScheduleHarness();
    harness.bus.clearPublications();

    for (const schedule of [
      '{"syncTime":1735689600}',
      '{"c":[{"t":108,"l":[]}],"syncTime":1735689600}',
      '{"c":[{"o":4,"t":108,"l":[]},{"o":4,"t":108,"l":[]}],"syncTime":1735689600}',
      '{"c":[{"o":4,"t":108,"l":[{"s":{"t":0,"p":101},"d":{"t":1439,"p":0}}]}],"syncTime":1735689600}',
    ]) {
      harness.publishCommand(`${DEVICE_ID} sc ${schedule}`);
    }

    expect(responseStrings(harness)).toEqual([
      "E: Invalid schedule",
      "E: Invalid schedule",
      "E: Invalid schedule",
      "E: Invalid schedule",
    ]);
    expect(harness.actor("alpha").persistenceSnapshot().schedule).toBe(
      FIRMWARE_FLAT_DOCUMENT_JSON,
    );
  });

  it("accepts 4095 bytes and rejects 4096 without replacing persistence", () => {
    const harness = createConnectedHarness();
    const safe = paddedEmptySchedule(4_095);
    harness.publishCommand(`${DEVICE_ID} sc ${safe}`);
    expect(responseStrings(harness)).toEqual(["schedule_ok"]);
    harness.bus.clearPublications();
    harness.publishCommand("discover");
    expect(latestAnnouncement(harness).scheduleHash).toBe("570947766");

    harness.bus.clearPublications();
    const oversized = paddedEmptySchedule(4_096);
    harness.publishCommand(`${DEVICE_ID} sc ${oversized}`);
    expect(responseStrings(harness)).toEqual(["E: Schedule too large"]);
    expect(harness.actor("alpha").persistenceSnapshot().schedule).toBe(safe);
    harness.bus.clearPublications();
    harness.publishCommand("discover");
    expect(latestAnnouncement(harness).scheduleHash).toBe("570947766");
  });

  it("forces removed schedule pins off and cancels their manual overrides", () => {
    const harness = activeFlatScheduleHarness();
    harness.publishCommand(`${DEVICE_ID} s 4 255 1`);
    expect(harness.actor("alpha").pinSnapshot(4)).toMatchObject({
      outputValue: 255,
      overwritten: true,
    });

    const emptySchedule = '{"c":[],"syncTime":1735689600}';
    harness.publishCommand(`${DEVICE_ID} sc ${emptySchedule}`);
    expect(responseStrings(harness).at(-1)).toBe("schedule_ok");
    expect(harness.actor("alpha").pinSnapshot(4)).toMatchObject({
      outputValue: 0,
      lastManualValue: 0,
      overwritten: false,
    });
    expect(harness.actor("alpha").persistenceSnapshot().schedule).toBe(
      emptySchedule,
    );

    harness.advanceBy(120_001);
    expect(harness.actor("alpha").pinSnapshot(4).outputValue).toBe(0);
  });

  it("retains the flat schedule hash golden through actor restart", () => {
    const harness = activeFlatScheduleHarness();
    harness.restartActor("alpha");
    harness.bus.clearPublications();
    harness.publishCommand("discover");
    expect(latestAnnouncement(harness).scheduleHash).toBe(FIRMWARE_FLAT_HASH);
  });

  it("rebases cadence timers when reconstructing an actor", () => {
    const harness = activeFlatScheduleHarness();
    harness.clock.advanceBy(10_000);
    harness.runLoops();

    const restarted = harness.restartActor("alpha");
    expect(restarted.pinSnapshot(4).outputValue).toBe(0);
    harness.advanceBy(999);
    expect(restarted.pinSnapshot(4).outputValue).toBe(0);
    harness.advanceBy(1);
    expect(restarted.pinSnapshot(4).outputValue).toBe(127);
  });
});

function createConnectedHarness(): FakeEspHarness {
  const harness = new FakeEspHarness([
    { key: "alpha", deviceName: "Alpha", deviceId: DEVICE_ID },
  ]);
  harness.connectAll();
  return harness;
}

function activeFlatScheduleHarness(): FakeEspHarness {
  const harness = createConnectedHarness();
  harness.publishCommand(`${DEVICE_ID} sc ${FIRMWARE_FLAT_DOCUMENT_JSON}`);
  harness.publishCommand(`${DEVICE_ID} sync 1735689600`);
  harness.advanceBy(1_000);
  return harness;
}

function responseStrings(harness: FakeEspHarness): readonly string[] {
  return harness.bus
    .publications()
    .filter(
      (publication) =>
        publication.origin === "actor" &&
        publication.topic === harness.topics.response,
    )
    .flatMap((publication) => {
      const parsed = JSON.parse(publication.payload) as {
        readonly responses?: readonly { readonly response: string }[];
      };
      return parsed.responses?.map(({ response }) => response) ?? [];
    });
}

function latestAnnouncement(harness: FakeEspHarness): {
  readonly id: string;
  readonly scheduleHash: string;
} {
  const payload = harness.bus
    .publications()
    .filter(
      (publication) =>
        publication.origin === "actor" &&
        publication.topic === harness.topics.announce,
    )
    .at(-1)?.payload;
  if (payload === undefined) {
    throw new Error("Expected a fake ESP announcement");
  }
  return JSON.parse(payload) as {
    readonly id: string;
    readonly scheduleHash: string;
  };
}

function paddedEmptySchedule(bytes: number): string {
  const json = '{"c":[],"syncTime":1735689600}';
  return `${" ".repeat(bytes - json.length)}${json}`;
}
