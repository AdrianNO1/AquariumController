import { legacyControlAreaSchema } from "@aquarium/contracts";
import { useQuery } from "@tanstack/react-query";
import { Link, NavLink, Route, Routes, useParams } from "react-router";

import { fetchHealth } from "./api.js";
import { useControllerEvents } from "./use-controller-events.js";

const controlAreas = [
  { path: "lights", label: "Lights" },
  { path: "pumps", label: "Pumps" },
  { path: "frag", label: "Frag tank" },
] as const;

function Dashboard(): React.JSX.Element {
  const health = useQuery({
    queryKey: ["controller-health"],
    queryFn: fetchHealth,
    refetchInterval: 30_000,
  });
  const events = useControllerEvents();

  return (
    <main className="page">
      <section className="hero">
        <p className="eyebrow">Foundation milestone</p>
        <h1>One controller, clear boundaries.</h1>
        <p>
          The new runtime is connected end-to-end. Device control stays disabled
          until persistence and the real-broker integration tests are in place.
        </p>
      </section>

      <section className="status-grid" aria-label="Controller status">
        <article className="status-card">
          <span className="status-label">HTTP API</span>
          <strong>{health.isSuccess ? "Healthy" : "Checking…"}</strong>
          <small>{health.data?.now ?? "Waiting for controller"}</small>
        </article>
        <article className="status-card">
          <span className="status-label">Live events</span>
          <strong className={`connection connection-${events.connection}`}>
            {events.connection}
          </strong>
          <small>
            {events.lastEvent === null
              ? "Waiting for first event"
              : `Revision ${events.currentRevision}`}
          </small>
        </article>
        <article className="status-card status-card-muted">
          <span className="status-label">MQTT / devices</span>
          <strong>Next milestone</strong>
          <small>No actuator commands are sent by this scaffold.</small>
        </article>
      </section>

      {health.isError ? (
        <p className="error-banner" role="alert">
          {health.error.message}
        </p>
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

  return (
    <main className="page narrow-page">
      <p className="eyebrow">Reserved migration route</p>
      <h1>{parsedArea.data}</h1>
      <p>
        The legacy schedule editor will move here after its UTC interpolation,
        throttle, pin mapping, and firmware schedule compiler have golden tests.
      </p>
      <Link className="text-link" to="/">
        Back to overview
      </Link>
    </main>
  );
}

function PlaceholderPage({
  eyebrow,
  title,
  children,
}: {
  readonly eyebrow: string;
  readonly title: string;
  readonly children: React.ReactNode;
}): React.JSX.Element {
  return (
    <main className="page narrow-page">
      <p className="eyebrow">{eyebrow}</p>
      <h1>{title}</h1>
      <p>{children}</p>
    </main>
  );
}

function NotFound(): React.JSX.Element {
  return (
    <main className="page narrow-page">
      <p className="eyebrow">404</p>
      <h1>That control surface does not exist.</h1>
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
          <NavLink to="/logs">Logs</NavLink>
          <NavLink to="/admin">Admin</NavLink>
        </nav>
      </header>

      <Routes>
        <Route path="/" element={<Dashboard />} />
        <Route path="/control/:deviceType" element={<ControlArea />} />
        <Route
          path="/logs"
          element={
            <PlaceholderPage eyebrow="Structured events" title="Logs">
              Query, retention, and export land with the separate events
              database.
            </PlaceholderPage>
          }
        />
        <Route
          path="/admin"
          element={
            <PlaceholderPage eyebrow="Protected operations" title="Admin">
              Reboot, deployment, diagnostics, and run-once controls will live
              behind an explicit authorization boundary—not unauthenticated GET
              routes.
            </PlaceholderPage>
          }
        />
        <Route path="*" element={<NotFound />} />
      </Routes>
    </div>
  );
}
