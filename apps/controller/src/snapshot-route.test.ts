import {
  apiErrorResponseSchema,
  controllerSnapshotSchema,
  type ControllerSnapshot,
} from "@aquarium/contracts";
import { afterEach, describe, expect, it } from "vitest";

import type { ControllerSnapshotReader } from "./application/snapshot/index.js";
import { buildApp } from "./app.js";
import { CONTROL_AREA_DEFINITIONS } from "./infrastructure/database/index.js";

const NOW = "2026-07-13T09:00:00.000Z";
const openApps: ReturnType<typeof buildApp>[] = [];

const EMPTY_SNAPSHOT: ControllerSnapshot = {
  schemaVersion: 1,
  revision: 0,
  committedAt: null,
  generatedAt: NOW,
  controlAreas: [...CONTROL_AREA_DEFINITIONS],
  channels: [],
  schedules: [],
  throttles: [],
  outputs: [],
  mappingProfiles: [],
  devices: [],
  operations: { items: [], limit: 100, truncated: false },
  unresolvedDeviceOperations: {
    items: [],
    limit: 100,
    truncated: false,
  },
  importRuns: [],
  overrides: [],
  alertRules: [],
  alerts: [],
};

afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
});

describe("GET /api/snapshot", () => {
  it("returns the repository projection through the shared contract", async () => {
    const reader = new StubSnapshotReader(EMPTY_SNAPSHOT);
    const app = buildApp({ snapshotReader: reader });
    openApps.push(app);

    const response = await app.inject({ method: "GET", url: "/api/snapshot" });

    expect(response.statusCode).toBe(200);
    expect(controllerSnapshotSchema.parse(response.json())).toEqual(
      EMPTY_SNAPSHOT,
    );
    expect(reader.readCount).toBe(1);
  });

  it("revalidates the complete repository response at the HTTP boundary", async () => {
    const semanticallyInvalid: ControllerSnapshot = {
      ...EMPTY_SNAPSHOT,
      revision: 1,
    };
    const app = buildApp({
      snapshotReader: new StubSnapshotReader(semanticallyInvalid),
    });
    openApps.push(app);

    const response = await app.inject({ method: "GET", url: "/api/snapshot" });

    expect(response.statusCode).toBe(500);
    expect(apiErrorResponseSchema.parse(response.json())).toMatchObject({
      code: "internal_error",
      message: "Controller snapshot generation failed",
    });
  });

  it("returns a safe error while the server records repository failures", async () => {
    const reader: ControllerSnapshotReader = {
      read: () =>
        Promise.reject(
          new Error("private persisted JSON value must not reach the client"),
        ),
    };
    const app = buildApp({ snapshotReader: reader });
    openApps.push(app);

    const response = await app.inject({ method: "GET", url: "/api/snapshot" });
    const body = apiErrorResponseSchema.parse(response.json());

    expect(response.statusCode).toBe(500);
    expect(body.code).toBe("internal_error");
    expect(response.body).not.toContain("private persisted JSON value");
  });

  it("fails loudly when production composition omits the snapshot reader", async () => {
    const app = buildApp();
    openApps.push(app);

    const response = await app.inject({ method: "GET", url: "/api/snapshot" });

    expect(response.statusCode).toBe(500);
    expect(apiErrorResponseSchema.parse(response.json()).code).toBe(
      "internal_error",
    );
  });
});

class StubSnapshotReader implements ControllerSnapshotReader {
  readCount = 0;

  constructor(private readonly snapshot: ControllerSnapshot) {}

  read(): Promise<ControllerSnapshot> {
    this.readCount += 1;
    return Promise.resolve(this.snapshot);
  }
}
