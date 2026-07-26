// @vitest-environment jsdom
// @vitest-environment-options {"url":"http://localhost/"}

import {
  manualOverrideCommandResponseSchema,
  manualOverrideStateResponseSchema,
  type ManualOverrideCommandResponse,
  type ManualOverrideStateResponse,
  type OperationSummary,
  type Override,
} from "@aquarium/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
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

import { ManualOverridePanel } from "./ManualOverridePanel.js";
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

describe("ManualOverridePanel", () => {
  it("records an output start without presenting the request as actuator success", async () => {
    let requestBody: object | null = null;
    const refresh = vi.fn();
    server.use(
      http.post("http://localhost/api/overrides", async ({ request }) => {
        requestBody = (await request.json()) as object;
        return HttpResponse.json(commandResponse());
      }),
    );
    const user = renderPanel({ overrides: [], operations: [], refresh });

    await user.selectOptions(
      screen.getByLabelText("Channel or output"),
      "output:output-moonlight",
    );
    const percentage = screen.getByRole("spinbutton", {
      name: /Override percentage/u,
    });
    await user.clear(percentage);
    await user.type(percentage, "42.5");
    await user.click(
      screen.getByRole("button", { name: "Start manual override" }),
    );

    expect(
      await screen.findByText(/recorded as pending at revision 9/u),
    ).toBeTruthy();
    expect(
      screen.getByText(
        /Device state will be shown only from authoritative updates/u,
      ),
    ).toBeTruthy();
    await waitFor(() =>
      expect(requestBody).toEqual({
        expectedRevision: 8,
        target: { targetType: "output", targetId: "output-moonlight" },
        valuePercentage: 42.5,
      }),
    );
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("shows a server-derived countdown and only active-state actions", async () => {
    const refresh = vi.fn();
    server.use(
      http.post("http://localhost/api/overrides/override-light/extend", () =>
        HttpResponse.json(
          stateResponse({
            ...activeOverride(),
            expiresAt: "2026-07-13T10:05:00.000Z",
          }),
        ),
      ),
    );
    const user = renderPanel({
      overrides: [activeOverride()],
      operations: [operation("succeeded")],
      refresh,
    });

    expect(screen.getByText("2m 0s")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Extend light-main" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Cancel light-main" }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", { name: "Reconcile unknown outcome" }),
    ).toBeNull();

    await user.click(screen.getByRole("button", { name: "Extend light-main" }));
    expect(await screen.findByText("4m 0s")).toBeTruthy();
    expect(
      screen.getByText(/Extension for override-light was recorded as active/u),
    ).toBeTruthy();
    expect(
      (
        screen.getByRole("button", {
          name: "Extend light-main",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(
      screen.getByText(/Waiting for authoritative revision 9/u),
    ).toBeTruthy();
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("keeps an unresolved active override controllable while offering reconciliation", async () => {
    const unknownOverride = activeOverride();
    server.use(
      http.post("http://localhost/api/overrides/override-light/reconcile", () =>
        HttpResponse.json(stateResponse(unknownOverride)),
      ),
    );
    const refresh = vi.fn();
    const user = renderPanel({
      overrides: [unknownOverride],
      operations: [operation("outcome_unknown")],
      refresh,
    });

    expect(
      screen.getByText(/Outcome unknown: actuator state is not claimed/u),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Extend light-main" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Cancel light-main" }),
    ).toBeTruthy();

    await user.click(
      screen.getByRole("button", { name: "Reconcile unknown outcome" }),
    );
    expect(
      await screen.findByText(
        /Reconciliation for override-light was recorded as active/u,
      ),
    ).toBeTruthy();
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("pins unchanged defaults on first focus and explicitly rebases after a conflict", async () => {
    const refresh = vi.fn();
    const requestBodies: object[] = [];
    server.use(
      http.post("http://localhost/api/overrides", async ({ request }) => {
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
        return HttpResponse.json(commandResponse());
      }),
    );
    const user = renderPanel({ overrides: [], operations: [], refresh });
    const percentage = screen.getByRole("spinbutton", {
      name: /Override percentage/u,
    });
    await user.click(percentage);
    user.rerenderRevision(9);
    await user.click(
      screen.getByRole("button", { name: "Start manual override" }),
    );

    expect(
      await screen.findByText(/Controller state advanced to revision 9/u),
    ).toBeTruthy();
    expect(requestBodies[0]).toMatchObject({ expectedRevision: 8 });
    expect((percentage as HTMLInputElement).value).toBe("50");
    expect(refresh).toHaveBeenCalledOnce();

    await user.click(
      screen.getByRole("button", {
        name: "Keep override draft with refreshed revision",
      }),
    );
    await user.click(
      screen.getByRole("button", { name: "Start manual override" }),
    );

    await waitFor(() => expect(requestBodies).toHaveLength(2));
    expect(requestBodies[1]).toMatchObject({ expectedRevision: 9 });
    expect(refresh).toHaveBeenCalledTimes(2);
  });

  it("keeps the first-interaction revision for keyboard submission", async () => {
    let requestBody: object | null = null;
    server.use(
      http.post("http://localhost/api/overrides", async ({ request }) => {
        requestBody = (await request.json()) as object;
        return HttpResponse.json(commandResponse());
      }),
    );
    const user = renderPanel({
      overrides: [],
      operations: [],
      refresh: vi.fn(),
    });
    await user.click(
      screen.getByRole("spinbutton", { name: /Override percentage/u }),
    );
    user.rerenderRevision(9);

    await user.keyboard("{Enter}");

    await waitFor(() =>
      expect(requestBody).toMatchObject({ expectedRevision: 8 }),
    );
  });
});

interface RenderPanelOptions {
  readonly overrides: readonly Override[];
  readonly operations: readonly OperationSummary[];
  readonly refresh: () => void;
}

type RenderedPanel = ReturnType<typeof userEvent.setup> & {
  readonly rerenderRevision: (revision: number) => void;
};

function renderPanel({
  overrides,
  operations,
  refresh,
}: RenderPanelOptions): RenderedPanel {
  const snapshot = createTestControlSnapshot();
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  const renderTree = (revision: number) =>
    createElement(QueryClientProvider, {
      client: queryClient,
      children: createElement(ManualOverridePanel, {
        channels: snapshot.channels.filter(
          (channel) => channel.typeKey === "light",
        ),
        outputs: snapshot.outputs,
        overrides,
        operations,
        expectedRevision: revision,
        refresh,
        nowMs: fixedNow,
      }),
    });
  const rendered = render(renderTree(8));
  return Object.assign(userEvent.setup(), {
    rerenderRevision: (revision: number) =>
      rendered.rerender(renderTree(revision)),
  });
}

function commandResponse(): ManualOverrideCommandResponse {
  return manualOverrideCommandResponseSchema.parse({
    override: {
      ...activeOverride(),
      id: "override-output",
      targetType: "output",
      targetId: "output-moonlight",
      status: "pending",
      startsAt: null,
    },
    operation: {
      id: "operation-start",
      deviceId: null,
      kind: "manual_override_start",
      status: "pending",
      requestedAt: "2026-07-13T10:01:00.000Z",
      deadlineAt: "2026-07-13T10:01:30.000Z",
      completedAt: null,
    },
    mutation: mutation("override-output", "operation-start", 9),
  });
}

function stateResponse(override: Override): ManualOverrideStateResponse {
  return manualOverrideStateResponseSchema.parse({
    override,
    mutation: mutation(
      override.id,
      override.operationId ?? "operation-start",
      9,
    ),
  });
}

function activeOverride(): Override {
  return {
    id: "override-light",
    targetType: "channel",
    targetId: "light-main",
    valuePercentage: 55,
    status: "active",
    requestedAt: "2026-07-13T10:00:00.000Z",
    startsAt: "2026-07-13T10:00:01.000Z",
    expiresAt: "2026-07-13T10:03:00.000Z",
    completedAt: null,
    operationId: "operation-start",
  };
}

function operation(status: OperationSummary["status"]): OperationSummary {
  return {
    id: "operation-start",
    deviceId: null,
    kind: "manual_override_start",
    status,
    requestedAt: "2026-07-13T10:00:00.000Z",
    deadlineAt: "2026-07-13T10:00:30.000Z",
    completedAt:
      status === "pending" || status === "in_flight"
        ? null
        : "2026-07-13T10:00:31.000Z",
  };
}

function mutation(overrideId: string, operationId: string, revision: number) {
  return {
    changed: true as const,
    revision,
    event: {
      revision,
      type: "override.pending",
      occurredAt: "2026-07-13T10:01:00.000Z",
      entity: { type: "override" as const, id: overrideId },
      schemaVersion: 1 as const,
      data: {
        invalidations: [
          { resource: "override" as const, id: overrideId },
          { resource: "operation" as const, id: operationId },
        ],
      },
      retentionClass: "audit" as const,
    },
  };
}

function fixedNow(): number {
  return Date.parse("2026-07-13T10:01:00.000Z");
}
