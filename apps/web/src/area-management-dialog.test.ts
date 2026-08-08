// @vitest-environment jsdom
// @vitest-environment-options {"url":"http://localhost/"}

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { HttpResponse, http } from "msw";
import { setupServer } from "msw/node";
import { createElement } from "react";
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { AreaManagementDialog } from "./AreaManagementDialog.js";

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

describe("area management dialog", () => {
  it("confirms unsaved closes and saves deletes, renames, and additions", async () => {
    const requests: Array<{ readonly method: string; readonly body: object }> =
      [];
    server.use(
      http.put("http://localhost/api/control-areas", async ({ request }) => {
        requests.push({
          method: request.method,
          body: (await request.json()) as object,
        });
        return HttpResponse.json({
          changed: false,
          revision: 8,
          event: null,
        });
      }),
    );
    const refresh = vi.fn();
    const onClose = vi.fn();
    const user = userEvent.setup();
    renderDialog(refresh, onClose);

    const lightsName = screen.getByDisplayValue("Lights");
    await user.clear(lightsName);
    await user.type(lightsName, "Main lights");
    await user.click(
      screen.getByRole("button", { name: "Close area manager" }),
    );
    const confirmation = screen.getByRole("alertdialog", {
      name: "Save changes before closing?",
    });
    expect(confirmation).toBeTruthy();
    await user.click(
      within(confirmation).getByRole("button", { name: "Keep editing" }),
    );

    const badRow = screen
      .getByDisplayValue("Bad")
      .closest<HTMLElement>(".area-management-row");
    if (badRow === null) throw new Error("Missing Bad area row");
    await user.click(within(badRow).getByRole("button", { name: "Delete" }));
    await user.type(screen.getByLabelText("New area"), "Anemone tank");
    await user.click(screen.getByRole("button", { name: "Add" }));
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    expect(requests).toEqual([
      {
        method: "PUT",
        body: {
          expectedRevision: 8,
          areas: [
            { slug: "lights", label: "Main lights" },
            { slug: null, label: "Anemone tank" },
          ],
        },
      },
    ]);
    expect(refresh).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("allows an area deletion to include its unreferenced channels and outputs", async () => {
    const user = userEvent.setup();
    renderDialog(vi.fn(), vi.fn());

    const lightsRow = screen
      .getByDisplayValue("Lights")
      .closest<HTMLElement>(".area-management-row");
    if (lightsRow === null) throw new Error("Missing Lights area row");
    const deleteButton = within(lightsRow).getByRole("button", {
      name: "Delete",
    });
    expect(deleteButton.hasAttribute("disabled")).toBe(false);
    expect(deleteButton.getAttribute("title")).toBe(
      "Delete area with 1 channel and 0 outputs",
    );
    expect(
      screen.getByText(/removes its unreferenced channels, schedules, and outputs atomically/u),
    ).toBeTruthy();

    await user.click(deleteButton);
    expect(screen.queryByDisplayValue("Lights")).toBeNull();
  });
});

function renderDialog(refresh: () => void, onClose: () => void): void {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  render(
    createElement(QueryClientProvider, {
      client: queryClient,
      children: createElement(AreaManagementDialog, {
        areas: [
          { slug: "lights", typeKey: "light", label: "Lights" },
          { slug: "bad", typeKey: "bad", label: "Bad" },
        ],
        channels: [
          {
            id: "channel-main",
            name: "Main",
            color: "#6f5bd5",
            typeKey: "light",
            throttleId: "throttle-light",
            displayOrder: 0,
            enabled: true,
            createdAt: "2026-07-13T10:00:00.000Z",
            updatedAt: "2026-07-13T10:00:00.000Z",
          },
        ],
        outputs: [],
        expectedRevision: 8,
        refresh,
        onClose,
      }),
    }),
  );
}
