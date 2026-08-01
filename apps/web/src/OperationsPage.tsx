import { Link } from "react-router";

import { UnresolvedOperationStatusPanel } from "./OperationStatusPanel.js";
import { useControllerState } from "./use-controller-state.js";

export function OperationsPage(): React.JSX.Element {
  const controller = useControllerState();
  if (controller.snapshot === null) {
    return (
      <main className="page control-page">
        <p className="eyebrow">Operation recovery</p>
        <h1>Loading controller state</h1>
        {controller.error === null ? (
          <p className="loading-panel" role="status">
            Loading unresolved device outcomes…
          </p>
        ) : (
          <div className="error-banner" role="alert">
            <span>{controller.error}</span>
            <button type="button" onClick={controller.retry}>
              Retry controller state
            </button>
          </div>
        )}
      </main>
    );
  }

  const showConnectionWarning =
    controller.status !== "connected" && controller.status !== "loading";
  const unresolved = controller.snapshot.unresolvedDeviceOperations;

  return (
    <main className="page control-page">
      <div className="control-page-heading">
        <div>
          <p className="eyebrow">Global safety recovery</p>
          <h1>Device operation outcomes</h1>
          <p>
            Inspect and reconcile unknown device outcomes across every control
            area, including devices that are no longer mapped.
          </p>
        </div>
        <Link className="secondary-button" to="/">
          Back to overview
        </Link>
      </div>

      {showConnectionWarning ? (
        <div className="stale-banner" role="status">
          <strong>Controller state is {controller.status}.</strong>
          <span>
            Reconciliation remains concurrency-guarded at revision{" "}
            {controller.snapshot.revision}, but refresh the state stream before
            confirming physical state.
          </span>
          <button
            className="text-button"
            type="button"
            onClick={controller.retry}
          >
            Reconnect state stream
          </button>
        </div>
      ) : null}

      <UnresolvedOperationStatusPanel
        operations={unresolved.items}
        devices={controller.snapshot.devices}
        truncated={unresolved.truncated}
        expectedRevision={controller.snapshot.revision}
        refresh={controller.refresh}
      />
    </main>
  );
}
