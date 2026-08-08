import type { ControlArea } from "@aquarium/contracts";
import { useMutation } from "@tanstack/react-query";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Link, useBeforeUnload, useBlocker } from "react-router";

import { replaceControlAreaScheduleConfiguration } from "./api.js";
import { ChannelManagementDialog } from "./ChannelManagementDialog.js";
import {
  CombinedScheduleEditor,
  type CombinedScheduleDraftPoints,
  type CombinedScheduleEditorHandle,
} from "./CombinedScheduleEditor.js";
import {
  configurationErrorMessage,
  currentRevisionFromError,
} from "./configuration-ui.js";
import { projectControlArea } from "./control-area-model.js";
import { DevicesPanel } from "./DevicesPanel.js";
import { ManualOverridePanel } from "./ManualOverridePanel.js";
import { MappingProfilesDialog } from "./MappingProfilesDialog.js";
import { ScheduleMultiplier } from "./ScheduleMultiplier.js";
import { UnsavedChangesDialog } from "./UnsavedChangesDialog.js";
import { useControllerState } from "./use-controller-state.js";
import { useDraftRevision } from "./use-draft-revision.js";

interface ControlAreaPageProps {
  readonly slug: ControlArea["slug"];
}

interface MultiplierDraft {
  readonly sourceValue: number;
  readonly value: number;
  readonly acceptedValue: number | null;
}

interface ConfigurationSaveResult {
  readonly revision: number;
  readonly savedMultiplierValue: number | null;
}

interface ConfigurationHistorySnapshot {
  readonly pointsByChannel: CombinedScheduleDraftPoints;
  readonly multiplier: number;
}

interface ConfigurationHistory {
  readonly past: readonly ConfigurationHistorySnapshot[];
  readonly future: readonly ConfigurationHistorySnapshot[];
}

const EMPTY_CONFIGURATION_HISTORY: ConfigurationHistory = {
  past: [],
  future: [],
};
const CONFIGURATION_HISTORY_LIMIT = 100;

export function ControlAreaPage({
  slug,
}: ControlAreaPageProps): React.JSX.Element {
  const controller = useControllerState();
  const [channelsOpen, setChannelsOpen] = useState(false);
  const [mappingsOpen, setMappingsOpen] = useState(false);
  const [scheduleDirty, setScheduleDirty] = useState(false);
  const [scheduleSaving, setScheduleSaving] = useState(false);
  const [multiplierConflictRevision, setMultiplierConflictRevision] = useState<
    number | null
  >(null);
  const editorRef = useRef<CombinedScheduleEditorHandle>(null);

  if (controller.snapshot === null) {
    return (
      <main className="page control-page">
        <p className="eyebrow">Control area</p>
        <h1>Loading controller state</h1>
        {controller.error === null ? (
          <p className="loading-panel" role="status">
            Loading the authoritative snapshot and live revision stream…
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

  const model = projectControlArea(controller.snapshot, slug);
  if (model === null) {
    throw new Error(`Snapshot is missing control area ${slug}`);
  }

  return (
    <LoadedControlArea
      key={model.area.slug}
      model={model}
      allChannels={controller.snapshot.channels}
      allOutputs={controller.snapshot.outputs}
      allAreas={controller.snapshot.controlAreas}
      liveStateUnavailable={controller.status !== "connected"}
      showConnectionWarning={controller.status !== "connected"}
      connectionStatus={controller.status}
      channelsOpen={channelsOpen}
      mappingsOpen={mappingsOpen}
      scheduleDirty={scheduleDirty}
      scheduleSaving={scheduleSaving}
      multiplierConflictRevision={multiplierConflictRevision}
      editorRef={editorRef}
      setChannelsOpen={setChannelsOpen}
      setMappingsOpen={setMappingsOpen}
      setScheduleDirty={setScheduleDirty}
      setScheduleSaving={setScheduleSaving}
      setMultiplierConflictRevision={setMultiplierConflictRevision}
      refresh={controller.refresh}
      retry={controller.retry}
    />
  );
}

type LoadedControlAreaProps = {
  readonly model: NonNullable<ReturnType<typeof projectControlArea>>;
  readonly allChannels: Parameters<typeof MappingProfilesDialog>[0]["channels"];
  readonly allOutputs: Parameters<typeof MappingProfilesDialog>[0]["outputs"];
  readonly allAreas: Parameters<
    typeof MappingProfilesDialog
  >[0]["controlAreas"];
  readonly liveStateUnavailable: boolean;
  readonly showConnectionWarning: boolean;
  readonly connectionStatus: string;
  readonly channelsOpen: boolean;
  readonly mappingsOpen: boolean;
  readonly scheduleDirty: boolean;
  readonly scheduleSaving: boolean;
  readonly multiplierConflictRevision: number | null;
  readonly editorRef: React.RefObject<CombinedScheduleEditorHandle | null>;
  readonly setChannelsOpen: (open: boolean) => void;
  readonly setMappingsOpen: (open: boolean) => void;
  readonly setScheduleDirty: (dirty: boolean) => void;
  readonly setScheduleSaving: (saving: boolean) => void;
  readonly setMultiplierConflictRevision: (revision: number | null) => void;
  readonly refresh: () => void;
  readonly retry: () => void;
};

function LoadedControlArea({
  model,
  allChannels,
  allOutputs,
  allAreas,
  liveStateUnavailable,
  showConnectionWarning,
  connectionStatus,
  channelsOpen,
  mappingsOpen,
  scheduleDirty,
  scheduleSaving,
  multiplierConflictRevision,
  editorRef,
  setChannelsOpen,
  setMappingsOpen,
  setScheduleDirty,
  setScheduleSaving,
  setMultiplierConflictRevision,
  refresh,
  retry,
}: LoadedControlAreaProps): React.JSX.Element {
  const authoritativeMultiplier = model.throttle?.percentage ?? 100;
  const [multiplierState, setMultiplierState] = useState<MultiplierDraft>(
    () => ({
      sourceValue: authoritativeMultiplier,
      value: authoritativeMultiplier,
      acceptedValue: null,
    }),
  );
  const [draftPointsByChannel, setDraftPointsByChannel] =
    useState<CombinedScheduleDraftPoints>({});
  const [configurationHistory, setConfigurationHistory] =
    useState<ConfigurationHistory>(EMPTY_CONFIGURATION_HISTORY);
  const draftPointsRef = useRef<CombinedScheduleDraftPoints>({});
  const multiplierValueRef = useRef(authoritativeMultiplier);
  const [overrideBusy, setOverrideBusy] = useState(false);
  const [pendingOverrideRevision, setPendingOverrideRevision] = useState<
    number | null
  >(null);
  const previousConfigurationSnapshotRef = useRef({
    revision: model.revision,
    multiplier: authoritativeMultiplier,
  });
  const multiplier = synchronizeMultiplierDraft(
    multiplierState,
    authoritativeMultiplier,
  );
  useEffect(() => {
    multiplierValueRef.current = multiplier.value;
  }, [multiplier.value]);
  const {
    revision: pinnedSaveRevision,
    pin: pinSaveRevision,
    rebase: rebaseSaveRevision,
    reset: resetSaveRevision,
  } = useDraftRevision(model.revision);
  const multiplierDirty =
    multiplier.acceptedValue === null &&
    multiplier.value !== authoritativeMultiplier;
  const waitingForOverrideSnapshot =
    pendingOverrideRevision !== null &&
    model.revision < pendingOverrideRevision;
  const missingSchedules = model.channels.filter(
    ({ schedule }) => schedule === null,
  );
  const scheduleChannels = useMemo(
    () =>
      model.channels.flatMap(({ channel, schedule }) =>
        schedule === null ? [] : [{ channel, schedule, color: channel.color }],
      ),
    [model.channels],
  );
  const overrideChannels = useMemo(
    () =>
      model.channels.map(({ channel, schedule }) => {
        const draftPoints = draftPointsByChannel[channel.id];
        return {
          channel,
          schedule:
            schedule === null || draftPoints === undefined
              ? schedule
              : { ...schedule, points: [...draftPoints] },
        };
      }),
    [draftPointsByChannel, model.channels],
  );
  const commandableOverrideChannelIds = useMemo(() => {
    const activeProfileIds = new Set(
      model.devices.flatMap((device) =>
        device.enabled &&
        ["online", "stale", "offline"].includes(device.status) &&
        device.mappingProfileId !== null
          ? [device.mappingProfileId]
          : [],
      ),
    );
    return new Set(
      model.mappingProfiles
        .filter((profile) => activeProfileIds.has(profile.id))
        .flatMap((profile) =>
          profile.mappings.flatMap((mapping) =>
            mapping.enabled && mapping.target.kind === "channel"
              ? [mapping.target.id]
              : [],
          ),
        ),
    );
  }, [model.devices, model.mappingProfiles]);

  useEffect(() => {
    if (multiplierDirty) {
      pinSaveRevision();
    } else if (!scheduleSaving) {
      resetSaveRevision();
    }
  }, [multiplierDirty, pinSaveRevision, resetSaveRevision, scheduleSaving]);

  useEffect(() => {
    const previous = previousConfigurationSnapshotRef.current;
    if (previous.revision === model.revision) return;

    if (multiplierDirty && multiplierConflictRevision === null) {
      if (previous.multiplier === authoritativeMultiplier) {
        rebaseSaveRevision();
      } else {
        setMultiplierConflictRevision(model.revision);
      }
    }
    previousConfigurationSnapshotRef.current = {
      revision: model.revision,
      multiplier: authoritativeMultiplier,
    };
  }, [
    authoritativeMultiplier,
    model.revision,
    multiplierConflictRevision,
    multiplierDirty,
    rebaseSaveRevision,
    setMultiplierConflictRevision,
  ]);

  const save = useMutation({
    retry: false,
    mutationFn: async (): Promise<ConfigurationSaveResult> => {
      let revision = multiplierDirty ? pinnedSaveRevision : model.revision;
      if (multiplierDirty) {
        if (model.throttle === null) {
          throw new Error(
            `${model.area.label} has no schedule multiplier record.`,
          );
        }
      }
      if (editorRef.current !== null) {
        revision = await editorRef.current.saveAll(
          revision,
          multiplierDirty ? multiplier.value : undefined,
        );
      } else if (multiplierDirty) {
        const result = await replaceControlAreaScheduleConfiguration(
          model.area.slug,
          {
            expectedRevision: revision,
            schedules: [],
            throttlePercentage: multiplier.value,
          },
        );
        revision = result.revision;
      }
      return {
        revision,
        savedMultiplierValue: multiplierDirty ? multiplier.value : null,
      };
    },
    onSuccess: (result) => {
      if (result.savedMultiplierValue !== null) {
        setMultiplierState((current) => ({
          ...synchronizeMultiplierDraft(current, authoritativeMultiplier),
          acceptedValue: result.savedMultiplierValue,
        }));
      }
      setMultiplierConflictRevision(null);
      setConfigurationHistory(EMPTY_CONFIGURATION_HISTORY);
      resetSaveRevision();
      refresh();
    },
    onError: (error) => {
      const currentRevision = currentRevisionFromError(error);
      if (multiplierDirty && currentRevision !== null) {
        setMultiplierConflictRevision(currentRevision);
      }
      refresh();
    },
  });
  const configurationDirty = scheduleDirty || multiplierDirty;
  const saving = save.isPending || scheduleSaving;
  const configurationSaveBlocked = overrideBusy || waitingForOverrideSnapshot;
  const multiplierConflictUnresolved =
    multiplierConflictRevision !== null &&
    model.revision < multiplierConflictRevision;
  const navigationBlocker = useBlocker(
    ({ currentLocation, nextLocation }) =>
      configurationDirty && currentLocation.pathname !== nextLocation.pathname,
  );
  const handleBeforeUnload = useCallback(
    (event: BeforeUnloadEvent) => {
      if (!configurationDirty) return;
      event.preventDefault();
      event.returnValue = "";
    },
    [configurationDirty],
  );
  useBeforeUnload(handleBeforeUnload);

  useEffect(() => {
    if (navigationBlocker.state === "blocked" && !configurationDirty) {
      navigationBlocker.proceed();
    }
  }, [configurationDirty, navigationBlocker]);

  const saveBeforeLeaving = (): void => {
    save.mutate(undefined, {
      onSuccess: () => {
        if (navigationBlocker.state === "blocked") {
          navigationBlocker.proceed();
        }
      },
    });
  };

  const checkpointConfigurationHistory = useCallback((): void => {
    const snapshot: ConfigurationHistorySnapshot = {
      pointsByChannel: draftPointsRef.current,
      multiplier: multiplierValueRef.current,
    };
    setConfigurationHistory((current) => ({
      past: [...current.past, snapshot].slice(-CONFIGURATION_HISTORY_LIMIT),
      future: [],
    }));
  }, []);

  const applyHistorySnapshot = (
    snapshot: ConfigurationHistorySnapshot,
  ): void => {
    draftPointsRef.current = snapshot.pointsByChannel;
    setDraftPointsByChannel(snapshot.pointsByChannel);
    editorRef.current?.restoreDraftPoints(
      snapshot.pointsByChannel,
      model.revision,
    );
    multiplierValueRef.current = snapshot.multiplier;
    setMultiplierState((current) => ({
      ...synchronizeMultiplierDraft(current, authoritativeMultiplier),
      value: snapshot.multiplier,
      acceptedValue: null,
    }));
    if (snapshot.multiplier === authoritativeMultiplier) {
      setMultiplierConflictRevision(null);
    }
  };

  const undoConfigurationChange = (): void => {
    const target = configurationHistory.past.at(-1);
    if (target === undefined) return;
    const current: ConfigurationHistorySnapshot = {
      pointsByChannel: draftPointsRef.current,
      multiplier: multiplierValueRef.current,
    };
    applyHistorySnapshot(target);
    setConfigurationHistory({
      past: configurationHistory.past.slice(0, -1),
      future: [current, ...configurationHistory.future],
    });
  };

  const redoConfigurationChange = (): void => {
    const target = configurationHistory.future[0];
    if (target === undefined) return;
    const current: ConfigurationHistorySnapshot = {
      pointsByChannel: draftPointsRef.current,
      multiplier: multiplierValueRef.current,
    };
    applyHistorySnapshot(target);
    setConfigurationHistory({
      past: [...configurationHistory.past, current].slice(
        -CONFIGURATION_HISTORY_LIMIT,
      ),
      future: configurationHistory.future.slice(1),
    });
  };

  return (
    <main className="page control-page">
      <div className="control-area-heading">
        <div>
          <p className="eyebrow">Control area</p>
          <h1>{model.area.label}</h1>
        </div>
        <div className="control-heading-actions">
          <Link className="secondary-button" to="/">
            Overview
          </Link>
          <button
            className="secondary-button"
            type="button"
            onClick={() => setMappingsOpen(true)}
          >
            Pin mappings
          </button>
          <button
            className="secondary-button"
            type="button"
            onClick={() => setChannelsOpen(true)}
          >
            Manage channels
          </button>
          <button
            className="secondary-button"
            type="button"
            disabled={configurationHistory.past.length === 0 || saving}
            onClick={undoConfigurationChange}
          >
            Undo
          </button>
          <button
            className="secondary-button"
            type="button"
            disabled={configurationHistory.future.length === 0 || saving}
            onClick={redoConfigurationChange}
          >
            Redo
          </button>
          <button
            className="primary-button"
            type="button"
            disabled={
              !configurationDirty ||
              saving ||
              configurationSaveBlocked ||
              multiplierConflictRevision !== null
            }
            onClick={() => save.mutate()}
          >
            {saving ? "Saving…" : "Save configuration"}
          </button>
        </div>
      </div>

      {save.error === null ? null : (
        <p
          className="configuration-save-feedback floating-save-error"
          role="alert"
        >
          {configurationErrorMessage(save.error)}
        </p>
      )}

      {showConnectionWarning ? (
        <div className="stale-banner compact-stale-banner" role="status">
          <span>
            Controller state is {connectionStatus}. This view may be stale;
            saves remain revision-protected.
          </span>
          <button className="text-button" type="button" onClick={retry}>
            Reconnect
          </button>
        </div>
      ) : null}
      {missingSchedules.length === 0 ? null : (
        <p className="error-banner" role="alert">
          {missingSchedules.map(({ channel }) => channel.name).join(", ")}{" "}
          {missingSchedules.length === 1 ? "has" : "have"} no owned schedule.
          Repair controller state before editing those channels.
        </p>
      )}

      <section className="control-surface" aria-label="Schedule editor">
        <CombinedScheduleEditor
          ref={editorRef}
          channels={scheduleChannels}
          expectedRevision={model.revision}
          onSaveConfiguration={(request) =>
            replaceControlAreaScheduleConfiguration(model.area.slug, request)
          }
          onDirtyChange={setScheduleDirty}
          onDraftPointsChange={(points) => {
            draftPointsRef.current = points;
            setDraftPointsByChannel(points);
          }}
          onSavingChange={setScheduleSaving}
          onHistoryCheckpoint={checkpointConfigurationHistory}
          onAcceptRevisionConflict={() => {
            if (multiplierDirty) {
              rebaseSaveRevision();
              setMultiplierConflictRevision(null);
            }
          }}
        />
      </section>

      <section className="testing-controls" aria-label="Live output controls">
        <ScheduleMultiplier
          areaLabel={model.area.label}
          throttle={model.throttle}
          value={multiplier.value}
          dirty={multiplierDirty}
          disabled={saving}
          conflictRevision={multiplierConflictRevision}
          conflictReady={!multiplierConflictUnresolved}
          onAcceptConflict={() => {
            if (
              multiplierConflictRevision === null ||
              multiplierConflictUnresolved
            ) {
              return;
            }
            rebaseSaveRevision();
            setMultiplierConflictRevision(null);
          }}
          onHistoryCheckpoint={checkpointConfigurationHistory}
          onChange={(value) => {
            multiplierValueRef.current = value;
            pinSaveRevision();
            if (value === authoritativeMultiplier) {
              setMultiplierConflictRevision(null);
            }
            setMultiplierState({
              ...multiplier,
              value,
              acceptedValue: null,
            });
          }}
        />
        <ManualOverridePanel
          channels={overrideChannels}
          commandableChannelIds={commandableOverrideChannelIds}
          multiplierPercentage={multiplier.value}
          overrides={model.overrides}
          operations={model.operations}
          expectedRevision={model.revision}
          disabled={liveStateUnavailable || saving}
          refresh={refresh}
          onAcceptedRevision={setPendingOverrideRevision}
          onBusyChange={setOverrideBusy}
        />
      </section>

      <DevicesPanel
        devices={model.devices}
        firmware={model.firmware}
        mappingProfiles={model.mappingProfiles}
        operations={model.operations}
        expectedRevision={model.revision}
        refresh={refresh}
      />

      {channelsOpen ? (
        <ChannelManagementDialog
          area={model.area}
          channels={model.channels.map(({ channel }) => channel)}
          throttleId={model.throttle?.id ?? null}
          expectedRevision={model.revision}
          refresh={refresh}
          onClose={() => setChannelsOpen(false)}
        />
      ) : null}
      <MappingProfilesDialog
        open={mappingsOpen}
        onClose={() => setMappingsOpen(false)}
        profiles={model.mappingProfiles}
        devices={model.devices}
        channels={allChannels}
        outputs={allOutputs}
        controlAreas={allAreas}
        currentTypeKey={model.area.typeKey}
        expectedRevision={model.revision}
        refresh={refresh}
      />
      <UnsavedChangesDialog
        open={navigationBlocker.state === "blocked"}
        saving={saving}
        saveDisabled={
          configurationSaveBlocked || multiplierConflictRevision !== null
        }
        heading="Save changes before leaving?"
        onSave={saveBeforeLeaving}
        onDiscard={() => {
          if (navigationBlocker.state === "blocked") {
            navigationBlocker.proceed();
          }
        }}
        onKeepEditing={() => {
          if (navigationBlocker.state === "blocked") {
            navigationBlocker.reset();
          }
        }}
      />
    </main>
  );
}

function synchronizeMultiplierDraft(
  current: MultiplierDraft,
  authoritativeValue: number,
): MultiplierDraft {
  if (current.sourceValue === authoritativeValue) return current;
  if (current.acceptedValue === authoritativeValue) {
    return {
      sourceValue: authoritativeValue,
      value: authoritativeValue,
      acceptedValue: null,
    };
  }
  const hasUnsavedDraft =
    current.acceptedValue === null && current.value !== current.sourceValue;
  return {
    sourceValue: authoritativeValue,
    value: hasUnsavedDraft ? current.value : authoritativeValue,
    acceptedValue: null,
  };
}
