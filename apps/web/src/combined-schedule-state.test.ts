import {
  scheduleGraphSchema,
  type ScheduleGraph,
  type SchedulePoint,
} from "@aquarium/contracts";
import { describe, expect, it } from "vitest";

import {
  COMBINED_SCHEDULE_PLOT,
  clientToViewBoxCoordinate,
  combinedScheduleReducer,
  createCombinedScheduleState,
  cyclicPlotPoints,
  isCombinedScheduleDraftDirty,
  minuteToPlotX,
  percentageToPlotY,
  pointFromDraggedCoordinate,
  scheduleValueAt,
  toCombinedReplaceScheduleRequest,
} from "./combined-schedule-state.js";

describe("combined schedule drafts", () => {
  it("hides only reserved synthetic boundaries and keeps ordinary boundary points editable", () => {
    const syntheticSchedule = schedule({
      id: "schedule-light",
      points: [
        point("wrap-boundary-schedule-light-start", 0, 40),
        point("point-morning", 300, 20),
        point("point-evening", 900, 80),
        point("wrap-boundary-schedule-light-end", 1_439, 40),
      ],
    });
    const syntheticState = createCombinedScheduleState([
      { channelId: "channel-light", schedule: syntheticSchedule },
    ]);
    expect(
      syntheticState.drafts["channel-light"]?.points.map(
        (candidate) => candidate.id,
      ),
    ).toEqual(["point-morning", "point-evening"]);

    const ordinarySchedule = schedule({
      id: "schedule-ordinary",
      points: [
        point("point-start", 0, 0),
        point("point-noon", 720, 100),
        point("point-end", 1_439, 0),
      ],
    });
    const ordinaryState = createCombinedScheduleState([
      { channelId: "channel-ordinary", schedule: ordinarySchedule },
    ]);
    expect(
      ordinaryState.drafts["channel-ordinary"]?.points.map(
        (candidate) => candidate.id,
      ),
    ).toEqual(["point-start", "point-noon", "point-end"]);
  });

  it("creates stable equal-value wrap boundaries in the canonical save request", () => {
    const source = schedule({
      id: "schedule-light",
      points: [
        point("wrap-boundary-schedule-light-start", 0, 10),
        point("point-morning", 300, 20),
        point("point-evening", 900, 80),
        point("wrap-boundary-schedule-light-end", 1_439, 10),
      ],
    });
    const state = createCombinedScheduleState([
      { channelId: "channel-light", schedule: source },
    ]);
    const draft = state.drafts["channel-light"];
    expect(draft).toBeDefined();
    if (draft === undefined) return;

    const request = toCombinedReplaceScheduleRequest(draft, 12);
    expect(request.expectedRevision).toBe(12);
    expect(request.points.map((candidate) => candidate.id)).toEqual([
      "wrap-boundary-schedule-light-start",
      "point-morning",
      "point-evening",
      "wrap-boundary-schedule-light-end",
    ]);
    expect(request.points[0]?.percentage).toBeCloseTo(
      scheduleValueAt(draft.points, 0),
    );
    expect(request.points[3]?.percentage).toBe(request.points[0]?.percentage);
    expect(request.points.map((candidate) => candidate.position)).toEqual([
      0, 1, 2, 3,
    ]);
  });

  it("keeps ordinary endpoints visible while normalizing their saved wrap values", () => {
    const source = schedule({
      id: "schedule-light",
      points: [
        point("point-start", 0, 25),
        point("point-noon", 720, 90),
        point("point-end", 1_439, 75),
      ],
    });
    const state = createCombinedScheduleState([
      { channelId: "channel-light", schedule: source },
    ]);
    const draft = state.drafts["channel-light"];
    expect(draft).toBeDefined();
    if (draft === undefined) return;

    expect(draft.points.map((candidate) => candidate.id)).toEqual([
      "point-start",
      "point-noon",
      "point-end",
    ]);
    const request = toCombinedReplaceScheduleRequest(draft, 4);
    expect(request.points[0]).toMatchObject({
      id: "point-start",
      minuteOfDay: 0,
      percentage: 25,
    });
    expect(request.points[2]).toMatchObject({
      id: "point-end",
      minuteOfDay: 1_439,
      percentage: 25,
    });
  });

  it("retains every dirty channel draft and reports a channel-specific snapshot conflict", () => {
    const light = schedule({
      id: "schedule-light",
      channelId: "channel-light",
      graphRevision: 2,
      points: [
        point("light-start", 0, 0),
        point("light-noon", 720, 80),
        point("light-end", 1_439, 0),
      ],
    });
    const uv = schedule({
      id: "schedule-uv",
      channelId: "channel-uv",
      graphRevision: 5,
      points: [
        point("uv-start", 0, 0),
        point("uv-noon", 720, 50),
        point("uv-end", 1_439, 0),
      ],
    });
    const sources = [
      { channelId: "channel-light", schedule: light },
      { channelId: "channel-uv", schedule: uv },
    ];
    const initial = createCombinedScheduleState(sources);
    const lightEdited = combinedScheduleReducer(initial, {
      type: "update_point",
      channelId: "channel-light",
      pointId: "light-noon",
      minuteOfDay: 713,
      percentage: 85,
      currentRevision: 30,
    });
    const bothEdited = combinedScheduleReducer(lightEdited, {
      type: "update_point",
      channelId: "channel-uv",
      pointId: "uv-noon",
      minuteOfDay: 721,
      percentage: 55,
      currentRevision: 30,
    });
    const selectedUv = combinedScheduleReducer(bothEdited, {
      type: "select_channel",
      channelId: "channel-uv",
    });
    const unchangedSnapshot = combinedScheduleReducer(selectedUv, {
      type: "snapshot",
      sources,
      currentRevision: 31,
    });
    expect(unchangedSnapshot.selectedChannelId).toBe("channel-uv");
    expect(
      unchangedSnapshot.drafts["channel-light"]?.points.find(
        (candidate) => candidate.id === "light-noon",
      ),
    ).toMatchObject({ minuteOfDay: 713, percentage: 85 });
    expect(
      unchangedSnapshot.drafts["channel-uv"]?.points.find(
        (candidate) => candidate.id === "uv-noon",
      ),
    ).toMatchObject({ minuteOfDay: 721, percentage: 55 });

    const externalLight = schedule({
      id: "schedule-light",
      channelId: "channel-light",
      graphRevision: 3,
      points: [
        point("light-start", 0, 0),
        point("light-noon", 720, 65),
        point("light-end", 1_439, 0),
      ],
    });
    const conflicted = combinedScheduleReducer(unchangedSnapshot, {
      type: "snapshot",
      sources: [
        { channelId: "channel-light", schedule: externalLight },
        { channelId: "channel-uv", schedule: uv },
      ],
      currentRevision: 32,
    });
    expect(conflicted.drafts["channel-light"]?.conflictRevision).toBe(32);
    expect(
      conflicted.drafts["channel-light"]?.points.find(
        (candidate) => candidate.id === "light-noon",
      )?.percentage,
    ).toBe(85);
    const uvDraft = conflicted.drafts["channel-uv"];
    expect(uvDraft).toBeDefined();
    if (uvDraft === undefined) return;
    expect(isCombinedScheduleDraftDirty(uvDraft)).toBe(true);

    const accepted = combinedScheduleReducer(conflicted, {
      type: "accept_conflict",
      channelId: "channel-light",
      currentRevision: 32,
    });
    expect(accepted.drafts["channel-light"]?.pinnedRevision).toBe(32);
    expect(accepted.drafts["channel-light"]?.conflictRevision).toBeNull();
    expect(accepted.drafts["channel-uv"]?.pinnedRevision).toBe(32);
  });

  it("acknowledges only the point snapshot sent to the controller", () => {
    const source = schedule({
      id: "schedule-light",
      points: [
        point("light-start", 0, 0),
        point("light-noon", 720, 60),
        point("light-end", 1_439, 0),
      ],
    });
    const initial = createCombinedScheduleState([
      { channelId: "channel-light", schedule: source },
    ]);
    const submitted = combinedScheduleReducer(initial, {
      type: "update_point",
      channelId: "channel-light",
      pointId: "light-noon",
      minuteOfDay: 713,
      percentage: 65,
      currentRevision: 8,
    });
    const submittedPoints = submitted.drafts["channel-light"]?.points;
    expect(submittedPoints).toBeDefined();
    if (submittedPoints === undefined) return;

    const editedWhileSaving = combinedScheduleReducer(submitted, {
      type: "update_point",
      channelId: "channel-light",
      pointId: "light-noon",
      minuteOfDay: 717,
      percentage: 72,
      currentRevision: 8,
    });
    const acknowledged = combinedScheduleReducer(editedWhileSaving, {
      type: "saved",
      channelId: "channel-light",
      savedPoints: submittedPoints,
      savedRevision: 9,
    });
    const remainingDraft = acknowledged.drafts["channel-light"];
    expect(remainingDraft).toBeDefined();
    if (remainingDraft === undefined) return;
    expect(remainingDraft.baselinePoints).toEqual(submittedPoints);
    expect(
      remainingDraft.points.find((candidate) => candidate.id === "light-noon"),
    ).toMatchObject({ minuteOfDay: 717, percentage: 72 });
    expect(remainingDraft.pinnedRevision).toBe(9);
    expect(isCombinedScheduleDraftDirty(remainingDraft)).toBe(true);

    const refreshedOwnSave = combinedScheduleReducer(acknowledged, {
      type: "snapshot",
      sources: [
        {
          channelId: "channel-light",
          schedule: schedule({
            id: "schedule-light",
            graphRevision: 2,
            points: submittedPoints,
          }),
        },
      ],
      currentRevision: 9,
    });
    const refreshedDraft = refreshedOwnSave.drafts["channel-light"];
    expect(refreshedDraft).toBeDefined();
    if (refreshedDraft === undefined) return;
    expect(refreshedDraft.graphRevision).toBe(2);
    expect(refreshedDraft.conflictRevision).toBeNull();
    expect(refreshedDraft.pinnedRevision).toBe(9);
    expect(
      refreshedDraft.points.find((candidate) => candidate.id === "light-noon"),
    ).toMatchObject({ minuteOfDay: 717, percentage: 72 });

    const fullyAcknowledged = combinedScheduleReducer(refreshedOwnSave, {
      type: "saved",
      channelId: "channel-light",
      savedPoints: refreshedDraft.points,
      savedRevision: 10,
    });
    const cleanDraft = fullyAcknowledged.drafts["channel-light"];
    expect(cleanDraft).toBeDefined();
    if (cleanDraft === undefined) return;
    expect(cleanDraft.pinnedRevision).toBeNull();
    expect(isCombinedScheduleDraftDirty(cleanDraft)).toBe(false);
  });
});

describe("combined schedule graph geometry", () => {
  it("draws a cyclic segment through both edges of the UTC day", () => {
    const logical = [
      point("point-morning", 300, 20),
      point("point-evening", 900, 80),
    ];
    const plotted = cyclicPlotPoints(logical);
    expect(plotted.map((candidate) => candidate.minuteOfDay)).toEqual([
      0, 300, 900, 1_440,
    ]);
    expect(plotted[0]?.percentage).toBeCloseTo(
      plotted[3]?.percentage ?? Number.NaN,
    );
  });

  it("converts letterboxed client coordinates into exact SVG coordinates", () => {
    const coordinate = clientToViewBoxCoordinate(
      { left: 10, top: 20, width: 2_000, height: 1_000 },
      10 + COMBINED_SCHEDULE_PLOT.left * 2,
      20 + 140 + COMBINED_SCHEDULE_PLOT.top * 2,
    );
    expect(coordinate.x).toBeCloseTo(COMBINED_SCHEDULE_PLOT.left);
    expect(coordinate.y).toBeCloseTo(COMBINED_SCHEDULE_PLOT.top);
  });

  it("preserves the pointer grab offset while snapping dragged time to five minutes", () => {
    const first = pointFromDraggedCoordinate(
      {
        x: minuteToPlotX(705),
        y: percentageToPlotY(45),
      },
      15,
      5,
    );
    expect(first).toEqual({ minuteOfDay: 720, percentage: 50 });

    const moved = pointFromDraggedCoordinate(
      {
        x: minuteToPlotX(710),
        y: percentageToPlotY(44),
      },
      15,
      5,
    );
    expect(moved).toEqual({ minuteOfDay: 725, percentage: 49 });
  });
});

function schedule(options: {
  readonly id: string;
  readonly channelId?: string;
  readonly graphRevision?: number;
  readonly points: readonly SchedulePoint[];
}): ScheduleGraph {
  return scheduleGraphSchema.parse({
    id: options.id,
    channelId: options.channelId ?? "channel-light",
    name: "Daily schedule",
    timezone: "UTC",
    enabled: true,
    graphRevision: options.graphRevision ?? 1,
    createdAt: "2026-07-13T08:00:00.000Z",
    updatedAt: "2026-07-13T09:00:00.000Z",
    points: options.points.map((candidate, position) => ({
      ...candidate,
      position,
    })),
  });
}

function point(
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
