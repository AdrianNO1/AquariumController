// @vitest-environment jsdom
// @vitest-environment-options {"url":"http://localhost/"}

import {
  expectedRevisionSchema,
  mutationResultSchema,
  operationDetailsResponseSchema,
  type OperationDetailsResponse,
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

import { OperationStatusPanel } from "./OperationStatusPanel.js";

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

describe("operation status reconciliation", () => {
  it("requires physical verification and suppresses the action after success", async () => {
    const details = deviceOutcomeDetails(null);
    const refresh = vi.fn();
    let requestBody: ReturnType<typeof expectedRevisionSchema.parse> | null =
      null;
    let reconcileRequests = 0;
    server.use(
      http.get("http://localhost/api/operations/operation-unknown", () =>
        HttpResponse.json(details),
      ),
      http.post(
        "http://localhost/api/operations/operation-unknown/reconcile",
        async ({ request }) => {
          reconcileRequests += 1;
          requestBody = expectedRevisionSchema.parse(await request.json());
          return HttpResponse.json(reconciliationMutation(9));
        },
      ),
    );
    const user = renderPanel(details, refresh);

    await user.click(
      screen.getByRole("button", { name: "Inspect operation-unknown" }),
    );
    expect(await screen.findByText("Device outcome is unknown.")).toBeTruthy();
    expect(
      screen.getByText(/Verify the aquarium output and the device's physical/u),
    ).toBeTruthy();

    const reconcile = screen.getByRole("button", {
      name: "Reconcile this unknown device outcome",
    }) as HTMLButtonElement;
    expect(reconcile.disabled).toBe(true);
    await user.click(
      screen.getByLabelText("I have verified the physical and device state."),
    );
    expect(reconcile.disabled).toBe(false);
    await user.click(reconcile);

    expect(
      await screen.findByText(
        "Reconciliation recorded at authoritative revision 9. The original device outcome remains unknown.",
      ),
    ).toBeTruthy();
    await waitFor(() => expect(refresh).toHaveBeenCalledOnce());
    expect(requestBody).toEqual({ expectedRevision: 8 });
    expect(reconcileRequests).toBe(1);
    expect(
      screen.queryByRole("button", {
        name: "Reconcile this unknown device outcome",
      }),
    ).toBeNull();
  });

  it("shows the server safety-window conflict without retrying or clearing the action", async () => {
    const details = deviceOutcomeDetails(null);
    const refresh = vi.fn();
    let reconcileRequests = 0;
    server.use(
      http.get("http://localhost/api/operations/operation-unknown", () =>
        HttpResponse.json(details),
      ),
      http.post(
        "http://localhost/api/operations/operation-unknown/reconcile",
        () => {
          reconcileRequests += 1;
          return HttpResponse.json(
            {
              code: "relational_conflict",
              message: "Device operation cannot be reconciled yet",
              conflicts: [
                {
                  resource: "operation",
                  id: "operation-unknown",
                  relation: "firmware_safety_window",
                  message:
                    "Operation operation-unknown cannot be reconciled before the firmware safety window ends",
                },
              ],
            },
            { status: 409 },
          );
        },
      ),
    );
    const user = renderPanel(details, refresh);

    await user.click(
      screen.getByRole("button", { name: "Inspect operation-unknown" }),
    );
    await user.click(
      await screen.findByLabelText(
        "I have verified the physical and device state.",
      ),
    );
    await user.click(
      screen.getByRole("button", {
        name: "Reconcile this unknown device outcome",
      }),
    );

    expect(
      await screen.findByText(
        "Operation operation-unknown cannot be reconciled before the firmware safety window ends",
      ),
    ).toBeTruthy();
    expect(reconcileRequests).toBe(1);
    expect(refresh).not.toHaveBeenCalled();
    expect(
      (
        screen.getByRole("button", {
          name: "Reconcile this unknown device outcome",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false);
  });

  it("does not offer reconciliation for an already reconciled outcome", async () => {
    const reconciledAtMs = Date.parse("2026-07-13T10:02:00.000Z");
    const details = deviceOutcomeDetails(reconciledAtMs);
    const user = renderPanel(details, vi.fn());

    await user.click(
      screen.getByRole("button", { name: "Inspect operation-unknown" }),
    );

    expect(
      await screen.findByText(/This unknown device outcome was reconciled at/u),
    ).toBeTruthy();
    expect(
      screen.queryByRole("button", {
        name: "Reconcile this unknown device outcome",
      }),
    ).toBeNull();
    expect(
      screen.queryByLabelText("I have verified the physical and device state."),
    ).toBeNull();
  });

  it("does not treat an aggregate unknown operation as a device operation", async () => {
    const details = operationDetailsResponseSchema.parse({
      ...deviceOutcomeDetails(null),
      operation: {
        ...deviceOutcomeDetails(null).operation,
        deviceId: null,
        kind: "manual_override_start",
      },
      request: {
        schemaVersion: 1,
        data: {
          kind: "manual_override_start",
          overrideId: "override-main",
        },
      },
    });
    const user = renderPanel(details, vi.fn());

    await user.click(
      screen.getByRole("button", { name: "Inspect operation-unknown" }),
    );
    expect(await screen.findByText("Result payload")).toBeTruthy();
    expect(screen.queryByText("Device outcome is unknown.")).toBeNull();
  });
});

function renderPanel(
  details: OperationDetailsResponse,
  refresh: () => void,
): ReturnType<typeof userEvent.setup> {
  server.use(
    http.get("http://localhost/api/operations/operation-unknown", () =>
      HttpResponse.json(details),
    ),
  );
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });
  render(
    createElement(QueryClientProvider, {
      client: queryClient,
      children: createElement(OperationStatusPanel, {
        operations: [details.operation],
        truncated: false,
        expectedRevision: 8,
        refresh,
      }),
    }),
  );
  return userEvent.setup();
}

function deviceOutcomeDetails(
  reconciledAtMs: number | null,
): OperationDetailsResponse {
  return operationDetailsResponseSchema.parse({
    operation: {
      id: "operation-unknown",
      deviceId: "device-main",
      kind: "ping",
      status: "outcome_unknown",
      requestedAt: "2026-07-13T10:00:00.000Z",
      deadlineAt: "2026-07-13T10:00:05.000Z",
      completedAt: "2026-07-13T10:00:06.000Z",
    },
    request: { schemaVersion: 1, data: { kind: "ping" } },
    result: {
      schemaVersion: 1,
      data: {
        status: "outcome_unknown",
        wireOperationId: "wire-operation",
        reason: "timeout",
        reconciledAtMs,
      },
    },
  });
}

function reconciliationMutation(revision: number) {
  return mutationResultSchema.parse({
    changed: true,
    revision,
    event: {
      revision,
      type: "operation.outcome-reconciled",
      occurredAt: "2026-07-13T10:02:00.000Z",
      entity: { type: "operation", id: "operation-unknown" },
      schemaVersion: 1,
      data: {
        invalidations: [{ resource: "operation", id: "operation-unknown" }],
      },
      retentionClass: "critical",
    },
  });
}
