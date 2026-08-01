import { Link } from "react-router";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";

import { requestFleetFirmwareUpdate } from "./api.js";
import {
  configurationErrorMessage,
  currentRevisionFromError,
} from "./configuration-ui.js";
import { FirmwareUpdateDialog } from "./FirmwareUpdateDialog.js";
import { UnresolvedOperationStatusPanel } from "./OperationStatusPanel.js";
import { useControllerState } from "./use-controller-state.js";

export function OperationsPage(): React.JSX.Element {
  const controller = useControllerState();
  const [firmwareDialogOpen, setFirmwareDialogOpen] = useState(false);
  const firmwareMutation = useMutation({
    retry: false,
    mutationFn: (mode: "immediate" | "when_off") => {
      if (controller.snapshot === null) {
        throw new Error("Controller state is unavailable");
      }
      return requestFleetFirmwareUpdate({
        expectedRevision: controller.snapshot.revision,
        mode,
      });
    },
    onSuccess: () => {
      setFirmwareDialogOpen(false);
      controller.refresh();
    },
    onError: (error) => {
      if (currentRevisionFromError(error) !== null) controller.refresh();
    },
  });
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

      <section
        className="firmware-fleet-panel"
        aria-labelledby="firmware-fleet-heading"
      >
        <div>
          <p className="eyebrow">ESP32 fleet</p>
          <h2 id="firmware-fleet-heading">Firmware updates</h2>
          <p>
            Current release: {controller.snapshot.firmware.currentVersion}. An
            update-all choice stays active for outdated ESPs that reconnect
            later.
          </p>
          {controller.snapshot.firmware.fleetPolicy === null ? null : (
            <p className="firmware-fleet-policy" role="status">
              Active rollout:{" "}
              {controller.snapshot.firmware.fleetPolicy.mode === "when_off"
                ? "update when outputs are off"
                : "update immediately"}
            </p>
          )}
        </div>
        <button
          className="primary-button"
          type="button"
          disabled={controller.status !== "connected"}
          onClick={() => setFirmwareDialogOpen(true)}
        >
          Update all ESPs
        </button>
      </section>

      {firmwareMutation.error === null ? null : (
        <p className="field-error" role="alert">
          {configurationErrorMessage(firmwareMutation.error)}
        </p>
      )}

      <UnresolvedOperationStatusPanel
        operations={unresolved.items}
        devices={controller.snapshot.devices}
        truncated={unresolved.truncated}
        expectedRevision={controller.snapshot.revision}
        refresh={controller.refresh}
      />
      {firmwareDialogOpen ? (
        <FirmwareUpdateDialog
          subject="all ESP32 devices"
          targetVersion={controller.snapshot.firmware.currentVersion}
          pending={firmwareMutation.isPending}
          onConfirm={(mode) => firmwareMutation.mutate(mode)}
          onClose={() => setFirmwareDialogOpen(false)}
        />
      ) : null}
    </main>
  );
}
