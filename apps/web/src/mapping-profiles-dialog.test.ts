// @vitest-environment jsdom
// @vitest-environment-options {"url":"http://localhost/"}

import type {
  Channel,
  ControlArea,
  MappingProfile,
  Output,
} from "@aquarium/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  cleanup,
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

import {
  MappingProfilesDialog,
  type MappingProfilesDialogProps,
} from "./MappingProfilesDialog.js";

const timestamp = "2026-07-13T10:00:00.000Z";
const controlAreas: readonly ControlArea[] = [
  { slug: "lights", typeKey: "light", label: "Lights" },
  { slug: "pumps", typeKey: "pump", label: "Pumps" },
];
const channels: readonly Channel[] = [
  {
    id: "channel-light",
    name: "White",
    color: "#80909a",
    typeKey: "light",
    throttleId: "throttle-light",
    displayOrder: 0,
    enabled: true,
    createdAt: timestamp,
    updatedAt: timestamp,
  },
  {
    id: "channel-pump",
    name: "Return pump",
    color: "#2aa7a0",
    typeKey: "pump",
    throttleId: "throttle-pump",
    displayOrder: 0,
    enabled: true,
    createdAt: timestamp,
    updatedAt: timestamp,
  },
];
const outputs: readonly Output[] = [
  {
    id: "output-emergency",
    name: "Emergency relay",
    typeKey: "pump",
    displayOrder: 0,
    enabled: true,
    outputGain: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
  },
];
const profile: MappingProfile = {
  id: "profile-main",
  name: "Main rack",
  deviceNamePrefix: "main",
  outputGain: 1,
  createdAt: timestamp,
  updatedAt: timestamp,
  mappings: [
    {
      id: "mapping-white",
      pin: 4,
      displayOrder: 0,
      enabled: true,
      target: { kind: "channel", id: "channel-light" },
    },
  ],
};

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

describe("MappingProfilesDialog", () => {
  it("keeps identifiers hidden and searches area-qualified global targets", async () => {
    const user = userEvent.setup();
    renderDialog();

    expect(screen.getByText("Main rack")).toBeTruthy();
    expect(screen.queryByText("profile-main")).toBeNull();
    expect(screen.queryByText("mapping-white")).toBeNull();

    await user.click(
      screen.getByRole("button", { name: "Target for mapping 1" }),
    );
    const search = screen.getByRole("searchbox", {
      name: "Search all channel targets",
    });
    expect((search as HTMLInputElement).value).toBe("");
    expect(screen.getByRole("option", { name: "Lights · White" })).toBeTruthy();
    expect(
      screen.getByRole("option", { name: "Pumps · Return pump" }),
    ).toBeTruthy();

    await user.type(search, "return");
    expect(screen.queryByRole("option", { name: "Lights · White" })).toBeNull();
    expect(
      screen.getByRole("option", { name: "Pumps · Return pump" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Target for mapping 1" }).textContent,
    ).toBe("Lights · White");
  });

  it("preserves the current target until an output is chosen and saves typed data", async () => {
    const requests: Array<{
      readonly profileId: string;
      readonly body: Record<string, object | string | number>;
    }> = [];
    server.use(
      http.put(
        "http://localhost/api/mapping-profiles/:profileId",
        async ({ params, request }) => {
          requests.push({
            profileId: String(params.profileId),
            body: (await request.json()) as Record<
              string,
              object | string | number
            >,
          });
          return HttpResponse.json({
            changed: false,
            revision: 8,
            event: null,
          });
        },
      ),
    );
    const user = userEvent.setup();
    renderDialog();

    await user.selectOptions(
      screen.getByRole("combobox", { name: "Target type for mapping 1" }),
      "output",
    );
    const targetButton = screen.getByRole("button", {
      name: "Target for mapping 1",
    });
    expect(targetButton.textContent).toBe(
      "Choose output target (currently Lights · White)",
    );
    expect(
      (
        screen.getByRole("button", {
          name: "Save profile",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);

    await user.click(targetButton);
    const search = screen.getByRole("searchbox", {
      name: "Search all output targets",
    });
    expect((search as HTMLInputElement).value).toBe("");
    await user.click(
      screen.getByRole("option", { name: "Pumps · Emergency relay" }),
    );
    expect(document.activeElement).toBe(targetButton);
    await user.clear(
      screen.getByRole("spinbutton", { name: "Output multiplier" }),
    );
    await user.type(
      screen.getByRole("spinbutton", { name: "Output multiplier" }),
      "0.65",
    );
    await user.click(screen.getByRole("button", { name: "Save profile" }));

    await waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0]?.profileId).toBe("profile-main");
    expect(requests[0]?.body).toMatchObject({
      expectedRevision: 8,
      name: "Main rack",
      deviceNamePrefix: "main",
      outputGain: 0.65,
      mappings: [
        {
          pin: 4,
          displayOrder: 0,
          enabled: true,
          target: { kind: "output", id: "output-emergency" },
        },
      ],
    });
  });

  it("preserves a pinned draft across refresh and explains profile deletion", async () => {
    const revisions: number[] = [];
    const deletions: Array<{ readonly id: string; readonly revision: number }> =
      [];
    server.use(
      http.put(
        "http://localhost/api/mapping-profiles/:profileId",
        async ({ request }) => {
          const body = (await request.json()) as {
            readonly expectedRevision: number;
          };
          revisions.push(body.expectedRevision);
          return HttpResponse.json({
            changed: false,
            revision: body.expectedRevision,
            event: null,
          });
        },
      ),
      http.delete(
        "http://localhost/api/mapping-profiles/:profileId",
        async ({ params, request }) => {
          const body = (await request.json()) as {
            readonly expectedRevision: number;
          };
          deletions.push({
            id: String(params.profileId),
            revision: body.expectedRevision,
          });
          return HttpResponse.json({
            changed: false,
            revision: body.expectedRevision,
            event: null,
          });
        },
      ),
    );
    const user = userEvent.setup();
    const rendered = renderDialog();
    const nameInput = screen.getByRole("textbox", { name: "Profile name" });
    await user.clear(nameInput);
    await user.type(nameInput, "Local draft");

    rendered.rerender(
      renderTree({
        expectedRevision: 9,
        profiles: [{ ...profile, name: "Server rename" }],
      }),
    );
    expect(
      (
        screen.getByRole("textbox", {
          name: "Profile name",
        }) as HTMLInputElement
      ).value,
    ).toBe("Local draft");
    await user.click(screen.getByRole("button", { name: "Save profile" }));
    await waitFor(() => expect(revisions).toEqual([8]));

    await user.click(screen.getByRole("button", { name: "Delete profile" }));
    expect(
      screen.getByText(
        /Devices referencing this profile will become unmapped/u,
      ),
    ).toBeTruthy();
    const deleteButtons = screen.getAllByRole("button", {
      name: "Delete profile",
    });
    const confirmDelete = deleteButtons.at(-1);
    if (confirmDelete === undefined) {
      throw new Error("Delete confirmation button was not rendered");
    }
    await user.click(confirmDelete);
    await waitFor(() =>
      expect(deletions).toEqual([{ id: "profile-main", revision: 9 }]),
    );
    expect(screen.getByText("No mapping profiles exist yet.")).toBeTruthy();
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Close mapping profiles" }),
    );
  });

  it("contains focus in delete confirmation and Escape returns to the profile editor", async () => {
    const user = userEvent.setup();
    renderDialog();
    const openConfirmation = screen.getByRole("button", {
      name: "Delete profile",
    });

    await user.click(openConfirmation);

    const confirmation = screen.getByRole("alertdialog", {
      name: "Delete Main rack?",
    });
    expect(confirmation.contains(document.activeElement)).toBe(true);
    expect(
      within(confirmation).getByRole("button", { name: "Delete profile" }),
    ).toBeTruthy();

    await user.keyboard("{Escape}");

    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(
      screen.getByRole("dialog", { name: "Mapping profiles" }),
    ).toBeTruthy();
    expect(document.activeElement).toBe(openConfirmation);
  });

  it("keeps focus inside the outer dialog while a newly saved editor is replaced", async () => {
    server.use(
      http.put("http://localhost/api/mapping-profiles/:profileId", () =>
        HttpResponse.json({
          changed: false,
          revision: 9,
          event: null,
        }),
      ),
    );
    const user = userEvent.setup();
    renderDialog();

    await user.click(screen.getByRole("button", { name: "New profile" }));
    await user.type(
      screen.getByRole("textbox", { name: "Profile name" }),
      "Backup rack",
    );
    await user.type(
      screen.getByRole("textbox", { name: /^Device-name prefix/u }),
      "backup",
    );
    await user.click(screen.getByRole("button", { name: "Save profile" }));

    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole("button", { name: "Close mapping profiles" }),
      ),
    );
  });

  it("rebases an explicitly retried save after a conflict without losing the draft", async () => {
    const revisions: number[] = [];
    server.use(
      http.put(
        "http://localhost/api/mapping-profiles/:profileId",
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
            changed: false,
            revision: 10,
            event: null,
          });
        },
      ),
    );
    const user = userEvent.setup();
    renderDialog();
    const nameInput = screen.getByRole("textbox", { name: "Profile name" });
    await user.clear(nameInput);
    await user.type(nameInput, "Preserved local draft");

    await user.click(screen.getByRole("button", { name: "Save profile" }));
    expect(
      await screen.findByText(
        "Controller state advanced to revision 9. Review the refreshed state before saving again.",
      ),
    ).toBeTruthy();
    expect((nameInput as HTMLInputElement).value).toBe("Preserved local draft");

    await user.click(screen.getByRole("button", { name: "Save profile" }));
    await waitFor(() => expect(revisions).toEqual([8, 9]));
  });

  it("requires dirty edits to be saved or discarded before changing profiles", async () => {
    const user = userEvent.setup();
    const secondaryProfile: MappingProfile = {
      ...profile,
      id: "profile-secondary",
      name: "Secondary rack",
      deviceNamePrefix: "secondary",
      mappings: [],
    };
    renderDialog({ profiles: [profile, secondaryProfile] });
    const profileSelect = screen.getByRole("combobox", {
      name: "Mapping profile",
    }) as HTMLSelectElement;
    const newProfileButton = screen.getByRole("button", {
      name: "New profile",
    }) as HTMLButtonElement;
    const nameInput = screen.getByRole("textbox", { name: "Profile name" });

    await user.clear(nameInput);
    await user.type(nameInput, "Unsaved name");
    expect(profileSelect.disabled).toBe(true);
    expect(newProfileButton.disabled).toBe(true);
    expect(
      screen.getByText("Save or discard changes before switching profiles."),
    ).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Discard changes" }));
    await waitFor(() => expect(profileSelect.disabled).toBe(false));
    expect(newProfileButton.disabled).toBe(false);

    await user.selectOptions(profileSelect, "profile-secondary");
    expect(
      (
        screen.getByRole("textbox", {
          name: "Profile name",
        }) as HTMLInputElement
      ).value,
    ).toBe("Secondary rack");
  });
});

function renderDialog(overrides: Partial<MappingProfilesDialogProps> = {}) {
  return render(renderTree(overrides));
}

function renderTree(
  overrides: Partial<MappingProfilesDialogProps> = {},
): React.ReactElement {
  const queryClient = new QueryClient({
    defaultOptions: { mutations: { retry: false }, queries: { retry: false } },
  });
  return createElement(
    QueryClientProvider,
    { client: queryClient },
    createElement(MappingProfilesDialog, {
      open: true,
      onClose: vi.fn(),
      profiles: [profile],
      channels,
      outputs,
      controlAreas,
      expectedRevision: 8,
      refresh: vi.fn(),
      ...overrides,
    }),
  );
}
