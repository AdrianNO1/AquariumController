import {
  legacyControlAreaSchema,
  type LegacyControlArea,
  type ControllerSnapshot,
  type ControlArea,
} from "@aquarium/contracts";
import { useQuery } from "@tanstack/react-query";
import { Link, NavLink, Route, Routes, useParams } from "react-router";

import { AlertsPage } from "./AlertsPage.js";
import { fetchHealth } from "./api.js";
import { ControlAreaPage } from "./ControlAreaPage.js";
import { LogsPage } from "./LogsPage.js";
import { OperationsPage } from "./OperationsPage.js";
import { useControllerState } from "./use-controller-state.js";

const controlAreas = [
  { path: "lights", label: "Lights" },
  { path: "pumps", label: "Pumps" },
  { path: "testlights", label: "Test lights" },
  { path: "bad", label: "Bad" },
  { path: "loft", label: "Loft" },
  { path: "biljard", label: "Biljard" },
  { path: "frag", label: "Frag tank" },
  { path: "qt1", label: "Quarantine 1" },
  { path: "qt2", label: "Quarantine 2" },
  { path: "qt3", label: "Quarantine 3" },
  { path: "qt4", label: "Quarantine 4" },
] as const satisfies readonly {
  readonly path: LegacyControlArea;
  readonly label: string;
}[];

function Dashboard(): React.JSX.Element {
  const health = useQuery({
    queryKey: ["controller-health"],
    queryFn: fetchHealth,
    refetchInterval: 30_000,
  });
  const controller = useControllerState();

  const summary =
    controller.snapshot === null
      ? null
      : createOverviewSummary(controller.snapshot);

  return (
    <main className="page overview-page">
      <div className="overview-heading">
        <div>
          <p className="eyebrow">System</p>
          <h1>Overview</h1>
        </div>
        <button
          className="secondary-button"
          type="button"
          disabled={controller.status === "loading"}
          onClick={controller.retry}
        >
          Refresh
        </button>
      </div>

      <section className="overview-stats" aria-label="Controller status">
        <article className="overview-stat">
          <span className="status-label">Controller</span>
          <strong
            className={`connection connection-${controller.status}`}
            aria-live="polite"
          >
            {formatConnectionStatus(controller.status)}
          </strong>
          <small>
            {controller.snapshot === null
              ? "Loading snapshot"
              : `Revision ${controller.revision}${controller.dataStale ? " · refresh pending" : ""}`}
          </small>
        </article>
        <article className="overview-stat">
          <span className="status-label">ESP32 devices</span>
          <strong>
            {summary === null ? "Loading…" : `${summary.onlineDevices} online`}
          </strong>
          <small>
            {summary === null
              ? "Waiting for controller"
              : `${summary.registeredDevices} registered`}
          </small>
        </article>
        <article
          className={`overview-stat${summary !== null && summary.attentionDevices > 0 ? " overview-stat-attention" : ""}`}
        >
          <span className="status-label">Needs attention</span>
          <strong>
            {summary === null
              ? "Loading…"
              : `${summary.attentionDevices} ${summary.attentionDevices === 1 ? "device" : "devices"}`}
          </strong>
          <small>
            {summary === null
              ? "Waiting for device state"
              : formatAttentionSummary(summary)}
          </small>
        </article>
        <article className="overview-stat">
          <span className="status-label">Temporary overrides</span>
          <strong>
            {summary === null ? "Loading…" : `${summary.liveOverrides} active`}
          </strong>
          <small>
            {health.isSuccess
              ? `API checked ${formatUtcTime(health.data.now)}`
              : health.isError
                ? "API health check failed"
                : "Checking HTTP API"}
          </small>
        </article>
      </section>

      {health.isError ? (
        <p className="error-banner" role="alert">
          {health.error.message}
        </p>
      ) : null}

      {controller.error !== null ? (
        <div className="error-banner" role="alert">
          <span>{controller.error}</span>
          <button type="button" onClick={controller.retry}>
            Retry state connection
          </button>
        </div>
      ) : null}

      <section className="area-section" aria-labelledby="areas-heading">
        <div className="overview-section-heading">
          <div>
            <p className="eyebrow">Control areas</p>
            <h2 id="areas-heading">Select an area</h2>
          </div>
        </div>
        <div className="area-grid">
          {controlAreas.map((area) => {
            const areaSummary =
              controller.snapshot === null
                ? null
                : createAreaSummary(controller.snapshot, area.path);
            return (
              <Link
                className={`area-card area-card-${areaSummary?.status ?? "loading"}`}
                key={area.path}
                to={`/control/${area.path}`}
              >
                <span className="area-card-heading">
                  <strong>{area.label}</strong>
                  <span className="area-card-state" aria-hidden="true" />
                </span>
                <span className="area-card-meta">
                  {areaSummary === null
                    ? "Loading configuration"
                    : `${areaSummary.channelCount} ${areaSummary.channelCount === 1 ? "channel" : "channels"} · ${areaSummary.deviceCount} ${areaSummary.deviceCount === 1 ? "ESP" : "ESPs"}`}
                </span>
                <span className="area-card-open">
                  {areaSummary === null
                    ? "Checking"
                    : areaSummary.status === "attention"
                      ? "Needs attention"
                      : areaSummary.status === "unassigned"
                        ? "No mapped ESP"
                        : "Open controls"}
                </span>
              </Link>
            );
          })}
        </div>
      </section>
    </main>
  );
}

interface OverviewSummary {
  readonly registeredDevices: number;
  readonly onlineDevices: number;
  readonly staleDevices: number;
  readonly offlineDevices: number;
  readonly errorDevices: number;
  readonly warningDevices: number;
  readonly attentionDevices: number;
  readonly liveOverrides: number;
}

function createOverviewSummary(snapshot: ControllerSnapshot): OverviewSummary {
  const onlineDevices = snapshot.devices.filter(
    (device) => device.enabled && device.status === "online",
  ).length;
  const staleDevices = snapshot.devices.filter(
    (device) => device.enabled && device.status === "stale",
  ).length;
  const offlineDevices = snapshot.devices.filter(
    (device) =>
      device.enabled &&
      (device.status === "offline" || device.status === "unknown"),
  ).length;
  const errorDevices = snapshot.devices.filter(
    (device) => device.enabled && device.status === "error",
  ).length;
  const warningDevices = snapshot.devices.filter(
    (device) =>
      device.enabled &&
      device.status === "online" &&
      hasDeviceConfigurationWarning(device),
  ).length;
  return {
    registeredDevices: snapshot.devices.length,
    onlineDevices,
    staleDevices,
    offlineDevices,
    errorDevices,
    warningDevices,
    attentionDevices: snapshot.devices.filter(
      (device) => device.enabled && deviceNeedsAttention(device),
    ).length,
    liveOverrides: snapshot.overrides.filter(
      (override) =>
        override.status === "pending" || override.status === "active",
    ).length,
  };
}

function formatAttentionSummary(summary: OverviewSummary): string {
  const parts = [
    summary.staleDevices > 0 ? `${summary.staleDevices} stale` : null,
    summary.offlineDevices > 0 ? `${summary.offlineDevices} offline` : null,
    summary.errorDevices > 0 ? `${summary.errorDevices} error` : null,
    summary.warningDevices > 0 ? `${summary.warningDevices} warning` : null,
  ].filter((part): part is string => part !== null);
  return parts.length === 0 ? "Everything responding" : parts.join(" · ");
}

interface AreaSummary {
  readonly channelCount: number;
  readonly deviceCount: number;
  readonly status: "ok" | "attention" | "unassigned";
}

function createAreaSummary(
  snapshot: ControllerSnapshot,
  slug: ControlArea["slug"],
): AreaSummary {
  const area = snapshot.controlAreas.find(
    (candidate) => candidate.slug === slug,
  );
  if (area === undefined) {
    return { channelCount: 0, deviceCount: 0, status: "unassigned" };
  }
  const channelIds = new Set(
    snapshot.channels
      .filter((channel) => channel.typeKey === area.typeKey)
      .map((channel) => channel.id),
  );
  const outputIds = new Set(
    snapshot.outputs
      .filter((output) => output.typeKey === area.typeKey)
      .map((output) => output.id),
  );
  const relevantProfiles = new Set(
    snapshot.mappingProfiles
      .filter((profile) =>
        profile.mappings.some((mapping) =>
          mapping.target.kind === "channel"
            ? channelIds.has(mapping.target.id)
            : outputIds.has(mapping.target.id),
        ),
      )
      .map((profile) => profile.id),
  );
  const devices = snapshot.devices.filter(
    (device) =>
      device.mappingProfileId !== null &&
      relevantProfiles.has(device.mappingProfileId),
  );
  const needsAttention = devices.some(
    (device) => device.enabled && deviceNeedsAttention(device),
  );
  return {
    channelCount: channelIds.size,
    deviceCount: devices.length,
    status:
      devices.length === 0 ? "unassigned" : needsAttention ? "attention" : "ok",
  };
}

function deviceNeedsAttention(
  device: ControllerSnapshot["devices"][number],
): boolean {
  return (
    device.status === "stale" ||
    device.status === "offline" ||
    device.status === "unknown" ||
    device.status === "error" ||
    hasDeviceConfigurationWarning(device)
  );
}

function hasDeviceConfigurationWarning(
  device: ControllerSnapshot["devices"][number],
): boolean {
  return (
    device.lastError !== null ||
    device.reported.name !== device.desired.name ||
    device.reported.pwmFrequencyHz !== device.desired.pwmFrequencyHz ||
    device.reported.pwmResolutionBits !== device.desired.pwmResolutionBits
  );
}

function formatConnectionStatus(
  status: ReturnType<typeof useControllerState>["status"],
): string {
  switch (status) {
    case "loading":
      return "Loading";
    case "connected":
      return "Connected";
    case "reconnecting":
      return "Reconnecting";
    case "stale":
      return "Stale";
    case "error":
      return "Error";
  }
}

function formatUtcTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    timeZone: "UTC",
    timeZoneName: "short",
  }).format(new Date(value));
}

function ControlArea(): React.JSX.Element {
  const { deviceType } = useParams();
  const parsedArea = legacyControlAreaSchema.safeParse(deviceType);

  if (!parsedArea.success) {
    return <NotFound />;
  }
  return <ControlAreaPage slug={parsedArea.data} />;
}

function NotFound(): React.JSX.Element {
  return (
    <main className="page narrow-page">
      <p className="eyebrow">404</p>
      <h1>That page does not exist.</h1>
      <Link className="text-link" to="/">
        Back to overview
      </Link>
    </main>
  );
}

export default function App(): React.JSX.Element {
  const controller = useControllerState();
  return (
    <div className="app-shell">
      <header className="topbar">
        <Link className="brand" to="/">
          <span className="brand-mark" aria-hidden="true">
            AQ
          </span>
          <span>
            Aquarium
            <small>Controller</small>
          </span>
        </Link>
        <nav aria-label="Primary navigation">
          <NavLink to="/" end>
            Overview
          </NavLink>
          <NavLink to="/operations">Operations</NavLink>
          <NavLink to="/alerts">Alerts</NavLink>
          <NavLink to="/logs">Logs</NavLink>
        </nav>
        <div className="topbar-status" aria-live="polite">
          <span>Revision {controller.revision}</span>
          <span className="save-state">
            <span
              className={`connection-dot connection-dot-${controller.status}`}
              aria-hidden="true"
            />
            Controller {formatConnectionStatus(controller.status).toLowerCase()}
          </span>
        </div>
      </header>

      <Routes>
        <Route path="/" element={<Dashboard />} />
        <Route path="/control/:deviceType" element={<ControlArea />} />
        <Route path="/operations" element={<OperationsPage />} />
        <Route path="/alerts" element={<AlertsPage />} />
        <Route path="/logs" element={<LogsPage />} />
        <Route path="*" element={<NotFound />} />
      </Routes>
    </div>
  );
}
