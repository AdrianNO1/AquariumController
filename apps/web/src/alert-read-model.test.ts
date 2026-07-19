import { describe, expect, it } from "vitest";

import {
  alertsReadModelFromSnapshot,
  buildAlertsReadModel,
} from "./alert-read-model.js";
import {
  createTestAlertsSnapshot,
  createTestControllerSnapshot,
} from "./test-controller-snapshot.js";

describe("alert presentation read model", () => {
  it("groups every contract state for either snapshot or history adapters", () => {
    const model = alertsReadModelFromSnapshot(createTestAlertsSnapshot());

    expect(model.open.map((item) => item.alert.id)).toEqual(["alert-open"]);
    expect(model.acknowledged.map((item) => item.alert.id)).toEqual([
      "alert-acknowledged",
    ]);
    expect(model.recovered.map((item) => item.alert.id)).toEqual([
      "alert-recovered",
    ]);
  });

  it("fails loudly if an adapter supplies an alert without its rule", () => {
    const snapshot = createTestAlertsSnapshot();
    expect(() => buildAlertsReadModel([], snapshot.alerts)).toThrow(
      "references missing rule",
    );
    expect(
      alertsReadModelFromSnapshot(createTestControllerSnapshot(0)),
    ).toMatchObject({
      open: [],
      acknowledged: [],
      recovered: [],
    });
  });
});
