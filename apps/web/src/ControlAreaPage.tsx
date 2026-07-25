import type { Channel, ControlArea, ScheduleGraph } from "@aquarium/contracts";
import { useMutation } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router";

import { createChannel, deleteChannel, renameChannel } from "./api.js";
import {
  configurationErrorMessage,
  currentRevisionFromError,
} from "./configuration-ui.js";
import { projectControlArea } from "./control-area-model.js";
import {
  DevicesPanel,
  MappingProfilesPanel,
  ThrottlePanel,
} from "./ControlAreaSettings.js";
import { ManualOverridePanel } from "./ManualOverridePanel.js";
import { OperationStatusPanel } from "./OperationStatusPanel.js";
import { ScheduleEditor } from "./ScheduleEditor.js";
import { useControllerState } from "./use-controller-state.js";
import { useDraftRevision } from "./use-draft-revision.js";

interface ControlAreaPageProps {
  readonly slug: ControlArea["slug"];
}

export function ControlAreaPage({
  slug,
}: ControlAreaPageProps): React.JSX.Element {
  const controller = useControllerState();
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
  const stale = controller.dataStale || controller.status !== "connected";

  return (
    <main className="page control-page">
      <div className="control-page-heading">
        <div>
          <p className="eyebrow">UTC control area</p>
          <h1>{model.area.label}</h1>
          <p>
            Edit schedules, scaling, pin mappings, and desired device state at
            authoritative revision {model.revision}.
          </p>
        </div>
        <Link className="secondary-button" to="/">
          Back to overview
        </Link>
      </div>

      {stale ? (
        <div className="stale-banner" role="status">
          <strong>Controller state is {controller.status}.</strong>
          <span>
            This view may be stale. Every save includes revision{" "}
            {model.revision}
            and will stop on conflict rather than overwrite newer state.
          </span>
          <button
            className="text-button"
            type="button"
            onClick={controller.retry}
          >
            Reconnect state stream
          </button>
        </div>
      ) : null}

      <section className="control-panel" aria-labelledby="channels-heading">
        <div className="section-heading">
          <div>
            <p className="eyebrow">Daily programs</p>
            <h2 id="channels-heading">Channels</h2>
          </div>
          <span className="section-count">
            {model.channels.length} configured
          </span>
        </div>
        <CreateChannelForm
          area={model.area}
          channels={model.channels.map(({ channel }) => channel)}
          throttleId={model.throttle?.id ?? null}
          expectedRevision={model.revision}
          refresh={controller.refresh}
        />
        {model.channels.length === 0 ? (
          <p className="empty-panel">
            No channels exist for this control area. Create one to provision its
            owned UTC schedule.
          </p>
        ) : (
          <div className="channel-list">
            {model.channels.map(({ channel, schedule }) => (
              <ChannelCard
                key={channel.id}
                channel={channel}
                schedule={schedule}
                expectedRevision={model.revision}
                refresh={controller.refresh}
              />
            ))}
          </div>
        )}
      </section>

      <ThrottlePanel
        key={model.throttle?.id ?? model.area.typeKey}
        typeKey={model.area.typeKey}
        throttle={model.throttle}
        expectedRevision={model.revision}
        refresh={controller.refresh}
      />
      <MappingProfilesPanel
        profiles={model.mappingProfiles}
        relevantProfileIds={model.relevantProfileIds}
        channels={controller.snapshot.channels}
        outputs={controller.snapshot.outputs}
        expectedRevision={model.revision}
        refresh={controller.refresh}
      />
      <DevicesPanel
        devices={model.devices}
        expectedRevision={model.revision}
        refresh={controller.refresh}
      />
      <ManualOverridePanel
        channels={model.channels.map(({ channel }) => channel)}
        outputs={model.outputs}
        overrides={model.overrides}
        operations={model.operations}
        expectedRevision={model.revision}
        refresh={controller.refresh}
      />
      <OperationStatusPanel
        operations={model.operations}
        truncated={controller.snapshot.operations.truncated}
        expectedRevision={model.revision}
        refresh={controller.refresh}
      />
    </main>
  );
}

interface CreateChannelFormProps {
  readonly area: ControlArea;
  readonly channels: readonly Channel[];
  readonly throttleId: string | null;
  readonly expectedRevision: number;
  readonly refresh: () => void;
}

function CreateChannelForm({
  area,
  channels,
  throttleId,
  expectedRevision,
  refresh,
}: CreateChannelFormProps): React.JSX.Element {
  const [expanded, setExpanded] = useState(false);
  const [id, setId] = useState("");
  const [name, setName] = useState("");
  const draftRevision = useDraftRevision(expectedRevision);
  const mutation = useMutation({
    mutationFn: () => {
      if (throttleId === null) {
        throw new Error("This control area has no throttle record.");
      }
      return createChannel({
        expectedRevision: draftRevision.revision,
        id,
        name,
        typeKey: area.typeKey,
        throttleId,
        displayOrder:
          channels.reduce(
            (maximum, channel) => Math.max(maximum, channel.displayOrder),
            -1,
          ) + 1,
        enabled: true,
      });
    },
    onSuccess: () => {
      setId("");
      setName("");
      setExpanded(false);
      draftRevision.reset();
      refresh();
    },
    onError: refreshApiFailure(refresh),
  });

  return (
    <div className="create-channel-panel">
      <button
        className="secondary-button"
        type="button"
        aria-expanded={expanded}
        onClick={() => {
          if (expanded) {
            draftRevision.reset();
          } else {
            draftRevision.pin();
          }
          setExpanded((current) => !current);
        }}
      >
        {expanded ? "Close channel form" : "Create channel"}
      </button>
      {!expanded ? null : (
        <form
          className="inline-editor create-channel-form"
          onSubmit={(event) => {
            event.preventDefault();
            mutation.mutate();
          }}
        >
          <label>
            Channel ID
            <input
              value={id}
              onChange={(event) => setId(event.currentTarget.value)}
              placeholder={`${area.typeKey}-main`}
              required
            />
          </label>
          <label>
            Channel name
            <input
              value={name}
              onChange={(event) => setName(event.currentTarget.value)}
              placeholder={`${area.label} main`}
              required
            />
          </label>
          <button
            className="primary-button"
            type="submit"
            disabled={throttleId === null || mutation.isPending}
          >
            {mutation.isPending
              ? "Creating channel…"
              : "Create channel and schedule"}
          </button>
        </form>
      )}
      {mutation.error === null ? null : (
        <p className="field-error" role="alert">
          {configurationErrorMessage(mutation.error)}
        </p>
      )}
      {mutation.isSuccess ? (
        <p className="success-message" role="status">
          Channel creation accepted. Refreshing authoritative state.
        </p>
      ) : null}
    </div>
  );
}

interface ChannelCardProps {
  readonly channel: Channel;
  readonly schedule: ScheduleGraph | null;
  readonly expectedRevision: number;
  readonly refresh: () => void;
}

function ChannelCard({
  channel,
  schedule,
  expectedRevision,
  refresh,
}: ChannelCardProps): React.JSX.Element {
  const [renameState, setRenameState] = useState(() => ({
    authoritativeName: channel.name,
    draftName: channel.name,
    touched: false,
  }));
  const name = renameState.draftName;
  const [confirmDelete, setConfirmDelete] = useState(false);
  const renameRevision = useDraftRevision(expectedRevision);
  const resetRenameRevision = renameRevision.reset;
  const deleteRevision = useDraftRevision(expectedRevision);
  const rename = useMutation({
    mutationFn: () =>
      renameChannel(channel.id, {
        expectedRevision: renameRevision.revision,
        name,
      }),
    onSuccess: () => {
      renameRevision.reset();
      refresh();
    },
    onError: refreshApiFailure(refresh),
  });
  const remove = useMutation({
    mutationFn: () => deleteChannel(channel.id, deleteRevision.revision),
    onSuccess: () => {
      deleteRevision.reset();
      refresh();
    },
    onError: refreshApiFailure(refresh),
  });

  if (renameState.authoritativeName !== channel.name) {
    const draftResolved = renameState.draftName === channel.name;
    const preserveDraft = renameState.touched && !draftResolved;
    setRenameState({
      authoritativeName: channel.name,
      draftName: preserveDraft ? renameState.draftName : channel.name,
      touched: preserveDraft,
    });
    if (draftResolved) resetRenameRevision();
  }

  return (
    <article className="channel-card">
      <div className="channel-card-heading">
        <div>
          <div className="channel-title-line">
            <h3>{channel.name}</h3>
            <span
              className={`status-pill ${channel.enabled ? "status-online" : "status-offline"}`}
            >
              {channel.enabled ? "enabled" : "disabled"}
            </span>
          </div>
          <code>{channel.id}</code>
        </div>
        <form
          className="rename-form"
          onSubmit={(event) => {
            event.preventDefault();
            rename.mutate();
          }}
        >
          <label>
            Rename channel
            <input
              value={name}
              onChange={(event) => {
                const nextName = event.currentTarget.value;
                if (nextName === channel.name) {
                  renameRevision.reset();
                } else {
                  renameRevision.pin();
                }
                setRenameState({
                  authoritativeName: channel.name,
                  draftName: nextName,
                  touched: nextName !== channel.name,
                });
              }}
              required
            />
          </label>
          <button
            className="secondary-button"
            type="submit"
            disabled={name === channel.name || rename.isPending}
          >
            {rename.isPending ? "Renaming…" : "Rename"}
          </button>
        </form>
      </div>
      {rename.error === null ? null : (
        <p className="field-error" role="alert">
          {configurationErrorMessage(rename.error)}
        </p>
      )}

      {schedule === null ? (
        <p className="error-banner" role="alert">
          This channel has no owned schedule. The controller state is
          incomplete; schedule edits are disabled.
        </p>
      ) : (
        <ScheduleEditor
          channel={channel}
          schedule={schedule}
          expectedRevision={expectedRevision}
          refresh={refresh}
        />
      )}

      <div className="destructive-zone">
        {!confirmDelete ? (
          <button
            className="text-button danger-text"
            type="button"
            onClick={() => {
              deleteRevision.pin();
              setConfirmDelete(true);
            }}
          >
            Delete channel {channel.name}
          </button>
        ) : (
          <div
            className="delete-confirmation"
            role="group"
            aria-label={`Confirm deletion of ${channel.name}`}
          >
            <span>
              Delete this channel and its owned schedule? Mapped or historically
              overridden channels will be rejected by the controller.
            </span>
            <button
              className="danger-button"
              type="button"
              disabled={remove.isPending}
              onClick={() => remove.mutate()}
            >
              {remove.isPending ? "Deleting…" : "Confirm delete"}
            </button>
            <button
              className="text-button"
              type="button"
              onClick={() => {
                deleteRevision.reset();
                setConfirmDelete(false);
              }}
            >
              Cancel
            </button>
          </div>
        )}
        {remove.error === null ? null : (
          <p className="field-error" role="alert">
            {configurationErrorMessage(remove.error)}
          </p>
        )}
      </div>
    </article>
  );
}

function refreshApiFailure(refresh: () => void): (error: Error) => void {
  return (error) => {
    if (currentRevisionFromError(error) !== null) refresh();
  };
}
