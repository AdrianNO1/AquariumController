import type {
  Channel,
  ControlArea,
  MappingProfile,
  Output,
  PinMapping,
} from "@aquarium/contracts";
import { useMutation } from "@tanstack/react-query";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { deleteMappingProfile, replaceMappingProfile } from "./api.js";
import {
  configurationErrorMessage,
  currentRevisionFromError,
} from "./configuration-ui.js";
import { ModalDialog } from "./ModalDialog.js";
import { useDraftRevision } from "./use-draft-revision.js";

type TargetKind = PinMapping["target"]["kind"];

export interface MappingProfilesDialogProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly profiles: readonly MappingProfile[];
  readonly channels: readonly Channel[];
  readonly outputs: readonly Output[];
  readonly controlAreas: readonly ControlArea[];
  readonly expectedRevision: number;
  readonly refresh: () => void;
}

interface EditableMapping extends Omit<PinMapping, "target"> {
  readonly target: PinMapping["target"];
  readonly targetKind: TargetKind;
}

interface MappingDraft {
  readonly name: string;
  readonly deviceNamePrefix: string;
  readonly outputGain: number;
  readonly mappings: readonly EditableMapping[];
}

interface MappingEditorState {
  readonly authoritativeSignature: string;
  readonly draft: MappingDraft;
  readonly touched: boolean;
}

interface TargetOption {
  readonly kind: TargetKind;
  readonly id: string;
  readonly label: string;
}

export function MappingProfilesDialog({
  open,
  onClose,
  profiles,
  channels,
  outputs,
  controlAreas,
  expectedRevision,
  refresh,
}: MappingProfilesDialogProps): React.JSX.Element | null {
  const [selectedProfileId, setSelectedProfileId] = useState(
    profiles[0]?.id ?? "",
  );
  const [newProfileId, setNewProfileId] = useState<string | null>(null);
  const [deletedProfileIds, setDeletedProfileIds] = useState<
    ReadonlySet<string>
  >(() => new Set());
  const [editorDirty, setEditorDirty] = useState(false);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const restoreFocusAfterEditorReplacement = useRef(false);
  const visibleProfiles = profiles.filter(
    (profile) => !deletedProfileIds.has(profile.id),
  );
  const effectiveSelectedId = visibleProfiles.some(
    (profile) => profile.id === selectedProfileId,
  )
    ? selectedProfileId
    : (visibleProfiles[0]?.id ?? "");
  const selectedProfile =
    newProfileId === null
      ? (visibleProfiles.find(
          (profile) => profile.id === effectiveSelectedId,
        ) ?? null)
      : null;

  useLayoutEffect(() => {
    if (!restoreFocusAfterEditorReplacement.current) return;
    restoreFocusAfterEditorReplacement.current = false;
    closeButtonRef.current?.focus();
  }, [deletedProfileIds, newProfileId]);

  if (!open) return null;

  function startNewProfile(): void {
    const id = createHiddenIdentifier(
      "profile",
      new Set(profiles.map((profile) => profile.id)),
    );
    setEditorDirty(false);
    setNewProfileId(id);
  }

  function selectProfile(profileId: string): void {
    setEditorDirty(false);
    setNewProfileId(null);
    setSelectedProfileId(profileId);
  }

  function finishNewProfile(profileId: string): void {
    restoreFocusAfterEditorReplacement.current = true;
    setSelectedProfileId(profileId);
    setNewProfileId(null);
  }

  function finishDeletion(profileId: string): void {
    const nextProfile = visibleProfiles.find(
      (profile) => profile.id !== profileId,
    );
    restoreFocusAfterEditorReplacement.current = true;
    setDeletedProfileIds((existing) => new Set([...existing, profileId]));
    setSelectedProfileId(nextProfile?.id ?? "");
    setNewProfileId(null);
  }

  return (
    <div
      className="modal-backdrop mapping-profiles-backdrop"
      role="presentation"
    >
      <ModalDialog
        className="configuration-dialog mapping-profiles-dialog"
        labelledBy="mapping-profiles-dialog-heading"
        onClose={onClose}
      >
        <div className="dialog-header mapping-profiles-dialog-header">
          <div>
            <p className="eyebrow">Pins and targets</p>
            <h2 id="mapping-profiles-dialog-heading">Mapping profiles</h2>
          </div>
          <button
            ref={closeButtonRef}
            className="icon-button"
            type="button"
            aria-label="Close mapping profiles"
            onClick={onClose}
          >
            ×
          </button>
        </div>

        <div className="mapping-profile-toolbar">
          <label className="field">
            Profile
            <select
              aria-label="Mapping profile"
              aria-describedby={
                editorDirty ? "mapping-profile-switch-help" : undefined
              }
              value={newProfileId === null ? effectiveSelectedId : ""}
              disabled={
                editorDirty ||
                newProfileId !== null ||
                visibleProfiles.length === 0
              }
              onChange={(event) => selectProfile(event.currentTarget.value)}
            >
              {visibleProfiles.map((profile) => (
                <option key={profile.id} value={profile.id}>
                  {profile.name}
                </option>
              ))}
            </select>
          </label>
          <button
            className="secondary-button"
            type="button"
            aria-describedby={
              editorDirty ? "mapping-profile-switch-help" : undefined
            }
            disabled={editorDirty || newProfileId !== null}
            onClick={startNewProfile}
          >
            New profile
          </button>
        </div>
        {editorDirty ? (
          <p
            className="muted-copy"
            id="mapping-profile-switch-help"
            role="status"
          >
            Save or discard changes before switching profiles.
          </p>
        ) : null}

        {selectedProfile === null && newProfileId === null ? (
          <div className="empty-panel mapping-profile-empty">
            <p>No mapping profiles exist yet.</p>
            <button
              className="primary-button"
              type="button"
              onClick={startNewProfile}
            >
              Create first profile
            </button>
          </div>
        ) : (
          <MappingProfileEditor
            key={selectedProfile?.id ?? `new-${newProfileId}`}
            profile={selectedProfile}
            profileId={selectedProfile?.id ?? newProfileId ?? ""}
            channels={channels}
            outputs={outputs}
            controlAreas={controlAreas}
            expectedRevision={expectedRevision}
            refresh={refresh}
            onCancelNew={() => setNewProfileId(null)}
            onSavedNew={finishNewProfile}
            onDeleted={finishDeletion}
            onDirtyChange={setEditorDirty}
          />
        )}
      </ModalDialog>
    </div>
  );
}

interface MappingProfileEditorProps {
  readonly profile: MappingProfile | null;
  readonly profileId: string;
  readonly channels: readonly Channel[];
  readonly outputs: readonly Output[];
  readonly controlAreas: readonly ControlArea[];
  readonly expectedRevision: number;
  readonly refresh: () => void;
  readonly onCancelNew: () => void;
  readonly onSavedNew: (profileId: string) => void;
  readonly onDeleted: (profileId: string) => void;
  readonly onDirtyChange: (dirty: boolean) => void;
}

function MappingProfileEditor({
  profile,
  profileId,
  channels,
  outputs,
  controlAreas,
  expectedRevision,
  refresh,
  onCancelNew,
  onSavedNew,
  onDeleted,
  onDirtyChange,
}: MappingProfileEditorProps): React.JSX.Element {
  const original = useMemo<MappingDraft>(
    () => ({
      name: profile?.name ?? "",
      deviceNamePrefix: profile?.deviceNamePrefix ?? "",
      outputGain: profile?.outputGain ?? 1,
      mappings: (profile?.mappings ?? []).map(toEditableMapping),
    }),
    [profile],
  );
  const originalSignature = mappingDraftSignature(original);
  const [editorState, setEditorState] = useState<MappingEditorState>(() => ({
    authoritativeSignature: originalSignature,
    draft: original,
    touched: false,
  }));
  const [confirmingDelete, setConfirmingDelete] = useState(false);
  const [saveConflictRevision, setSaveConflictRevision] = useState<
    number | null
  >(null);
  const [deleteConflictRevision, setDeleteConflictRevision] = useState<
    number | null
  >(null);
  const draftRevision = useDraftRevision(expectedRevision);
  const draft = editorState.draft;
  const dirty = mappingDraftSignature(draft) !== originalSignature;
  const saveExpectedRevision =
    saveConflictRevision === null
      ? draftRevision.revision
      : Math.max(saveConflictRevision, expectedRevision);
  const deleteExpectedRevision =
    deleteConflictRevision === null
      ? expectedRevision
      : Math.max(deleteConflictRevision, expectedRevision);
  const validationErrors = validateDraft(draft);
  const targetOptions = useMemo(
    () => buildTargetOptions(channels, outputs, controlAreas),
    [channels, controlAreas, outputs],
  );
  const availableTarget = targetOptions.find(
    (option) =>
      !draft.mappings.some(
        (mapping) =>
          mapping.target.kind === option.kind &&
          mapping.target.id === option.id,
      ),
  );
  const availablePin = firstAvailablePin(draft.mappings);
  const saveMutation = useMutation({
    retry: false,
    mutationFn: () =>
      replaceMappingProfile(profileId, {
        expectedRevision: saveExpectedRevision,
        name: draft.name,
        deviceNamePrefix: draft.deviceNamePrefix,
        outputGain: draft.outputGain,
        mappings: draft.mappings.map(toPinMapping),
      }),
    onSuccess: () => {
      setSaveConflictRevision(null);
      draftRevision.reset();
      refresh();
      if (profile === null) onSavedNew(profileId);
    },
    onError: (error) => {
      const currentRevision = currentRevisionFromError(error);
      if (currentRevision === null) return;
      setSaveConflictRevision(currentRevision);
      refresh();
    },
  });
  const deleteMutation = useMutation({
    retry: false,
    mutationFn: () => deleteMappingProfile(profileId, deleteExpectedRevision),
    onSuccess: () => {
      setDeleteConflictRevision(null);
      setConfirmingDelete(false);
      refresh();
      onDeleted(profileId);
    },
    onError: (error) => {
      const currentRevision = currentRevisionFromError(error);
      if (currentRevision === null) return;
      setDeleteConflictRevision(currentRevision);
      refresh();
    },
  });

  useEffect(() => {
    onDirtyChange(dirty);
    return () => onDirtyChange(false);
  }, [dirty, onDirtyChange]);

  if (editorState.authoritativeSignature !== originalSignature) {
    const draftResolved =
      mappingDraftSignature(editorState.draft) === originalSignature;
    const preserveDraft = editorState.touched && !draftResolved;
    setEditorState({
      authoritativeSignature: originalSignature,
      draft: preserveDraft ? editorState.draft : original,
      touched: preserveDraft,
    });
    if (!preserveDraft) draftRevision.reset();
  }

  function applyDraft(nextDraft: MappingDraft): void {
    const touched = mappingDraftSignature(nextDraft) !== originalSignature;
    if (touched) {
      draftRevision.pin();
    } else {
      draftRevision.reset();
    }
    setEditorState({
      authoritativeSignature: originalSignature,
      draft: nextDraft,
      touched,
    });
  }

  function addMapping(): void {
    if (availableTarget === undefined || availablePin === null) return;
    const mappingIds = new Set(draft.mappings.map((mapping) => mapping.id));
    applyDraft({
      ...draft,
      mappings: [
        ...draft.mappings,
        {
          id: createHiddenIdentifier("mapping", mappingIds),
          pin: availablePin,
          displayOrder: draft.mappings.length,
          enabled: true,
          target: {
            kind: availableTarget.kind,
            id: availableTarget.id,
          },
          targetKind: availableTarget.kind,
        },
      ],
    });
  }

  function resetDraft(): void {
    setSaveConflictRevision(null);
    draftRevision.reset();
    setEditorState({
      authoritativeSignature: originalSignature,
      draft: original,
      touched: false,
    });
  }

  return (
    <div className="profile-editor mapping-profile-editor">
      <div className="profile-fields form-grid-three">
        <label>
          Profile name
          <input
            value={draft.name}
            maxLength={256}
            required
            onChange={(event) =>
              applyDraft({ ...draft, name: event.currentTarget.value })
            }
          />
        </label>
        <label>
          Device-name prefix
          <input
            value={draft.deviceNamePrefix}
            maxLength={256}
            required
            aria-describedby="mapping-prefix-help"
            onChange={(event) =>
              applyDraft({
                ...draft,
                deviceNamePrefix: event.currentTarget.value,
              })
            }
          />
          <small id="mapping-prefix-help">
            Case-sensitive. Devices whose configured names start with this text
            use the profile.
          </small>
        </label>
        <label>
          Output multiplier
          <input
            type="number"
            min="0"
            max="1"
            step="0.01"
            value={Number.isNaN(draft.outputGain) ? "" : draft.outputGain}
            onChange={(event) =>
              applyDraft({
                ...draft,
                outputGain: event.currentTarget.valueAsNumber,
              })
            }
          />
        </label>
      </div>

      <div className="mapping-profile-section-heading">
        <div>
          <h3>Pin mappings</h3>
          <p className="muted-copy">Targets can come from any control area.</p>
        </div>
        <button
          className="secondary-button"
          type="button"
          disabled={
            availableTarget === undefined ||
            availablePin === null ||
            saveMutation.isPending
          }
          onClick={addMapping}
        >
          Add mapping
        </button>
      </div>

      <div className="mapping-list mapping-profile-list">
        {draft.mappings.length === 0 ? (
          <p className="muted-copy">No pins are mapped in this profile.</p>
        ) : (
          draft.mappings.map((mapping, index) => (
            <MappingEditorRow
              key={mapping.id}
              index={index}
              mapping={mapping}
              targetOptions={targetOptions}
              onChange={(changed) =>
                applyDraft({
                  ...draft,
                  mappings: draft.mappings.map((candidate) =>
                    candidate.id === mapping.id ? changed : candidate,
                  ),
                })
              }
              onRemove={() =>
                applyDraft({
                  ...draft,
                  mappings: draft.mappings.filter(
                    (candidate) => candidate.id !== mapping.id,
                  ),
                })
              }
            />
          ))
        )}
      </div>

      {validationErrors.length === 0 ? null : (
        <ul className="validation-list" aria-label="Profile validation errors">
          {validationErrors.map((message) => (
            <li key={message}>{message}</li>
          ))}
        </ul>
      )}
      {saveMutation.error === null ? null : (
        <p className="field-error" role="alert">
          {configurationErrorMessage(saveMutation.error)}
        </p>
      )}
      {saveMutation.isSuccess ? (
        <p className="success-message" role="status">
          Mapping profile save accepted. Refreshing authoritative state.
        </p>
      ) : null}

      <div className="button-row editor-actions">
        <button
          className="primary-button"
          type="button"
          disabled={
            validationErrors.length > 0 ||
            (!dirty && profile !== null) ||
            saveMutation.isPending
          }
          onClick={() => saveMutation.mutate()}
        >
          {saveMutation.isPending ? "Saving profile…" : "Save profile"}
        </button>
        <button
          className="secondary-button"
          type="button"
          disabled={!dirty || saveMutation.isPending}
          onClick={resetDraft}
        >
          Discard changes
        </button>
        {profile === null ? (
          <button
            className="text-button"
            type="button"
            disabled={saveMutation.isPending}
            onClick={onCancelNew}
          >
            Cancel new profile
          </button>
        ) : (
          <button
            className="text-button danger-text"
            type="button"
            disabled={deleteMutation.isPending}
            onClick={() => setConfirmingDelete(true)}
          >
            Delete profile
          </button>
        )}
      </div>

      {confirmingDelete ? (
        <div className="nested-confirmation-backdrop" role="presentation">
          <ModalDialog
            className="mapping-profile-delete-confirmation"
            describedBy="delete-mapping-profile-description"
            labelledBy="delete-mapping-profile-heading"
            onClose={() => setConfirmingDelete(false)}
            role="alertdialog"
          >
            <h3 id="delete-mapping-profile-heading">
              Delete {profile?.name ?? "profile"}?
            </h3>
            <p id="delete-mapping-profile-description">
              Devices referencing this profile will become unmapped and will
              stop receiving mapped commands until they are assigned another
              profile.
            </p>
            {dirty ? (
              <p className="muted-copy">
                Unsaved profile edits will be discarded.
              </p>
            ) : null}
            {deleteMutation.error === null ? null : (
              <p className="field-error" role="alert">
                {configurationErrorMessage(deleteMutation.error)}
              </p>
            )}
            <div className="button-row">
              <button
                className="danger-button"
                type="button"
                disabled={deleteMutation.isPending}
                onClick={() => deleteMutation.mutate()}
              >
                {deleteMutation.isPending
                  ? "Deleting profile…"
                  : "Delete profile"}
              </button>
              <button
                className="secondary-button"
                type="button"
                disabled={deleteMutation.isPending}
                onClick={() => setConfirmingDelete(false)}
              >
                Keep profile
              </button>
            </div>
          </ModalDialog>
        </div>
      ) : null}
    </div>
  );
}

interface MappingEditorRowProps {
  readonly index: number;
  readonly mapping: EditableMapping;
  readonly targetOptions: readonly TargetOption[];
  readonly onChange: (mapping: EditableMapping) => void;
  readonly onRemove: () => void;
}

function MappingEditorRow({
  index,
  mapping,
  targetOptions,
  onChange,
  onRemove,
}: MappingEditorRowProps): React.JSX.Element {
  const rowNumber = index + 1;
  const selectedTarget = targetOptions.find(
    (option) =>
      option.kind === mapping.target.kind && option.id === mapping.target.id,
  );
  const targetKindChanged = mapping.targetKind !== mapping.target.kind;

  return (
    <article className="mapping-row mapping-profile-row">
      <label>
        Pin
        <input
          aria-label={`Pin for mapping ${rowNumber}`}
          type="number"
          min="0"
          max="63"
          step="1"
          value={Number.isNaN(mapping.pin) ? "" : mapping.pin}
          onChange={(event) =>
            onChange({ ...mapping, pin: event.currentTarget.valueAsNumber })
          }
        />
      </label>
      <label>
        Target type
        <select
          aria-label={`Target type for mapping ${rowNumber}`}
          value={mapping.targetKind}
          onChange={(event) =>
            onChange({
              ...mapping,
              targetKind: event.currentTarget.value as TargetKind,
            })
          }
        >
          <option value="channel">Channel</option>
          <option value="output">Output</option>
        </select>
      </label>
      <TargetPicker
        rowNumber={rowNumber}
        kind={mapping.targetKind}
        currentLabel={
          selectedTarget?.label ?? `Unavailable ${mapping.target.kind}`
        }
        targetKindChanged={targetKindChanged}
        options={targetOptions}
        selectedId={
          targetKindChanged || mapping.target.kind !== mapping.targetKind
            ? null
            : mapping.target.id
        }
        onSelect={(target) =>
          onChange({
            ...mapping,
            targetKind: target.kind,
            target: { kind: target.kind, id: target.id },
          })
        }
      />
      <label className="checkbox-label mapping-enabled-control">
        <input
          type="checkbox"
          checked={mapping.enabled}
          onChange={(event) =>
            onChange({ ...mapping, enabled: event.currentTarget.checked })
          }
        />
        Enabled
      </label>
      <button
        className="text-button danger-text"
        type="button"
        aria-label={`Remove mapping ${rowNumber}`}
        onClick={onRemove}
      >
        Remove
      </button>
    </article>
  );
}

interface TargetPickerProps {
  readonly rowNumber: number;
  readonly kind: TargetKind;
  readonly currentLabel: string;
  readonly targetKindChanged: boolean;
  readonly options: readonly TargetOption[];
  readonly selectedId: string | null;
  readonly onSelect: (target: TargetOption) => void;
}

function TargetPicker({
  rowNumber,
  kind,
  currentLabel,
  targetKindChanged,
  options,
  selectedId,
  onSelect,
}: TargetPickerProps): React.JSX.Element {
  const [open, setOpen] = useState(false);
  const [search, setSearch] = useState("");
  const triggerRef = useRef<HTMLButtonElement>(null);
  const restoreFocusAfterClose = useRef(false);
  const kindOptions = options.filter((option) => option.kind === kind);
  const normalizedSearch = search.trim().toLocaleLowerCase();
  const filteredOptions =
    normalizedSearch.length === 0
      ? kindOptions
      : kindOptions.filter((option) =>
          option.label.toLocaleLowerCase().includes(normalizedSearch),
        );

  function openPicker(): void {
    setSearch("");
    setOpen(true);
  }

  function closePicker(): void {
    restoreFocusAfterClose.current = true;
    setOpen(false);
  }

  useEffect(() => {
    if (open || !restoreFocusAfterClose.current) return;
    restoreFocusAfterClose.current = false;
    triggerRef.current?.focus();
  }, [open]);

  return (
    <div className="mapping-target-picker">
      <span className="mapping-target-label">Target</span>
      <button
        ref={triggerRef}
        className="mapping-target-trigger"
        type="button"
        aria-label={`Target for mapping ${rowNumber}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={openPicker}
      >
        {targetKindChanged
          ? `Choose ${kind} target (currently ${currentLabel})`
          : currentLabel}
      </button>
      {open ? (
        <div
          className="mapping-target-popover"
          role="dialog"
          aria-label={`Choose ${kind} target for mapping ${rowNumber}`}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              event.preventDefault();
              event.stopPropagation();
              closePicker();
            }
          }}
        >
          <div className="mapping-target-search-row">
            <label>
              Search all {kind} targets
              <input
                autoFocus
                type="search"
                value={search}
                onChange={(event) => setSearch(event.currentTarget.value)}
              />
            </label>
            <button
              className="icon-button"
              type="button"
              aria-label="Close target picker"
              onClick={closePicker}
            >
              ×
            </button>
          </div>
          <div
            className="mapping-target-options"
            role="listbox"
            aria-label={`Available ${kind} targets`}
          >
            {filteredOptions.length === 0 ? (
              <p className="muted-copy">No matching targets.</p>
            ) : (
              filteredOptions.map((option) => (
                <button
                  key={`${option.kind}:${option.id}`}
                  className="mapping-target-option"
                  type="button"
                  role="option"
                  aria-selected={option.id === selectedId}
                  onClick={() => {
                    onSelect(option);
                    closePicker();
                  }}
                >
                  {option.label}
                </button>
              ))
            )}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function buildTargetOptions(
  channels: readonly Channel[],
  outputs: readonly Output[],
  controlAreas: readonly ControlArea[],
): readonly TargetOption[] {
  const areaLabels = new Map(
    controlAreas.map((area) => [area.typeKey, area.label]),
  );
  return [
    ...channels.map((channel) => ({
      kind: "channel" as const,
      id: channel.id,
      label: `${areaLabels.get(channel.typeKey) ?? channel.typeKey} · ${channel.name}`,
    })),
    ...outputs.map((output) => ({
      kind: "output" as const,
      id: output.id,
      label: `${areaLabels.get(output.typeKey) ?? output.typeKey} · ${output.name}`,
    })),
  ].sort((left, right) => left.label.localeCompare(right.label));
}

function toEditableMapping(mapping: PinMapping): EditableMapping {
  return { ...mapping, targetKind: mapping.target.kind };
}

function toPinMapping(mapping: EditableMapping, index: number): PinMapping {
  return {
    id: mapping.id,
    pin: mapping.pin,
    displayOrder: index,
    enabled: mapping.enabled,
    target: mapping.target,
  };
}

function mappingDraftSignature(draft: MappingDraft): string {
  return JSON.stringify(draft);
}

function validateDraft(draft: MappingDraft): readonly string[] {
  const errors: string[] = [];
  const name = draft.name;
  const prefix = draft.deviceNamePrefix;
  if (name.length === 0 || name.length > 256 || name.trim() !== name) {
    errors.push(
      "Profile name is required and cannot have leading or trailing spaces.",
    );
  }
  if (prefix.length === 0 || prefix.length > 256 || prefix.trim() !== prefix) {
    errors.push(
      "Device-name prefix is required and cannot have leading or trailing spaces.",
    );
  }
  if (
    !Number.isFinite(draft.outputGain) ||
    draft.outputGain < 0 ||
    draft.outputGain > 1
  ) {
    errors.push("Output multiplier must be between 0 and 1.");
  }

  const pins = new Set<number>();
  const targets = new Set<string>();
  for (const [index, mapping] of draft.mappings.entries()) {
    if (!Number.isInteger(mapping.pin) || mapping.pin < 0 || mapping.pin > 63) {
      errors.push(
        `Mapping ${index + 1} needs a whole-number pin from 0 to 63.`,
      );
    } else if (pins.has(mapping.pin)) {
      errors.push(`Pin ${mapping.pin} is used more than once.`);
    }
    pins.add(mapping.pin);

    if (mapping.targetKind !== mapping.target.kind) {
      errors.push(
        `Mapping ${index + 1} needs a ${mapping.targetKind} target selected.`,
      );
      continue;
    }
    const targetKey = `${mapping.target.kind}:${mapping.target.id}`;
    if (targets.has(targetKey)) {
      errors.push(`Mapping ${index + 1} repeats an existing target.`);
    }
    targets.add(targetKey);
  }
  return errors;
}

function firstAvailablePin(
  mappings: readonly EditableMapping[],
): number | null {
  const usedPins = new Set(mappings.map((mapping) => mapping.pin));
  for (let pin = 0; pin <= 63; pin += 1) {
    if (!usedPins.has(pin)) return pin;
  }
  return null;
}

function createHiddenIdentifier(
  prefix: "profile" | "mapping",
  existingIds: ReadonlySet<string>,
): string {
  let id: string;
  do {
    id = `${prefix}-${globalThis.crypto.randomUUID()}`;
  } while (existingIds.has(id));
  return id;
}
