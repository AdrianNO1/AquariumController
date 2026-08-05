// @vitest-environment jsdom
// @vitest-environment-options {"url":"http://localhost/"}

import type { Channel, ControlArea } from "@aquarium/contracts";
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
import {
  afterAll,
  afterEach,
  beforeAll,
  describe,
  expect,
  it,
  vi,
} from "vitest";

import { ChannelManagementDialog } from "./ChannelManagementDialog.js";
import { chooseDistinctChannelColor } from "./channel-color.js";

const timestamp = "2026-07-13T10:00:00.000Z";
const area: ControlArea = {
  slug: "lights",
  typeKey: "light",
  label: "Lights",
};
const channels: readonly Channel[] = [
  channel("channel-white", "White", "#87959e", 0),
  channel("channel-blue", "Blue", "#0aa0c0", 1),
];
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

describe("ChannelManagementDialog", () => {
  it("keeps identifiers hidden and saves the complete channel edit atomically", async () => {
    const requests: Array<{
      readonly expectedRevision: number;
      readonly channels: readonly {
        readonly id: string;
        readonly name: string;
        readonly color: string;
      }[];
    }> = [];
    server.use(
      http.put("http://localhost/api/control-areas/lights/channels", async ({ request }) => {
        requests.push((await request.json()) as (typeof requests)[number]);
        return HttpResponse.json({
          changed: false,
          revision: 9,
          event: null,
        });
      }),
    );
    const refresh = vi.fn();
    const onClose = vi.fn();
    const user = userEvent.setup();
    renderDialog({ refresh, onClose });

    expect(screen.queryByText("channel-white")).toBeNull();
    expect(screen.queryByText("channel-blue")).toBeNull();
    expect(screen.getByRole("button", { name: "Delete White" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Delete Blue" })).toBeTruthy();

    const whiteName = screen.getByLabelText("Channel name for White");
    await user.clear(whiteName);
    await user.type(whiteName, "Warm white");
    fireEvent.change(screen.getByLabelText("Color for Warm white"), {
      target: { value: "#db5451" },
    });

    const newColor = screen.getByLabelText(
      "New channel color",
    ) as HTMLInputElement;
    expect(channels.map((item) => item.color)).not.toContain(newColor.value);
    const distinctNewColor = newColor.value;
    await user.type(
      screen.getByRole("textbox", { name: "New channel" }),
      "Moonlight",
    );
    await user.click(screen.getByRole("button", { name: "Add" }));

    expect(screen.getByLabelText("Channel name for Moonlight")).toBeTruthy();
    expect(screen.queryByText(/^channel-/u)).toBeNull();
    await user.click(screen.getByRole("button", { name: "Save changes" }));

    await waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0]).toMatchObject({
      expectedRevision: 8,
      channels: [
        {
          id: "channel-white",
          name: "Warm white",
          color: "#db5451",
        },
        { id: "channel-blue", name: "Blue", color: "#0aa0c0" },
        { name: "Moonlight", color: distinctNewColor },
      ],
    });
    expect(requests[0]?.channels[2]?.id).toMatch(/^channel-/u);
    expect(refresh).toHaveBeenCalledOnce();
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("chooses a palette color that is not already in use", () => {
    const existing = ["#6c54d8", "#a84aa7", "#315bd6", "#0aa0c0", "#87959e"];

    expect(existing).not.toContain(chooseDistinctChannelColor(existing));
  });

  it("requires dirty changes to be saved or discarded before backdrop close", async () => {
    const onClose = vi.fn();
    const user = userEvent.setup();
    renderDialog({ onClose });
    const name = screen.getByLabelText("Channel name for White");
    await user.clear(name);
    await user.type(name, "Warm white");
    const backdrop = screen.getByRole("dialog", {
      name: "Manage channels",
    }).parentElement;
    if (backdrop === null) throw new Error("Channel backdrop is missing");

    await user.pointer({ target: backdrop, keys: "[MouseLeft]" });

    expect(onClose).not.toHaveBeenCalled();
    const confirmation = screen.getByRole("alertdialog", {
      name: "Save changes before closing?",
    });
    await user.click(
      within(confirmation).getByRole("button", { name: "Discard changes" }),
    );
    expect(onClose).toHaveBeenCalledOnce();
  });
});

function renderDialog({
  refresh = vi.fn(),
  onClose = vi.fn(),
}: {
  readonly refresh?: () => void;
  readonly onClose?: () => void;
} = {}): void {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  render(
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(ChannelManagementDialog, {
        area,
        channels,
        throttleId: "throttle-light",
        expectedRevision: 8,
        refresh,
        onClose,
      }),
    ),
  );
}

function channel(
  id: string,
  name: string,
  color: string,
  displayOrder: number,
): Channel {
  return {
    id,
    name,
    color,
    typeKey: "light",
    throttleId: "throttle-light",
    displayOrder,
    enabled: true,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}
