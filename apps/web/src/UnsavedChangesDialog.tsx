import { useId } from "react";

import { ModalBackdrop } from "./ModalBackdrop.js";
import { ModalDialog } from "./ModalDialog.js";

export interface UnsavedChangesDialogProps {
  readonly open: boolean;
  readonly saving: boolean;
  readonly saveDisabled?: boolean;
  readonly onSave: () => void;
  readonly onDiscard: () => void;
  readonly onKeepEditing: () => void;
}

export function UnsavedChangesDialog({
  open,
  saving,
  saveDisabled = false,
  onSave,
  onDiscard,
  onKeepEditing,
}: UnsavedChangesDialogProps): React.JSX.Element | null {
  const id = useId();
  if (!open) return null;

  const headingId = `${id}-heading`;
  const descriptionId = `${id}-description`;
  return (
    <ModalBackdrop
      className="nested-confirmation-backdrop"
      onClose={onKeepEditing}
    >
      <ModalDialog
        className="unsaved-changes-confirmation"
        describedBy={descriptionId}
        labelledBy={headingId}
        onClose={onKeepEditing}
        role="alertdialog"
      >
        <h3 id={headingId}>Save changes before closing?</h3>
        <p id={descriptionId}>This editor has unsaved changes.</p>
        <div className="button-row">
          <button
            className="primary-button"
            type="button"
            disabled={saving || saveDisabled}
            onClick={onSave}
          >
            {saving ? "Saving…" : "Save changes"}
          </button>
          <button
            className="danger-button"
            type="button"
            disabled={saving}
            onClick={onDiscard}
          >
            Discard changes
          </button>
          <button
            className="secondary-button"
            type="button"
            disabled={saving}
            onClick={onKeepEditing}
          >
            Keep editing
          </button>
        </div>
      </ModalDialog>
    </ModalBackdrop>
  );
}
