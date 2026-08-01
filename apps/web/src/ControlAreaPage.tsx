import type { ControlArea } from "@aquarium/contracts";
import { useMutation } from "@tanstack/react-query";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link } from "react-router";

import { replaceSchedule, updateThrottle } from "./api.js";
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
      liveStateUnavailable={
        controller.dataStale || controller.status !== "connected"
      }
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
  const multiplier = synchronizeMultiplierDraft(
    multiplierState,
    authoritativeMultiplier,
  );
  const {
    revision: pinnedSaveRevision,
    pin: pinSaveRevision,
    rebase: rebaseSaveRevision,
    reset: resetSaveRevision,
  } = useDraftRevision(model.revision);
  const multiplierDirty =
    multiplier.acceptedValue === null &&
    multiplier.value !== authoritativeMultiplier;
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

  const save = useMutation({
    retry: false,
    mutationFn: async (): Promise<ConfigurationSaveResult> => {
      const hadScheduleChanges = editorRef.current?.dirty ?? false;
      let revision = multiplierDirty ? pinnedSaveRevision : model.revision;
      if (editorRef.current !== null) {
        revision = await editorRef.current.saveAll(revision);
      }
      if (multiplierDirty) {
        if (model.throttle === null) {
          throw new Error(
            `${model.area.label} has no schedule multiplier record.`,
          );
        }
        try {
          const result = await updateThrottle(model.area.typeKey, {
            expectedRevision: revision,
            percentage: multiplier.value,
          });
          revision = result.revision;
        } catch (caught) {
          const error =
            caught instanceof Error
              ? caught
              : new Error("The schedule multiplier save failed.");
          throw new MultiplierSaveError(
            hadScheduleChanges
              ? `Schedule changes were saved, but the schedule multiplier was not. ${configurationErrorMessage(error)}`
              : configurationErrorMessage(error),
            currentRevisionFromError(error),
            caught,
          );
        }
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
      resetSaveRevision();
      refresh();
    },
    onError: (error) => {
      if (
        error instanceof MultiplierSaveError &&
        error.currentRevision !== null
      ) {
        setMultiplierConflictRevision(error.currentRevision);
      }
      refresh();
    },
  });
  const configurationDirty = scheduleDirty || multiplierDirty;
  const saving = save.isPending || scheduleSaving;
  const multiplierConflictUnresolved =
    multiplierConflictRevision !== null &&
    model.revision < multiplierConflictRevision;

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
            className="primary-button"
            type="button"
            disabled={
              !configurationDirty ||
              saving ||
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
          onSaveSchedule={replaceSchedule}
          onDirtyChange={setScheduleDirty}
          onDraftPointsChange={setDraftPointsByChannel}
          onSavingChange={setScheduleSaving}
          onAcceptRevisionConflict={() => {
            if (multiplierDirty) rebaseSaveRevision();
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
          onChange={(value) => {
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
        />
      </section>

      <DevicesPanel
        devices={model.devices}
        mappingProfiles={model.mappingProfiles}
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
        channels={allChannels}
        outputs={allOutputs}
        controlAreas={allAreas}
        currentTypeKey={model.area.typeKey}
        expectedRevision={model.revision}
        refresh={refresh}
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

class MultiplierSaveError extends Error {
  override readonly name = "MultiplierSaveError";

  public constructor(
    message: string,
    readonly currentRevision: number | null,
    cause: ErrorOptions["cause"],
  ) {
    super(message, { cause });
  }
}
