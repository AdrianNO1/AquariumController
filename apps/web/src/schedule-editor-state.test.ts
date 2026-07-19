import { scheduleGraphSchema, type ScheduleGraph } from "@aquarium/contracts";
import { describe, expect, it } from "vitest";

import {
  createScheduleEditorState,
  isScheduleDraftDirty,
  scheduleEditorReducer,
  toReplaceScheduleRequest,
  validateScheduleDraft,
} from "./schedule-editor-state.js";

describe("scheduleEditorReducer", () => {
  it("adds, reorders, edits, removes, and discards schedule points", () => {
    const initial = createScheduleEditorState(schedule());
    const added = scheduleEditorReducer(initial, {
      type: "add",
      point: {
        id: "point-evening",
        position: 10,
        minuteOfDay: 1_080,
        percentage: 60,
        editorX: null,
        editorY: null,
      },
    });
    expect(added.points.map((point) => point.id)).toEqual([
      "point-start",
      "point-noon",
      "point-evening",
      "point-end",
    ]);
    expect(added.points.map((point) => point.position)).toEqual([0, 1, 2, 3]);
    expect(isScheduleDraftDirty(added)).toBe(true);

    const edited = scheduleEditorReducer(added, {
      type: "update",
      pointId: "point-evening",
      minuteOfDay: 300,
      percentage: 25,
    });
    expect(edited.points.map((point) => point.id)).toEqual([
      "point-start",
      "point-evening",
      "point-noon",
      "point-end",
    ]);
    expect(edited.points[1]).toMatchObject({
      minuteOfDay: 300,
      percentage: 25,
      position: 1,
    });

    const removed = scheduleEditorReducer(edited, {
      type: "remove",
      pointId: "point-noon",
    });
    expect(removed.points.map((point) => point.position)).toEqual([0, 1, 2]);
    const discarded = scheduleEditorReducer(removed, { type: "discard" });
    expect(discarded.points).toEqual(initial.points);
    expect(isScheduleDraftDirty(discarded)).toBe(false);
  });

  it("validates full UTC coverage, daily wrap, duplicates, and request shape", () => {
    const initial = createScheduleEditorState(schedule());
    expect(validateScheduleDraft(initial)).toEqual({ valid: true, issues: [] });
    expect(toReplaceScheduleRequest(initial, 12)).toMatchObject({
      expectedRevision: 12,
      points: [
        { id: "point-start", position: 0, minuteOfDay: 0 },
        { id: "point-noon", position: 1, minuteOfDay: 720 },
        { id: "point-end", position: 2, minuteOfDay: 1_439 },
      ],
    });

    const brokenStart = scheduleEditorReducer(initial, {
      type: "update",
      pointId: "point-start",
      minuteOfDay: 1,
      percentage: 0,
    });
    expect(validateScheduleDraft(brokenStart).issues).toContain(
      "The first point must be 00:00 UTC.",
    );
    const brokenWrap = scheduleEditorReducer(initial, {
      type: "update",
      pointId: "point-end",
      minuteOfDay: 1_439,
      percentage: 30,
    });
    expect(validateScheduleDraft(brokenWrap).issues).toContain(
      "The 00:00 and 23:59 percentages must match for a continuous daily wrap.",
    );
    const duplicateMinute = scheduleEditorReducer(initial, {
      type: "update",
      pointId: "point-noon",
      minuteOfDay: 0,
      percentage: 50,
    });
    expect(validateScheduleDraft(duplicateMinute).issues).toContain(
      "UTC minute 0 is duplicated.",
    );
  });

  it("preserves a dirty draft across external revision conflict and rebases a matching save", () => {
    const initial = createScheduleEditorState(schedule());
    const dirty = scheduleEditorReducer(initial, {
      type: "update",
      pointId: "point-noon",
      minuteOfDay: 720,
      percentage: 80,
    });
    const external = schedule({
      graphRevision: 4,
      noonPercentage: 60,
    });
    const editing = scheduleEditorReducer(initial, {
      type: "snapshot",
      schedule: external,
      currentRevision: 41,
      draftInProgress: true,
    });
    expect(editing.conflictRevision).toBe(41);
    expect(editing.graphRevision).toBe(initial.graphRevision);

    const conflicted = scheduleEditorReducer(dirty, {
      type: "snapshot",
      schedule: external,
      currentRevision: 41,
    });
    expect(conflicted.conflictRevision).toBe(41);
    expect(conflicted.points[1]?.percentage).toBe(80);
    const retainedConflict = scheduleEditorReducer(conflicted, {
      type: "update",
      pointId: "point-noon",
      minuteOfDay: 720,
      percentage: 85,
    });
    expect(retainedConflict.conflictRevision).toBe(41);
    expect(
      scheduleEditorReducer(retainedConflict, { type: "accept_conflict" })
        .conflictRevision,
    ).toBeNull();

    const matching = schedule({ graphRevision: 5, noonPercentage: 80 });
    const rebased = scheduleEditorReducer(dirty, {
      type: "snapshot",
      schedule: matching,
      currentRevision: 42,
    });
    expect(rebased.graphRevision).toBe(5);
    expect(rebased.conflictRevision).toBeNull();
    expect(isScheduleDraftDirty(rebased)).toBe(false);
  });
});

function schedule(
  options: {
    readonly graphRevision?: number;
    readonly noonPercentage?: number;
  } = {},
): ScheduleGraph {
  return scheduleGraphSchema.parse({
    id: "channel-light",
    channelId: "channel-light",
    name: "Main light schedule",
    timezone: "UTC",
    enabled: true,
    graphRevision: options.graphRevision ?? 3,
    createdAt: "2026-07-13T08:00:00.000Z",
    updatedAt: "2026-07-13T09:00:00.000Z",
    points: [
      {
        id: "point-start",
        position: 0,
        minuteOfDay: 0,
        percentage: 0,
        editorX: null,
        editorY: null,
      },
      {
        id: "point-noon",
        position: 1,
        minuteOfDay: 720,
        percentage: options.noonPercentage ?? 50,
        editorX: null,
        editorY: null,
      },
      {
        id: "point-end",
        position: 2,
        minuteOfDay: 1_439,
        percentage: 0,
        editorX: null,
        editorY: null,
      },
    ],
  });
}
