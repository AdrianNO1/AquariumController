// @vitest-environment jsdom
// @vitest-environment-options {"url":"http://localhost/"}

import {
  manualOverrideCommandResponseSchema,
  type Channel,
  type ManualOverrideCommandResponse,
  type OperationSummary,
  type Override,
  type ScheduleGraph,
  type StartManualOverrideRequest,
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
  ManualOverridePanel,
  type ManualOverridePanelProps,
} from "./ManualOverridePanel.js";
import { scheduleValueAt as schedulePointsValueAt } from "./combined-schedule-state.js";
import { createTestControlSnapshot } from "./test-control-snapshot.js";

const server = setupServer();
const nativeFetch = globalThis.fetch;
const now = Date.parse("2026-07-13T10:00:00.000Z");
const snapshot = createTestControlSnapshot();
const mainChannel = requireItem(
  snapshot.channels.find((channel) => channel.id === "light-main"),
  "main test channel",
);
const mainSchedule = requireItem(
  snapshot.schedules.find((schedule) => schedule.channelId === mainChannel.id),
  "main test schedule",
);
const accentChannel: Channel = {
  ...mainChannel,
  id: "light-accent",
  name: "Accent",
  color: "#a84aa7",
  displayOrder: 1,
};
const accentSchedule: ScheduleGraph = {
  ...mainSchedule,
  id: "light-accent",
  channelId: accentChannel.id,
  points: [
    {
      id: "accent-midnight",
      position: 0,
      minuteOfDay: 0,
      percentage: 25,
      editorX: null,
      editorY: null,
    },
    {
      id: "accent-morning",
      position: 1,
      minuteOfDay: 600,
      percentage: 25,
      editorX: null,
      editorY: null,
    },
  ],
};
const channels: ManualOverridePanelProps["channels"] = [
  { channel: mainChannel, schedule: mainSchedule },
  { channel: accentChannel, schedule: accentSchedule },
];

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
  it("uses vertical channel sliders and applies the selected duration with sequential revisions", async () => {
    const requests: StartManualOverrideRequest[] = [];
    server.use(
      http.post("http://localhost/api/overrides", async ({ request }) => {
        const body = (await request.json()) as StartManualOverrideRequest;
        requests.push(body);
        return HttpResponse.json(
          commandResponse({
            overrideId: `override-${body.target.targetId}`,
            operationId: `operation-${requests.length}`,
            targetId: body.target.targetId,
            valuePercentage: body.valuePercentage,
            durationSeconds: body.durationSeconds,
            revision: body.expectedRevision + 1,
            kind: "manual_override_start",
          }),
        );
      }),
    );
    const refresh = vi.fn();
    const user = userEvent.setup();
    const panel = renderPanel({ overrides: [], operations: [], refresh });

    const mainSlider = screen.getByRole("slider", {
      name: "Main light temporary override",
    });
    const accentSlider = screen.getByRole("slider", {
      name: "Accent temporary override",
    });
    expect(mainSlider.classList.contains("vertical-range")).toBe(true);
    expect(accentSlider.classList.contains("vertical-range")).toBe(true);
    expect((mainSlider as HTMLInputElement).value).toBe("40");
    expect((accentSlider as HTMLInputElement).value).toBe("20");

    fireEvent.change(mainSlider, { target: { value: "72" } });
    await user.selectOptions(
      screen.getByRole("combobox", { name: "Duration" }),
      "300",
    );
    await user.click(screen.getByRole("button", { name: "Apply test levels" }));

    await waitFor(() => expect(requests).toHaveLength(2));
    expect(requests).toEqual([
      {
        expectedRevision: 8,
        target: { targetType: "channel", targetId: "light-main" },
        valuePercentage: 72,
        durationSeconds: 300,
      },
      {
        expectedRevision: 9,
        target: { targetType: "channel", targetId: "light-accent" },
        valuePercentage: 20,
        durationSeconds: 300,
      },
    ]);
    expect(
      await screen.findByText("Waiting for ESP confirmation…"),
    ).toBeTruthy();
    panel.rerenderOperations([
      operation("operation-1"),
      operation("operation-2"),
    ]);
    expect(await screen.findByText("Success")).toBeTruthy();
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("releases active overrides in revision order and immediately restores scheduled slider values", async () => {
    const cancelRequests: Array<{
      readonly overrideId: string;
      readonly expectedRevision: number;
    }> = [];
    const activeOverrides = [
      activeOverride("override-main", "light-main", 85, "operation-main"),
      activeOverride("override-accent", "light-accent", 65, "operation-accent"),
    ];
    server.use(
      http.post(
        "http://localhost/api/overrides/:overrideId/cancel",
        async ({ params, request }) => {
          const body = (await request.json()) as {
            readonly expectedRevision: number;
          };
          const overrideId = String(params.overrideId);
          cancelRequests.push({
            overrideId,
            expectedRevision: body.expectedRevision,
          });
          const original = requireItem(
            activeOverrides.find((override) => override.id === overrideId),
            `override ${overrideId}`,
          );
          return HttpResponse.json(
            commandResponse({
              overrideId,
              operationId: `operation-cancel-${cancelRequests.length}`,
              targetId: original.targetId,
              valuePercentage: original.valuePercentage,
              durationSeconds: 120,
              revision: body.expectedRevision + 1,
              kind: "manual_override_cancel",
            }),
          );
        },
      ),
    );
    const refresh = vi.fn();
    const user = userEvent.setup();
    const panel = renderPanel({
      overrides: activeOverrides,
      operations: [operation("operation-main"), operation("operation-accent")],
      refresh,
    });
    const mainSlider = screen.getByRole("slider", {
      name: "Main light temporary override",
    }) as HTMLInputElement;
    const accentSlider = screen.getByRole("slider", {
      name: "Accent temporary override",
    }) as HTMLInputElement;
    expect(mainSlider.value).toBe("85");
    expect(accentSlider.value).toBe("65");

    await user.click(screen.getByRole("button", { name: "Release all" }));

    await waitFor(() => expect(cancelRequests).toHaveLength(2));
    expect(cancelRequests).toEqual([
      { overrideId: "override-main", expectedRevision: 8 },
      { overrideId: "override-accent", expectedRevision: 9 },
    ]);
    await waitFor(() => expect(mainSlider.value).toBe("40"));
    expect(accentSlider.value).toBe("20");
    expect(
      await screen.findByText("Waiting for ESP confirmation…"),
    ).toBeTruthy();
    panel.rerenderOperations([
      operation("operation-main"),
      operation("operation-accent"),
      {
        ...operation("operation-cancel-1"),
        kind: "manual_override_cancel",
      },
      {
        ...operation("operation-cancel-2"),
        kind: "manual_override_cancel",
      },
    ]);
    expect(await screen.findByText("Success")).toBeTruthy();
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("replaces an active override when applying new test levels", async () => {
    const requests: StartManualOverrideRequest[] = [];
    const active = activeOverride(
      "override-main",
      "light-main",
      85,
      "operation-main",
    );
    server.use(
      http.post("http://localhost/api/overrides", async ({ request }) => {
        const body = (await request.json()) as StartManualOverrideRequest;
        requests.push(body);
        return HttpResponse.json(
          commandResponse({
            overrideId: "override-replacement",
            operationId: "operation-replacement",
            targetId: body.target.targetId,
            valuePercentage: body.valuePercentage,
            durationSeconds: body.durationSeconds,
            revision: body.expectedRevision + 1,
            kind: "manual_override_start",
          }),
        );
      }),
    );
    const user = userEvent.setup();
    const panel = renderPanel({
      overrides: [active],
      operations: [operation("operation-main")],
      refresh: vi.fn(),
      commandableChannelIds: new Set(["light-main"]),
    });
    fireEvent.change(
      screen.getByRole("slider", {
        name: "Main light temporary override",
      }),
      { target: { value: "60" } },
    );

    await user.click(screen.getByRole("button", { name: "Apply test levels" }));

    await waitFor(() => expect(requests).toHaveLength(1));
    expect(requests[0]).toMatchObject({
      expectedRevision: 8,
      replaceOverrideId: "override-main",
      target: { targetType: "channel", targetId: "light-main" },
      valuePercentage: 60,
    });
    expect(screen.queryByText(/Unresolved override state blocked/u)).toBeNull();
    panel.rerenderOperations([
      operation("operation-main"),
      operation("operation-replacement"),
    ]);
    expect(await screen.findByText("Success")).toBeTruthy();
  });

  it("releases active overrides without attempting to cancel pending starts", async () => {
    const cancelledOverrideIds: string[] = [];
    const active = activeOverride(
      "override-main",
      "light-main",
      85,
      "operation-main",
    );
    const pending: Override = {
      ...activeOverride(
        "override-accent",
        "light-accent",
        65,
        "operation-accent",
      ),
      status: "pending",
      startsAt: null,
    };
    server.use(
      http.post(
        "http://localhost/api/overrides/:overrideId/cancel",
        async ({ params, request }) => {
          const body = (await request.json()) as {
            readonly expectedRevision: number;
          };
          const overrideId = String(params.overrideId);
          cancelledOverrideIds.push(overrideId);
          return HttpResponse.json(
            commandResponse({
              overrideId,
              operationId: "operation-cancel-main",
              targetId: active.targetId,
              valuePercentage: active.valuePercentage,
              durationSeconds: 120,
              revision: body.expectedRevision + 1,
              kind: "manual_override_cancel",
            }),
          );
        },
      ),
    );
    const user = userEvent.setup();
    renderPanel({
      overrides: [pending, active],
      operations: [operation("operation-accent"), operation("operation-main")],
      refresh: vi.fn(),
    });

    await user.click(screen.getByRole("button", { name: "Release all" }));

    await waitFor(() =>
      expect(cancelledOverrideIds).toEqual(["override-main"]),
    );
  });

  it("quietly skips channels that no enabled controller currently maps", async () => {
    const requestedTargets: string[] = [];
    server.use(
      http.post("http://localhost/api/overrides", async ({ request }) => {
        const body = (await request.json()) as StartManualOverrideRequest;
        requestedTargets.push(body.target.targetId);
        return HttpResponse.json(
          commandResponse({
            overrideId: "override-main",
            operationId: "operation-main",
            targetId: body.target.targetId,
            valuePercentage: body.valuePercentage,
            durationSeconds: body.durationSeconds,
            revision: body.expectedRevision + 1,
            kind: "manual_override_start",
          }),
        );
      }),
    );
    const user = userEvent.setup();
    const panel = renderPanel({
      overrides: [],
      operations: [],
      refresh: vi.fn(),
      commandableChannelIds: new Set(["light-main"]),
    });

    await user.click(screen.getByRole("button", { name: "Apply test levels" }));

    await waitFor(() => expect(requestedTargets).toEqual(["light-main"]));
    panel.rerenderOperations([operation("operation-main")]);
    expect(await screen.findByText("Success")).toBeTruthy();
  });

  it("does not report success until every ESP confirms the requested output", async () => {
    server.use(
      http.post("http://localhost/api/overrides", async ({ request }) => {
        const body = (await request.json()) as StartManualOverrideRequest;
        return HttpResponse.json(
          commandResponse({
            overrideId: "override-main",
            operationId: "operation-main",
            targetId: body.target.targetId,
            valuePercentage: body.valuePercentage,
            durationSeconds: body.durationSeconds,
            revision: body.expectedRevision + 1,
            kind: "manual_override_start",
          }),
        );
      }),
    );
    const user = userEvent.setup();
    const panel = renderPanel({
      overrides: [],
      operations: [],
      refresh: vi.fn(),
      commandableChannelIds: new Set(["light-main"]),
    });

    await user.click(screen.getByRole("button", { name: "Apply test levels" }));
    expect(
      await screen.findByText("Waiting for ESP confirmation…"),
    ).toBeTruthy();
    expect(screen.queryByText("Success")).toBeNull();

    panel.rerenderOperations([
      { ...operation("operation-main"), status: "outcome_unknown" },
    ]);
    expect(
      await screen.findByText(/An ESP did not confirm the requested output/u),
    ).toBeTruthy();
    expect(screen.queryByText("Success")).toBeNull();
  });

  it("interpolates cyclic schedules across midnight", () => {
    expect(schedulePointsValueAt(mainSchedule?.points ?? [], 600)).toBe(50);
    expect(schedulePointsValueAt(accentSchedule?.points ?? [], 1_439)).toBe(25);
  });
});

function renderPanel({
  overrides,
  operations,
  refresh,
  commandableChannelIds = new Set(channels.map(({ channel }) => channel.id)),
}: {
  readonly overrides: readonly Override[];
  readonly operations: readonly OperationSummary[];
  readonly refresh: () => void;
  readonly commandableChannelIds?: ReadonlySet<string>;
}): {
  readonly rerenderOperations: (next: readonly OperationSummary[]) => void;
} {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  const renderTree = (renderedOperations: readonly OperationSummary[]) =>
    createElement(
      QueryClientProvider,
      { client: queryClient },
      createElement(ManualOverridePanel, {
        channels,
        commandableChannelIds,
        multiplierPercentage: 80,
        overrides,
        operations: renderedOperations,
        expectedRevision: 8,
        refresh,
        nowMs: () => now,
      }),
    );
  const rendered = render(renderTree(operations));
  return {
    rerenderOperations: (next) => rendered.rerender(renderTree(next)),
  };
}

function activeOverride(
  id: string,
  targetId: string,
  valuePercentage: number,
  operationId: string,
): Override {
  return {
    id,
    targetType: "channel",
    targetId,
    valuePercentage,
    status: "active",
    requestedAt: "2026-07-13T09:58:00.000Z",
    startsAt: "2026-07-13T09:58:01.000Z",
    expiresAt: "2026-07-13T10:03:00.000Z",
    completedAt: null,
    operationId,
  };
}

function operation(id: string): OperationSummary {
  return {
    id,
    deviceId: null,
    kind: "manual_override_start",
    status: "succeeded",
    requestedAt: "2026-07-13T09:58:00.000Z",
    deadlineAt: "2026-07-13T09:58:30.000Z",
    completedAt: "2026-07-13T09:58:01.000Z",
  };
}

function commandResponse({
  overrideId,
  operationId,
  targetId,
  valuePercentage,
  durationSeconds,
  revision,
  kind,
}: {
  readonly overrideId: string;
  readonly operationId: string;
  readonly targetId: string;
  readonly valuePercentage: number;
  readonly durationSeconds: number;
  readonly revision: number;
  readonly kind: "manual_override_start" | "manual_override_cancel";
}): ManualOverrideCommandResponse {
  const requestedAtMs = Date.parse("2026-07-13T10:00:00.000Z");
  return manualOverrideCommandResponseSchema.parse({
    override: {
      id: overrideId,
      targetType: "channel",
      targetId,
      valuePercentage,
      status: "pending",
      requestedAt: new Date(requestedAtMs).toISOString(),
      startsAt: null,
      expiresAt: new Date(
        requestedAtMs + durationSeconds * 1_000,
      ).toISOString(),
      completedAt: null,
      operationId,
    },
    operation: {
      id: operationId,
      deviceId: null,
      kind,
      status: "pending",
      requestedAt: new Date(requestedAtMs).toISOString(),
      deadlineAt: new Date(requestedAtMs + 30_000).toISOString(),
      completedAt: null,
    },
    mutation: {
      changed: true,
      revision,
      event: {
        revision,
        type: "override.pending",
        occurredAt: new Date(requestedAtMs).toISOString(),
        entity: { type: "override", id: overrideId },
        schemaVersion: 1,
        data: {
          invalidations: [
            { resource: "override", id: overrideId },
            { resource: "operation", id: operationId },
          ],
        },
        retentionClass: "audit",
      },
    },
  });
}

function requireItem<Value>(value: Value | undefined, label: string): Value {
  if (value === undefined) {
    throw new Error(`Missing ${label}`);
  }
  return value;
}
