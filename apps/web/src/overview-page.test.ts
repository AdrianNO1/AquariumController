// @vitest-environment jsdom
// @vitest-environment-options {"url":"http://localhost/"}

import type { ControllerSnapshot } from "@aquarium/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen } from "@testing-library/react";
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
  window.localStorage.clear();
});

afterAll(() => {
  server.close();
  globalThis.fetch = nativeFetch;
});

describe("maintainer overview", () => {
  it("shows compact system stats, tucked-away utilities, and all control areas", async () => {
    installHealthyApi();
    const snapshot = overviewSnapshot();

    const user = renderOverview(controllerState(snapshot));

    expect(screen.getByRole("heading", { name: "Overview" })).toBeTruthy();
    expect(screen.getByText("1 online")).toBeTruthy();
    expect(screen.getByText("2 registered")).toBeTruthy();
    expect(screen.getByText("1 device")).toBeTruthy();
    expect(screen.getByText("1 offline")).toBeTruthy();
    expect(screen.getByText("1 active")).toBeTruthy();

    expect(screen.getByRole("link", { name: "Overview" })).toBeTruthy();
    for (const name of ["Operations", "Alerts", "Logs"]) {
      expect(screen.queryByRole("link", { name })).toBeNull();
    }
    await user.click(
      screen.getByRole("button", { name: "Adrian sine knapper" }),
    );
    for (const name of ["Operations", "Alerts", "Logs"]) {
      expect(screen.getByRole("link", { name })).toBeTruthy();
    }

    const expectedAreas = [
      ["Lights", "/control/lights"],
      ["Pumps", "/control/pumps"],
      ["Test lights", "/control/testlights"],
      ["Bad", "/control/bad"],
      ["Loft", "/control/loft"],
      ["Biljard", "/control/biljard"],
      ["Frag tank", "/control/frag"],
      ["Quarantine 1", "/control/qt1"],
      ["Quarantine 2", "/control/qt2"],
      ["Quarantine 3", "/control/qt3"],
      ["Quarantine 4", "/control/qt4"],
    ] as const;
    for (const [name, href] of expectedAreas) {
      expect(
        screen
          .getByRole("link", { name: new RegExp(`^${name}`) })
          .getAttribute("href"),
      ).toBe(href);
    }
    expect(await screen.findByText(/API checked/u)).toBeTruthy();

    expect(screen.queryByText("One controller, clear boundaries.")).toBeNull();
    expect(screen.queryByText("Foundation milestone")).toBeNull();
    expect(screen.queryByText("Migration map")).toBeNull();
  });

  it("makes stale controller and health failures explicit and retryable", async () => {
    server.use(
      http.get("http://localhost/api/health", () =>
        HttpResponse.text("Unavailable", { status: 503 }),
      ),
    );
    const retry = vi.fn();
    const user = renderOverview({
      ...controllerState(overviewSnapshot()),
      status: "stale",
      dataStale: true,
      error: "Controller event stream stalled",
      retry,
    });

    expect(screen.getByText("Stale")).toBeTruthy();
    expect(screen.getByText(/refresh pending/u)).toBeTruthy();
    expect(screen.getByText("Controller event stream stalled")).toBeTruthy();
    expect(
      await screen.findByText("Health request failed with HTTP 503"),
    ).toBeTruthy();

    await user.click(
      screen.getByRole("button", { name: "Retry state connection" }),
    );
    expect(retry).toHaveBeenCalledOnce();
  });

  it("shows maintenance navigation on the overview when developer mode is enabled", () => {
    installHealthyApi();
    window.localStorage.setItem("dev", "true");

    renderOverview(controllerState(overviewSnapshot()));

    for (const name of ["Operations", "Alerts", "Logs"]) {
      expect(screen.getByRole("link", { name })).toBeTruthy();
    }
  });

  it("flags online devices with firmware or configuration warnings", () => {
    installHealthyApi();
    const snapshot = createTestControlSnapshot();
    const sourceDevice = snapshot.devices[0];
    if (sourceDevice === undefined) {
      throw new Error("Test snapshot is missing its primary ESP32 device");
    }
    const warningSnapshot: ControllerSnapshot = {
      ...snapshot,
      devices: [
        {
          ...sourceDevice,
          status: "online",
          reported: {
            ...sourceDevice.reported,
            name: sourceDevice.desired.name,
            pwmFrequencyHz: sourceDevice.desired.pwmFrequencyHz,
            pwmResolutionBits: sourceDevice.desired.pwmResolutionBits,
          },
          lastError: {
            code: "firmware_unsupported",
            message: "Firmware version is unsupported",
          },
        },
      ],
    };

    renderOverview(controllerState(warningSnapshot));

    expect(screen.getByText("1 device")).toBeTruthy();
    expect(screen.getByText("1 warning")).toBeTruthy();
    expect(
      screen.getByRole("link", { name: /^Lights.*Needs attention/u }),
    ).toBeTruthy();
  });
});

function installHealthyApi(): void {
  server.use(
    http.get("http://localhost/api/health", () =>
      HttpResponse.json({
        service: "aquarium-controller",
        status: "ok",
        version: "0.1.0",
        now: "2026-07-13T10:00:00.000Z",
        capabilities: ["http", "sse"],
      }),
    ),
  );
}

function overviewSnapshot(): ControllerSnapshot {
  const snapshot = createTestControlSnapshot();
  return {
    ...snapshot,
    devices: snapshot.devices.map((device, index) => ({
      ...device,
      status: index === 0 ? "online" : "offline",
      reported:
        index === 0
          ? {
              ...device.reported,
              name: device.desired.name,
              pwmFrequencyHz: device.desired.pwmFrequencyHz,
              pwmResolutionBits: device.desired.pwmResolutionBits,
            }
          : device.reported,
      lastError:
        index === 0
          ? null
          : { code: "device_offline", message: "Announcement is overdue" },
    })),
  };
}

function controllerState(
  snapshot: ControllerSnapshot,
): ControllerStateContextValue {
  return {
    status: "connected",
    snapshot,
    revision: snapshot.revision,
    dataStale: false,
    isRefreshing: false,
    lastMessageAt: "2026-07-13T10:00:00.000Z",
    error: null,
    refresh: vi.fn(),
    retry: vi.fn(),
  };
}

function renderOverview(state: ControllerStateContextValue) {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  const rendered = render(
    createElement(QueryClientProvider, {
      client: queryClient,
      children: createElement(ControllerStateContext.Provider, {
        value: state,
        children: createElement(MemoryRouter, {
          initialEntries: ["/"],
          children: createElement(App),
        }),
      }),
    }),
  );
  return Object.assign(userEvent.setup(), {
    unmount: rendered.unmount,
  });
}
