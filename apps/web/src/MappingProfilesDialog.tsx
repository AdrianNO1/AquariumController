import type {
  Channel,
  ControlArea,
  Device,
  HardwareProfileId,
  MappingProfile,
  Output,
  PinMapping,
} from "@aquarium/contracts";
import {
  HARDWARE_PROFILES,
  hardwareProfileById,
  isAllowedPwmPin,
  NODEMCU_ESP32S_V1_1_HARDWARE_PROFILE_ID,
} from "@aquarium/contracts";
import { useMutation } from "@tanstack/react-query";
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";

import { deleteMappingProfile, replaceMappingProfile } from "./api.js";
import {
  configurationErrorMessage,
  currentRevisionFromError,
} from "./configuration-ui.js";
import { ModalDialog } from "./ModalDialog.js";
import { ModalBackdrop } from "./ModalBackdrop.js";
import { UnsavedChangesDialog } from "./UnsavedChangesDialog.js";
import { useDraftRevision } from "./use-draft-revision.js";

type TargetKind = PinMapping["target"]["kind"];

export interface MappingProfilesDialogProps {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly profiles: readonly MappingProfile[];
  readonly devices: readonly Device[];
  readonly channels: readonly Channel[];
  readonly outputs: readonly Output[];
  readonly controlAreas: readonly ControlArea[];
  readonly currentTypeKey: string;
  readonly expectedRevision: number;
  readonly refresh: () => void;
}

interface EditableMapping extends Omit<PinMapping, "target"> {
  readonly target: PinMapping["target"];
  readonly targetKind: TargetKind;
}

interface MappingDraft {
  readonly name: string;
  readonly hardwareProfileId: HardwareProfileId;
  readonly outputGain: number;
  readonly mappings: readonly EditableMapping[];
}

interface NewMappingProfile {
  readonly id: string;
  readonly draft: MappingDraft;
}

interface MappingEditorState {
  readonly authoritativeSignature: string;
  readonly draft: MappingDraft;
  readonly touched: boolean;
}

interface PendingSavedDraft {
  readonly revision: number;
  readonly signature: string;
}

interface TargetOption {
  readonly kind: TargetKind;
  readonly id: string;
  readonly label: string;
  readonly searchText: string;
  readonly currentArea: boolean;
}

export function MappingProfilesDialog({
  open,
  onClose,
  profiles,
  devices,
  channels,
  outputs,
  controlAreas,
  currentTypeKey,
  expectedRevision,
  refresh,
}: MappingProfilesDialogProps): React.JSX.Element | null {
  const [selectedProfileId, setSelectedProfileId] = useState(
    profiles[0]?.id ?? "",
  );
  const [newProfile, setNewProfile] = useState<NewMappingProfile | null>(null);
  const [deletedProfileIds, setDeletedProfileIds] = useState<
    ReadonlySet<string>
  >(() => new Set());
  const [editorDirty, setEditorDirty] = useState(false);
  const [closeRequested, setCloseRequested] = useState(false);
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
    newProfile === null
      ? (visibleProfiles.find(
          (profile) => profile.id === effectiveSelectedId,
        ) ?? null)
      : null;

  useLayoutEffect(() => {
    if (!restoreFocusAfterEditorReplacement.current) return;
    restoreFocusAfterEditorReplacement.current = false;
    closeButtonRef.current?.focus();
  }, [deletedProfileIds, newProfile]);

  if (!open) return null;

  function startNewProfile(): void {
    const id = createHiddenIdentifier(
      "profile",
      new Set(profiles.map((profile) => profile.id)),
    );
    setEditorDirty(false);
    setNewProfile({
      id,
      draft: {
        name: "",
        hardwareProfileId: NODEMCU_ESP32S_V1_1_HARDWARE_PROFILE_ID,
        outputGain: 1,
        mappings: [],
      },
    });
  }

  function duplicateSelectedProfile(): void {
    if (selectedProfile === null) return;
    const id = createHiddenIdentifier(
      "profile",
      new Set(profiles.map((profile) => profile.id)),
    );
    const mappingIds = new Set(
      profiles.flatMap((profile) =>
        profile.mappings.map((mapping) => mapping.id),
      ),
    );
    const mappings = selectedProfile.mappings.map((mapping) => {
      const mappingId = createHiddenIdentifier("mapping", mappingIds);
      mappingIds.add(mappingId);
      return toEditableMapping({ ...mapping, id: mappingId });
    });
    setEditorDirty(false);
    setNewProfile({
      id,
      draft: {
        name: duplicateProfileName(
          selectedProfile.name,
          new Set(profiles.map((profile) => profile.name)),
        ),
        hardwareProfileId: selectedProfile.hardwareProfileId,
        outputGain: selectedProfile.outputGain,
        mappings,
      },
    });
  }

  function selectProfile(profileId: string): void {
    setEditorDirty(false);
    setNewProfile(null);
    setSelectedProfileId(profileId);
  }

  function finishNewProfile(profileId: string): void {
    restoreFocusAfterEditorReplacement.current = true;
    setSelectedProfileId(profileId);
    setNewProfile(null);
  }

  function finishDeletion(profileId: string): void {
    const nextProfile = visibleProfiles.find(
      (profile) => profile.id !== profileId,
    );
    restoreFocusAfterEditorReplacement.current = true;
    setDeletedProfileIds((existing) => new Set([...existing, profileId]));
    setSelectedProfileId(nextProfile?.id ?? "");
    setNewProfile(null);
  }

  function requestClose(): void {
    if (editorDirty) {
      setCloseRequested(true);
      return;
    }
    onClose();
  }

  function finishEditorAction(): void {
    if (closeRequested) onClose();
  }

  function cancelNewProfile(): void {
    setNewProfile(null);
    finishEditorAction();
  }

  return (
    <ModalBackdrop
      className="modal-backdrop mapping-profiles-backdrop"
      onClose={requestClose}
    >
      <ModalDialog
        className="configuration-dialog mapping-profiles-dialog"
        labelledBy="mapping-profiles-dialog-heading"
        onClose={requestClose}
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
            onClick={requestClose}
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
              value={newProfile === null ? effectiveSelectedId : ""}
              disabled={
                editorDirty ||
                newProfile !== null ||
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
            disabled={editorDirty || newProfile !== null}
            onClick={startNewProfile}
          >
            New profile
          </button>
          <button
            className="secondary-button"
            type="button"
            disabled={
              editorDirty || newProfile !== null || selectedProfile === null
            }
            onClick={duplicateSelectedProfile}
          >
            Duplicate profile
          </button>
        </div>
        <p
          className={`muted-copy mapping-profile-switch-help${editorDirty ? "" : " mapping-profile-switch-help-hidden"}`}
          id="mapping-profile-switch-help"
          role={editorDirty ? "status" : undefined}
          aria-hidden={editorDirty ? undefined : true}
        >
          Save or discard changes before switching profiles.
        </p>

        {selectedProfile === null && newProfile === null ? (
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
            key={selectedProfile?.id ?? `new-${newProfile?.id}`}
            profile={selectedProfile}
            profileId={selectedProfile?.id ?? newProfile?.id ?? ""}
            initialDraft={newProfile?.draft ?? null}
            devices={devices}
            channels={channels}
            outputs={outputs}
            controlAreas={controlAreas}
            currentTypeKey={currentTypeKey}
            expectedRevision={expectedRevision}
            refresh={refresh}
            onCancelNew={cancelNewProfile}
            onSavedNew={finishNewProfile}
            onDeleted={finishDeletion}
            onDirtyChange={setEditorDirty}
            onSaved={finishEditorAction}
            onDiscarded={finishEditorAction}
            closeRequested={closeRequested}
            onKeepEditing={() => setCloseRequested(false)}
          />
        )}
      </ModalDialog>
    </ModalBackdrop>
  );
}

interface MappingProfileEditorProps {
  readonly profile: MappingProfile | null;
  readonly profileId: string;
  readonly initialDraft: MappingDraft | null;
  readonly devices: readonly Device[];
  readonly channels: readonly Channel[];
  readonly outputs: readonly Output[];
  readonly controlAreas: readonly ControlArea[];
  readonly currentTypeKey: string;
  readonly expectedRevision: number;
  readonly refresh: () => void;
  readonly onCancelNew: () => void;
  readonly onSavedNew: (profileId: string) => void;
  readonly onDeleted: (profileId: string) => void;
  readonly onDirtyChange: (dirty: boolean) => void;
  readonly onSaved: () => void;
  readonly onDiscarded: () => void;
  readonly closeRequested: boolean;
  readonly onKeepEditing: () => void;
}

function MappingProfileEditor({
  profile,
  profileId,
  initialDraft,
  devices,
  channels,
  outputs,
  controlAreas,
  currentTypeKey,
  expectedRevision,
  refresh,
  onCancelNew,
  onSavedNew,
  onDeleted,
  onDirtyChange,
  onSaved,
  onDiscarded,
  closeRequested,
  onKeepEditing,
}: MappingProfileEditorProps): React.JSX.Element {
  const original = useMemo<MappingDraft>(() => {
    if (initialDraft !== null) return initialDraft;
    if (profile === null) {
      throw new Error("A new mapping profile requires an initial draft");
    }
    return {
      name: profile.name,
      hardwareProfileId: profile.hardwareProfileId,
      outputGain: profile.outputGain,
      mappings: profile.mappings.map(toEditableMapping),
    };
  }, [initialDraft, profile]);
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
  const [pendingSavedDraft, setPendingSavedDraft] =
    useState<PendingSavedDraft | null>(null);
  const draftRevision = useDraftRevision(expectedRevision);
  const draft = editorState.draft;
  const draftSignature = mappingDraftSignature(draft);
  const savedBaseline =
    pendingSavedDraft !== null &&
    expectedRevision < pendingSavedDraft.revision
      ? pendingSavedDraft.signature
      : originalSignature;
  const dirty = draftSignature !== savedBaseline;
  const saveExpectedRevision =
    saveConflictRevision === null
      ? draftRevision.revision
      : Math.max(saveConflictRevision, expectedRevision);
  const deleteExpectedRevision =
    deleteConflictRevision === null
      ? expectedRevision
      : Math.max(deleteConflictRevision, expectedRevision);
  const validationErrors = validateDraft(draft);
  const assignedDevices = devices.filter(
    (device) => device.mappingProfileId === profileId,
  );
  const hardwareWarnings = hardwareProfileById(
    draft.hardwareProfileId,
  ).pinWarnings.filter((warning) =>
    draft.mappings.some(
      (mapping) => mapping.enabled && mapping.pin === warning.pin,
    ),
  );
  const targetOptions = useMemo(
    () => buildTargetOptions(channels, outputs, controlAreas, currentTypeKey),
    [channels, controlAreas, currentTypeKey, outputs],
  );
  const availableTarget = targetOptions.find(
    (option) =>
      !draft.mappings.some(
        (mapping) =>
          mapping.target.kind === option.kind &&
          mapping.target.id === option.id,
      ),
  );
  const availablePin = firstAvailablePin(
    draft.mappings,
    draft.hardwareProfileId,
  );
  const saveMutation = useMutation({
    retry: false,
    mutationFn: (draftToSave: MappingDraft) =>
      replaceMappingProfile(profileId, {
        expectedRevision: saveExpectedRevision,
        name: draftToSave.name,
        hardwareProfileId: draftToSave.hardwareProfileId,
        outputGain: draftToSave.outputGain,
        mappings: draftToSave.mappings.map(toPinMapping),
      }),
    onSuccess: (result, savedDraft) => {
      setPendingSavedDraft({
        revision: result.revision,
        signature: mappingDraftSignature(savedDraft),
      });
      setSaveConflictRevision(null);
      draftRevision.reset();
      refresh();
      if (profile === null) onSavedNew(profileId);
      onSaved();
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
    onDiscarded();
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
          Hardware
          <select
            value={draft.hardwareProfileId}
            onChange={(event) =>
              applyDraft({
                ...draft,
                hardwareProfileId: event.currentTarget
                  .value as HardwareProfileId,
              })
            }
          >
            {HARDWARE_PROFILES.map((hardwareProfile) => (
              <option key={hardwareProfile.id} value={hardwareProfile.id}>
                {hardwareProfile.label}
              </option>
            ))}
          </select>
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
      {assignedDevices.length === 0 || hardwareWarnings.length === 0 ? null : (
        <ul
          className="validation-list hardware-warning-list"
          aria-label="Profile hardware warnings"
        >
          {hardwareWarnings.map((warning) => (
            <li key={warning.pin}>
              {warning.message} Assigned ESP32 devices:{" "}
              {assignedDevices.map((device) => device.desired.name).join(", ")}.
            </li>
          ))}
        </ul>
      )}
      {saveMutation.error === null ? null : (
        <p className="field-error" role="alert">
          {configurationErrorMessage(saveMutation.error)}
        </p>
      )}
      <div className="button-row editor-actions">
        <button
          className="primary-button"
          type="button"
          disabled={
            validationErrors.length > 0 ||
            (!dirty && profile !== null) ||
            saveMutation.isPending
          }
          onClick={() => saveMutation.mutate(draft)}
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
            className="danger-button compact-button"
            type="button"
            disabled={deleteMutation.isPending}
            onClick={() => setConfirmingDelete(true)}
          >
            Delete profile
          </button>
        )}
      </div>

      {confirmingDelete ? (
        <ModalBackdrop
          className="nested-confirmation-backdrop"
          onClose={() => setConfirmingDelete(false)}
        >
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
        </ModalBackdrop>
      ) : null}
      <UnsavedChangesDialog
        open={closeRequested && dirty}
        saving={saveMutation.isPending}
        saveDisabled={validationErrors.length > 0}
        onSave={() => saveMutation.mutate(draft)}
        onDiscard={resetDraft}
        onKeepEditing={onKeepEditing}
      />
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
          option.searchText.includes(normalizedSearch),
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
  currentTypeKey: string,
): readonly TargetOption[] {
  const areaLabels = new Map(
    controlAreas.map((area) => [area.typeKey, area.label]),
  );
  return [
    ...channels.map((channel) => ({
      kind: "channel" as const,
      id: channel.id,
      label: `${areaLabels.get(channel.typeKey) ?? channel.typeKey} · ${channel.name}`,
      searchText:
        `${areaLabels.get(channel.typeKey) ?? channel.typeKey} ${channel.name} ${channel.typeKey}`.toLocaleLowerCase(),
      currentArea: channel.typeKey === currentTypeKey,
    })),
    ...outputs.map((output) => ({
      kind: "output" as const,
      id: output.id,
      label: `${areaLabels.get(output.typeKey) ?? output.typeKey} · ${output.name}`,
      searchText:
        `${areaLabels.get(output.typeKey) ?? output.typeKey} ${output.name} ${output.typeKey}`.toLocaleLowerCase(),
      currentArea: output.typeKey === currentTypeKey,
    })),
  ].sort(
    (left, right) =>
      Number(right.currentArea) - Number(left.currentArea) ||
      left.label.localeCompare(right.label),
  );
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
  if (name.length === 0 || name.length > 256 || name.trim() !== name) {
    errors.push(
      "Profile name is required and cannot have leading or trailing spaces.",
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
    } else if (
      mapping.enabled &&
      !isAllowedPwmPin(draft.hardwareProfileId, mapping.pin)
    ) {
      errors.push(
        `GPIO${mapping.pin} is not an allowed PWM output on ${hardwareProfileById(draft.hardwareProfileId).label}.`,
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
  hardwareProfileId: HardwareProfileId,
): number | null {
  const usedPins = new Set(mappings.map((mapping) => mapping.pin));
  for (const pin of hardwareProfileById(hardwareProfileId).pwmPins) {
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

function duplicateProfileName(
  sourceName: string,
  existingNames: ReadonlySet<string>,
): string {
  for (let copyNumber = 1; ; copyNumber += 1) {
    const suffix = copyNumber === 1 ? " copy" : ` copy ${copyNumber}`;
    const name = `${sourceName.slice(0, 256 - suffix.length)}${suffix}`;
    if (!existingNames.has(name)) return name;
  }
}
