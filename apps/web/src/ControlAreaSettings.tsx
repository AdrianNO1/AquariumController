import type {
  Channel,
  Device,
  MappingProfile,
  Output,
  PatchDeviceConfigurationRequest,
  PinMapping,
  Throttle,
} from "@aquarium/contracts";
import { useMutation } from "@tanstack/react-query";
import { useMemo, useState } from "react";

import {
  patchDeviceConfiguration,
  replaceMappingProfile,
  setDeviceEnabled,
  updateThrottle,
} from "./api.js";
import {
  configurationErrorMessage,
  currentRevisionFromError,
} from "./configuration-ui.js";
import { useDraftRevision } from "./use-draft-revision.js";

interface AuthoritativePanelProps {
  readonly expectedRevision: number;
  readonly refresh: () => void;
}

interface ThrottlePanelProps extends AuthoritativePanelProps {
  readonly typeKey: string;
  readonly throttle: Throttle | null;
}

export function ThrottlePanel({
  typeKey,
  throttle,
  expectedRevision,
  refresh,
}: ThrottlePanelProps): React.JSX.Element {
  const initialPercentage = String(throttle?.percentage ?? 100);
  const [percentageState, setPercentageState] = useState(() => ({
    authoritativePercentage: initialPercentage,
    draftPercentage: initialPercentage,
    touched: false,
  }));
  const percentage = percentageState.draftPercentage;
  const draftRevision = useDraftRevision(expectedRevision);
  const resetDraftRevision = draftRevision.reset;
  const authoritativePercentage = String(throttle?.percentage ?? 100);
  const mutation = useMutation({
    mutationFn: () =>
      updateThrottle(typeKey, {
        expectedRevision: draftRevision.revision,
        percentage: Number(percentage),
      }),
    onSuccess: () => {
      resetDraftRevision();
      refresh();
    },
    onError: refreshOnConflict(refresh),
  });

  function updatePercentage(value: string): void {
    if (value === authoritativePercentage) {
      draftRevision.reset();
    } else {
      draftRevision.pin();
    }
    setPercentageState({
      authoritativePercentage,
      draftPercentage: value,
      touched: value !== authoritativePercentage,
    });
  }

  if (percentageState.authoritativePercentage !== authoritativePercentage) {
    const draftResolved =
      percentageState.draftPercentage === authoritativePercentage;
    const preserveDraft = percentageState.touched && !draftResolved;
    setPercentageState({
      authoritativePercentage,
      draftPercentage: preserveDraft
        ? percentageState.draftPercentage
        : authoritativePercentage,
      touched: preserveDraft,
    });
    if (draftResolved) resetDraftRevision();
  }

  if (throttle === null) {
    return (
      <section className="control-panel" aria-labelledby="throttle-heading">
        <h2 id="throttle-heading">Throttle</h2>
        <p className="empty-panel">
          This control area has no throttle record, so output scaling cannot be
          changed.
        </p>
      </section>
    );
  }

  const parsedPercentage = Number(percentage);
  const valid =
    Number.isFinite(parsedPercentage) &&
    parsedPercentage >= 0 &&
    parsedPercentage <= 100;
  const changed = valid && parsedPercentage !== throttle.percentage;

  return (
    <section className="control-panel" aria-labelledby="throttle-heading">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Area-wide scaling</p>
          <h2 id="throttle-heading">Throttle</h2>
        </div>
        <output htmlFor="area-throttle">{percentage}%</output>
      </div>
      <div className="throttle-control">
        <label htmlFor="area-throttle">Output throttle percentage</label>
        <input
          id="area-throttle"
          type="range"
          min="0"
          max="100"
          step="1"
          value={percentage}
          onChange={(event) => updatePercentage(event.currentTarget.value)}
        />
        <input
          aria-label="Throttle percentage"
          type="number"
          min="0"
          max="100"
          step="1"
          value={percentage}
          onChange={(event) => updatePercentage(event.currentTarget.value)}
        />
      </div>
      {!valid ? (
        <p className="field-error" role="alert">
          Throttle must be between 0 and 100 percent.
        </p>
      ) : null}
      {mutation.error === null ? null : (
        <p className="field-error" role="alert">
          {configurationErrorMessage(mutation.error)}
        </p>
      )}
      {mutation.isSuccess ? (
        <p className="success-message" role="status">
          Throttle update accepted. Refreshing authoritative state.
        </p>
      ) : null}
      <button
        className="primary-button"
        type="button"
        disabled={!changed || mutation.isPending}
        onClick={() => mutation.mutate()}
      >
        {mutation.isPending ? "Saving throttle…" : "Save throttle"}
      </button>
    </section>
  );
}

interface MappingProfilesPanelProps extends AuthoritativePanelProps {
  readonly profiles: readonly MappingProfile[];
  readonly relevantProfileIds: ReadonlySet<string>;
  readonly channels: readonly Channel[];
  readonly outputs: readonly Output[];
}

export function MappingProfilesPanel({
  profiles,
  relevantProfileIds,
  channels,
  outputs,
  expectedRevision,
  refresh,
}: MappingProfilesPanelProps): React.JSX.Element {
  const suggestedProfile =
    profiles.find((profile) => relevantProfileIds.has(profile.id)) ??
    profiles[0] ??
    null;
  const [selectedId, setSelectedId] = useState(suggestedProfile?.id ?? "");
  const [newProfileId, setNewProfileId] = useState("");
  const [draftProfileId, setDraftProfileId] = useState<string | null>(null);
  const [newProfileError, setNewProfileError] = useState<string | null>(null);
  const newProfileRevision = useDraftRevision(expectedRevision);
  const effectiveSelectedId = profiles.some(
    (profile) => profile.id === selectedId,
  )
    ? selectedId
    : (suggestedProfile?.id ?? "");
  const selectedProfile =
    draftProfileId === null
      ? (profiles.find((profile) => profile.id === effectiveSelectedId) ?? null)
      : null;

  function startProfileDraft(event: React.FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (newProfileId.length === 0) return;
    if (profiles.some((profile) => profile.id === newProfileId)) {
      setNewProfileError(
        `Mapping profile ${newProfileId} already exists. Select it from the profile list instead.`,
      );
      return;
    }
    newProfileRevision.pin();
    setNewProfileError(null);
    setDraftProfileId(newProfileId);
  }

  return (
    <section className="control-panel" aria-labelledby="mapping-heading">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Pins and targets</p>
          <h2 id="mapping-heading">Mapping profiles</h2>
        </div>
        <span className="section-count">
          {relevantProfileIds.size} used by this area
        </span>
      </div>
      <div className="mapping-selector">
        <label>
          Profile to edit
          <select
            value={draftProfileId === null ? effectiveSelectedId : ""}
            disabled={draftProfileId !== null || profiles.length === 0}
            onChange={(event) => setSelectedId(event.currentTarget.value)}
          >
            {profiles.map((profile) => (
              <option key={profile.id} value={profile.id}>
                {profile.name} ({profile.id})
                {relevantProfileIds.has(profile.id) ? " · used here" : ""}
              </option>
            ))}
          </select>
        </label>
        <form className="new-profile-form" onSubmit={startProfileDraft}>
          <label>
            New profile ID
            <input
              value={newProfileId}
              onChange={(event) => {
                setNewProfileError(null);
                setNewProfileId(event.currentTarget.value);
              }}
              placeholder="profile-frag"
              required
            />
          </label>
          <button className="secondary-button" type="submit">
            Create profile draft
          </button>
        </form>
        {newProfileError === null ? null : (
          <p className="field-error" role="alert">
            {newProfileError}
          </p>
        )}
      </div>
      {selectedProfile === null && draftProfileId === null ? (
        <p className="empty-panel">
          No mapping profiles exist. Create a profile draft to configure pins.
        </p>
      ) : (
        <MappingProfileForm
          key={selectedProfile?.id ?? `new-${draftProfileId}`}
          profile={selectedProfile}
          profileId={selectedProfile?.id ?? draftProfileId ?? ""}
          expectedRevision={
            draftProfileId === null
              ? expectedRevision
              : newProfileRevision.revision
          }
          channels={channels}
          outputs={outputs}
          refresh={refresh}
          onCancelNew={() => {
            newProfileRevision.reset();
            setDraftProfileId(null);
          }}
          onSavedNew={(profileId) => {
            newProfileRevision.reset();
            setSelectedId(profileId);
            setDraftProfileId(null);
            setNewProfileId("");
          }}
        />
      )}
    </section>
  );
}

interface MappingDraft {
  readonly name: string;
  readonly deviceNamePrefix: string;
  readonly outputGain: number;
  readonly mappings: readonly PinMapping[];
}

interface MappingEditorState {
  readonly authoritativeSignature: string;
  readonly draft: MappingDraft;
  readonly touched: boolean;
}

interface MappingProfileFormProps extends AuthoritativePanelProps {
  readonly profile: MappingProfile | null;
  readonly profileId: string;
  readonly channels: readonly Channel[];
  readonly outputs: readonly Output[];
  readonly onCancelNew: () => void;
  readonly onSavedNew: (profileId: string) => void;
}

function MappingProfileForm({
  profile,
  profileId,
  channels,
  outputs,
  expectedRevision,
  refresh,
  onCancelNew,
  onSavedNew,
}: MappingProfileFormProps): React.JSX.Element {
  const original = useMemo<MappingDraft>(
    () => ({
      name: profile?.name ?? profileId,
      deviceNamePrefix: profile?.deviceNamePrefix ?? profileId,
      outputGain: profile?.outputGain ?? 1,
      mappings: profile?.mappings ?? [],
    }),
    [profile, profileId],
  );
  const originalSignature = JSON.stringify(original);
  const [editorState, setEditorState] = useState<MappingEditorState>(() => ({
    authoritativeSignature: originalSignature,
    draft: original,
    touched: false,
  }));
  const draft = editorState.draft;
  const draftRevision = useDraftRevision(expectedRevision);
  const resetDraftRevision = draftRevision.reset;
  const [newMappingId, setNewMappingId] = useState("");
  const [newPin, setNewPin] = useState("0");
  const [newTargetKind, setNewTargetKind] = useState<"channel" | "output">(
    "channel",
  );
  const targetOptions = newTargetKind === "channel" ? channels : outputs;
  const [newTargetId, setNewTargetId] = useState(targetOptions[0]?.id ?? "");
  const dirty = JSON.stringify(draft) !== originalSignature;
  const mutation = useMutation({
    mutationFn: () =>
      replaceMappingProfile(profileId, {
        expectedRevision: draftRevision.revision,
        name: draft.name,
        deviceNamePrefix: draft.deviceNamePrefix,
        outputGain: draft.outputGain,
        mappings: [...draft.mappings],
      }),
    onSuccess: () => {
      resetDraftRevision();
      refresh();
      if (profile === null) onSavedNew(profileId);
    },
    onError: refreshOnConflict(refresh),
  });

  if (editorState.authoritativeSignature !== originalSignature) {
    const draftResolved =
      JSON.stringify(editorState.draft) === originalSignature;
    const preserveDraft = editorState.touched && !draftResolved;
    setEditorState({
      authoritativeSignature: originalSignature,
      draft: preserveDraft ? editorState.draft : original,
      touched: preserveDraft,
    });
    if (!preserveDraft) resetDraftRevision();
  }

  function applyDraft(nextDraft: MappingDraft): void {
    const touched = JSON.stringify(nextDraft) !== originalSignature;
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

  function addMapping(event: React.FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    if (newMappingId.length === 0 || newTargetId.length === 0) return;
    applyDraft({
      ...draft,
      mappings: [
        ...draft.mappings,
        {
          id: newMappingId,
          pin: Number(newPin),
          displayOrder: draft.mappings.length,
          enabled: true,
          target: { kind: newTargetKind, id: newTargetId },
        },
      ],
    });
    setNewMappingId("");
  }

  return (
    <div className="profile-editor">
      <div className="profile-fields form-grid-three">
        <label>
          Profile name
          <input
            value={draft.name}
            onChange={(event) => {
              const name = event.currentTarget.value;
              applyDraft({
                ...draft,
                name,
              });
            }}
          />
        </label>
        <label>
          Device name prefix
          <input
            value={draft.deviceNamePrefix}
            onChange={(event) => {
              const deviceNamePrefix = event.currentTarget.value;
              applyDraft({
                ...draft,
                deviceNamePrefix,
              });
            }}
          />
        </label>
        <label>
          Output gain
          <input
            type="number"
            min="0"
            max="1"
            step="0.01"
            value={draft.outputGain}
            onChange={(event) => {
              const outputGain = event.currentTarget.valueAsNumber;
              applyDraft({
                ...draft,
                outputGain,
              });
            }}
          />
        </label>
      </div>

      <div className="mapping-list">
        {draft.mappings.length === 0 ? (
          <p className="muted-copy">No pins are mapped in this profile.</p>
        ) : (
          draft.mappings.map((mapping) => (
            <MappingRow
              key={mapping.id}
              mapping={mapping}
              channels={channels}
              outputs={outputs}
              onChange={(changed) => {
                applyDraft({
                  ...draft,
                  mappings: draft.mappings.map((candidate) =>
                    candidate.id === mapping.id ? changed : candidate,
                  ),
                });
              }}
              onRemove={() => {
                applyDraft({
                  ...draft,
                  mappings: draft.mappings.filter(
                    (candidate) => candidate.id !== mapping.id,
                  ),
                });
              }}
            />
          ))
        )}
      </div>

      <form className="inline-editor mapping-add-form" onSubmit={addMapping}>
        <label>
          Mapping ID
          <input
            value={newMappingId}
            onChange={(event) => setNewMappingId(event.currentTarget.value)}
            placeholder="map-frag-light"
            required
          />
        </label>
        <label>
          Pin
          <input
            type="number"
            min="0"
            max="63"
            value={newPin}
            onChange={(event) => setNewPin(event.currentTarget.value)}
            required
          />
        </label>
        <label>
          Target type
          <select
            value={newTargetKind}
            onChange={(event) => {
              const kind = event.currentTarget.value as "channel" | "output";
              const choices = kind === "channel" ? channels : outputs;
              setNewTargetKind(kind);
              setNewTargetId(choices[0]?.id ?? "");
            }}
          >
            <option value="channel">Channel</option>
            <option value="output">Output</option>
          </select>
        </label>
        <label>
          Target
          <select
            value={newTargetId}
            onChange={(event) => setNewTargetId(event.currentTarget.value)}
            required
          >
            {targetOptions.map((target) => (
              <option key={target.id} value={target.id}>
                {target.name} ({target.id})
              </option>
            ))}
          </select>
        </label>
        <button
          className="secondary-button"
          type="submit"
          disabled={targetOptions.length === 0}
        >
          Add mapping
        </button>
      </form>

      {mutation.error === null ? null : (
        <p className="field-error" role="alert">
          {configurationErrorMessage(mutation.error)}
        </p>
      )}
      {mutation.isSuccess ? (
        <p className="success-message" role="status">
          Mapping profile save accepted. Refreshing authoritative state.
        </p>
      ) : null}
      <div className="button-row editor-actions">
        <button
          className="primary-button"
          type="button"
          disabled={(!dirty && profile !== null) || mutation.isPending}
          onClick={() => mutation.mutate()}
        >
          {mutation.isPending ? "Saving profile…" : "Save mapping profile"}
        </button>
        <button
          className="secondary-button"
          type="button"
          disabled={!dirty || mutation.isPending}
          onClick={() => {
            draftRevision.reset();
            setEditorState({
              authoritativeSignature: originalSignature,
              draft: original,
              touched: false,
            });
          }}
        >
          Discard profile edits
        </button>
        {profile === null ? (
          <button className="text-button" type="button" onClick={onCancelNew}>
            Cancel new profile
          </button>
        ) : null}
      </div>
    </div>
  );
}

interface MappingRowProps {
  readonly mapping: PinMapping;
  readonly channels: readonly Channel[];
  readonly outputs: readonly Output[];
  readonly onChange: (mapping: PinMapping) => void;
  readonly onRemove: () => void;
}

function MappingRow({
  mapping,
  channels,
  outputs,
  onChange,
  onRemove,
}: MappingRowProps): React.JSX.Element {
  const options = mapping.target.kind === "channel" ? channels : outputs;
  return (
    <div className="mapping-row">
      <code>{mapping.id}</code>
      <label>
        <span className="visually-hidden">Pin for {mapping.id}</span>
        <input
          aria-label={`Pin for ${mapping.id}`}
          type="number"
          min="0"
          max="63"
          value={mapping.pin}
          onChange={(event) =>
            onChange({ ...mapping, pin: event.currentTarget.valueAsNumber })
          }
        />
      </label>
      <label>
        <span className="visually-hidden">Order for {mapping.id}</span>
        <input
          aria-label={`Order for ${mapping.id}`}
          type="number"
          min="0"
          value={mapping.displayOrder}
          onChange={(event) =>
            onChange({
              ...mapping,
              displayOrder: event.currentTarget.valueAsNumber,
            })
          }
        />
      </label>
      <select
        aria-label={`Target type for ${mapping.id}`}
        value={mapping.target.kind}
        onChange={(event) => {
          const kind = event.currentTarget.value as "channel" | "output";
          const candidates = kind === "channel" ? channels : outputs;
          const first = candidates[0];
          if (first !== undefined) {
            onChange({ ...mapping, target: { kind, id: first.id } });
          }
        }}
      >
        <option value="channel">Channel</option>
        <option value="output">Output</option>
      </select>
      <select
        aria-label={`Target for ${mapping.id}`}
        value={mapping.target.id}
        onChange={(event) =>
          onChange({
            ...mapping,
            target: { ...mapping.target, id: event.currentTarget.value },
          })
        }
      >
        {options.map((target) => (
          <option key={target.id} value={target.id}>
            {target.name} ({target.id})
          </option>
        ))}
      </select>
      <label className="checkbox-label">
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
        onClick={onRemove}
      >
        Remove {mapping.id}
      </button>
    </div>
  );
}

interface DevicesPanelProps extends AuthoritativePanelProps {
  readonly devices: readonly Device[];
}

interface EditingDevice {
  readonly device: Device;
  readonly expectedRevision: number;
}

export function DevicesPanel({
  devices,
  expectedRevision,
  refresh,
}: DevicesPanelProps): React.JSX.Element {
  const [editingDevice, setEditingDevice] = useState<EditingDevice | null>(
    null,
  );
  const enabledMutation = useMutation({
    mutationFn: ({
      deviceId,
      enabled,
    }: {
      readonly deviceId: string;
      readonly enabled: boolean;
    }) => setDeviceEnabled(deviceId, { expectedRevision, enabled }),
    onSuccess: refresh,
    onError: refreshOnConflict(refresh),
  });
  return (
    <section className="control-panel" aria-labelledby="devices-heading">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Desired versus observed</p>
          <h2 id="devices-heading">Devices</h2>
        </div>
        <span className="section-count">{devices.length} mapped</span>
      </div>
      {devices.length === 0 ? (
        <p className="empty-panel">
          No enabled devices are assigned to a profile used by this area.
        </p>
      ) : (
        <div className="device-grid">
          {devices.map((device) => (
            <article className="device-card" key={device.id}>
              <div className="device-card-heading">
                <div>
                  <h3>{device.desired.name}</h3>
                  <code>{device.hardwareId}</code>
                </div>
                <div className="device-status-actions">
                  <span className={`status-pill status-${device.status}`}>
                    {device.status}
                  </span>
                  {device.enabled ? null : (
                    <span className="status-pill status-excluded">
                      Excluded
                    </span>
                  )}
                  {device.enabled ? (
                    <button
                      aria-label={`Exclude ${device.desired.name}`}
                      className="device-exclude-button"
                      title="Exclude this device from controller commands"
                      type="button"
                      disabled={enabledMutation.isPending}
                      onClick={() =>
                        enabledMutation.mutate({
                          deviceId: device.id,
                          enabled: false,
                        })
                      }
                    >
                      ×
                    </button>
                  ) : (
                    <button
                      className="text-button"
                      type="button"
                      disabled={enabledMutation.isPending}
                      onClick={() =>
                        enabledMutation.mutate({
                          deviceId: device.id,
                          enabled: true,
                        })
                      }
                    >
                      Include
                    </button>
                  )}
                </div>
              </div>
              <dl className="comparison-list">
                <DeviceComparison
                  label="Name"
                  desired={device.desired.name}
                  reported={device.reported.name}
                />
                <DeviceComparison
                  label="PWM frequency"
                  desired={`${device.desired.pwmFrequencyHz} Hz`}
                  reported={
                    device.reported.pwmFrequencyHz === null
                      ? null
                      : `${device.reported.pwmFrequencyHz} Hz`
                  }
                />
                <DeviceComparison
                  label="PWM resolution"
                  desired={`${device.desired.pwmResolutionBits} bit`}
                  reported={
                    device.reported.pwmResolutionBits === null
                      ? null
                      : `${device.reported.pwmResolutionBits} bit`
                  }
                />
                <DeviceComparison
                  label="Firmware"
                  desired={null}
                  reported={device.reported.firmwareVersion}
                />
                <DeviceComparison
                  label="Schedule hash"
                  desired={null}
                  reported={device.reported.scheduleHash}
                />
              </dl>
              <p className="device-last-seen">
                Last seen: {formatTimestamp(device.lastSeenAt)}
              </p>
              {device.lastError === null ? null : (
                <p className="device-error" role="alert">
                  {device.lastError.code}: {device.lastError.message}
                </p>
              )}
              <button
                className="secondary-button"
                type="button"
                disabled={
                  !device.enabled ||
                  !["online", "stale", "offline"].includes(device.status)
                }
                title={
                  !device.enabled
                    ? "Include this device before sending configuration"
                    : ["online", "stale", "offline"].includes(device.status)
                      ? undefined
                      : "Wait for a healthy announcement before sending configuration"
                }
                onClick={() => setEditingDevice({ device, expectedRevision })}
              >
                Edit {device.desired.name} configuration
              </button>
            </article>
          ))}
        </div>
      )}
      {enabledMutation.error === null ? null : (
        <p className="field-error" role="alert">
          {configurationErrorMessage(enabledMutation.error)}
        </p>
      )}
      {editingDevice === null ? null : (
        <DeviceConfigurationDialog
          device={editingDevice.device}
          expectedRevision={editingDevice.expectedRevision}
          refresh={refresh}
          onClose={() => setEditingDevice(null)}
        />
      )}
    </section>
  );
}

function DeviceComparison({
  label,
  desired,
  reported,
}: {
  readonly label: string;
  readonly desired: string | null;
  readonly reported: string | null;
}): React.JSX.Element {
  const matches = reported !== null && desired === reported;
  return (
    <div>
      <dt>{label}</dt>
      <dd>
        {desired === null ? null : <span>Desired: {desired}</span>}
        <span
          className={
            desired === null
              ? "reported-observation"
              : matches
                ? "reported-match"
                : "reported-mismatch"
          }
        >
          Reported: {reported ?? "Not announced"}
        </span>
      </dd>
    </div>
  );
}

interface DeviceConfigurationDialogProps extends AuthoritativePanelProps {
  readonly device: Device;
  readonly onClose: () => void;
}

function DeviceConfigurationDialog({
  device,
  expectedRevision,
  refresh,
  onClose,
}: DeviceConfigurationDialogProps): React.JSX.Element {
  const [name, setName] = useState(device.desired.name);
  const [frequency, setFrequency] = useState(
    String(device.desired.pwmFrequencyHz),
  );
  const [resolution, setResolution] = useState(
    String(device.desired.pwmResolutionBits),
  );
  const parsedFrequency = Number(frequency);
  const parsedResolution = Number(resolution);
  const fieldsChanged =
    name !== device.desired.name ||
    parsedFrequency !== device.desired.pwmFrequencyHz ||
    parsedResolution !== device.desired.pwmResolutionBits;
  const reapplyingConfiguration =
    !fieldsChanged && device.lastError?.code === "configuration_mismatch";
  const patch = useMemo<PatchDeviceConfigurationRequest>(() => {
    if (reapplyingConfiguration) {
      return {
        expectedRevision,
        name: device.desired.name,
        pwmFrequencyHz: device.desired.pwmFrequencyHz,
        pwmResolutionBits: device.desired.pwmResolutionBits,
      };
    }
    return {
      expectedRevision,
      ...(name === device.desired.name ? {} : { name }),
      ...(parsedFrequency === device.desired.pwmFrequencyHz
        ? {}
        : { pwmFrequencyHz: parsedFrequency }),
      ...(parsedResolution === device.desired.pwmResolutionBits
        ? {}
        : { pwmResolutionBits: parsedResolution }),
    };
  }, [
    device,
    expectedRevision,
    name,
    parsedFrequency,
    parsedResolution,
    reapplyingConfiguration,
  ]);
  const canSubmit = fieldsChanged || reapplyingConfiguration;
  const mutation = useMutation({
    mutationFn: () => patchDeviceConfiguration(device.id, patch),
    onSuccess: () => {
      refresh();
      onClose();
    },
    onError: refreshOnConflict(refresh),
  });

  return (
    <div className="modal-backdrop">
      <section
        className="configuration-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={`device-dialog-${device.id}`}
      >
        <div className="section-heading compact-heading">
          <h2 id={`device-dialog-${device.id}`}>
            Configure {device.desired.name}
          </h2>
          <button className="text-button" type="button" onClick={onClose}>
            Close
          </button>
        </div>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            mutation.mutate();
          }}
        >
          <label>
            Device name
            <input
              value={name}
              onChange={(event) => setName(event.currentTarget.value)}
              required
            />
          </label>
          <label>
            PWM frequency (Hz)
            <input
              type="number"
              min="1"
              max="40000"
              value={frequency}
              onChange={(event) => setFrequency(event.currentTarget.value)}
              required
            />
          </label>
          <label>
            PWM resolution (bits)
            <input
              type="number"
              min="1"
              max="16"
              value={resolution}
              onChange={(event) => setResolution(event.currentTarget.value)}
              required
            />
          </label>
          {mutation.error === null ? null : (
            <p className="field-error" role="alert">
              {configurationErrorMessage(mutation.error)}
            </p>
          )}
          <div className="button-row">
            <button
              className="primary-button"
              type="submit"
              disabled={!canSubmit || mutation.isPending}
            >
              {mutation.isPending
                ? "Sending configuration…"
                : reapplyingConfiguration
                  ? "Reapply desired configuration"
                  : "Save configuration"}
            </button>
            <button
              className="secondary-button"
              type="button"
              onClick={onClose}
            >
              Cancel
            </button>
          </div>
        </form>
        <p className="muted-copy">
          Success means the controller recorded the operation. Reported values
          change only after the device confirms them.
        </p>
      </section>
    </div>
  );
}

function refreshOnConflict(refresh: () => void): (error: Error) => void {
  return (error) => {
    if (currentRevisionFromError(error) !== null) refresh();
  };
}

function formatTimestamp(value: string | null): string {
  if (value === null) return "Never";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "medium",
    timeZone: "UTC",
  }).format(new Date(value));
}
