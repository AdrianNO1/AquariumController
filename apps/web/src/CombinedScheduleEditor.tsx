import type {
  Channel,
  ReplaceScheduleRequest,
  ScheduleGraph,
  SchedulePoint,
} from "@aquarium/contracts";
import {
  forwardRef,
  useCallback,
  useEffect,
  useImperativeHandle,
  useMemo,
  useReducer,
  useRef,
  useState,
} from "react";

import {
  COMBINED_SCHEDULE_PLOT,
  COMBINED_SCHEDULE_VIEW_BOX,
  clientToViewBoxCoordinate,
  combinedScheduleReducer,
  createCombinedScheduleState,
  createSchedulePointId,
  cyclicPlotPoints,
  isCombinedScheduleDraftDirty,
  isCombinedScheduleStateDirty,
  minuteToPlotX,
  minuteToTime,
  percentageToPlotY,
  plotXToMinute,
  plotYToPercentage,
  pointFromDraggedCoordinate,
  scheduleValueAt,
  snapDraggedMinute,
  timeToMinute,
  toCombinedReplaceScheduleRequest,
  validateCombinedScheduleDraft,
  type CombinedScheduleDraft,
  type CombinedScheduleSource,
  type PlotCoordinate,
} from "./combined-schedule-state.js";
import { CombinedScheduleSaveError } from "./combined-schedule-save.js";
import { currentRevisionFromError } from "./configuration-ui.js";

export interface CombinedScheduleChannel {
  readonly channel: Channel;
  readonly schedule: ScheduleGraph;
  readonly color: string;
}

export interface ScheduleMutationResult {
  readonly revision: number;
}

export type CombinedScheduleDraftPoints = Readonly<
  Record<string, readonly SchedulePoint[]>
>;

export interface CombinedScheduleEditorProps {
  readonly channels: readonly CombinedScheduleChannel[];
  readonly expectedRevision: number;
  readonly onSaveSchedule: (
    channelId: string,
    request: ReplaceScheduleRequest,
  ) => Promise<ScheduleMutationResult>;
  readonly onDirtyChange?: (dirty: boolean) => void;
  readonly onDraftPointsChange?: (
    pointsByChannel: CombinedScheduleDraftPoints,
  ) => void;
  readonly onSavingChange?: (saving: boolean) => void;
  readonly onAcceptRevisionConflict?: () => void;
  readonly currentMinuteOfDay?: number;
}

export interface CombinedScheduleEditorHandle {
  readonly dirty: boolean;
  readonly isSaving: boolean;
  readonly saveAll: (expectedRevision: number) => Promise<number>;
  readonly discardAll: () => void;
}

export const CombinedScheduleEditor = forwardRef<
  CombinedScheduleEditorHandle,
  CombinedScheduleEditorProps
>(function CombinedScheduleEditor(
  {
    channels,
    expectedRevision,
    onSaveSchedule,
    onDirtyChange,
    onDraftPointsChange,
    onSavingChange,
    onAcceptRevisionConflict,
    currentMinuteOfDay: suppliedCurrentMinute,
  },
  ref,
): React.JSX.Element {
  const sources = useMemo(
    () =>
      channels.map(({ channel, schedule }): CombinedScheduleSource => ({
        channelId: channel.id,
        schedule,
      })),
    [channels],
  );
  const [state, dispatch] = useReducer(
    combinedScheduleReducer,
    sources,
    createCombinedScheduleState,
  );
  const [addPointMode, setAddPointMode] = useState(false);
  const [addPointHover, setAddPointHover] = useState<PlotCoordinate | null>(
    null,
  );
  const [interactionError, setInteractionError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const savingRef = useRef(false);
  const dragRef = useRef<DragState | null>(null);
  const suppressGraphClickRef = useRef(false);
  const currentMinute = useUtcMinute(suppliedCurrentMinute);
  const dirty = isCombinedScheduleStateDirty(state);
  const draftPoints = useMemo(
    (): CombinedScheduleDraftPoints =>
      Object.fromEntries(
        Object.entries(state.drafts).map(([channelId, draft]) => [
          channelId,
          draft.points,
        ]),
      ),
    [state.drafts],
  );
  const reportedDraftPointsRef = useRef<CombinedScheduleDraftPoints | null>(
    null,
  );

  useEffect(() => {
    dispatch({
      type: "snapshot",
      sources,
      currentRevision: expectedRevision,
    });
  }, [expectedRevision, sources]);

  useEffect(() => {
    onDirtyChange?.(dirty);
  }, [dirty, onDirtyChange]);

  useEffect(() => {
    if (
      onDraftPointsChange === undefined ||
      draftPointMapsEqual(reportedDraftPointsRef.current, draftPoints)
    ) {
      return;
    }
    reportedDraftPointsRef.current = draftPoints;
    onDraftPointsChange(draftPoints);
  }, [draftPoints, onDraftPointsChange]);

  useEffect(() => {
    onSavingChange?.(isSaving);
  }, [isSaving, onSavingChange]);

  const saveAll = useCallback(
    async (currentRevision: number): Promise<number> => {
      if (savingRef.current) {
        throw new Error("Schedule changes are already being saved.");
      }
      const dirtyDrafts = channels.flatMap(({ channel }) => {
        const draft = state.drafts[channel.id];
        return draft !== undefined && isCombinedScheduleDraftDirty(draft)
          ? [draft]
          : [];
      });
      if (dirtyDrafts.length === 0) return currentRevision;
      const conflict = dirtyDrafts.find(
        (draft) => draft.conflictRevision !== null,
      );
      if (conflict !== undefined) {
        throw new Error(
          "A schedule changed on the controller while it was being edited.",
        );
      }
      for (const draft of dirtyDrafts) {
        const validation = validateCombinedScheduleDraft(draft);
        if (!validation.valid) {
          throw new Error(validation.issues.join(" "));
        }
      }

      savingRef.current = true;
      setIsSaving(true);
      let completedCount = 0;
      const pinnedRevisions = dirtyDrafts.flatMap((draft) =>
        draft.pinnedRevision === null ? [] : [draft.pinnedRevision],
      );
      let revision = Math.min(currentRevision, ...pinnedRevisions);
      try {
        for (const draft of dirtyDrafts) {
          const request = toCombinedReplaceScheduleRequest(draft, revision);
          const result = await onSaveSchedule(draft.channelId, request);
          revision = result.revision;
          completedCount += 1;
          dispatch({
            type: "saved",
            channelId: draft.channelId,
            savedPoints: draft.points,
            savedRevision: result.revision,
          });
        }
        return revision;
      } catch (caught) {
        const error =
          caught instanceof Error
            ? caught
            : new Error("The schedule save failed.");
        const failedDraft = dirtyDrafts[completedCount];
        const serverRevision = currentRevisionFromError(error);
        if (failedDraft !== undefined && serverRevision !== null) {
          dispatch({
            type: "revision_conflict",
            channelId: failedDraft.channelId,
            currentRevision: serverRevision,
          });
        } else {
          dispatch({
            type: "rebase_save_chain",
            channelIds: dirtyDrafts
              .slice(completedCount)
              .map((draft) => draft.channelId),
            currentRevision: revision,
          });
        }
        throw new CombinedScheduleSaveError(
          completedCount,
          dirtyDrafts.length,
          error,
        );
      } finally {
        savingRef.current = false;
        setIsSaving(false);
      }
    },
    [channels, onSaveSchedule, state.drafts],
  );

  useImperativeHandle(
    ref,
    () => ({
      dirty,
      isSaving,
      saveAll,
      discardAll: () => dispatch({ type: "discard_all" }),
    }),
    [dirty, isSaving, saveAll],
  );

  const selectedChannel =
    channels.find(({ channel }) => channel.id === state.selectedChannelId) ??
    null;
  const selectedDraft =
    selectedChannel === null
      ? null
      : (state.drafts[selectedChannel.channel.id] ?? null);
  const selectedPoint =
    selectedDraft?.points.find(
      (point) => point.id === state.selectedPointIds[selectedDraft.channelId],
    ) ?? null;
  const validation =
    selectedDraft === null
      ? null
      : validateCombinedScheduleDraft(selectedDraft);

  function selectChannel(channelId: string): void {
    dispatch({ type: "select_channel", channelId });
    setAddPointMode(false);
    setAddPointHover(null);
    setInteractionError(null);
  }

  function graphCoordinate(
    svg: SVGSVGElement,
    clientX: number,
    clientY: number,
  ): PlotCoordinate {
    const matrix = svg.getScreenCTM();
    if (matrix !== null) {
      const point = svg.createSVGPoint();
      point.x = clientX;
      point.y = clientY;
      const transformed = point.matrixTransform(matrix.inverse());
      return { x: transformed.x, y: transformed.y };
    }
    return clientToViewBoxCoordinate(
      svg.getBoundingClientRect(),
      clientX,
      clientY,
    );
  }

  function beginDrag(
    event: React.PointerEvent<SVGCircleElement>,
    draft: CombinedScheduleDraft,
    point: SchedulePoint,
  ): void {
    if (addPointMode) return;
    const svg = event.currentTarget.ownerSVGElement;
    if (svg === null) return;
    const coordinate = graphCoordinate(svg, event.clientX, event.clientY);
    dragRef.current = {
      pointerId: event.pointerId,
      channelId: draft.channelId,
      pointId: point.id,
      minuteGrabOffset: point.minuteOfDay - plotXToMinute(coordinate.x),
      percentageGrabOffset: point.percentage - plotYToPercentage(coordinate.y),
      captureElement: event.currentTarget,
    };
    event.currentTarget.setPointerCapture(event.pointerId);
    dispatch({
      type: "select_point",
      channelId: draft.channelId,
      pointId: point.id,
    });
    suppressGraphClickRef.current = false;
    setInteractionError(null);
    event.preventDefault();
  }

  function movePointer(event: React.PointerEvent<SVGSVGElement>): void {
    const coordinate = graphCoordinate(
      event.currentTarget,
      event.clientX,
      event.clientY,
    );
    const drag = dragRef.current;
    if (drag !== null && drag.pointerId === event.pointerId) {
      const point = pointFromDraggedCoordinate(
        coordinate,
        drag.minuteGrabOffset,
        drag.percentageGrabOffset,
      );
      dispatch({
        type: "update_point",
        channelId: drag.channelId,
        pointId: drag.pointId,
        minuteOfDay: point.minuteOfDay,
        percentage: point.percentage,
        currentRevision: expectedRevision,
      });
      suppressGraphClickRef.current = true;
      return;
    }
    if (addPointMode) setAddPointHover(coordinate);
  }

  function finishDrag(event: React.PointerEvent<SVGSVGElement>): void {
    const drag = dragRef.current;
    if (drag === null || drag.pointerId !== event.pointerId) return;
    if (drag.captureElement.hasPointerCapture(event.pointerId)) {
      drag.captureElement.releasePointerCapture(event.pointerId);
    }
    dragRef.current = null;
  }

  function addPoint(minuteOfDay: number, percentage: number): boolean {
    if (selectedDraft === null || selectedChannel === null) return false;
    if (
      selectedDraft.points.some((point) => point.minuteOfDay === minuteOfDay)
    ) {
      setInteractionError(
        `${minuteToTime(minuteOfDay)} already has a schedule point.`,
      );
      return false;
    }
    const point: SchedulePoint = {
      id: createSchedulePointId(),
      position: selectedDraft.points.length,
      minuteOfDay,
      percentage,
      editorX: null,
      editorY: null,
    };
    dispatch({
      type: "add_point",
      channelId: selectedChannel.channel.id,
      point,
      currentRevision: expectedRevision,
    });
    setAddPointMode(false);
    setAddPointHover(null);
    setInteractionError(null);
    return true;
  }

  function addPointFromGraph(event: React.MouseEvent<SVGSVGElement>): void {
    if (suppressGraphClickRef.current) {
      suppressGraphClickRef.current = false;
      return;
    }
    if (!addPointMode || selectedDraft === null || selectedChannel === null) {
      return;
    }
    const coordinate = graphCoordinate(
      event.currentTarget,
      event.clientX,
      event.clientY,
    );
    const minuteOfDay = snapDraggedMinute(plotXToMinute(coordinate.x));
    addPoint(minuteOfDay, Math.round(plotYToPercentage(coordinate.y)));
  }

  if (channels.length === 0) {
    return (
      <section className="combined-schedule-editor combined-schedule-editor-empty">
        <p>No schedules are available for this control area.</p>
      </section>
    );
  }

  return (
    <section
      className="combined-schedule-editor"
      aria-label="Combined UTC schedules"
    >
      <div className="combined-schedule-layout">
        <figure className="combined-schedule-figure">
          <svg
            className={
              addPointMode
                ? "combined-schedule-chart add-mode"
                : "combined-schedule-chart"
            }
            viewBox={`0 0 ${COMBINED_SCHEDULE_VIEW_BOX.width} ${COMBINED_SCHEDULE_VIEW_BOX.height}`}
            role="img"
            aria-label="All channel output percentages across a UTC day"
            onPointerMove={movePointer}
            onPointerUp={finishDrag}
            onPointerCancel={finishDrag}
            onPointerLeave={() => {
              if (dragRef.current === null) setAddPointHover(null);
            }}
            onClick={addPointFromGraph}
          >
            <rect
              className="combined-schedule-chart-background"
              x="0"
              y="0"
              width={COMBINED_SCHEDULE_VIEW_BOX.width}
              height={COMBINED_SCHEDULE_VIEW_BOX.height}
              rx="6"
            />
            {[0, 25, 50, 75, 100].map((percentage) => {
              const y = percentageToPlotY(percentage);
              return (
                <g key={percentage}>
                  <line
                    className={
                      percentage === 0
                        ? "combined-schedule-grid-line axis"
                        : "combined-schedule-grid-line"
                    }
                    x1={COMBINED_SCHEDULE_PLOT.left}
                    x2={COMBINED_SCHEDULE_PLOT.right}
                    y1={y}
                    y2={y}
                  />
                  <text
                    className="combined-schedule-axis-label"
                    x={COMBINED_SCHEDULE_PLOT.left - 11}
                    y={y + 4}
                    textAnchor="end"
                  >
                    {percentage}%
                  </text>
                </g>
              );
            })}
            {Array.from({ length: 25 }, (_, hour) => {
              const x = minuteToPlotX(hour * 60);
              return (
                <g key={hour}>
                  <line
                    className={
                      hour % 3 === 0
                        ? "combined-schedule-grid-line major"
                        : "combined-schedule-grid-line"
                    }
                    x1={x}
                    x2={x}
                    y1={COMBINED_SCHEDULE_PLOT.top}
                    y2={COMBINED_SCHEDULE_PLOT.bottom}
                  />
                  {hour % 3 === 0 ? (
                    <text
                      className="combined-schedule-axis-label"
                      x={x}
                      y={COMBINED_SCHEDULE_PLOT.bottom + 24}
                      textAnchor={
                        hour === 0 ? "start" : hour === 24 ? "end" : "middle"
                      }
                    >
                      {String(hour).padStart(2, "0")}:00
                    </text>
                  ) : null}
                </g>
              );
            })}
            <line
              className="combined-schedule-current-time"
              x1={minuteToPlotX(currentMinute)}
              x2={minuteToPlotX(currentMinute)}
              y1={COMBINED_SCHEDULE_PLOT.top}
              y2={COMBINED_SCHEDULE_PLOT.bottom}
            />
            {addPointMode &&
            addPointHover !== null &&
            selectedChannel !== null ? (
              <line
                className="combined-schedule-add-guide"
                x1={minuteToPlotX(
                  snapDraggedMinute(plotXToMinute(addPointHover.x)),
                )}
                x2={minuteToPlotX(
                  snapDraggedMinute(plotXToMinute(addPointHover.x)),
                )}
                y1={COMBINED_SCHEDULE_PLOT.top}
                y2={COMBINED_SCHEDULE_PLOT.bottom}
                stroke={selectedChannel.color}
                pointerEvents="none"
              />
            ) : null}
            {orderedChannels(channels, state.selectedChannelId).map(
              ({ channel, color }) => {
                const draft = state.drafts[channel.id];
                if (draft === undefined) return null;
                const channelSelected = channel.id === state.selectedChannelId;
                const points = cyclicPlotPoints(draft.points)
                  .map(
                    (point) =>
                      `${minuteToPlotX(point.minuteOfDay)},${percentageToPlotY(point.percentage)}`,
                  )
                  .join(" ");
                return (
                  <g
                    className={
                      channelSelected
                        ? "combined-schedule-channel selected"
                        : "combined-schedule-channel"
                    }
                    key={channel.id}
                  >
                    <polyline
                      className="combined-schedule-line"
                      points={points}
                      fill="none"
                      stroke={color}
                      pointerEvents="none"
                    />
                    {draft.points.map((point) => {
                      const pointSelected =
                        channelSelected &&
                        point.id === state.selectedPointIds[channel.id];
                      return (
                        <circle
                          className={
                            pointSelected
                              ? "combined-schedule-point selected"
                              : "combined-schedule-point"
                          }
                          key={point.id}
                          cx={minuteToPlotX(point.minuteOfDay)}
                          cy={percentageToPlotY(point.percentage)}
                          r={pointSelected ? 11 : channelSelected ? 7.5 : 3.5}
                          fill={color}
                          stroke="none"
                          opacity={channelSelected ? 1 : 0.76}
                          pointerEvents={
                            channelSelected && !addPointMode ? "all" : "none"
                          }
                          onPointerDown={(event) =>
                            beginDrag(event, draft, point)
                          }
                          onClick={(event) => {
                            suppressGraphClickRef.current = false;
                            event.stopPropagation();
                          }}
                        />
                      );
                    })}
                  </g>
                );
              },
            )}
          </svg>
          <figcaption className="visually-hidden">
            Select a channel from the adjacent list to edit its schedule.
          </figcaption>
        </figure>

        <ul
          className="combined-schedule-channel-list"
          aria-label="Schedule channels"
        >
          {channels.map(({ channel, color }) => {
            const draft = state.drafts[channel.id];
            const selected = channel.id === state.selectedChannelId;
            return (
              <li className="combined-schedule-channel-item" key={channel.id}>
                <button
                  className={
                    selected
                      ? "combined-schedule-channel-button selected"
                      : "combined-schedule-channel-button"
                  }
                  type="button"
                  aria-pressed={selected}
                  onClick={() => selectChannel(channel.id)}
                >
                  <span
                    className="combined-schedule-channel-swatch"
                    style={{ backgroundColor: color }}
                    aria-hidden="true"
                  />
                  <span className="combined-schedule-channel-name">
                    {channel.name}
                  </span>
                  <span className="combined-schedule-channel-value">
                    {draft === undefined
                      ? "—"
                      : `${Math.round(scheduleValueAt(draft.points, currentMinute))}%`}
                  </span>
                  {draft !== undefined &&
                  isCombinedScheduleDraftDirty(draft) ? (
                    <span
                      className="combined-schedule-unsaved"
                      aria-label="Unsaved changes"
                    >
                      Unsaved
                    </span>
                  ) : null}
                </button>
              </li>
            );
          })}
        </ul>
      </div>

      {selectedChannel === null || selectedDraft === null ? null : (
        <div className="combined-schedule-point-editor">
          <div className="combined-schedule-point-editor-heading">
            <h2>{selectedChannel.channel.name}</h2>
            <div className="combined-schedule-point-actions">
              <button
                className="secondary-button"
                type="button"
                aria-pressed={addPointMode}
                onClick={() => {
                  setAddPointMode((active) => !active);
                  setAddPointHover(null);
                  setInteractionError(null);
                }}
              >
                {addPointMode ? "Click graph…" : "New point"}
              </button>
              <button
                className="text-button danger-text"
                type="button"
                disabled={
                  selectedPoint === null || selectedDraft.points.length <= 2
                }
                onClick={() => {
                  if (selectedPoint === null) return;
                  dispatch({
                    type: "remove_point",
                    channelId: selectedDraft.channelId,
                    pointId: selectedPoint.id,
                    currentRevision: expectedRevision,
                  });
                  setInteractionError(null);
                }}
              >
                Delete selected point
              </button>
            </div>
          </div>

          <div
            className="combined-schedule-point-list"
            aria-label={`${selectedChannel.channel.name} schedule points`}
          >
            {selectedDraft.points.map((point) => (
              <button
                className={
                  point.id === selectedPoint?.id
                    ? "combined-schedule-point-button selected"
                    : "combined-schedule-point-button"
                }
                key={point.id}
                type="button"
                aria-pressed={point.id === selectedPoint?.id}
                onClick={() =>
                  dispatch({
                    type: "select_point",
                    channelId: selectedDraft.channelId,
                    pointId: point.id,
                  })
                }
              >
                {minuteToTime(point.minuteOfDay)} · {point.percentage}%
              </button>
            ))}
          </div>

          {addPointMode ? (
            <NewPointForm
              key={selectedDraft.channelId}
              channelName={selectedChannel.channel.name}
              initialMinuteOfDay={currentMinute}
              initialPercentage={Math.round(
                scheduleValueAt(selectedDraft.points, currentMinute),
              )}
              onCommit={addPoint}
            />
          ) : null}

          {addPointMode || selectedPoint === null ? null : (
            <SelectedPointForm
              key={`${selectedPoint.id}:${selectedPoint.minuteOfDay}:${selectedPoint.percentage}`}
              channelName={selectedChannel.channel.name}
              point={selectedPoint}
              onCommit={(minuteOfDay, percentage) => {
                dispatch({
                  type: "update_point",
                  channelId: selectedDraft.channelId,
                  pointId: selectedPoint.id,
                  minuteOfDay,
                  percentage,
                  currentRevision: expectedRevision,
                });
                setInteractionError(null);
              }}
            />
          )}

          {addPointMode ? (
            <p className="combined-schedule-editor-message" role="status">
              Click the chart or enter an exact UTC time to add the new point.
            </p>
          ) : null}
          {interactionError === null ? null : (
            <p className="field-error" role="alert">
              {interactionError}
            </p>
          )}
          {validation?.valid === false ? (
            <ul
              className="validation-list"
              aria-label="Schedule validation errors"
            >
              {validation.issues.map((issue) => (
                <li key={issue}>{issue}</li>
              ))}
            </ul>
          ) : null}
          {selectedDraft.conflictRevision === null ? null : (
            <div className="conflict-banner" role="alert">
              <span>
                This schedule changed at controller revision{" "}
                {selectedDraft.conflictRevision}. The local draft was preserved.
              </span>
              <button
                className="text-button"
                type="button"
                disabled={expectedRevision < selectedDraft.conflictRevision}
                onClick={() => {
                  dispatch({
                    type: "accept_conflict",
                    channelId: selectedDraft.channelId,
                    currentRevision: expectedRevision,
                  });
                  onAcceptRevisionConflict?.();
                }}
              >
                Keep local draft with refreshed revision
              </button>
            </div>
          )}
        </div>
      )}
    </section>
  );
});

interface DragState {
  readonly pointerId: number;
  readonly channelId: string;
  readonly pointId: string;
  readonly minuteGrabOffset: number;
  readonly percentageGrabOffset: number;
  readonly captureElement: SVGCircleElement;
}

interface SelectedPointFormProps {
  readonly channelName: string;
  readonly point: SchedulePoint;
  readonly onCommit: (minuteOfDay: number, percentage: number) => void;
}

interface NewPointFormProps {
  readonly channelName: string;
  readonly initialMinuteOfDay: number;
  readonly initialPercentage: number;
  readonly onCommit: (minuteOfDay: number, percentage: number) => boolean;
}

function NewPointForm({
  channelName,
  initialMinuteOfDay,
  initialPercentage,
  onCommit,
}: NewPointFormProps): React.JSX.Element {
  const [time, setTime] = useState(minuteToTime(initialMinuteOfDay));
  const [percentage, setPercentage] = useState(String(initialPercentage));
  const [error, setError] = useState<string | null>(null);

  function commit(event: React.FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const minuteOfDay = timeToMinute(time);
    const parsedPercentage = Number(percentage);
    if (minuteOfDay === null || !Number.isFinite(parsedPercentage)) {
      setError("Enter a complete UTC time and numeric percentage.");
      return;
    }
    if (parsedPercentage < 0 || parsedPercentage > 100) {
      setError("Output percentage must be between 0 and 100.");
      return;
    }
    if (onCommit(minuteOfDay, parsedPercentage)) setError(null);
  }

  return (
    <form className="combined-schedule-selected-point-form" onSubmit={commit}>
      <label>
        New point UTC time
        <input
          aria-label={`${channelName} new point UTC time`}
          type="time"
          step="60"
          value={time}
          onChange={(event) => setTime(event.currentTarget.value)}
          required
        />
      </label>
      <label>
        New point output
        <span className="percentage-input">
          <input
            aria-label={`${channelName} new point output`}
            type="number"
            min="0"
            max="100"
            step="0.1"
            value={percentage}
            onChange={(event) => setPercentage(event.currentTarget.value)}
            required
          />
          <span aria-hidden="true">%</span>
        </span>
      </label>
      <button className="secondary-button" type="submit">
        Add point
      </button>
      {error === null ? null : (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}

function SelectedPointForm({
  channelName,
  point,
  onCommit,
}: SelectedPointFormProps): React.JSX.Element {
  const [time, setTime] = useState(minuteToTime(point.minuteOfDay));
  const [percentage, setPercentage] = useState(String(point.percentage));
  const [error, setError] = useState<string | null>(null);

  function commit(event: React.FormEvent<HTMLFormElement>): void {
    event.preventDefault();
    const minuteOfDay = timeToMinute(time);
    const parsedPercentage = Number(percentage);
    if (minuteOfDay === null || !Number.isFinite(parsedPercentage)) {
      setError("Enter a complete UTC time and numeric percentage.");
      return;
    }
    if (parsedPercentage < 0 || parsedPercentage > 100) {
      setError("Output percentage must be between 0 and 100.");
      return;
    }
    onCommit(minuteOfDay, parsedPercentage);
    setError(null);
  }

  return (
    <form className="combined-schedule-selected-point-form" onSubmit={commit}>
      <label>
        UTC time
        <input
          aria-label={`${channelName} selected point UTC time`}
          type="time"
          step="60"
          value={time}
          onChange={(event) => setTime(event.currentTarget.value)}
          required
        />
      </label>
      <label>
        Output
        <span className="percentage-input">
          <input
            aria-label={`${channelName} selected point output`}
            type="number"
            min="0"
            max="100"
            step="0.1"
            value={percentage}
            onChange={(event) => setPercentage(event.currentTarget.value)}
            required
          />
          <span aria-hidden="true">%</span>
        </span>
      </label>
      <button className="secondary-button" type="submit">
        Apply point
      </button>
      {error === null ? null : (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
    </form>
  );
}

function orderedChannels(
  channels: readonly CombinedScheduleChannel[],
  selectedChannelId: string | null,
): readonly CombinedScheduleChannel[] {
  return [
    ...channels.filter(({ channel }) => channel.id !== selectedChannelId),
    ...channels.filter(({ channel }) => channel.id === selectedChannelId),
  ];
}

function useUtcMinute(suppliedMinute: number | undefined): number {
  const [minute, setMinute] = useState(() => currentUtcMinute());
  useEffect(() => {
    if (suppliedMinute !== undefined) return;
    const timer = window.setInterval(
      () => setMinute(currentUtcMinute()),
      30_000,
    );
    return () => window.clearInterval(timer);
  }, [suppliedMinute]);
  return suppliedMinute ?? minute;
}

function currentUtcMinute(): number {
  const now = new Date();
  return now.getUTCHours() * 60 + now.getUTCMinutes();
}

function draftPointMapsEqual(
  left: CombinedScheduleDraftPoints | null,
  right: CombinedScheduleDraftPoints,
): boolean {
  if (left === null) return false;
  const leftEntries = Object.entries(left);
  const rightEntries = Object.entries(right);
  return (
    leftEntries.length === rightEntries.length &&
    leftEntries.every(([channelId, leftPoints]) => {
      const rightPoints = right[channelId];
      return (
        rightPoints !== undefined &&
        leftPoints.length === rightPoints.length &&
        leftPoints.every((point, index) => {
          const rightPoint = rightPoints[index];
          return (
            rightPoint !== undefined &&
            point.id === rightPoint.id &&
            point.position === rightPoint.position &&
            point.minuteOfDay === rightPoint.minuteOfDay &&
            point.percentage === rightPoint.percentage &&
            point.editorX === rightPoint.editorX &&
            point.editorY === rightPoint.editorY
          );
        })
      );
    })
  );
}
