import type { Channel, ControlArea, Output } from "@aquarium/contracts";
import { useMutation } from "@tanstack/react-query";
import { useMemo, useState } from "react";

import { replaceControlAreas } from "./api.js";
import {
  configurationErrorMessage,
  currentRevisionFromError,
} from "./configuration-ui.js";
import { ModalBackdrop } from "./ModalBackdrop.js";
import { ModalDialog } from "./ModalDialog.js";
import { UnsavedChangesDialog } from "./UnsavedChangesDialog.js";
import { useDraftRevision } from "./use-draft-revision.js";

interface AreaManagementDialogProps {
  readonly areas: readonly ControlArea[];
  readonly channels: readonly Channel[];
  readonly outputs: readonly Output[];
  readonly expectedRevision: number;
  readonly refresh: () => void;
  readonly onClose: () => void;
}

interface AreaDraft {
  readonly key: string;
  readonly slug: string | null;
  readonly typeKey: string | null;
  readonly label: string;
}

export function AreaManagementDialog({
  areas,
  channels,
  outputs,
  expectedRevision,
  refresh,
  onClose,
}: AreaManagementDialogProps): React.JSX.Element {
  const initialDrafts = useMemo(
    () =>
      areas.map<AreaDraft>((area) => ({
        key: area.slug,
        slug: area.slug,
        typeKey: area.typeKey,
        label: area.label,
      })),
    [areas],
  );
  const [drafts, setDrafts] = useState<readonly AreaDraft[]>(initialDrafts);
  const [newName, setNewName] = useState("");
  const [closeRequested, setCloseRequested] = useState(false);
  const draftRevision = useDraftRevision(expectedRevision);
  const originalBySlug = new Map(areas.map((area) => [area.slug, area]));
  const dirty =
    drafts.length !== areas.length ||
    drafts.some((draft) => {
      if (draft.slug === null) return true;
      return originalBySlug.get(draft.slug)?.label !== draft.label;
    });
  const save = useMutation({
    retry: false,
    mutationFn: () =>
      replaceControlAreas({
        expectedRevision: draftRevision.revision,
        areas: drafts.map(({ slug, label }) => ({ slug, label })),
      }),
    onSuccess: () => {
      draftRevision.reset();
      refresh();
      onClose();
    },
    onError: (error) => {
      if (currentRevisionFromError(error) !== null) refresh();
    },
  });

  function updateName(key: string, label: string): void {
    draftRevision.pin();
    setDrafts((current) =>
      current.map((draft) => (draft.key === key ? { ...draft, label } : draft)),
    );
  }

  function addArea(): void {
    const label = newName.trim();
    if (label.length === 0) return;
    draftRevision.pin();
    setDrafts((current) => [
      ...current,
      {
        key: `new-area-${crypto.randomUUID()}`,
        slug: null,
        typeKey: null,
        label,
      },
    ]);
    setNewName("");
  }

  function removeArea(draft: AreaDraft): void {
    draftRevision.pin();
    setDrafts((current) => current.filter((area) => area.key !== draft.key));
  }

  function requestClose(): void {
    if (dirty) {
      setCloseRequested(true);
      return;
    }
    onClose();
  }

  const invalid = drafts.some((draft) => draft.label.trim().length === 0);
  return (
    <ModalBackdrop onClose={requestClose}>
      <ModalDialog
        className="configuration-dialog area-management-dialog"
        labelledBy="manage-areas-heading"
        onClose={requestClose}
      >
        <div className="dialog-header">
          <div>
            <p className="eyebrow">Overview</p>
            <h2 id="manage-areas-heading">Manage areas</h2>
          </div>
          <button
            className="icon-button"
            type="button"
            aria-label="Close area manager"
            onClick={requestClose}
          >
            ×
          </button>
        </div>
        <div className="dialog-body">
          <div className="area-management-list">
            {drafts.map((draft) => {
              const channelCount = channels.filter(
                (channel) => channel.typeKey === draft.typeKey,
              ).length;
              const outputCount = outputs.filter(
                (output) => output.typeKey === draft.typeKey,
              ).length;
              return (
                <div className="area-management-row" key={draft.key}>
                  <label className="field">
                    <span className="visually-hidden">
                      Area name for {draft.label}
                    </span>
                    <input
                      value={draft.label}
                      maxLength={120}
                      required
                      onChange={(event) =>
                        updateName(draft.key, event.currentTarget.value)
                      }
                    />
                  </label>
                  <button
                    className="danger-button compact-button"
                    type="button"
                    title={`Delete area with ${channelCount} channel${channelCount === 1 ? "" : "s"} and ${outputCount} output${outputCount === 1 ? "" : "s"}`}
                    onClick={() => removeArea(draft)}
                  >
                    Delete
                  </button>
                </div>
              );
            })}
          </div>
          <div className="add-area-row">
            <label className="field">
              <span>New area</span>
              <input
                value={newName}
                placeholder="Area name"
                maxLength={120}
                onChange={(event) => setNewName(event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    addArea();
                  }
                }}
              />
            </label>
            <button
              className="secondary-button"
              type="button"
              disabled={newName.trim().length === 0}
              onClick={addArea}
            >
              Add
            </button>
          </div>
          <p className="muted-copy area-forensics-note">
            Saving an area deletion also removes its unreferenced channels,
            schedules, and outputs atomically. Mappings and retained operational
            history still block deletion and are reported without partial
            changes.
          </p>
          {save.error === null ? null : (
            <p className="field-error" role="alert">
              {configurationErrorMessage(save.error)}
            </p>
          )}
        </div>
        <div className="dialog-actions">
          <button
            className="secondary-button"
            type="button"
            disabled={save.isPending}
            onClick={onClose}
          >
            {dirty ? "Discard changes" : "Close"}
          </button>
          <button
            className="primary-button"
            type="button"
            disabled={!dirty || invalid || save.isPending}
            onClick={() => save.mutate()}
          >
            {save.isPending ? "Saving…" : "Save changes"}
          </button>
        </div>
        <UnsavedChangesDialog
          open={closeRequested && dirty}
          saving={save.isPending}
          saveDisabled={invalid}
          onSave={() => save.mutate()}
          onDiscard={onClose}
          onKeepEditing={() => setCloseRequested(false)}
        />
      </ModalDialog>
    </ModalBackdrop>
  );
}
