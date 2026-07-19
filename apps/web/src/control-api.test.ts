// @vitest-environment jsdom
// @vitest-environment-options {"url":"http://localhost/"}

import { operationDetailsResponseSchema } from "@aquarium/contracts";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

import {
  createChannel,
  deleteChannel,
  fetchOperationDetails,
  patchDeviceConfiguration,
  renameChannel,
  replaceMappingProfile,
  replaceSchedule,
  updateThrottle,
} from "./api.js";

const server = setupServer();
const nativeFetch = globalThis.fetch;

beforeAll(() => {
  globalThis.fetch = (input, init) => {
    const resolvedInput =
      typeof input === "string" ? new URL(input, window.location.href) : input;
    return nativeFetch(resolvedInput, init);
  };
  server.listen({ onUnhandledRequest: "error" });
});

afterEach(() => server.resetHandlers());

afterAll(() => {
  server.close();
  globalThis.fetch = nativeFetch;
});

describe("control configuration API", () => {
  it("uses every typed R4 mutation route with an expected revision", async () => {
    const requests: {
      readonly method: string;
      readonly path: string;
      readonly body: { readonly expectedRevision?: number };
    }[] = [];
    server.use(
      http.all("http://localhost/api/*", async ({ request }) => {
        requests.push({
          method: request.method,
          path: new URL(request.url).pathname,
          body: (await request.json()) as {
            readonly expectedRevision?: number;
          },
        });
        return HttpResponse.json({ changed: false, revision: 8, event: null });
      }),
    );

    await createChannel({
      expectedRevision: 8,
      id: "light-main",
      name: "Main light",
      typeKey: "light",
      throttleId: "throttle-light",
      displayOrder: 0,
      enabled: true,
    });
    await renameChannel("light-main", {
      expectedRevision: 8,
      name: "Main reef light",
    });
    await replaceSchedule("light-main", {
      expectedRevision: 8,
      points: [point("start", 0, 0, 0), point("end", 1, 1_439, 0)],
    });
    await updateThrottle("light", { expectedRevision: 8, percentage: 70 });
    await replaceMappingProfile("profile-main", {
      expectedRevision: 8,
      name: "Main",
      deviceNamePrefix: "main",
      outputGain: 0.7,
      mappings: [],
    });
    await patchDeviceConfiguration("device-main", {
      expectedRevision: 8,
      pwmFrequencyHz: 2_000,
    });
    await deleteChannel("light-main", 8);

    expect(requests.map(({ method, path }) => `${method} ${path}`)).toEqual([
      "POST /api/channels",
      "PATCH /api/channels/light-main",
      "PUT /api/channels/light-main/schedule",
      "PUT /api/throttles/light",
      "PUT /api/mapping-profiles/profile-main",
      "PATCH /api/devices/device-main/configuration",
      "DELETE /api/channels/light-main",
    ]);
    expect(requests.every(({ body }) => body.expectedRevision === 8)).toBe(
      true,
    );
  });

  it("validates operation details and preserves revision conflicts", async () => {
    const details = operationDetailsResponseSchema.parse({
      operation: {
        id: "operation-main",
        deviceId: "device-main",
        kind: "schedule",
        status: "succeeded",
        requestedAt: "2026-07-13T10:00:00.000Z",
        deadlineAt: "2026-07-13T10:00:05.000Z",
        completedAt: "2026-07-13T10:00:01.000Z",
      },
      request: { schemaVersion: 1, data: { kind: "schedule" } },
      result: { schemaVersion: 1, data: { status: "succeeded" } },
    });
    server.use(
      http.get("http://localhost/api/operations/operation-main", () =>
        HttpResponse.json(details),
      ),
      http.put("http://localhost/api/throttles/light", () =>
        HttpResponse.json(
          {
            code: "revision_conflict",
            message: "State revision changed",
            expectedRevision: 8,
            currentRevision: 9,
          },
          { status: 409 },
        ),
      ),
    );

    await expect(fetchOperationDetails("operation-main")).resolves.toEqual(
      details,
    );
    await expect(
      updateThrottle("light", { expectedRevision: 8, percentage: 60 }),
    ).rejects.toMatchObject({
      status: 409,
      details: { code: "revision_conflict", currentRevision: 9 },
    });
  });
});

function point(
  id: string,
  position: number,
  minuteOfDay: number,
  percentage: number,
) {
  return {
    id,
    position,
    minuteOfDay,
    percentage,
    editorX: null,
    editorY: null,
  };
}
