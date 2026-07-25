import {
  legacyControlAreaSchema,
  type LegacyControlArea,
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

  return (
    <main className="page">
      <section className="hero">
        <p className="eyebrow">Foundation milestone</p>
        <h1>One controller, clear boundaries.</h1>
        <p>
          The runtime keeps authoritative state, device intent, and observed
          outcomes separate. MQTT may be disabled by configuration, and
          real-broker replacement evidence remains gated on the local Docker
          prerequisite.
        </p>
      </section>

      <section className="status-grid" aria-label="Controller status">
        <article className="status-card">
          <span className="status-label">HTTP API</span>
          <strong>{health.isSuccess ? "Healthy" : "Checking…"}</strong>
          <small>{health.data?.now ?? "Waiting for controller"}</small>
        </article>
        <article className="status-card">
          <span className="status-label">Authoritative state</span>
          <strong
            className={`connection connection-${controller.status}`}
            aria-live="polite"
          >
            {controller.status}
          </strong>
          <small>
            {controller.snapshot === null
              ? "Loading snapshot"
              : `Revision ${controller.revision}${controller.dataStale ? " · refresh pending" : ""}`}
          </small>
        </article>
        <article className="status-card status-card-muted">
          <span className="status-label">Device registry</span>
          <strong>
            {controller.snapshot === null
              ? "Loading…"
              : `${controller.snapshot.devices.length} registered`}
          </strong>
          <small>
            Runtime connectivity follows explicit configuration and never
            implies an actuator outcome.
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

      <section className="section-block">
        <div>
          <p className="eyebrow">Migration map</p>
          <h2>Existing control surfaces</h2>
        </div>
        <div className="link-grid">
          {controlAreas.map((area) => (
            <Link key={area.path} to={`/control/${area.path}`}>
              {area.label}
              <span aria-hidden="true">→</span>
            </Link>
          ))}
        </div>
      </section>
    </main>
  );
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
