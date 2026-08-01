import type { FirmwareUpdateMode } from "@aquarium/contracts";

import { ModalBackdrop } from "./ModalBackdrop.js";
import { ModalDialog } from "./ModalDialog.js";

export function FirmwareUpdateDialog({
  subject,
  targetVersion,
  pending,
  onConfirm,
  onClose,
}: {
  readonly subject: string;
  readonly targetVersion: string;
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
          <button
            className="primary-button"
            type="button"
            disabled={pending}
            onClick={() => onConfirm("immediate")}
          >
            Update now
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
