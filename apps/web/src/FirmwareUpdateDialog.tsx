import type { FirmwareUpdateMode } from "@aquarium/contracts";

import { ModalBackdrop } from "./ModalBackdrop.js";
import { ModalDialog } from "./ModalDialog.js";

export function FirmwareUpdateDialog({
  subject,
  targetVersion,
  targets,
  immediateDanger = false,
  pending,
  onConfirm,
  onClose,
}: {
  readonly subject: string;
  readonly targetVersion: string;
  readonly targets?: readonly FirmwareUpdateTarget[];
  readonly immediateDanger?: boolean;
  readonly pending: boolean;
  readonly onConfirm: (mode: FirmwareUpdateMode) => void;
  readonly onClose: () => void;
}): React.JSX.Element {
  return (
    <ModalBackdrop onClose={onClose}>
      <ModalDialog
        className="configuration-dialog firmware-update-dialog"
        labelledBy="firmware-update-heading"
        onClose={onClose}
      >
        <div className="dialog-header">
          <div>
            <p className="eyebrow">Wireless firmware update</p>
            <h2 id="firmware-update-heading">Update {subject}?</h2>
          </div>
          <button
            className="icon-button"
            type="button"
            aria-label="Close firmware update confirmation"
            onClick={onClose}
          >
            {"\u00d7"}
          </button>
        </div>
        <div className="dialog-body firmware-update-options">
          <p>
            Install firmware {targetVersion}. Outputs continue running while the
            image downloads, but the ESP restarts briefly to activate it.
          </p>
          {targets === undefined ? null : (
            <section
              className="firmware-update-targets"
              aria-labelledby="firmware-update-targets-heading"
            >
              <h3 id="firmware-update-targets-heading">
                Outdated ESPs ({targets.length})
              </h3>
              {targets.length === 0 ? (
                <p>
                  No enabled ESP is currently outdated. The selected rollout
                  mode will apply if an outdated ESP reconnects later.
                </p>
              ) : (
                <ul>
                  {targets.map((target) => (
                    <li key={target.id}>
                      <strong>{target.name}</strong>
                      <span>
                        {target.firmwareVersion === null
                          ? "Firmware version unknown"
                          : `Firmware ${target.firmwareVersion}`}{" "}
                        {"\u00b7"} {target.status.replaceAll("_", " ")}
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}
          <button
            className={immediateDanger ? "danger-button" : "primary-button"}
            type="button"
            disabled={pending}
            onClick={() => onConfirm("immediate")}
          >
            Update now (restart)
            <small>Download immediately, then restart.</small>
          </button>
          <button
            className="secondary-button"
            type="button"
            disabled={pending}
            onClick={() => onConfirm("when_off")}
          >
            Update when outputs are off
            <small>Wait until every reported pin is at 0%, then update.</small>
          </button>
          <button
            className="text-button"
            type="button"
            disabled={pending}
            onClick={onClose}
          >
            Cancel
          </button>
        </div>
      </ModalDialog>
    </ModalBackdrop>
  );
}

interface FirmwareUpdateTarget {
  readonly id: string;
  readonly name: string;
  readonly firmwareVersion: string | null;
  readonly status: string;
}
