import {
  replaceScheduleRequestSchema,
  type ReplaceScheduleRequest,
  type ScheduleGraph,
  type SchedulePoint,
} from "@aquarium/contracts";
import {
  scheduleGraphFromPoints,
  validateScheduleGraph,
} from "@aquarium/domain";

export interface ScheduleEditorState {
  readonly scheduleId: string;
  readonly channelId: string;
  readonly graphRevision: number;
  readonly baselinePoints: readonly SchedulePoint[];
  readonly points: readonly SchedulePoint[];
  readonly conflictRevision: number | null;
}

export type ScheduleEditorAction =
  | { readonly type: "add"; readonly point: SchedulePoint }
  | {
      readonly type: "update";
      readonly pointId: string;
      readonly minuteOfDay: number;
      readonly percentage: number;
    }
  | { readonly type: "remove"; readonly pointId: string }
  | { readonly type: "discard" }
  | { readonly type: "saved" }
  | { readonly type: "accept_conflict" }
  | { readonly type: "revision_conflict"; readonly currentRevision: number }
  | {
      readonly type: "snapshot";
      readonly schedule: ScheduleGraph;
      readonly currentRevision: number;
      readonly draftInProgress?: boolean;
    };

export interface ScheduleDraftValidation {
  readonly valid: boolean;
  readonly issues: readonly string[];
}

export function createScheduleEditorState(
  schedule: ScheduleGraph,
): ScheduleEditorState {
  const points = normalizePoints(schedule.points);
  return {
    scheduleId: schedule.id,
    channelId: schedule.channelId,
    graphRevision: schedule.graphRevision,
    baselinePoints: points,
    points,
    conflictRevision: null,
  };
}

export function scheduleEditorReducer(
  state: ScheduleEditorState,
  action: ScheduleEditorAction,
): ScheduleEditorState {
  switch (action.type) {
    case "add":
      return {
        ...state,
        points: normalizePoints([...state.points, action.point]),
      };
    case "update":
      return {
        ...state,
        points: normalizePoints(
          state.points.map((point) =>
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
        ),
      };
    case "remove":
      return {
        ...state,
        points: normalizePoints(
          state.points.filter((point) => point.id !== action.pointId),
        ),
      };
    case "discard":
      return {
        ...state,
        points: state.baselinePoints,
        conflictRevision: null,
      };
    case "saved":
      return {
        ...state,
        baselinePoints: state.points,
        conflictRevision: null,
      };
    case "accept_conflict":
      return { ...state, conflictRevision: null };
    case "revision_conflict":
      return { ...state, conflictRevision: action.currentRevision };
    case "snapshot": {
      if (
        action.schedule.id !== state.scheduleId ||
        action.schedule.channelId !== state.channelId
      ) {
        return createScheduleEditorState(action.schedule);
      }
      if (action.schedule.graphRevision === state.graphRevision) {
        return state;
      }
      const incoming = normalizePoints(action.schedule.points);
      if (
        (!isScheduleDraftDirty(state) && !action.draftInProgress) ||
        schedulePointsEqual(incoming, state.points)
      ) {
        return createScheduleEditorState(action.schedule);
      }
      return {
        ...state,
        conflictRevision: action.currentRevision,
      };
    }
  }
}

export function isScheduleDraftDirty(state: ScheduleEditorState): boolean {
  return !schedulePointsEqual(state.points, state.baselinePoints);
}

export function validateScheduleDraft(
  state: ScheduleEditorState,
): ScheduleDraftValidation {
  const issues: string[] = [];
  if (state.points.length < 2) {
    issues.push("A schedule requires at least two points.");
  }
  const identifiers = new Set<string>();
  const minutes = new Set<number>();
  for (const point of state.points) {
    if (identifiers.has(point.id)) {
      issues.push(`Point identifier ${point.id} is duplicated.`);
    }
    if (minutes.has(point.minuteOfDay)) {
      issues.push(`UTC minute ${point.minuteOfDay} is duplicated.`);
    }
    if (
      !Number.isInteger(point.minuteOfDay) ||
      point.minuteOfDay < 0 ||
      point.minuteOfDay > 1_439
    ) {
      issues.push(`Point ${point.id} has an invalid UTC minute.`);
    }
    if (
      !Number.isFinite(point.percentage) ||
      point.percentage < 0 ||
      point.percentage > 100
    ) {
      issues.push(`Point ${point.id} has an invalid percentage.`);
    }
    identifiers.add(point.id);
    minutes.add(point.minuteOfDay);
  }

  if (issues.length === 0) {
    const domainResult = validateScheduleGraph(
      scheduleGraphFromPoints(
        state.points.map((point) => ({
          minute: point.minuteOfDay,
          percent: point.percentage,
        })),
      ),
    );
    if (!domainResult.ok) {
      for (const issue of domainResult.issues) {
        switch (issue.code) {
          case "start-not-midnight":
            issues.push("The first point must be 00:00 UTC.");
            break;
          case "end-not-final-minute":
            issues.push("The final point must be 23:59 UTC.");
            break;
          case "wrap-discontinuity":
            issues.push(
              "The 00:00 and 23:59 percentages must match for a continuous daily wrap.",
            );
            break;
          default:
            issues.push(`Schedule graph is invalid (${issue.code}).`);
        }
      }
    }
  }

  return { valid: issues.length === 0, issues };
}

export function toReplaceScheduleRequest(
  state: ScheduleEditorState,
  expectedRevision: number,
): ReplaceScheduleRequest {
  return replaceScheduleRequestSchema.parse({
    expectedRevision,
    points: normalizePoints(state.points),
  });
}

function normalizePoints(
  points: readonly SchedulePoint[],
): readonly SchedulePoint[] {
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

function compareIdentifiers(left: string, right: string): number {
  return left === right ? 0 : left < right ? -1 : 1;
}
