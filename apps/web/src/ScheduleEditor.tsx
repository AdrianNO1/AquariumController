import type {
  Channel,
  ScheduleGraph,
  SchedulePoint,
} from "@aquarium/contracts";
import { useMutation } from "@tanstack/react-query";
import { useEffect, useMemo, useReducer, useState } from "react";

import { replaceSchedule } from "./api.js";
import {
  configurationErrorMessage,
  currentRevisionFromError,
} from "./configuration-ui.js";
import {
  createScheduleEditorState,
  isScheduleDraftDirty,
  scheduleEditorReducer,
  toReplaceScheduleRequest,
  validateScheduleDraft,
} from "./schedule-editor-state.js";
import { useDraftRevision } from "./use-draft-revision.js";

interface ScheduleEditorProps {
  readonly channel: Channel;
  readonly schedule: ScheduleGraph;
  readonly expectedRevision: number;
  readonly refresh: () => void;
}

export function ScheduleEditor({
  channel,
  schedule,
  expectedRevision,
  refresh,
}: ScheduleEditorProps): React.JSX.Element {
  const [state, dispatch] = useReducer(
    scheduleEditorReducer,
    schedule,
    createScheduleEditorState,
  );
  const [newPointId, setNewPointId] = useState("");
  const [newPointTime, setNewPointTime] = useState("12:00");
  const [newPointPercentage, setNewPointPercentage] = useState("50");
  const [addError, setAddError] = useState<string | null>(null);
  const [pointEditInProgress, setPointEditInProgress] = useState(false);
  const draftRevision = useDraftRevision(expectedRevision);
  const resetDraftRevision = draftRevision.reset;
  const validation = useMemo(() => validateScheduleDraft(state), [state]);
  const dirty = isScheduleDraftDirty(state);
  const save = useMutation({
    mutationFn: () =>
      replaceSchedule(
        channel.id,
        toReplaceScheduleRequest(state, draftRevision.revision),
      ),
    onSuccess: () => {
      resetDraftRevision();
      dispatch({ type: "saved" });
      refresh();
    },
    onError: (error) => {
      const currentRevision = currentRevisionFromError(error);
      if (currentRevision !== null) {
        dispatch({ type: "revision_conflict", currentRevision });
        refresh();
      }
    },
  });

  useEffect(() => {
    dispatch({
      type: "snapshot",
      schedule,
      currentRevision: expectedRevision,
      draftInProgress: pointEditInProgress,
    });
  }, [expectedRevision, pointEditInProgress, schedule]);

  useEffect(() => {
    if (!dirty && !pointEditInProgress) resetDraftRevision();
  }, [dirty, pointEditInProgress, resetDraftRevision]);

  function addPoint(event: React.FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const minuteOfDay = timeToMinute(newPointTime);
    const percentage = Number(newPointPercentage);
    if (newPointId.length === 0 || minuteOfDay === null) {
      setAddError("Enter a point identifier and a complete UTC time.");
      return;
    }
    if (!Number.isFinite(percentage)) {
      setAddError("Enter a numeric percentage.");
      return;
    }
    draftRevision.pin();
    dispatch({
      type: "add",
      point: {
        id: newPointId,
        position: state.points.length,
        minuteOfDay,
        percentage,
        editorX: null,
        editorY: null,
      },
    });
    setNewPointId("");
    setAddError(null);
  }

  return (
    <section
      className="schedule-editor"
      aria-labelledby={`schedule-${channel.id}`}
    >
      <div className="section-heading compact-heading">
        <div>
          <p className="eyebrow">UTC schedule</p>
          <h3 id={`schedule-${channel.id}`}>{schedule.name}</h3>
        </div>
        <span className={dirty ? "draft-indicator dirty" : "draft-indicator"}>
          {dirty ? "Unsaved draft" : `Graph revision ${schedule.graphRevision}`}
        </span>
      </div>

      <ScheduleGraphFigure channelName={channel.name} points={state.points} />

      <div
        className="schedule-point-table"
        role="group"
        aria-label={`${channel.name} schedule point form`}
      >
        <div
          className="schedule-point-row schedule-point-header"
          aria-hidden="true"
        >
          <span>Point</span>
          <span>UTC time</span>
          <span>Output</span>
          <span>Action</span>
        </div>
        {state.points.map((point) => (
          <SchedulePointRow
            key={point.id}
            point={point}
            onEditStart={() => {
              draftRevision.pin();
              setPointEditInProgress(true);
            }}
            onEditEnd={() => setPointEditInProgress(false)}
            onUpdate={(minuteOfDay, percentage) => {
              draftRevision.pin();
              dispatch({
                type: "update",
                pointId: point.id,
                minuteOfDay,
                percentage,
              });
            }}
            onRemove={() => {
              draftRevision.pin();
              dispatch({ type: "remove", pointId: point.id });
            }}
          />
        ))}
      </div>

      <form className="inline-editor add-point-form" onSubmit={addPoint}>
        <label>
          New point ID
          <input
            value={newPointId}
            onChange={(event) => setNewPointId(event.currentTarget.value)}
            placeholder="light-dawn"
            required
          />
        </label>
        <label>
          UTC time
          <input
            type="time"
            value={newPointTime}
            onChange={(event) => setNewPointTime(event.currentTarget.value)}
            required
          />
        </label>
        <label>
          Output percent
          <input
            type="number"
            min="0"
            max="100"
            step="0.1"
            value={newPointPercentage}
            onChange={(event) =>
              setNewPointPercentage(event.currentTarget.value)
            }
            required
          />
        </label>
        <button className="secondary-button" type="submit">
          Add point
        </button>
      </form>

      {addError === null ? null : (
        <p className="field-error" role="alert">
          {addError}
        </p>
      )}
      {validation.valid ? null : (
        <ul className="validation-list" aria-label="Schedule validation errors">
          {validation.issues.map((issue) => (
            <li key={issue}>{issue}</li>
          ))}
        </ul>
      )}
      {state.conflictRevision === null ? null : (
        <div className="conflict-banner" role="alert">
          <span>
            This draft began before controller revision {state.conflictRevision}
            . It was preserved; review the refreshed graph or discard the draft.
          </span>
          <button
            className="text-button"
            type="button"
            disabled={expectedRevision < state.conflictRevision}
            onClick={() => {
              draftRevision.rebase();
              dispatch({ type: "accept_conflict" });
            }}
          >
            Keep draft with refreshed revision
          </button>
        </div>
      )}
      {save.error === null ? null : (
        <p className="field-error" role="alert">
          {configurationErrorMessage(save.error)}
        </p>
      )}
      {save.isSuccess ? (
        <p className="success-message" role="status">
          Schedule save accepted. Refreshing authoritative state.
        </p>
      ) : null}
      <div className="button-row editor-actions">
        <button
          className="primary-button"
          type="button"
          disabled={
            !dirty ||
            !validation.valid ||
            state.conflictRevision !== null ||
            save.isPending
          }
          onClick={() => save.mutate()}
        >
          {save.isPending ? "Saving schedule…" : "Save schedule"}
        </button>
        <button
          className="secondary-button"
          type="button"
          disabled={!dirty || save.isPending}
          onClick={() => {
            draftRevision.reset();
            dispatch({ type: "discard" });
          }}
        >
          Discard draft
        </button>
      </div>
    </section>
  );
}

interface SchedulePointRowProps {
  readonly point: SchedulePoint;
  readonly onEditStart: () => void;
  readonly onEditEnd: () => void;
  readonly onUpdate: (minuteOfDay: number, percentage: number) => void;
  readonly onRemove: () => void;
}

function SchedulePointRow({
  point,
  onEditStart,
  onEditEnd,
  onUpdate,
  onRemove,
}: SchedulePointRowProps): React.JSX.Element {
  const [input, setInput] = useState(() => ({
    authoritativeMinuteOfDay: point.minuteOfDay,
    authoritativePercentage: point.percentage,
    time: minuteToTime(point.minuteOfDay),
    percentage: String(point.percentage),
    editing: false,
  }));
  if (
    !input.editing &&
    (input.authoritativeMinuteOfDay !== point.minuteOfDay ||
      input.authoritativePercentage !== point.percentage)
  ) {
    setInput({
      authoritativeMinuteOfDay: point.minuteOfDay,
      authoritativePercentage: point.percentage,
      time: minuteToTime(point.minuteOfDay),
      percentage: String(point.percentage),
      editing: false,
    });
  }

  function beginEdit(): void {
    if (input.editing) return;
    setInput((current) => ({ ...current, editing: true }));
    onEditStart();
  }

  function commit(): void {
    const minuteOfDay = timeToMinute(input.time);
    const parsedPercentage = Number(input.percentage);
    if (minuteOfDay !== null && Number.isFinite(parsedPercentage)) {
      onUpdate(minuteOfDay, parsedPercentage);
    }
    setInput((current) => ({ ...current, editing: false }));
    onEditEnd();
  }

  return (
    <div className="schedule-point-row">
      <code>{point.id}</code>
      <label>
        <span className="visually-hidden">UTC time for {point.id}</span>
        <input
          type="time"
          value={input.time}
          onChange={(event) => {
            const time = event.currentTarget.value;
            beginEdit();
            setInput((current) => ({
              ...current,
              time,
              editing: true,
            }));
          }}
          onBlur={commit}
        />
      </label>
      <label>
        <span className="visually-hidden">Output percent for {point.id}</span>
        <span className="percentage-input">
          <input
            type="number"
            min="0"
            max="100"
            step="0.1"
            value={input.percentage}
            onChange={(event) => {
              const percentage = event.currentTarget.value;
              beginEdit();
              setInput((current) => ({
                ...current,
                percentage,
                editing: true,
              }));
            }}
            onBlur={commit}
          />
          <span aria-hidden="true">%</span>
        </span>
      </label>
      <button
        className="text-button danger-text"
        type="button"
        onClick={onRemove}
      >
        Delete point {point.id}
      </button>
    </div>
  );
}

function ScheduleGraphFigure({
  channelName,
  points,
}: {
  readonly channelName: string;
  readonly points: readonly SchedulePoint[];
}): React.JSX.Element {
  const plotPoints = points
    .filter(
      (point) =>
        Number.isFinite(point.minuteOfDay) && Number.isFinite(point.percentage),
    )
    .map(
      (point) =>
        `${30 + (point.minuteOfDay / 1_439) * 640},${15 + ((100 - point.percentage) / 100) * 150}`,
    )
    .join(" ");

  return (
    <figure className="schedule-graph">
      <svg
        viewBox="0 0 700 200"
        role="img"
        aria-label={`${channelName} output percentage across a UTC day`}
      >
        <line x1="30" y1="15" x2="30" y2="165" />
        <line x1="30" y1="165" x2="670" y2="165" />
        {[0, 6, 12, 18, 24].map((hour) => {
          const x = 30 + (hour / 24) * 640;
          return (
            <g key={hour}>
              <line className="grid-line" x1={x} y1="15" x2={x} y2="165" />
              <text x={x} y="187" textAnchor="middle">
                {String(hour).padStart(2, "0")}:00
              </text>
            </g>
          );
        })}
        {[0, 50, 100].map((percentage) => {
          const y = 15 + ((100 - percentage) / 100) * 150;
          return (
            <g key={percentage}>
              <line className="grid-line" x1="30" y1={y} x2="670" y2={y} />
              <text x="24" y={y + 4} textAnchor="end">
                {percentage}%
              </text>
            </g>
          );
        })}
        <polyline className="schedule-line" points={plotPoints} />
      </svg>
      <figcaption>
        UTC day. Every graph action is also available through the point form.
      </figcaption>
    </figure>
  );
}

function minuteToTime(minuteOfDay: number): string {
  const hours = Math.floor(minuteOfDay / 60);
  const minutes = minuteOfDay % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

function timeToMinute(value: string): number | null {
  const match = /^(?<hour>[0-2][0-9]):(?<minute>[0-5][0-9])$/u.exec(value);
  if (match?.groups === undefined) return null;
  const hour = Number(match.groups.hour);
  const minute = Number(match.groups.minute);
  if (hour > 23) return null;
  return hour * 60 + minute;
}
