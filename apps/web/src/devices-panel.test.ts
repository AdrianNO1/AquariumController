// @vitest-environment jsdom
// @vitest-environment-options {"url":"http://localhost/"}

import type {
  Device,
  FirmwareDeployment,
  MappingProfile,
  OperationSummary,
} from "@aquarium/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  act,
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

import { DevicesPanel } from "./DevicesPanel.js";

const timestamp = "2026-07-13T10:00:00.000Z";
const firmware: FirmwareDeployment = {
  currentVersion: "5.0.4",
  sha256: "0000000000000000000000000000000000000000000000000000000000000000",
  sizeBytes: 1,
  fleetPolicy: null,
};
const profile: MappingProfile = {
  id: "profile-main",
  name: "Main rack",
  hardwareProfileId: "nodemcu-esp32s-v1.1",
  outputGain: 1,
  createdAt: timestamp,
  updatedAt: timestamp,
  mappings: [],
};
const devices: readonly Device[] = [
  device({
    id: "device-online",
    name: "Online rack",
    hardwareId: "A1B2C3D4",
    status: "online",
    firmwareVersion: "5.0.4",
    lastError: null,
  }),
  device({
    id: "device-stale",
    name: "Stale rack",
    hardwareId: "B2C3D4E5",
    status: "stale",
    firmwareVersion: "5.0.0-beta.1",
    lastError: null,
  }),
  device({
    id: "device-offline",
    name: "Legacy rack",
    hardwareId: "C3D4E5F6",
    status: "offline",
    firmwareVersion: "3.9.2",
    lastError: {
      code: "device_offline",
      message: "Announcement is overdue",
    },
  }),
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

describe("DevicesPanel", () => {
  it("shows every device as a status-colored card with hardware ID and firmware guidance", () => {
    renderPanel();

    const onlineCard = screen.getByLabelText("ESP32 device Online rack");
    const staleCard = screen.getByLabelText("ESP32 device Stale rack");
    const offlineCard = screen.getByLabelText("ESP32 device Legacy rack");
    expect(onlineCard.classList.contains("device-card-online")).toBe(true);
    expect(staleCard.classList.contains("device-card-stale")).toBe(true);
    expect(offlineCard.classList.contains("device-card-offline")).toBe(true);
    expect(screen.getByText("ID: A1B2C3D4")).toBeTruthy();
    expect(screen.getByText("ID: B2C3D4E5")).toBeTruthy();
    expect(screen.getByText("ID: C3D4E5F6")).toBeTruthy();
    expect(screen.getByText(/5\.0\.4 .* current/u)).toBeTruthy();
    expect(
      screen.getByText(/5\.0\.0-beta\.1 .* update available/u),
    ).toBeTruthy();
    expect(screen.getByText(/3\.9\.2 .* upgrade required/u)).toBeTruthy();
    expect(screen.queryByText("Controls")).toBeNull();
  });

  it("updates relative last-seen labels locally without refreshing controller state", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(timestamp));
    try {
      const refresh = vi.fn();
      renderPanel(refresh);

      expect(screen.getAllByText("0s ago")).toHaveLength(2);
      act(() => vi.advanceTimersByTime(1_000));
      expect(screen.getAllByText("1s ago")).toHaveLength(2);
      expect(refresh).not.toHaveBeenCalled();
    } finally {
      cleanup();
      vi.useRealTimers();
    }
  });

  it("offers exclusion only for stale and offline devices and sends the authoritative revision", async () => {
    const requests: Array<{
      readonly id: string;
      readonly body: {
        readonly expectedRevision: number;
        readonly enabled: boolean;
      };
    }> = [];
    server.use(
      http.patch(
        "http://localhost/api/devices/:deviceId/enabled",
        async ({ params, request }) => {
          requests.push({
            id: String(params.deviceId),
            body: (await request.json()) as (typeof requests)[number]["body"],
          });
          return HttpResponse.json({
            changed: false,
            revision: 8,
            event: null,
          });
        },
      ),
    );
    const refresh = vi.fn();
    const user = userEvent.setup();
    renderPanel(refresh);

    expect(
      screen.queryByRole("button", {
        name: "Hide Online rack until it reconnects",
      }),
    ).toBeNull();
    expect(
      screen.getByRole("button", {
        name: "Hide Stale rack until it reconnects",
      }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", {
        name: "Hide Legacy rack until it reconnects",
      }),
    ).toBeTruthy();

    await user.click(
      screen.getByRole("button", {
        name: "Hide Stale rack until it reconnects",
      }),
    );

    await waitFor(() =>
      expect(requests).toEqual([
        {
          id: "device-stale",
          body: { expectedRevision: 8, enabled: false },
        },
      ]),
    );
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("hides operator-excluded devices but keeps protocol quarantines visible", () => {
    const hiddenSource = devices[1];
    const quarantinedSource = devices[2];
    if (hiddenSource === undefined || quarantinedSource === undefined) {
      throw new Error("Test devices are missing exclusion fixtures");
    }
    const hidden = { ...hiddenSource, enabled: false };
    const quarantined = {
      ...quarantinedSource,
      enabled: false,
      status: "error" as const,
      lastError: {
        code: "protocol_invalid_response",
        message: "Invalid response",
      },
    };

    renderPanel(vi.fn(), [hidden, quarantined]);

    expect(screen.queryByLabelText("ESP32 device Stale rack")).toBeNull();
    expect(screen.getByLabelText("ESP32 device Legacy rack")).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Include in controller commands" }),
    ).toBeTruthy();
  });

  it("allows a reported configuration mismatch to be reapplied when an unsupported-firmware error masks it", async () => {
    let requestBody: object | null = null;
    server.use(
      http.patch(
        "http://localhost/api/devices/device-online/configuration",
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
    const sourceDevice = devices[0];
    if (sourceDevice === undefined) {
      throw new Error("Test devices are missing the online ESP32");
    }
    const user = userEvent.setup();
    renderPanel(vi.fn(), [
      {
        ...sourceDevice,
        desired: {
          ...sourceDevice.desired,
          name: "online-rack",
        },
        reported: {
          ...sourceDevice.reported,
          name: "online-rack",
          pwmFrequencyHz: 500,
        },
        lastError: {
          code: "firmware_unsupported",
          message: "Firmware 4.1.0 is unsupported",
        },
      },
    ]);

    await user.click(screen.getByRole("button", { name: "Edit" }));
    await user.click(
      screen.getByRole("button", { name: "Reapply configuration" }),
    );

    await waitFor(() =>
      expect(requestBody).toEqual({
        expectedRevision: 8,
        name: "online-rack",
        pwmFrequencyHz: 1_000,
        pwmResolutionBits: 8,
        mappingProfileId: "profile-main",
      }),
    );
  });

  it("presents an in-flight configuration mismatch as an update pending", () => {
    const sourceDevice = devices[0];
    if (sourceDevice === undefined) {
      throw new Error("Test devices are missing the online ESP32");
    }
    const pendingOperation: OperationSummary = {
      id: "operation-edit-online",
      deviceId: sourceDevice.id,
      kind: "edit_configuration",
      status: "in_flight",
      requestedAt: timestamp,
      deadlineAt: "2026-07-13T10:00:05.000Z",
      completedAt: null,
    };

    renderPanel(
      vi.fn(),
      [
        {
          ...sourceDevice,
          desired: { ...sourceDevice.desired, name: "Renamed rack" },
          lastError: {
            code: "configuration_mismatch",
            message:
              "Reported configuration differs from desired configuration",
          },
        },
      ],
      [pendingOperation],
    );

    expect(screen.getByText("Update pending…")).toBeTruthy();
    expect(
      screen.queryByText("Desired and reported configuration differ."),
    ).toBeNull();
    expect(
      screen.queryByText(
        "Reported configuration differs from desired configuration",
      ),
    ).toBeNull();
  });

  it("changes the explicit pin profile without renaming the ESP", async () => {
    let requestBody: object | null = null;
    server.use(
      http.patch(
        "http://localhost/api/devices/device-online/configuration",
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
    const user = userEvent.setup();
    renderPanel();

    const editButton = screen.getAllByRole("button", { name: "Edit" }).at(0);
    if (editButton === undefined)
      throw new Error("Expected an ESP edit button");
    await user.click(editButton);
    await user.selectOptions(
      screen.getByRole("combobox", { name: "Pin mapping profile" }),
      "",
    );
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(requestBody).toEqual({
        expectedRevision: 8,
        mappingProfileId: null,
      }),
    );
  });

  it("hides a successful firmware update after ten minutes", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(timestamp));
    try {
      const sourceDevice = devices[0];
      if (sourceDevice === undefined) {
        throw new Error("Test devices are missing the online ESP32");
      }
      renderPanel(vi.fn(), [
        {
          ...sourceDevice,
          firmwareUpdate: {
            targetVersion: firmware.currentVersion,
            mode: "immediate",
            transitionSeconds: 5,
            status: "succeeded",
            progress: 100,
            operationId: "operation-firmware-online",
            error: null,
            requestedAt: timestamp,
            updatedAt: timestamp,
          },
        },
      ]);

      expect(screen.getByText("Update: succeeded · 100%")).toBeTruthy();
      act(() => vi.advanceTimersByTime(10 * 60 * 1_000 - 1));
      expect(screen.getByText("Update: succeeded · 100%")).toBeTruthy();
      act(() => vi.advanceTimersByTime(1));
      expect(screen.queryByText("Update: succeeded · 100%")).toBeNull();
    } finally {
      cleanup();
      vi.useRealTimers();
    }
  });

  it("confirms whether an available firmware update runs now or waits for outputs off", async () => {
    let requestBody: object | null = null;
    server.use(
      http.post(
        "http://localhost/api/devices/device-stale/firmware-update",
        async ({ request }) => {
          requestBody = (await request.json()) as object;
          return HttpResponse.json({
            changed: false,
            revision: 8,
            event: null,
          });
        },
      ),
    );
    const refresh = vi.fn();
    const user = userEvent.setup();
    renderPanel(refresh);

    await user.click(screen.getByRole("button", { name: "Update to 5.0.4" }));
    expect(
      screen.getByRole("dialog", { name: "Update Stale rack?" }),
    ).toBeTruthy();
    await user.click(
      screen.getByRole("button", { name: /Update when outputs are off/u }),
    );

    await waitFor(() =>
      expect(requestBody).toEqual({
        expectedRevision: 8,
        mode: "when_off",
        transitionSeconds: 5,
      }),
    );
    expect(refresh).toHaveBeenCalledOnce();
  });

  it("requires edited configuration to be saved or discarded before backdrop close", async () => {
    const user = userEvent.setup();
    renderPanel();
    await user.click(
      within(screen.getByLabelText("ESP32 device Online rack")).getByRole(
        "button",
        { name: "Edit" },
      ),
    );
    expect(
      screen.queryByText(
        /Saving records controller intent\. Reported values update only/u,
      ),
    ).toBeNull();
    const name = screen.getByRole("textbox", { name: "Device name" });
    await user.clear(name);
    await user.type(name, "Renamed-rack");
    const backdrop = screen.getByRole("dialog", {
      name: "Edit Online rack",
    }).parentElement;
    if (backdrop === null) throw new Error("Device backdrop is missing");

    await user.pointer({ target: backdrop, keys: "[MouseLeft]" });

    const confirmation = screen.getByRole("alertdialog", {
      name: "Save changes before closing?",
    });
    expect(
      screen.getByRole("dialog", { name: "Edit Online rack" }),
    ).toBeTruthy();
    await user.click(
      within(confirmation).getByRole("button", { name: "Discard changes" }),
    );
    expect(
      screen.queryByRole("dialog", { name: "Edit Online rack" }),
    ).toBeNull();
  });
});

function renderPanel(
  refresh = vi.fn(),
  renderedDevices: readonly Device[] = devices,
  operations: readonly OperationSummary[] = [],
): void {
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
      createElement(DevicesPanel, {
        devices: renderedDevices,
        mappingProfiles: [profile],
        operations,
        firmware,
        expectedRevision: 8,
        refresh,
      }),
    ),
  );
}

function device({
  id,
  name,
  hardwareId,
  status,
  firmwareVersion,
  lastError,
}: {
  readonly id: string;
  readonly name: string;
  readonly hardwareId: string;
  readonly status: "online" | "stale" | "offline";
  readonly firmwareVersion: string;
  readonly lastError: Device["lastError"];
}): Device {
  return {
    id,
    hardwareId,
    mappingProfileId: "profile-main",
    desired: {
      name,
      pwmFrequencyHz: 1_000,
      pwmResolutionBits: 8,
    },
    reported: {
      name,
      pwmFrequencyHz: 1_000,
      pwmResolutionBits: 8,
      firmwareVersion,
      scheduleHash: "1234",
      outputsOff: true,
      outputs: [],
      ota: null,
      hardwareProfileId: "nodemcu-esp32s-v1.1",
      hardwareModel: "Ai-Thinker NodeMCU-32S V1.1",
    },
    firmwareUpdate: null,
    status,
    lastSeenAt: status === "offline" ? null : timestamp,
    lastError,
    enabled: true,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}
