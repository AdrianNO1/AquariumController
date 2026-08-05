import type { Channel, ControlArea } from "@aquarium/contracts";
import { useMutation } from "@tanstack/react-query";
import { useMemo, useState } from "react";

import { replaceControlAreaChannels } from "./api.js";
import {
  configurationErrorMessage,
  currentRevisionFromError,
} from "./configuration-ui.js";
import { chooseDistinctChannelColor } from "./channel-color.js";
import { ModalDialog } from "./ModalDialog.js";
import { ModalBackdrop } from "./ModalBackdrop.js";
import { UnsavedChangesDialog } from "./UnsavedChangesDialog.js";
import { useDraftRevision } from "./use-draft-revision.js";

export interface ChannelManagementDialogProps {
  readonly area: ControlArea;
  readonly channels: readonly Channel[];
  readonly throttleId: string | null;
  readonly expectedRevision: number;
  readonly refresh: () => void;
  readonly onClose: () => void;
}

interface ChannelDraft {
  readonly id: string;
  readonly name: string;
  readonly color: string;
  readonly isNew: boolean;
}

export function ChannelManagementDialog({
  area,
  channels,
  throttleId,
  expectedRevision,
  refresh,
  onClose,
}: ChannelManagementDialogProps): React.JSX.Element {
  const initialDrafts = useMemo(
    () =>
      channels.map<ChannelDraft>((channel) => ({
        id: channel.id,
        name: channel.name,
        color: channel.color,
        isNew: false,
      })),
    [channels],
  );
  const [drafts, setDrafts] = useState<readonly ChannelDraft[]>(initialDrafts);
  const [newName, setNewName] = useState("");
  const [newColor, setNewColor] = useState(() =>
    chooseDistinctChannelColor(channels.map((channel) => channel.color)),
  );
  const [closeRequested, setCloseRequested] = useState(false);
  const draftRevision = useDraftRevision(expectedRevision);
  const originalById = new Map(
    channels.map((channel) => [channel.id, channel]),
  );
  const dirty =
    drafts.length !== channels.length ||
    drafts.some((draft) => {
      if (draft.isNew) return true;
      const original = originalById.get(draft.id);
      return (
        original === undefined ||
        original.name !== draft.name ||
        original.color !== draft.color
      );
    });
  const save = useMutation({
    retry: false,
    mutationFn: () =>
      replaceControlAreaChannels(area.slug, {
        expectedRevision: draftRevision.revision,
        channels: drafts.map(({ id, name, color }) => ({ id, name, color })),
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

  function updateDraft(
    id: string,
    update: (draft: ChannelDraft) => ChannelDraft,
  ): void {
    draftRevision.pin();
    setDrafts((current) =>
      current.map((draft) => (draft.id === id ? update(draft) : draft)),
    );
  }

  function addChannel(): void {
    const name = newName.trim();
    if (name.length === 0) return;
    const draft: ChannelDraft = {
      id: `channel-${crypto.randomUUID()}`,
      name,
      color: newColor,
      isNew: true,
    };
    draftRevision.pin();
    const nextDrafts = [...drafts, draft];
    setDrafts(nextDrafts);
    setNewName("");
    setNewColor(
      chooseDistinctChannelColor(nextDrafts.map((channel) => channel.color)),
    );
  }

  function removeChannel(draft: ChannelDraft): void {
    draftRevision.pin();
    setDrafts((current) =>
      current.filter((channel) => channel.id !== draft.id),
    );
  }

  function requestClose(): void {
    if (dirty) {
      setCloseRequested(true);
      return;
    }
    onClose();
  }

  return (
    <ModalBackdrop onClose={requestClose}>
      <ModalDialog
        className="configuration-dialog channel-dialog"
        labelledBy="manage-channels-heading"
        onClose={requestClose}
      >
        <div className="dialog-header">
          <div>
            <p className="eyebrow">{area.label}</p>
            <h2 id="manage-channels-heading">Manage channels</h2>
          </div>
          <button
            className="icon-button"
            type="button"
            aria-label="Close channel manager"
            onClick={requestClose}
          >
            ×
          </button>
        </div>
        <div className="dialog-body">
          <div className="channel-management-list">
            {drafts.map((draft) => (
              <div className="channel-management-row" key={draft.id}>
                <label
                  className="channel-color-field"
                  title={`Color for ${draft.name}`}
                >
                  <span className="visually-hidden">
                    Color for {draft.name}
                  </span>
                  <input
                    type="color"
                    value={draft.color}
                    onChange={(event) => {
                      const color = event.currentTarget.value;
                      updateDraft(draft.id, (current) => ({
                        ...current,
                        color,
                      }));
                    }}
                  />
                </label>
                <label className="field">
                  <span className="visually-hidden">
                    Channel name for {draft.name}
                  </span>
                  <input
                    value={draft.name}
                    maxLength={120}
                    required
                    onChange={(event) => {
                      const name = event.currentTarget.value;
                      updateDraft(draft.id, (current) => ({
                        ...current,
                        name,
                      }));
                    }}
                  />
                </label>
                <button
                  className="danger-button compact-button"
                  type="button"
                  aria-label={`Delete ${draft.name.trim() || "unnamed channel"}`}
                  onClick={() => removeChannel(draft)}
                >
                  Delete
                </button>
              </div>
            ))}
          </div>
          <div className="add-channel-row">
            <label
              className="channel-color-field"
              title="Color for new channel"
            >
              <span className="visually-hidden">New channel color</span>
              <input
                type="color"
                value={newColor}
                onChange={(event) => setNewColor(event.currentTarget.value)}
              />
            </label>
            <label className="field">
              <span>New channel</span>
              <input
                value={newName}
                placeholder="Channel name"
                maxLength={120}
                onChange={(event) => setNewName(event.currentTarget.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    addChannel();
                  }
                }}
              />
            </label>
            <button
              className="secondary-button"
              type="button"
              disabled={newName.trim().length === 0 || throttleId === null}
              onClick={addChannel}
            >
              Add
            </button>
          </div>
          {throttleId === null ? (
            <p className="field-error" role="alert">
              This area has no schedule multiplier record. Existing channels can
              be edited, but new channels cannot be created.
            </p>
          ) : null}
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
            disabled={
              !dirty ||
              drafts.some((draft) => draft.name.trim().length === 0) ||
              save.isPending
            }
            onClick={() => save.mutate()}
          >
            {save.isPending ? "Saving…" : "Save changes"}
          </button>
        </div>
        <UnsavedChangesDialog
          open={closeRequested && dirty}
          saving={save.isPending}
          saveDisabled={drafts.some((draft) => draft.name.trim().length === 0)}
          onSave={() => save.mutate()}
          onDiscard={onClose}
          onKeepEditing={() => setCloseRequested(false)}
        />
      </ModalDialog>
    </ModalBackdrop>
  );
}
