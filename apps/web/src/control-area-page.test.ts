// @vitest-environment jsdom
// @vitest-environment-options {"url":"http://localhost/"}

import type {
  Channel,
  ControllerSnapshot,
  ScheduleGraph,
} from "@aquarium/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { createElement } from "react";
import { createMemoryRouter, RouterProvider } from "react-router";
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
import { localMinuteToUtcMinute } from "./local-time.js";
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
  it("renders every retained route, useful empty states, and every known ESP", () => {
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
      screen.getByText("No schedules are available for this control area."),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "Quarantine 4 has no multiplier record, so scaling cannot be changed.",
      ),
    ).toBeTruthy();
    expect(
      screen.getByRole("article", {
        name: "ESP32 device device-main",
      }),
    ).toBeTruthy();
    expect(
      screen.getByRole("article", {
        name: "ESP32 device device-backup",
      }),
    ).toBeTruthy();
  });

  it("composes the combined editor, channel manager, global mappings, and device cards", async () => {
    const snapshot = withAccentLight(createTestControlSnapshot());
    const withFirmwareStates: ControllerSnapshot = {
      ...snapshot,
      devices: snapshot.devices.map((device) =>
        device.id === "device-main"
          ? {
              ...device,
              reported: {
                ...device.reported,
                firmwareVersion: "5.0.0-beta.1",
              },
              lastError: null,
            }
          : {
              ...device,
              reported: { ...device.reported, firmwareVersion: "3.2.0" },
            },
      ),
    };
    const user = renderControlArea(
      "/control/lights",
      controllerState(withFirmwareStates, vi.fn()),
    );

    const graph = screen.getByRole("img", {
      name: "All channel output percentages across a local day",
    });
    const channelList = screen.getByRole("list", {
      name: "Schedule channels",
    });
    const mainChannel = within(channelList)
      .getByText("Main light")
      .closest("button");
    const accentChannel = within(channelList)
      .getByText("Accent light")
      .closest("button");
    if (mainChannel === null || accentChannel === null) {
      throw new Error("Channel list controls are missing");
    }
    expect(mainChannel.getAttribute("aria-pressed")).toBe("true");

    const accentLine = graph.querySelector('polyline[stroke="#a84aa7"]');
    if (accentLine === null) throw new Error("Accent graph line is missing");
    fireEvent.click(accentLine);
    expect(mainChannel.getAttribute("aria-pressed")).toBe("true");

    await user.click(accentChannel);
    expect(accentChannel.getAttribute("aria-pressed")).toBe("true");
    expect(
      screen.getByRole("heading", { level: 2, name: "Accent light" }),
    ).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Manage channels" }));
    expect(
      screen.getByRole("dialog", { name: "Manage channels" }),
    ).toBeTruthy();
    expect(screen.queryByText("light-main")).toBeNull();
    await user.click(
      screen.getByRole("button", { name: "Close channel manager" }),
    );

    await user.click(screen.getByRole("button", { name: "Pin mappings" }));
    expect(
      screen.getByRole("dialog", { name: "Mapping profiles" }),
    ).toBeTruthy();
    await user.click(
      screen.getByRole("button", { name: "Target for mapping 1" }),
    );
    await user.type(
      screen.getByLabelText("Search all channel targets"),
      "Return",
    );
    expect(
      screen.getByRole("option", { name: /Pumps.*Return pump/u }),
    ).toBeTruthy();
    await user.click(
      screen.getByRole("button", { name: "Close target picker" }),
    );
    expect(screen.getByRole("button", { name: "Delete profile" })).toBeTruthy();
    await user.click(
      screen.getByRole("button", { name: "Close mapping profiles" }),
    );

    expect(screen.getByText(/5\.0\.0-beta\.1.*update available/u)).toBeTruthy();
    expect(screen.getByText(/3\.2\.0.*upgrade required/u)).toBeTruthy();
    const mainDevice = screen.getByRole("article", {
      name: "ESP32 device device-main",
    });
    expect(within(mainDevice).getByText("ID: DEVICE-MAIN")).toBeTruthy();
    expect(
      within(mainDevice).getByRole("button", {
        name: "Hide device-main until it reconnects",
      }),
    ).toBeTruthy();
  });

  it("saves an exact manually entered time and multiplier atomically", async () => {
    const requests: RecordedRequest[] = [];
    installConfigurationSaveHandlers(requests);
    const refresh = vi.fn();
    const user = renderControlArea(
      "/control/lights",
      controllerState(createTestControlSnapshot(), refresh),
    );

    fireEvent.change(
      screen.getByLabelText("Main light selected point local time"),
      { target: { value: "00:07" } },
    );
    fireEvent.change(screen.getByLabelText("Lights schedule multiplier"), {
      target: { value: "75" },
    });

    expect(screen.getAllByText("Unsaved")).toHaveLength(2);
    await user.click(
      screen.getByRole("button", { name: "Save configuration" }),
    );

    await waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0]?.path).toBe(
      "/api/control-areas/lights/schedule-configuration",
    );
    expect(requests[0]?.body).toMatchObject({
      expectedRevision: 8,
      schedules: [
        expect.objectContaining({
          channelId: "light-main",
          points: expect.arrayContaining([
            expect.objectContaining({
              minuteOfDay: localMinuteToUtcMinute(
                7,
                new Date().getTimezoneOffset(),
              ),
            }),
          ]),
        }),
      ],
      throttlePercentage: 75,
    });
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("undoes and redoes schedule and multiplier edits in one history", async () => {
    const user = renderControlArea(
      "/control/lights",
      controllerState(createTestControlSnapshot(), vi.fn()),
    );
    const output = screen.getByLabelText(
      "Main light selected point output",
    ) as HTMLInputElement;
    const multiplier = screen.getByLabelText(
      "Lights schedule multiplier",
    ) as HTMLInputElement;

    fireEvent.change(output, { target: { value: "65" } });
    fireEvent.blur(output);
    fireEvent.change(multiplier, { target: { value: "75" } });
    fireEvent.blur(multiplier);

    await user.click(screen.getByRole("button", { name: "Undo" }));
    expect(output.value).toBe("65");
    expect(multiplier.value).toBe("80");

    await user.click(screen.getByRole("button", { name: "Undo" }));
    expect(output.value).toBe("0");

    await user.click(screen.getByRole("button", { name: "Redo" }));
    expect(output.value).toBe("65");
    await user.click(screen.getByRole("button", { name: "Redo" }));
    expect(multiplier.value).toBe("75");
  });

  it("protects unsaved configuration from route changes and page unloads", async () => {
    const user = renderControlArea(
      "/control/lights",
      controllerState(createTestControlSnapshot(), vi.fn()),
    );

    fireEvent.change(screen.getByLabelText("Lights schedule multiplier"), {
      target: { value: "75" },
    });

    const unload = new Event("beforeunload", { cancelable: true });
    window.dispatchEvent(unload);
    expect(unload.defaultPrevented).toBe(true);

    const overviewLinks = screen.getAllByRole("link", { name: "Overview" });
    const overviewLink = overviewLinks.at(-1);
    if (overviewLink === undefined) {
      throw new Error("Control area did not render its overview link");
    }
    await user.click(overviewLink);
    const confirmation = screen.getByRole("alertdialog", {
      name: "Save changes before leaving?",
    });
    expect(
      screen.getByRole("heading", { level: 1, name: "Lights" }),
    ).toBeTruthy();

    await user.click(
      within(confirmation).getByRole("button", { name: "Keep editing" }),
    );
    expect(screen.queryByRole("alertdialog")).toBeNull();

    await user.click(overviewLink);
    await user.click(
      within(screen.getByRole("alertdialog")).getByRole("button", {
        name: "Discard changes",
      }),
    );
    expect(
      await screen.findByRole("heading", { level: 1, name: "Overview" }),
    ).toBeTruthy();
  });

  it("keeps revision-protected configuration saves available while live state is stale", async () => {
    const snapshot = createTestControlSnapshot();
    renderControlArea(
      "/control/lights",
      controllerState(snapshot, vi.fn(), true),
    );

    fireEvent.change(
      screen.getByLabelText("Main light selected point local time"),
      { target: { value: "00:07" } },
    );

    expect(
      (
        screen.getByRole("button", {
          name: "Save configuration",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false);
    expect(
      (
        screen.getByRole("slider", {
          name: "Main light temporary override",
        }) as HTMLInputElement
      ).disabled,
    ).toBe(true);
    expect(screen.getByText(/Controller state is stale/u)).toBeTruthy();
  });

  it("keeps live controls available during a normal snapshot refresh", () => {
    const snapshot = createTestControlSnapshot();
    renderControlArea("/control/lights", {
      ...controllerState(snapshot, vi.fn()),
      dataStale: true,
    });

    expect(screen.queryByText(/Controller state is connected/u)).toBeNull();
    expect(
      (
        screen.getByRole("slider", {
          name: "Main light temporary override",
        }) as HTMLInputElement
      ).disabled,
    ).toBe(false);
  });

  it("uses unsaved graph points as the scheduled baseline for test sliders", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-07-13T10:00:00.000Z"));
    try {
      const snapshot = createTestControlSnapshot();
      renderControlArea(
        "/control/lights",
        controllerState({ ...snapshot, overrides: [] }, vi.fn()),
      );
      const overrideSlider = screen.getByRole("slider", {
        name: "Main light temporary override",
      });
      expect(overrideSlider).toHaveProperty("value", "40");

      fireEvent.change(
        screen.getByLabelText("Main light selected point output"),
        { target: { value: "100" } },
      );

      await waitFor(() => expect(overrideSlider).toHaveProperty("value", "53"));
    } finally {
      vi.useRealTimers();
    }
  });

  it("rebases unsaved configuration after an unrelated snapshot revision", async () => {
    const requests: RecordedRequest[] = [];
    installConfigurationSaveHandlers(requests);
    const snapshot = createTestControlSnapshot();
    const user = renderControlArea(
      "/control/lights",
      controllerState(snapshot, vi.fn()),
    );

    fireEvent.change(
      screen.getByLabelText("Main light selected point output"),
      { target: { value: "65" } },
    );
    fireEvent.change(screen.getByLabelText("Lights schedule multiplier"), {
      target: { value: "73" },
    });

    user.rerenderState(
      controllerState({ ...snapshot, revision: snapshot.revision + 1 }, vi.fn()),
    );
    await user.click(
      screen.getByRole("button", { name: "Save configuration" }),
    );

    await waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0]?.body.expectedRevision).toBe(snapshot.revision + 1);
    expect(
      screen.queryByText(/Controller configuration advanced/u),
    ).toBeNull();
    expect(screen.queryByText(/This schedule changed/u)).toBeNull();
  });

  it("preserves a multiplier draft and explicitly rebases after a revision conflict", async () => {
    const revisions: number[] = [];
    server.use(
      http.put(
        "http://localhost/api/control-areas/lights/schedule-configuration",
        async ({ request }) => {
        const body = (await request.json()) as {
          readonly expectedRevision: number;
        };
        revisions.push(body.expectedRevision);
        if (revisions.length === 1) {
          return HttpResponse.json(
            {
              code: "revision_conflict",
              message: "State revision changed",
              expectedRevision: body.expectedRevision,
              currentRevision: 9,
            },
            { status: 409 },
          );
        }
        return HttpResponse.json({
          changed: true,
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

    fireEvent.change(screen.getByLabelText("Lights schedule multiplier"), {
      target: { value: "73" },
    });
    await user.click(
      screen.getByRole("button", { name: "Save configuration" }),
    );
    expect(
      await screen.findByText(
        /Controller configuration advanced to revision 9/u,
      ),
    ).toBeTruthy();
    expect(screen.getByLabelText("Lights schedule multiplier")).toHaveProperty(
      "value",
      "73",
    );

    user.rerenderState(controllerState({ ...snapshot, revision: 9 }, refresh));
    await user.click(
      screen.getByRole("button", {
        name: "Keep local multiplier with refreshed revision",
      }),
    );
    await user.click(
      screen.getByRole("button", { name: "Save configuration" }),
    );

    await waitFor(() => expect(revisions).toEqual([8, 9]));
  });

  it("rebases a dirty multiplier with the accepted schedule conflict", async () => {
    const requests: RecordedRequest[] = [];
    let saveAttempts = 0;
    server.use(
      http.put(
        "http://localhost/api/control-areas/lights/schedule-configuration",
        async ({ request }) => {
          const body = (await request.json()) as RecordedRequest["body"];
          requests.push({
            path: new URL(request.url).pathname,
            body,
          });
          const expectedRevision = body.expectedRevision;
          if (typeof expectedRevision !== "number") {
            throw new Error("Schedule request omitted expectedRevision");
          }
          saveAttempts += 1;
          if (saveAttempts === 1) {
            return HttpResponse.json(
              {
                code: "revision_conflict",
                message: "State revision changed",
                expectedRevision,
                currentRevision: 9,
              },
              { status: 409 },
            );
          }
          return HttpResponse.json({
            changed: false,
            revision: expectedRevision + 1,
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

    fireEvent.change(
      screen.getByLabelText("Main light selected point output"),
      { target: { value: "65" } },
    );
    fireEvent.change(screen.getByLabelText("Lights schedule multiplier"), {
      target: { value: "73" },
    });
    await user.click(
      screen.getByRole("button", { name: "Save configuration" }),
    );
    expect(
      await screen.findByRole("button", {
        name: "Keep local draft with refreshed revision",
      }),
    ).toBeTruthy();

    user.rerenderState(controllerState({ ...snapshot, revision: 9 }, refresh));
    await user.click(
      screen.getByRole("button", {
        name: "Keep local draft with refreshed revision",
      }),
    );
    await user.click(
      screen.getByRole("button", { name: "Save configuration" }),
    );

    await waitFor(() => expect(requests).toHaveLength(2));
    expect(requests.map(({ path }) => path)).toEqual([
      "/api/control-areas/lights/schedule-configuration",
      "/api/control-areas/lights/schedule-configuration",
    ]);
    expect(requests.map(({ body }) => body.expectedRevision)).toEqual([
      8, 9,
    ]);
    expect(requests[1]?.body.throttlePercentage).toBe(73);
  });

  it("preserves a dirty schedule when a newer graph arrives until explicit acceptance", async () => {
    const requests: RecordedRequest[] = [];
    installConfigurationSaveHandlers(requests);
    const snapshot = createTestControlSnapshot();
    const user = renderControlArea(
      "/control/lights",
      controllerState(snapshot, vi.fn()),
    );

    fireEvent.change(
      screen.getByLabelText("Main light selected point output"),
      { target: { value: "65" } },
    );

    const advanced: ControllerSnapshot = {
      ...snapshot,
      revision: 9,
      schedules: snapshot.schedules.map((schedule) =>
        schedule.channelId === "light-main"
          ? {
              ...schedule,
              graphRevision: schedule.graphRevision + 1,
              updatedAt: "2026-07-13T10:01:00.000Z",
              points: schedule.points.map((point) =>
                point.minuteOfDay === 720
                  ? { ...point, percentage: 70 }
                  : point,
              ),
            }
          : schedule,
      ),
    };
    user.rerenderState(controllerState(advanced, vi.fn()));

    expect(
      await screen.findByText(
        /This schedule changed at controller revision 9/u,
      ),
    ).toBeTruthy();
    expect(
      (
        screen.getByLabelText(
          "Main light selected point output",
        ) as HTMLInputElement
      ).value,
    ).toBe("65");
    await user.click(
      screen.getByRole("button", {
        name: "Keep local draft with refreshed revision",
      }),
    );
    await waitFor(() =>
      expect(
        screen.queryByText(/This schedule changed at controller revision 9/u),
      ).toBeNull(),
    );
    await user.click(
      screen.getByRole("button", { name: "Save configuration" }),
    );
    await waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0]?.body.expectedRevision).toBe(9);
  });

  it("keeps the device and revision captured when its editor opens", async () => {
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
    const device = screen.getByRole("article", {
      name: "ESP32 device device-main",
    });

    await user.click(within(device).getByRole("button", { name: "Edit" }));
    fireEvent.change(screen.getByLabelText("PWM frequency (Hz)"), {
      target: { value: "2000" },
    });
    user.rerenderState(controllerState({ ...snapshot, revision: 9 }, refresh));
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(requestBody).toEqual({
        expectedRevision: 8,
        pwmFrequencyHz: 2_000,
      }),
    );
    expect(refresh).toHaveBeenCalledOnce();
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
      screen.getByText(/Loading the authoritative snapshot/u),
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

function installConfigurationSaveHandlers(requests: RecordedRequest[]): void {
  const handler = async ({ request }: { readonly request: Request }) => {
    const body = (await request.json()) as RecordedRequest["body"];
    requests.push({
      path: new URL(request.url).pathname,
      body,
    });
    const expectedRevision = body.expectedRevision;
    if (typeof expectedRevision !== "number") {
      throw new Error("Configuration request omitted expectedRevision");
    }
    return HttpResponse.json({
      changed: false,
      revision: expectedRevision + 1,
      event: null,
    });
  };
  server.use(
    http.put(
      "http://localhost/api/control-areas/lights/schedule-configuration",
      handler,
    ),
  );
}

function withAccentLight(snapshot: ControllerSnapshot): ControllerSnapshot {
  const sourceChannel = required(
    snapshot.channels.find((channel) => channel.id === "light-main"),
    "main light channel",
  );
  const sourceSchedule = required(
    snapshot.schedules.find(
      (schedule) => schedule.channelId === sourceChannel.id,
    ),
    "main light schedule",
  );
  const channel: Channel = {
    ...sourceChannel,
    id: "light-accent",
    name: "Accent light",
    color: "#a84aa7",
    displayOrder: 1,
  };
  const schedule: ScheduleGraph = {
    ...sourceSchedule,
    id: channel.id,
    channelId: channel.id,
    name: "Accent light UTC schedule",
    points: sourceSchedule.points.map((point) => ({
      ...point,
      id: point.id.replace("light-main", "light-accent"),
    })),
  };
  return {
    ...snapshot,
    channels: [...snapshot.channels, channel],
    schedules: [...snapshot.schedules, schedule],
  };
}

function required<T>(value: T | undefined, label: string): T {
  if (value === undefined) throw new Error(`Missing ${label}`);
  return value;
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
  const router = createMemoryRouter(
    [
      {
        path: "*",
        element: createElement(App),
      },
    ],
    { initialEntries: [path] },
  );
  const renderTree = (value: ControllerStateContextValue) =>
    createElement(QueryClientProvider, {
      client: queryClient,
      children: createElement(ControllerStateContext.Provider, {
        value,
        children: createElement(RouterProvider, {
          router,
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
