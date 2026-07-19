// @vitest-environment jsdom
// @vitest-environment-options {"url":"http://localhost/"}

import {
  alertHistoryListResponseSchema,
  acknowledgeAlertRequestSchema,
  createLogFilterFingerprint,
  encodeLogCursor,
  logsListResponseSchema,
  type AcknowledgeAlertRequest,
  type ControllerSnapshot,
  type LogEntry,
  type LogsListResponse,
} from "@aquarium/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
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
import {
  createTestAlertsSnapshot,
  createTestControllerSnapshot,
} from "./test-controller-snapshot.js";

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

function controllerState(
  snapshot: ControllerSnapshot,
  refresh: () => void,
  dataStale = false,
): ControllerStateContextValue {
  return {
    status: "connected",
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

function renderApp(
  path: string,
  state: ControllerStateContextValue,
): RenderedApp {
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
  return Object.assign(userEvent.setup(), {
    rerenderState: (nextState: ControllerStateContextValue) =>
      rendered.rerender(renderTree(nextState)),
  });
}

type RenderedApp = ReturnType<typeof userEvent.setup> & {
  readonly rerenderState: (state: ControllerStateContextValue) => void;
};

function logEntry(id: number, occurredAtMs: number, kind: string): LogEntry {
  return {
    id,
    occurredAtMs,
    direction: "inbound",
    kind,
    severity: "warning",
    topic: "test/aquarium/fromesp",
    deviceId: "device-1",
    correlationId: "correlation-1",
    operationId: "operation-1",
    outcome: "succeeded",
    durationMs: 5,
    byteCount: 32,
    retentionClass: "audit",
    payload: { command: "s" },
    payloadSchemaVersion: 1,
    payloadSha256: "b".repeat(64),
  };
}

function logsResponse(
  items: readonly LogEntry[],
  nextCursor: string | null,
): LogsListResponse {
  return logsListResponseSchema.parse({
    schemaVersion: 1,
    items,
    nextCursor,
    hasMore: nextCursor !== null,
    summary: {
      returnedCount: items.length,
      totalByteCount: items.reduce((total, item) => total + item.byteCount, 0),
      firstOccurredAtMs: items[0]?.occurredAtMs ?? null,
      lastOccurredAtMs: items.at(-1)?.occurredAtMs ?? null,
    },
  });
}

describe("logs route", () => {
  it("keeps filters in the URL, inspects payloads, paginates, and exports the filtered set", async () => {
    const filter = { direction: "inbound" } as const;
    const cursor = encodeLogCursor({
      schemaVersion: 1,
      order: "occurred_at_ms_desc_id_desc",
      filterFingerprint: createLogFilterFingerprint(filter),
      occurredAtMs: 2_000,
      id: 2,
    });
    const firstPage = logsResponse(
      [logEntry(2, 2_000, "mqtt.command")],
      cursor,
    );
    const secondPage = logsResponse([logEntry(1, 1_000, "device.state")], null);
    const emptyPage = logsResponse([], null);
    const requestedUrls: URL[] = [];
    server.use(
      http.get("http://localhost/api/logs", ({ request }) => {
        const url = new URL(request.url);
        requestedUrls.push(url);
        if (url.searchParams.get("kind") === "scheduler.tick") {
          return HttpResponse.json(emptyPage);
        }
        return HttpResponse.json(
          url.searchParams.has("cursor") ? secondPage : firstPage,
        );
      }),
    );

    const user = renderApp(
      "/logs?direction=inbound&pageSize=25",
      controllerState(createTestControllerSnapshot(4), vi.fn()),
    );
    expect(await screen.findByText("mqtt.command")).toBeTruthy();
    expect(requestedUrls[0]?.searchParams.get("direction")).toBe("inbound");
    expect(requestedUrls[0]?.searchParams.get("pageSize")).toBe("25");

    const exportLink = screen.getByRole("link", {
      name: "Download CSV export",
    });
    expect(exportLink.getAttribute("href")).toContain("direction=inbound");
    expect(exportLink.getAttribute("href")).toContain("maxRows=10000");

    await user.click(screen.getByText("Inspect log 2"));
    expect(screen.getByText(/"command": "s"/u)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Next page" }));
    expect(await screen.findByText("device.state")).toBeTruthy();
    expect(
      (
        screen.getByRole("button", {
          name: "Previous page",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false);

    await user.type(screen.getByLabelText("Kind"), "scheduler.tick");
    await user.click(screen.getByRole("button", { name: "Apply filters" }));
    expect(
      await screen.findByText("No logs match the current filters."),
    ).toBeTruthy();
    const finalUrl = requestedUrls.at(-1);
    expect(finalUrl?.searchParams.get("kind")).toBe("scheduler.tick");
    expect(finalUrl?.searchParams.has("cursor")).toBe(false);
  });

  it("shows typed query failures with an explicit retry", async () => {
    server.use(
      http.get("http://localhost/api/logs", () =>
        HttpResponse.json(
          {
            code: "service_unavailable",
            message: "logs service is not configured",
            service: "logs service",
          },
          { status: 503 },
        ),
      ),
    );

    renderApp(
      "/logs",
      controllerState(createTestControllerSnapshot(4), vi.fn()),
    );
    expect(
      await screen.findByText("logs service is not configured"),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Retry log query" }),
    ).toBeTruthy();
  });
});

describe("alerts route", () => {
  it("shows delivery failures, acknowledges safely, paginates, and filters recovered history", async () => {
    const snapshot = createTestAlertsSnapshot(4);
    const open = snapshot.alerts.find((alert) => alert.state === "open");
    const acknowledged = snapshot.alerts.find(
      (alert) => alert.state === "acknowledged",
    );
    const recovered = snapshot.alerts.find(
      (alert) => alert.state === "recovered",
    );
    if (
      open === undefined ||
      acknowledged === undefined ||
      recovered === undefined
    ) {
      throw new Error("Incomplete alert fixture");
    }
    const refresh = vi.fn();
    let acknowledgementBody: AcknowledgeAlertRequest | null = null;
    const requestedStates: string[] = [];
    server.use(
      http.get("http://localhost/api/alerts", ({ request }) => {
        const url = new URL(request.url);
        const state = url.searchParams.get("state") ?? "active";
        requestedStates.push(state);
        if (state === "recovered") {
          return HttpResponse.json(
            alertHistoryListResponseSchema.parse({
              schemaVersion: 1,
              items: [recovered],
              nextCursor: null,
              hasMore: false,
              deliveriesTruncatedAlertIds: [],
            }),
          );
        }
        if (url.searchParams.has("cursor")) {
          return HttpResponse.json(
            alertHistoryListResponseSchema.parse({
              schemaVersion: 1,
              items: [acknowledged],
              nextCursor: null,
              hasMore: false,
              deliveriesTruncatedAlertIds: [],
            }),
          );
        }
        return HttpResponse.json(
          alertHistoryListResponseSchema.parse({
            schemaVersion: 1,
            items: [open],
            nextCursor: "cursor_2",
            hasMore: true,
            deliveriesTruncatedAlertIds: [open.id],
          }),
        );
      }),
      http.post(
        "http://localhost/api/alerts/alert-open/acknowledge",
        async ({ request }) => {
          acknowledgementBody = acknowledgeAlertRequestSchema.parse(
            await request.json(),
          );
          return HttpResponse.json({
            changed: false,
            revision: 4,
            event: null,
          });
        },
      ),
    );

    const user = renderApp(
      "/alerts?state=active&pageSize=10",
      controllerState(snapshot, refresh),
    );
    expect(
      await screen.findByText(/http_503: Destination unavailable/u),
    ).toBeTruthy();
    expect(
      screen.getByText(
        "Only the most recent notification deliveries are included for this alert.",
      ),
    ).toBeTruthy();

    await user.type(
      screen.getByLabelText("Acknowledgement note (optional)"),
      "Investigating",
    );
    await user.click(screen.getByRole("button", { name: "Acknowledge alert" }));
    expect(
      await screen.findByText(
        "Acknowledgement accepted. Refreshing authoritative state…",
      ),
    ).toBeTruthy();
    expect(acknowledgementBody).toEqual({
      expectedRevision: 4,
      note: "Investigating",
    });
    expect(refresh).toHaveBeenCalled();

    await user.click(screen.getByRole("button", { name: "Next page" }));
    expect(
      await screen.findByRole("heading", { name: "Acknowledged 1" }),
    ).toBeTruthy();

    await user.selectOptions(
      screen.getByLabelText("Lifecycle state"),
      "recovered",
    );
    expect(
      await screen.findByRole("heading", { name: "Recovered 1" }),
    ).toBeTruthy();
    expect(requestedStates).toContain("recovered");
  });

  it("pins acknowledgement review and explicitly rebases after a conflict", async () => {
    const snapshot = createTestAlertsSnapshot(4);
    const open = snapshot.alerts.find((alert) => alert.state === "open");
    if (open === undefined) {
      throw new Error("Missing open alert fixture");
    }
    const refresh = vi.fn();
    const requestBodies: AcknowledgeAlertRequest[] = [];
    server.use(
      http.get("http://localhost/api/alerts", () =>
        HttpResponse.json(
          alertHistoryListResponseSchema.parse({
            schemaVersion: 1,
            items: [open],
            nextCursor: null,
            hasMore: false,
            deliveriesTruncatedAlertIds: [],
          }),
        ),
      ),
      http.post(
        "http://localhost/api/alerts/alert-open/acknowledge",
        async ({ request }) => {
          requestBodies.push(
            acknowledgeAlertRequestSchema.parse(await request.json()),
          );
          if (requestBodies.length === 1) {
            return HttpResponse.json(
              {
                code: "revision_conflict",
                message: "State revision changed",
                expectedRevision: 4,
                currentRevision: 5,
              },
              { status: 409 },
            );
          }
          return HttpResponse.json({
            changed: false,
            revision: 5,
            event: null,
          });
        },
      ),
    );

    const user = renderApp("/alerts", controllerState(snapshot, refresh));
    await screen.findByRole("button", { name: "Acknowledge alert" });
    await user.type(
      screen.getByLabelText("Acknowledgement note (optional)"),
      "Reviewing",
    );
    user.rerenderState(controllerState({ ...snapshot, revision: 5 }, refresh));
    await waitFor(() =>
      expect(
        (
          screen.getByRole("button", {
            name: "Acknowledge alert",
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(false),
    );
    await user.click(screen.getByRole("button", { name: "Acknowledge alert" }));
    expect(
      await screen.findByText(/Controller state advanced to revision 5/u),
    ).toBeTruthy();
    expect(requestBodies[0]).toEqual({
      expectedRevision: 4,
      note: "Reviewing",
    });
    expect(refresh).toHaveBeenCalledOnce();

    await user.click(
      screen.getByRole("button", {
        name: "Keep acknowledgement draft with refreshed revision",
      }),
    );
    await user.click(screen.getByRole("button", { name: "Acknowledge alert" }));

    await waitFor(() => expect(requestBodies).toHaveLength(2));
    expect(requestBodies[1]).toEqual({
      expectedRevision: 5,
      note: "Reviewing",
    });
    expect(refresh).toHaveBeenCalledTimes(2);
  });
});

describe("operational navigation", () => {
  it("links alerts and removes the unsafe admin placeholder", () => {
    renderApp(
      "/admin",
      controllerState(createTestControllerSnapshot(0), vi.fn()),
    );

    expect(
      screen.getByRole("heading", { name: "That page does not exist." }),
    ).toBeTruthy();
    expect(screen.getByRole("link", { name: "Alerts" })).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Admin" })).toBeNull();
  });
});
