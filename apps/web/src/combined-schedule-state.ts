import {
  replaceScheduleRequestSchema,
  type ReplaceScheduleRequest,
  type ScheduleGraph,
  type SchedulePoint,
} from "@aquarium/contracts";

export const COMBINED_SCHEDULE_VIEW_BOX = {
  width: 1_000,
  height: 360,
} as const;

export const COMBINED_SCHEDULE_PLOT = {
  left: 60,
  right: 975,
  top: 20,
  bottom: 320,
} as const;

export interface CombinedScheduleSource {
  readonly channelId: string;
  readonly schedule: ScheduleGraph;
}

export interface CombinedScheduleDraft {
  readonly channelId: string;
  readonly scheduleId: string;
  readonly graphRevision: number;
  readonly baselinePoints: readonly SchedulePoint[];
  readonly points: readonly SchedulePoint[];
  readonly hiddenBoundaryPoints: readonly SchedulePoint[];
  readonly pinnedRevision: number | null;
  readonly conflictRevision: number | null;
}

export interface CombinedScheduleState {
  readonly selectedChannelId: string | null;
  readonly selectedPointIds: Readonly<Record<string, string | null>>;
  readonly drafts: Readonly<Record<string, CombinedScheduleDraft>>;
}

export type CombinedScheduleAction =
  | {
      readonly type: "select_channel";
      readonly channelId: string;
    }
  | {
      readonly type: "select_point";
      readonly channelId: string;
      readonly pointId: string;
    }
  | {
      readonly type: "add_point";
      readonly channelId: string;
      readonly point: SchedulePoint;
      readonly currentRevision: number;
    }
  | {
      readonly type: "update_point";
      readonly channelId: string;
      readonly pointId: string;
      readonly minuteOfDay: number;
      readonly percentage: number;
      readonly currentRevision: number;
    }
  | {
      readonly type: "remove_point";
      readonly channelId: string;
      readonly pointId: string;
      readonly currentRevision: number;
    }
  | {
      readonly type: "discard_all";
    }
  | {
      readonly type: "saved";
      readonly channelId: string;
      readonly savedPoints: readonly SchedulePoint[];
      readonly savedRevision: number;
    }
  | {
      readonly type: "accept_conflict";
      readonly channelId: string;
      readonly currentRevision: number;
    }
  | {
      readonly type: "revision_conflict";
      readonly channelId: string;
      readonly currentRevision: number;
    }
  | {
      readonly type: "snapshot";
      readonly sources: readonly CombinedScheduleSource[];
      readonly currentRevision: number;
    };

export interface ScheduleDraftValidation {
  readonly valid: boolean;
  readonly issues: readonly string[];
}

export interface PlotCoordinate {
  readonly x: number;
  readonly y: number;
}

export interface ClientRectangle {
  readonly left: number;
  readonly top: number;
  readonly width: number;
  readonly height: number;
}

export function createCombinedScheduleState(
  sources: readonly CombinedScheduleSource[],
): CombinedScheduleState {
  const drafts: Record<string, CombinedScheduleDraft> = {};
  const selectedPointIds: Record<string, string | null> = {};
  for (const source of sources) {
    const draft = createCombinedScheduleDraft(source);
    drafts[source.channelId] = draft;
    selectedPointIds[source.channelId] = preferredPointId(draft.points);
  }
  return {
    selectedChannelId: sources[0]?.channelId ?? null,
    selectedPointIds,
    drafts,
  };
}

export function combinedScheduleReducer(
  state: CombinedScheduleState,
  action: CombinedScheduleAction,
): CombinedScheduleState {
  switch (action.type) {
    case "select_channel":
      return state.drafts[action.channelId] === undefined
        ? state
        : { ...state, selectedChannelId: action.channelId };
    case "select_point":
      return updateSelectedPoint(state, action.channelId, action.pointId);
    case "add_point": {
      const draft = state.drafts[action.channelId];
      if (draft === undefined) return state;
      const nextDraft = editDraft(
        draft,
        normalizeLogicalPoints([...draft.points, action.point]),
        action.currentRevision,
      );
      return {
        ...state,
        drafts: { ...state.drafts, [action.channelId]: nextDraft },
        selectedPointIds: {
          ...state.selectedPointIds,
          [action.channelId]: action.point.id,
        },
      };
    }
    case "update_point": {
      const draft = state.drafts[action.channelId];
      if (draft === undefined) return state;
      const points = normalizeLogicalPoints(
        draft.points.map((point) =>
          point.id === action.pointId
            ? {
                ...point,
                minuteOfDay: action.minuteOfDay,
                percentage: action.percentage,
                editorX: null,
                editorY: null,
              }
            : point,
        ),
      );
      return {
        ...state,
        drafts: {
          ...state.drafts,
          [action.channelId]: editDraft(draft, points, action.currentRevision),
        },
      };
    }
    case "remove_point": {
      const draft = state.drafts[action.channelId];
      if (draft === undefined || draft.points.length <= 2) return state;
      const points = normalizeLogicalPoints(
        draft.points.filter((point) => point.id !== action.pointId),
      );
      const selectedPointId =
        state.selectedPointIds[action.channelId] === action.pointId
          ? preferredPointId(points)
          : (state.selectedPointIds[action.channelId] ?? null);
      return {
        ...state,
        drafts: {
          ...state.drafts,
          [action.channelId]: editDraft(draft, points, action.currentRevision),
        },
        selectedPointIds: {
          ...state.selectedPointIds,
          [action.channelId]: selectedPointId,
        },
      };
    }
    case "discard_all": {
      const drafts: Record<string, CombinedScheduleDraft> = {};
      const selectedPointIds: Record<string, string | null> = {
        ...state.selectedPointIds,
      };
      for (const draft of Object.values(state.drafts)) {
        const discarded = {
          ...draft,
          points: draft.baselinePoints,
          pinnedRevision: null,
          conflictRevision: null,
        };
        drafts[draft.channelId] = discarded;
        if (
          !discarded.points.some(
            (point) => point.id === selectedPointIds[discarded.channelId],
          )
        ) {
          selectedPointIds[discarded.channelId] = preferredPointId(
            discarded.points,
          );
        }
      }
      return { ...state, drafts, selectedPointIds };
    }
    case "saved": {
      const draft = state.drafts[action.channelId];
      if (draft === undefined) return state;
      const savedPoints = normalizeLogicalPoints(action.savedPoints);
      const hasNewerEdits = !schedulePointsEqual(draft.points, savedPoints);
      return {
        ...state,
        drafts: {
          ...state.drafts,
          [action.channelId]: {
            ...draft,
            baselinePoints: savedPoints,
            pinnedRevision: hasNewerEdits ? action.savedRevision : null,
            conflictRevision: null,
          },
        },
      };
    }
    case "accept_conflict": {
      const draft = state.drafts[action.channelId];
      if (draft === undefined) return state;
      const drafts = Object.fromEntries(
        Object.entries(state.drafts).map(([channelId, candidate]) => [
          channelId,
          isCombinedScheduleDraftDirty(candidate)
            ? {
                ...candidate,
                pinnedRevision: action.currentRevision,
                conflictRevision: null,
              }
            : candidate,
        ]),
      );
      return {
        ...state,
        drafts,
      };
    }
    case "revision_conflict": {
      const draft = state.drafts[action.channelId];
      if (draft === undefined) return state;
      return {
        ...state,
        selectedChannelId: action.channelId,
        drafts: {
          ...state.drafts,
          [action.channelId]: {
            ...draft,
            conflictRevision: action.currentRevision,
          },
        },
      };
    }
    case "snapshot":
      return synchronizeCombinedScheduleState(
        state,
        action.sources,
        action.currentRevision,
      );
  }
}

export function isCombinedScheduleDraftDirty(
  draft: CombinedScheduleDraft,
): boolean {
  return !schedulePointsEqual(draft.points, draft.baselinePoints);
}

export function isCombinedScheduleStateDirty(
  state: CombinedScheduleState,
): boolean {
  return Object.values(state.drafts).some(isCombinedScheduleDraftDirty);
}

export function validateCombinedScheduleDraft(
  draft: CombinedScheduleDraft,
): ScheduleDraftValidation {
  const issues: string[] = [];
  if (draft.points.length < 2) {
    issues.push("A schedule requires at least two points.");
  }
  const identifiers = new Set<string>();
  const minutes = new Set<number>();
  for (const point of draft.points) {
    if (identifiers.has(point.id)) {
      issues.push(`Point identifier ${point.id} is duplicated.`);
    }
    if (minutes.has(point.minuteOfDay)) {
      issues.push("Two schedule points have the same time.");
    }
    if (
      !Number.isInteger(point.minuteOfDay) ||
      point.minuteOfDay < 0 ||
      point.minuteOfDay > 1_439
    ) {
      issues.push("A schedule point has an invalid time.");
    }
    if (
      !Number.isFinite(point.percentage) ||
      point.percentage < 0 ||
      point.percentage > 100
    ) {
      issues.push(`A schedule point has an invalid percentage.`);
    }
    identifiers.add(point.id);
    minutes.add(point.minuteOfDay);
  }
  return { valid: issues.length === 0, issues };
}

export function toCombinedReplaceScheduleRequest(
  draft: CombinedScheduleDraft,
  expectedRevision: number,
): ReplaceScheduleRequest {
  const validation = validateCombinedScheduleDraft(draft);
  if (!validation.valid) {
    throw new Error(validation.issues.join(" "));
  }
  return replaceScheduleRequestSchema.parse({
    expectedRevision,
    points: canonicalSchedulePoints(draft),
  });
}

export function isHiddenWrapBoundaryPoint(
  scheduleId: string,
  point: SchedulePoint,
): boolean {
  return point.id.startsWith(wrapBoundaryPrefix(scheduleId));
}

export function wrapBoundaryPrefix(scheduleId: string): string {
  return `wrap-boundary-${scheduleId}-`;
}

export function scheduleValueAt(
  points: readonly SchedulePoint[],
  minuteOfDay: number,
): number {
  const ordered = normalizeLogicalPoints(points);
  if (ordered.length === 0) return 0;
  if (ordered.length === 1) return ordered[0]?.percentage ?? 0;

  const normalizedMinute =
    minuteOfDay === 1_440 ? 1_440 : ((minuteOfDay % 1_440) + 1_440) % 1_440;
  if (normalizedMinute < 1_440) {
    const exact = ordered.find(
      (point) => point.minuteOfDay === normalizedMinute,
    );
    if (exact !== undefined) return exact.percentage;
    for (let index = 1; index < ordered.length; index += 1) {
      const right = ordered[index];
      const left = ordered[index - 1];
      if (
        left !== undefined &&
        right !== undefined &&
        normalizedMinute > left.minuteOfDay &&
        normalizedMinute < right.minuteOfDay
      ) {
        return interpolate(
          left.minuteOfDay,
          left.percentage,
          right.minuteOfDay,
          right.percentage,
          normalizedMinute,
        );
      }
    }
  }

  const first = ordered[0];
  const last = ordered[ordered.length - 1];
  if (first === undefined || last === undefined) return 0;
  const targetMinute =
    normalizedMinute < first.minuteOfDay
      ? normalizedMinute + 1_440
      : normalizedMinute;
  return interpolate(
    last.minuteOfDay,
    last.percentage,
    first.minuteOfDay + 1_440,
    first.percentage,
    targetMinute,
  );
}

export function cyclicPlotPoints(
  points: readonly SchedulePoint[],
): readonly SchedulePoint[] {
  const ordered = normalizeLogicalPoints(points);
  if (ordered.length === 0) return [];
  const first = ordered[0];
  const result: SchedulePoint[] = [];
  if (first !== undefined && first.minuteOfDay !== 0) {
    result.push(
      virtualPoint("plot-wrap-start", 0, scheduleValueAt(ordered, 0)),
    );
  }
  result.push(...ordered);
  result.push(
    virtualPoint("plot-wrap-end", 1_440, scheduleValueAt(ordered, 1_440)),
  );
  return result;
}

export function minuteToPlotX(minuteOfDay: number): number {
  const ratio = clamp(minuteOfDay, 0, 1_440) / 1_440;
  return (
    COMBINED_SCHEDULE_PLOT.left +
    ratio * (COMBINED_SCHEDULE_PLOT.right - COMBINED_SCHEDULE_PLOT.left)
  );
}

export function plotXToMinute(x: number): number {
  const ratio =
    (x - COMBINED_SCHEDULE_PLOT.left) /
    (COMBINED_SCHEDULE_PLOT.right - COMBINED_SCHEDULE_PLOT.left);
  return clamp(ratio, 0, 1) * 1_440;
}

export function percentageToPlotY(percentage: number): number {
  const ratio = (100 - clamp(percentage, 0, 100)) / 100;
  return (
    COMBINED_SCHEDULE_PLOT.top +
    ratio * (COMBINED_SCHEDULE_PLOT.bottom - COMBINED_SCHEDULE_PLOT.top)
  );
}

export function plotYToPercentage(y: number): number {
  const ratio =
    (y - COMBINED_SCHEDULE_PLOT.top) /
    (COMBINED_SCHEDULE_PLOT.bottom - COMBINED_SCHEDULE_PLOT.top);
  return clamp(100 - ratio * 100, 0, 100);
}

export function snapDraggedMinute(minuteOfDay: number): number {
  return clamp(Math.round(minuteOfDay / 5) * 5, 0, 1_439);
}

export function clientToViewBoxCoordinate(
  rectangle: ClientRectangle,
  clientX: number,
  clientY: number,
): PlotCoordinate {
  if (rectangle.width <= 0 || rectangle.height <= 0) {
    return { x: 0, y: 0 };
  }
  const scale = Math.min(
    rectangle.width / COMBINED_SCHEDULE_VIEW_BOX.width,
    rectangle.height / COMBINED_SCHEDULE_VIEW_BOX.height,
  );
  const renderedWidth = COMBINED_SCHEDULE_VIEW_BOX.width * scale;
  const renderedHeight = COMBINED_SCHEDULE_VIEW_BOX.height * scale;
  const offsetX = (rectangle.width - renderedWidth) / 2;
  const offsetY = (rectangle.height - renderedHeight) / 2;
  return {
    x: (clientX - rectangle.left - offsetX) / scale,
    y: (clientY - rectangle.top - offsetY) / scale,
  };
}

export function pointFromDraggedCoordinate(
  coordinate: PlotCoordinate,
  minuteGrabOffset: number,
  percentageGrabOffset: number,
): { readonly minuteOfDay: number; readonly percentage: number } {
  return {
    minuteOfDay: snapDraggedMinute(
      plotXToMinute(coordinate.x) + minuteGrabOffset,
    ),
    percentage: Math.round(
      clamp(plotYToPercentage(coordinate.y) + percentageGrabOffset, 0, 100),
    ),
  };
}

export function minuteToTime(minuteOfDay: number): string {
  const hours = Math.floor(clamp(minuteOfDay, 0, 1_439) / 60);
  const minutes = clamp(minuteOfDay, 0, 1_439) % 60;
  return `${String(hours).padStart(2, "0")}:${String(minutes).padStart(2, "0")}`;
}

export function timeToMinute(value: string): number | null {
  const match = /^(?<hour>[0-2][0-9]):(?<minute>[0-5][0-9])$/u.exec(value);
  if (match?.groups === undefined) return null;
  const hour = Number(match.groups.hour);
  const minute = Number(match.groups.minute);
  if (hour > 23) return null;
  return hour * 60 + minute;
}

export function createSchedulePointId(): string {
  return `point-${crypto.randomUUID()}`;
}

function createCombinedScheduleDraft(
  source: CombinedScheduleSource,
): CombinedScheduleDraft {
  const points = normalizeLogicalPoints(
    source.schedule.points.filter(
      (point) => !isHiddenWrapBoundaryPoint(source.schedule.id, point),
    ),
  );
  return {
    channelId: source.channelId,
    scheduleId: source.schedule.id,
    graphRevision: source.schedule.graphRevision,
    baselinePoints: points,
    points,
    hiddenBoundaryPoints: source.schedule.points.filter((point) =>
      isHiddenWrapBoundaryPoint(source.schedule.id, point),
    ),
    pinnedRevision: null,
    conflictRevision: null,
  };
}

function synchronizeCombinedScheduleState(
  state: CombinedScheduleState,
  sources: readonly CombinedScheduleSource[],
  currentRevision: number,
): CombinedScheduleState {
  const drafts: Record<string, CombinedScheduleDraft> = {};
  const selectedPointIds: Record<string, string | null> = {};
  for (const source of sources) {
    const existing = state.drafts[source.channelId];
    const incoming = createCombinedScheduleDraft(source);
    let draft = incoming;
    if (existing !== undefined && existing.scheduleId === incoming.scheduleId) {
      if (existing.graphRevision === incoming.graphRevision) {
        draft = isCombinedScheduleDraftDirty(existing)
          ? { ...existing, pinnedRevision: currentRevision }
          : existing;
      } else if (
        !isCombinedScheduleDraftDirty(existing) ||
        schedulePointsEqual(incoming.points, existing.points)
      ) {
        draft = incoming;
      } else if (
        schedulePointsEqual(incoming.points, existing.baselinePoints)
      ) {
        draft = {
          ...existing,
          graphRevision: incoming.graphRevision,
          baselinePoints: incoming.points,
          hiddenBoundaryPoints: incoming.hiddenBoundaryPoints,
          conflictRevision: null,
        };
      } else {
        draft = { ...existing, conflictRevision: currentRevision };
      }
    }
    drafts[source.channelId] = draft;
    const existingSelection = state.selectedPointIds[source.channelId];
    selectedPointIds[source.channelId] =
      existingSelection !== undefined &&
      draft.points.some((point) => point.id === existingSelection)
        ? existingSelection
        : preferredPointId(draft.points);
  }
  const selectedChannelId =
    state.selectedChannelId !== null &&
    drafts[state.selectedChannelId] !== undefined
      ? state.selectedChannelId
      : (sources[0]?.channelId ?? null);
  return { selectedChannelId, selectedPointIds, drafts };
}

function updateSelectedPoint(
  state: CombinedScheduleState,
  channelId: string,
  pointId: string,
): CombinedScheduleState {
  const draft = state.drafts[channelId];
  if (
    draft === undefined ||
    !draft.points.some((point) => point.id === pointId)
  ) {
    return state;
  }
  return {
    ...state,
    selectedPointIds: {
      ...state.selectedPointIds,
      [channelId]: pointId,
    },
  };
}

function editDraft(
  draft: CombinedScheduleDraft,
  points: readonly SchedulePoint[],
  currentRevision: number,
): CombinedScheduleDraft {
  return {
    ...draft,
    points,
    pinnedRevision: draft.pinnedRevision ?? currentRevision,
  };
}

function canonicalSchedulePoints(
  draft: CombinedScheduleDraft,
): readonly SchedulePoint[] {
  const logical = normalizeLogicalPoints(draft.points);
  const start = logical.find((point) => point.minuteOfDay === 0);
  const end = logical.find((point) => point.minuteOfDay === 1_439);
  const boundaryPercentage =
    start?.percentage ?? end?.percentage ?? scheduleValueAt(logical, 0);
  const canonical = logical.map((point) =>
    point.minuteOfDay === 0 || point.minuteOfDay === 1_439
      ? { ...point, percentage: boundaryPercentage }
      : point,
  );
  if (start === undefined) {
    canonical.push(boundaryPoint(draft, 0, boundaryPercentage, "start"));
  }
  if (end === undefined) {
    canonical.push(boundaryPoint(draft, 1_439, boundaryPercentage, "end"));
  }
  return normalizeLogicalPoints(canonical);
}

function boundaryPoint(
  draft: CombinedScheduleDraft,
  minuteOfDay: 0 | 1_439,
  percentage: number,
  edge: "start" | "end",
): SchedulePoint {
  const existing = draft.hiddenBoundaryPoints.find(
    (point) => point.minuteOfDay === minuteOfDay,
  );
  return {
    id: existing?.id ?? wrapBoundaryIdentifier(draft.scheduleId, edge),
    position: 0,
    minuteOfDay,
    percentage,
    editorX: null,
    editorY: null,
  };
}

function wrapBoundaryIdentifier(
  scheduleId: string,
  edge: "start" | "end",
): string {
  const id = `${wrapBoundaryPrefix(scheduleId)}${edge}`;
  if (id.length > 128) {
    throw new Error(
      `Schedule identifier ${scheduleId} is too long for a wrap-boundary point identifier.`,
    );
  }
  return id;
}

function virtualPoint(
  id: string,
  minuteOfDay: number,
  percentage: number,
): SchedulePoint {
  return {
    id,
    position: 0,
    minuteOfDay,
    percentage,
    editorX: null,
    editorY: null,
  };
}

function normalizeLogicalPoints(
  points: readonly SchedulePoint[],
): SchedulePoint[] {
  return [...points]
    .sort(
      (left, right) =>
        left.minuteOfDay - right.minuteOfDay ||
        compareIdentifiers(left.id, right.id),
    )
    .map((point, position) => ({ ...point, position }));
}

function schedulePointsEqual(
  left: readonly SchedulePoint[],
  right: readonly SchedulePoint[],
): boolean {
  return (
    left.length === right.length &&
    left.every((point, index) => {
      const candidate = right[index];
      return (
        candidate !== undefined &&
        point.id === candidate.id &&
        point.position === candidate.position &&
        point.minuteOfDay === candidate.minuteOfDay &&
        point.percentage === candidate.percentage &&
        point.editorX === candidate.editorX &&
        point.editorY === candidate.editorY
      );
    })
  );
}

function preferredPointId(points: readonly SchedulePoint[]): string | null {
  return points[0]?.id ?? null;
}

function interpolate(
  leftMinute: number,
  leftPercentage: number,
  rightMinute: number,
  rightPercentage: number,
  minute: number,
): number {
  const duration = rightMinute - leftMinute;
  if (duration === 0) return leftPercentage;
  const progress = (minute - leftMinute) / duration;
  return leftPercentage + (rightPercentage - leftPercentage) * progress;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function compareIdentifiers(left: string, right: string): number {
  return left === right ? 0 : left < right ? -1 : 1;
}
