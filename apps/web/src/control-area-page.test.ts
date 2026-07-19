// @vitest-environment jsdom
// @vitest-environment-options {"url":"http://localhost/"}

import {
  operationDetailsResponseSchema,
  type ControllerSnapshot,
} from "@aquarium/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { createElement } from "react";
import { MemoryRouter } from "react-router";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import App from "./App.js";
import {
  ControllerStateContext,
  type ControllerStateContextValue,
} from "./controller-state-context.js";
import { createTestControlSnapshot } from "./test-control-snapshot.js";

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

afterEach(() => {
  cleanup();
  server.resetHandlers();
});

afterAll(() => {
  server.close();
  globalThis.fetch = nativeFetch;
});

describe("control area routes", () => {
  it("renders every retained direct route and a useful empty state", () => {
    const snapshot = createTestControlSnapshot();
    for (const area of snapshot.controlAreas) {
      const rendered = renderControlArea(
        `/control/${area.slug}`,
        controllerState(snapshot, vi.fn()),
      );
      expect(
        screen.getByRole("heading", { level: 1, name: area.label }),
      ).toBeTruthy();
      rendered.unmount();
    }

    renderControlArea("/control/qt4", controllerState(snapshot, vi.fn()));
    expect(
      screen.getByText(
        "No channels exist for this control area. Create one to provision its owned UTC schedule.",
      ),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "This control area has no throttle record, so output scaling cannot be changed.",
      ),
    ).toBeTruthy();
  });

  it(
    "runs typed channel, schedule, throttle, mapping, and device workflows without optimistic outcomes",
    { timeout: 10_000 },
    async () => {
      const requests: RecordedRequest[] = [];
      const refresh = vi.fn();
      installMutationHandlers(requests);
      server.use(
        http.get("http://localhost/api/operations/operation-success", () =>
          HttpResponse.json(
            operationDetailsResponseSchema.parse({
              operation: {
                id: "operation-success",
                deviceId: "device-main",
                kind: "schedule",
                status: "succeeded",
                requestedAt: "2026-07-13T10:00:00.000Z",
                deadlineAt: "2026-07-13T10:00:05.000Z",
                completedAt: "2026-07-13T10:00:01.000Z",
              },
              request: { schemaVersion: 1, data: { kind: "schedule" } },
              result: { schemaVersion: 1, data: { status: "succeeded" } },
            }),
          ),
        ),
      );
      const user = renderControlArea(
        "/control/lights",
        controllerState(createTestControlSnapshot(), refresh, true),
      );

      expect(
        screen.getByRole("img", {
          name: "Main light output percentage across a UTC day",
        }),
      ).toBeTruthy();
      expect(screen.getByText("Controller state is stale.")).toBeTruthy();
      expect(screen.getByText("offline")).toBeTruthy();
      const startOverride = screen.getByRole("button", {
        name: "Start manual override",
      }) as HTMLButtonElement;
      expect(startOverride.disabled).toBe(true);
      expect(
        screen.getByText(/selected target already has a pending, active/u),
      ).toBeTruthy();
      await user.selectOptions(
        screen.getByLabelText("Channel or output"),
        "output:output-moonlight",
      );
      expect(startOverride.disabled).toBe(false);

      await user.click(screen.getByRole("button", { name: "Create channel" }));
      await user.type(screen.getByLabelText("Channel ID"), "light-backup");
      await user.type(screen.getByLabelText("Channel name"), "Backup light");
      await user.click(
        screen.getByRole("button", { name: "Create channel and schedule" }),
      );

      const renameInput = screen.getByLabelText("Rename channel");
      await user.clear(renameInput);
      await user.type(renameInput, "Reef light");
      await user.click(screen.getByRole("button", { name: "Rename" }));

      await user.type(screen.getByLabelText("New point ID"), "light-evening");
      fireEvent.change(screen.getByLabelText("UTC time"), {
        target: { value: "18:00" },
      });
      const newPercentage = screen.getByLabelText("Output percent");
      await user.clear(newPercentage);
      await user.type(newPercentage, "45");
      await user.click(screen.getByRole("button", { name: "Add point" }));
      expect(screen.getByText("light-evening")).toBeTruthy();
      await user.click(screen.getByRole("button", { name: "Save schedule" }));

      fireEvent.change(screen.getByLabelText("Throttle percentage"), {
        target: { value: "75" },
      });
      await user.click(screen.getByRole("button", { name: "Save throttle" }));

      fireEvent.change(screen.getByLabelText("Pin for mapping-light"), {
        target: { value: "7" },
      });
      await user.click(
        screen.getByRole("button", { name: "Save mapping profile" }),
      );

      await user.click(
        screen.getByRole("button", {
          name: "Edit device-main configuration",
        }),
      );
      fireEvent.change(screen.getByLabelText("PWM frequency (Hz)"), {
        target: { value: "2000" },
      });
      await user.click(
        screen.getByRole("button", { name: "Save configuration" }),
      );

      await user.click(
        screen.getByRole("button", { name: "Inspect operation-success" }),
      );
      expect(await screen.findByText("Request payload")).toBeTruthy();
      expect(screen.getByText(/"kind": "schedule"/u)).toBeTruthy();

      await user.click(
        screen.getByRole("button", { name: "Delete channel Main light" }),
      );
      await user.click(screen.getByRole("button", { name: "Confirm delete" }));

      expect(requests.map(({ path }) => path)).toEqual([
        "/api/channels",
        "/api/channels/light-main",
        "/api/channels/light-main/schedule",
        "/api/throttles/light",
        "/api/mapping-profiles/profile-main",
        "/api/devices/device-main/configuration",
        "/api/channels/light-main",
      ]);
      expect(requests[2]?.body).toMatchObject({
        expectedRevision: 8,
        points: expect.arrayContaining([
          expect.objectContaining({
            id: "light-evening",
            minuteOfDay: 1_080,
            percentage: 45,
          }),
        ]),
      });
      expect(requests[3]?.body).toMatchObject({ percentage: 75 });
      expect(requests[4]?.body).toMatchObject({
        mappings: expect.arrayContaining([
          expect.objectContaining({ id: "mapping-light", pin: 7 }),
        ]),
      });
      expect(requests[5]?.body).toMatchObject({ pwmFrequencyHz: 2_000 });
      expect(refresh).toHaveBeenCalledTimes(7);
    },
  );

  it("pins a dirty schedule revision and rebases it only after explicit acceptance", async () => {
    const refresh = vi.fn();
    const requestBodies: object[] = [];
    server.use(
      http.put(
        "http://localhost/api/channels/light-main/schedule",
        async ({ request }) => {
          requestBodies.push((await request.json()) as object);
          if (requestBodies.length === 1) {
            return HttpResponse.json(
              {
                code: "revision_conflict",
                message: "State revision changed",
                expectedRevision: 8,
                currentRevision: 9,
              },
              { status: 409 },
            );
          }
          return HttpResponse.json({
            changed: false,
            revision: 9,
            event: null,
          });
        },
      ),
    );
    const snapshot = createTestControlSnapshot();
    const user = renderControlArea(
      "/control/lights",
      controllerState(snapshot, refresh),
    );
    await user.type(screen.getByLabelText("New point ID"), "conflict-point");
    fireEvent.change(screen.getByLabelText("UTC time"), {
      target: { value: "16:00" },
    });
    await user.click(screen.getByRole("button", { name: "Add point" }));
    user.rerenderState(controllerState({ ...snapshot, revision: 9 }, refresh));
    await user.click(screen.getByRole("button", { name: "Save schedule" }));

    expect(
      await screen.findByText(/This draft began before controller revision 9/u),
    ).toBeTruthy();
    expect(requestBodies[0]).toMatchObject({ expectedRevision: 8 });
    expect(screen.getByText("conflict-point")).toBeTruthy();
    expect(refresh).toHaveBeenCalledOnce();

    await user.click(
      screen.getByRole("button", {
        name: "Keep draft with refreshed revision",
      }),
    );
    await user.click(screen.getByRole("button", { name: "Save schedule" }));

    await waitFor(() => expect(requestBodies).toHaveLength(2));
    expect(requestBodies[1]).toMatchObject({ expectedRevision: 9 });
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("pins a schedule point on its first edit before blur", async () => {
    let requestBody: object | null = null;
    server.use(
      http.put(
        "http://localhost/api/channels/light-main/schedule",
        async ({ request }) => {
          requestBody = (await request.json()) as object;
          return HttpResponse.json({
            changed: false,
            revision: 9,
            event: null,
          });
        },
      ),
    );
    const snapshot = createTestControlSnapshot();
    const refresh = vi.fn();
    const user = renderControlArea(
      "/control/lights",
      controllerState(snapshot, refresh),
    );
    const percentage = screen.getByDisplayValue("60");

    fireEvent.change(percentage, { target: { value: "65" } });
    user.rerenderState(controllerState({ ...snapshot, revision: 9 }, refresh));
    fireEvent.blur(percentage);
    await user.click(screen.getByRole("button", { name: "Save schedule" }));

    await waitFor(() =>
      expect(requestBody).toMatchObject({ expectedRevision: 8 }),
    );
  });

  it("keeps the device and revision captured when its dialog opened", async () => {
    let requestBody: object | null = null;
    server.use(
      http.patch(
        "http://localhost/api/devices/device-main/configuration",
        async ({ request }) => {
          requestBody = (await request.json()) as object;
          return HttpResponse.json({
            changed: false,
            revision: 9,
            event: null,
          });
        },
      ),
    );
    const snapshot = createTestControlSnapshot();
    const refresh = vi.fn();
    const user = renderControlArea(
      "/control/lights",
      controllerState(snapshot, refresh),
    );

    await user.click(
      screen.getByRole("button", {
        name: "Edit device-main configuration",
      }),
    );
    fireEvent.change(screen.getByLabelText("PWM frequency (Hz)"), {
      target: { value: "2000" },
    });
    user.rerenderState(controllerState({ ...snapshot, revision: 9 }, refresh));
    await user.click(
      screen.getByRole("button", { name: "Save configuration" }),
    );

    await waitFor(() =>
      expect(requestBody).toEqual({
        expectedRevision: 8,
        pwmFrequencyHz: 2_000,
      }),
    );
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("pins channel deletion when confirmation begins", async () => {
    let requestBody: object | null = null;
    server.use(
      http.delete(
        "http://localhost/api/channels/light-main",
        async ({ request }) => {
          requestBody = (await request.json()) as object;
          return HttpResponse.json({
            changed: false,
            revision: 9,
            event: null,
          });
        },
      ),
    );
    const snapshot = createTestControlSnapshot();
    const user = renderControlArea(
      "/control/lights",
      controllerState(snapshot, vi.fn()),
    );

    await user.click(
      screen.getByRole("button", { name: "Delete channel Main light" }),
    );
    user.rerenderState(controllerState({ ...snapshot, revision: 9 }, vi.fn()));
    await user.click(screen.getByRole("button", { name: "Confirm delete" }));

    await waitFor(() => expect(requestBody).toEqual({ expectedRevision: 8 }));
  });

  it("pins channel creation when its form opens", async () => {
    let requestBody: object | null = null;
    server.use(
      http.post("http://localhost/api/channels", async ({ request }) => {
        requestBody = (await request.json()) as object;
        return HttpResponse.json({
          changed: false,
          revision: 9,
          event: null,
        });
      }),
    );
    const snapshot = createTestControlSnapshot();
    const user = renderControlArea(
      "/control/lights",
      controllerState(snapshot, vi.fn()),
    );

    await user.click(screen.getByRole("button", { name: "Create channel" }));
    user.rerenderState(controllerState({ ...snapshot, revision: 9 }, vi.fn()));
    await user.type(screen.getByLabelText("Channel ID"), "light-secondary");
    await user.type(screen.getByLabelText("Channel name"), "Secondary light");
    await user.click(
      screen.getByRole("button", { name: "Create channel and schedule" }),
    );

    await waitFor(() =>
      expect(requestBody).toMatchObject({ expectedRevision: 8 }),
    );
  });

  it("pins a new mapping profile when its draft begins", async () => {
    let requestBody: object | null = null;
    server.use(
      http.put(
        "http://localhost/api/mapping-profiles/profile-new",
        async ({ request }) => {
          requestBody = (await request.json()) as object;
          return HttpResponse.json({
            changed: false,
            revision: 9,
            event: null,
          });
        },
      ),
    );
    const snapshot = createTestControlSnapshot();
    const refresh = vi.fn();
    const user = renderControlArea(
      "/control/lights",
      controllerState(snapshot, refresh),
    );
    await user.type(screen.getByLabelText("New profile ID"), "profile-new");
    await user.click(
      screen.getByRole("button", { name: "Create profile draft" }),
    );

    user.rerenderState(controllerState({ ...snapshot, revision: 9 }, refresh));
    await user.click(
      screen.getByRole("button", { name: "Save mapping profile" }),
    );

    await waitFor(() =>
      expect(requestBody).toMatchObject({ expectedRevision: 8 }),
    );
  });

  it("syncs untouched values but preserves first-edit revisions", async () => {
    let renameBody: object | null = null;
    let throttleBody: object | null = null;
    let mappingBody: object | null = null;
    server.use(
      http.patch(
        "http://localhost/api/channels/light-main",
        async ({ request }) => {
          renameBody = (await request.json()) as object;
          return HttpResponse.json({
            changed: false,
            revision: 10,
            event: null,
          });
        },
      ),
      http.put("http://localhost/api/throttles/light", async ({ request }) => {
        throttleBody = (await request.json()) as object;
        return HttpResponse.json({
          changed: false,
          revision: 10,
          event: null,
        });
      }),
      http.put(
        "http://localhost/api/mapping-profiles/profile-main",
        async ({ request }) => {
          mappingBody = (await request.json()) as object;
          return HttpResponse.json({
            changed: false,
            revision: 10,
            event: null,
          });
        },
      ),
    );
    const snapshot = createTestControlSnapshot();
    const refresh = vi.fn();
    const user = renderControlArea(
      "/control/lights",
      controllerState(snapshot, refresh),
    );
    const advanced: ControllerSnapshot = {
      ...snapshot,
      revision: 9,
      channels: snapshot.channels.map((channel) =>
        channel.id === "light-main"
          ? {
              ...channel,
              name: "External light",
              updatedAt: "2026-07-13T10:01:00.000Z",
            }
          : channel,
      ),
      throttles: snapshot.throttles.map((throttle) =>
        throttle.typeKey === "light"
          ? {
              ...throttle,
              percentage: 71,
              updatedAt: "2026-07-13T10:01:00.000Z",
            }
          : throttle,
      ),
    };

    user.rerenderState(controllerState(advanced, refresh));
    await waitFor(() => {
      expect(
        (screen.getByLabelText("Rename channel") as HTMLInputElement).value,
      ).toBe("External light");
      expect(
        (screen.getByLabelText("Throttle percentage") as HTMLInputElement)
          .value,
      ).toBe("71");
    });

    fireEvent.change(screen.getByLabelText("Rename channel"), {
      target: { value: "Browser light" },
    });
    fireEvent.change(screen.getByLabelText("Throttle percentage"), {
      target: { value: "75" },
    });
    fireEvent.change(screen.getByLabelText("Profile name"), {
      target: { value: "Browser profile" },
    });
    const newer: ControllerSnapshot = {
      ...advanced,
      revision: 10,
      channels: advanced.channels.map((channel) =>
        channel.id === "light-main"
          ? {
              ...channel,
              name: "Second external light",
              updatedAt: "2026-07-13T10:02:00.000Z",
            }
          : channel,
      ),
      throttles: advanced.throttles.map((throttle) =>
        throttle.typeKey === "light"
          ? {
              ...throttle,
              percentage: 68,
              updatedAt: "2026-07-13T10:02:00.000Z",
            }
          : throttle,
      ),
    };
    user.rerenderState(controllerState(newer, refresh));

    expect(
      (screen.getByLabelText("Rename channel") as HTMLInputElement).value,
    ).toBe("Browser light");
    expect(
      (screen.getByLabelText("Throttle percentage") as HTMLInputElement).value,
    ).toBe("75");
    await user.click(screen.getByRole("button", { name: "Rename" }));
    await user.click(screen.getByRole("button", { name: "Save throttle" }));
    await user.click(
      screen.getByRole("button", { name: "Save mapping profile" }),
    );

    await waitFor(() => {
      expect(renameBody).toMatchObject({ expectedRevision: 9 });
      expect(throttleBody).toMatchObject({ expectedRevision: 9 });
      expect(mappingBody).toMatchObject({ expectedRevision: 9 });
    });
  });

  it("never carries a mapping draft between profiles with equal timestamps", async () => {
    const snapshot = createTestControlSnapshot();
    const primary = snapshot.mappingProfiles[0];
    if (primary === undefined) throw new Error("Test snapshot has no profile");
    const withSecondProfile: ControllerSnapshot = {
      ...snapshot,
      mappingProfiles: [
        primary,
        {
          ...primary,
          id: "profile-secondary",
          name: "Secondary rack",
          deviceNamePrefix: "secondary",
          mappings: [],
        },
      ],
    };
    const user = renderControlArea(
      "/control/lights",
      controllerState(withSecondProfile, vi.fn()),
    );

    fireEvent.change(screen.getByLabelText("Profile name"), {
      target: { value: "Dirty primary draft" },
    });
    await user.selectOptions(
      screen.getByLabelText("Profile to edit"),
      "profile-secondary",
    );

    expect(
      (screen.getByLabelText("Profile name") as HTMLInputElement).value,
    ).toBe("Secondary rack");
    expect(
      (screen.getByLabelText("Device name prefix") as HTMLInputElement).value,
    ).toBe("secondary");
  });

  it("uses the controller revision for live schedule graph conflicts", async () => {
    let requestBody: object | null = null;
    server.use(
      http.put(
        "http://localhost/api/channels/light-main/schedule",
        async ({ request }) => {
          requestBody = (await request.json()) as object;
          return HttpResponse.json({
            changed: false,
            revision: 9,
            event: null,
          });
        },
      ),
    );
    const snapshot = createTestControlSnapshot();
    const refresh = vi.fn();
    const user = renderControlArea(
      "/control/lights",
      controllerState(snapshot, refresh),
    );
    await user.type(screen.getByLabelText("New point ID"), "live-conflict");
    fireEvent.change(screen.getByLabelText("UTC time"), {
      target: { value: "16:00" },
    });
    await user.click(screen.getByRole("button", { name: "Add point" }));
    const advanced: ControllerSnapshot = {
      ...snapshot,
      revision: 9,
      schedules: snapshot.schedules.map((schedule) =>
        schedule.channelId === "light-main"
          ? {
              ...schedule,
              graphRevision: 77,
              updatedAt: "2026-07-13T10:01:00.000Z",
            }
          : schedule,
      ),
    };

    user.rerenderState(controllerState(advanced, refresh));

    expect(
      await screen.findByText(/This draft began before controller revision 9/u),
    ).toBeTruthy();
    expect(screen.queryByText(/controller revision 77/u)).toBeNull();
    expect(screen.getByText("live-conflict")).toBeTruthy();
    await user.click(
      screen.getByRole("button", {
        name: "Keep draft with refreshed revision",
      }),
    );
    await user.click(screen.getByRole("button", { name: "Save schedule" }));

    await waitFor(() =>
      expect(requestBody).toMatchObject({ expectedRevision: 9 }),
    );
  });

  it("refuses to start a new mapping draft with an existing profile ID", async () => {
    const user = renderControlArea(
      "/control/lights",
      controllerState(createTestControlSnapshot(), vi.fn()),
    );

    await user.type(screen.getByLabelText("New profile ID"), "profile-main");
    await user.click(
      screen.getByRole("button", { name: "Create profile draft" }),
    );

    expect(
      screen.getByText(
        "Mapping profile profile-main already exists. Select it from the profile list instead.",
      ),
    ).toBeTruthy();
  });

  it("shows an actionable outdated-firmware error on the device card", () => {
    const original = createTestControlSnapshot();
    const snapshot: ControllerSnapshot = {
      ...original,
      devices: original.devices.map((device) => ({
        ...device,
        status: "error",
        reported: { ...device.reported, firmwareVersion: "3.2w" },
        lastError: {
          code: "firmware_outdated",
          message: "Firmware 3.2w is outdated; install 4.0.0",
        },
      })),
    };

    renderControlArea("/control/lights", controllerState(snapshot, vi.fn()));

    expect(
      screen.getAllByText(
        "firmware_outdated: Firmware 3.2w is outdated; install 4.0.0",
      ),
    ).toHaveLength(2);
  });

  it("shows loading and retryable snapshot failures", async () => {
    const loading = renderControlArea("/control/lights", {
      status: "loading",
      snapshot: null,
      revision: 0,
      dataStale: false,
      isRefreshing: false,
      lastMessageAt: null,
      error: null,
      refresh: vi.fn(),
      retry: vi.fn(),
    });
    expect(
      screen.getByText(
        "Loading the authoritative snapshot and live revision stream…",
      ),
    ).toBeTruthy();
    loading.unmount();

    const retry = vi.fn();
    const user = renderControlArea("/control/lights", {
      status: "error",
      snapshot: null,
      revision: 0,
      dataStale: true,
      isRefreshing: false,
      lastMessageAt: null,
      error: "Snapshot unavailable",
      refresh: vi.fn(),
      retry,
    });
    expect(screen.getByText("Snapshot unavailable")).toBeTruthy();
    await user.click(
      screen.getByRole("button", { name: "Retry controller state" }),
    );
    expect(retry).toHaveBeenCalledOnce();
  });
});

interface RecordedRequest {
  readonly path: string;
  readonly body: Record<string, object | string | number | boolean | null>;
}

function installMutationHandlers(requests: RecordedRequest[]): void {
  const handler = async ({ request }: { readonly request: Request }) => {
    requests.push({
      path: new URL(request.url).pathname,
      body: (await request.json()) as RecordedRequest["body"],
    });
    return HttpResponse.json({ changed: false, revision: 8, event: null });
  };
  server.use(
    http.post("http://localhost/api/channels", handler),
    http.patch("http://localhost/api/channels/light-main", handler),
    http.put("http://localhost/api/channels/light-main/schedule", handler),
    http.put("http://localhost/api/throttles/light", handler),
    http.put("http://localhost/api/mapping-profiles/profile-main", handler),
    http.patch(
      "http://localhost/api/devices/device-main/configuration",
      handler,
    ),
    http.delete("http://localhost/api/channels/light-main", handler),
  );
}

function controllerState(
  snapshot: ControllerSnapshot,
  refresh: () => void,
  dataStale = false,
): ControllerStateContextValue {
  return {
    status: dataStale ? "stale" : "connected",
    snapshot,
    revision: snapshot.revision,
    dataStale,
    isRefreshing: false,
    lastMessageAt: "2026-07-13T10:00:00.000Z",
    error: null,
    refresh,
    retry: vi.fn(),
  };
}

function renderControlArea(
  path: string,
  state: ControllerStateContextValue,
): RenderedControlArea {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  const renderTree = (value: ControllerStateContextValue) =>
    createElement(QueryClientProvider, {
      client: queryClient,
      children: createElement(ControllerStateContext.Provider, {
        value,
        children: createElement(MemoryRouter, {
          initialEntries: [path],
          children: createElement(App),
        }),
      }),
    });
  const rendered = render(renderTree(state));
  return Object.assign(userEvent.setup({ delay: null }), {
    unmount: rendered.unmount,
    rerenderState: (nextState: ControllerStateContextValue) =>
      rendered.rerender(renderTree(nextState)),
  });
}

type RenderedControlArea = ReturnType<typeof userEvent.setup> & {
  readonly unmount: () => void;
  readonly rerenderState: (state: ControllerStateContextValue) => void;
};
