// @vitest-environment jsdom
// @vitest-environment-options {"url":"http://localhost/"}

import {
  channelSchema,
  scheduleGraphSchema,
  type ReplaceScheduleRequest,
} from "@aquarium/contracts";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createElement, createRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { AquariumApiError } from "./api.js";
import {
  CombinedScheduleEditor,
  type CombinedScheduleDraftPoints,
  type CombinedScheduleEditorHandle,
  type ScheduleMutationResult,
} from "./CombinedScheduleEditor.js";

afterEach(cleanup);

describe("CombinedScheduleEditor", () => {
  it("adds an exact manually entered point and reports the logical draft", async () => {
    const reportedDrafts: CombinedScheduleDraftPoints[] = [];
    const user = userEvent.setup();
    render(
      createElement(CombinedScheduleEditor, {
        channels: [combinedChannel()],
        expectedRevision: 8,
        currentMinuteOfDay: 600,
        timezoneOffsetMinutes: 0,
        onSaveSchedule: async (): Promise<ScheduleMutationResult> => ({
          revision: 9,
        }),
        onDraftPointsChange: (drafts) => reportedDrafts.push(drafts),
      }),
    );

    await user.click(screen.getByRole("button", { name: "New point" }));
    fireEvent.change(screen.getByLabelText("Main light new point local time"), {
      target: { value: "10:07" },
    });
    fireEvent.change(screen.getByLabelText("Main light new point output"), {
      target: { value: "42" },
    });
    await user.click(screen.getByRole("button", { name: "Add point" }));

    await waitFor(() => {
      const latest = reportedDrafts.at(-1)?.["light-main"];
      expect(latest?.find((point) => point.minuteOfDay === 607)).toMatchObject({
        minuteOfDay: 607,
        percentage: 42,
      });
    });
    expect(
      screen
        .getByLabelText("Main light selected point output")
        .getAttribute("step"),
    ).toBe("1");
    expect(
      screen.queryByLabelText("Main light new point local time"),
    ).toBeNull();
    expect(screen.getByLabelText("Unsaved changes")).toBeTruthy();
  });

  it("keeps edits made during an in-flight save dirty for the next save", async () => {
    const requests: ReplaceScheduleRequest[] = [];
    const reportedDrafts: CombinedScheduleDraftPoints[] = [];
    const editorRef = createRef<CombinedScheduleEditorHandle>();
    let resolveFirstSave:
      ((result: ScheduleMutationResult) => void) | undefined;
    const firstResult = new Promise<ScheduleMutationResult>((resolve) => {
      resolveFirstSave = resolve;
    });
    const onSaveSchedule = (
      _channelId: string,
      request: ReplaceScheduleRequest,
    ): Promise<ScheduleMutationResult> => {
      requests.push(request);
      return requests.length === 1
        ? firstResult
        : Promise.resolve({ revision: 10 });
    };
    const user = userEvent.setup();
    render(
      createElement(CombinedScheduleEditor, {
        ref: editorRef,
        channels: [combinedChannel()],
        expectedRevision: 8,
        currentMinuteOfDay: 600,
        timezoneOffsetMinutes: 0,
        onSaveSchedule,
        onDraftPointsChange: (drafts) => reportedDrafts.push(drafts),
      }),
    );

    const pointList = screen.getByLabelText("Main light schedule points");
    const noonPoint = within(pointList).getAllByRole("button")[1];
    if (noonPoint === undefined) throw new Error("Noon point is missing");
    await user.click(noonPoint);
    fireEvent.change(
      screen.getByLabelText("Main light selected point output"),
      { target: { value: "65" } },
    );
    await user.click(screen.getByRole("button", { name: "Apply point" }));

    let pendingSave: Promise<number> | undefined;
    act(() => {
      pendingSave = editorRef.current?.saveAll(8);
    });
    await waitFor(() => expect(requests).toHaveLength(1));

    fireEvent.change(
      screen.getByLabelText("Main light selected point output"),
      { target: { value: "72" } },
    );
    await user.click(screen.getByRole("button", { name: "Apply point" }));

    await act(async () => {
      resolveFirstSave?.({ revision: 9 });
      await pendingSave;
    });

    expect(editorRef.current?.dirty).toBe(true);
    expect(screen.getByLabelText("Unsaved changes")).toBeTruthy();
    expect(
      reportedDrafts
        .at(-1)
        ?.["light-main"]?.find((point) => point.minuteOfDay === 720)
        ?.percentage,
    ).toBe(72);

    await act(async () => {
      await editorRef.current?.saveAll(9);
    });
    expect(requests).toHaveLength(2);
    expect(requests[1]?.expectedRevision).toBe(9);
    expect(
      requests[1]?.points.find((point) => point.minuteOfDay === 720)
        ?.percentage,
    ).toBe(72);
    expect(editorRef.current?.dirty).toBe(false);
  });

  it("rebases a draft when unrelated controller changes leave its graph unchanged", async () => {
    const requests: ReplaceScheduleRequest[] = [];
    const editorRef = createRef<CombinedScheduleEditorHandle>();
    const channel = combinedChannel();
    const renderEditor = (expectedRevision: number) =>
      createElement(CombinedScheduleEditor, {
        ref: editorRef,
        channels: [channel],
        expectedRevision,
        currentMinuteOfDay: 600,
        timezoneOffsetMinutes: 0,
        onSaveSchedule: async (
          _channelId: string,
          request: ReplaceScheduleRequest,
        ): Promise<ScheduleMutationResult> => {
          requests.push(request);
          return { revision: request.expectedRevision + 1 };
        },
      });
    const user = userEvent.setup();
    const rendered = render(renderEditor(8));

    fireEvent.change(
      screen.getByLabelText("Main light selected point output"),
      { target: { value: "65" } },
    );
    await user.click(screen.getByRole("button", { name: "Apply point" }));
    rendered.rerender(renderEditor(12));

    await act(async () => {
      await editorRef.current?.saveAll(12);
    });
    expect(requests[0]?.expectedRevision).toBe(12);
  });

  it("rebases every dirty schedule after one shared revision conflict", async () => {
    const channels = [
      combinedChannel(),
      combinedChannel("light-uv", "UV light", "#805ad5"),
    ];
    const requests: Array<{
      readonly channelId: string;
      readonly request: ReplaceScheduleRequest;
    }> = [];
    const editorRef = createRef<CombinedScheduleEditorHandle>();
    const acceptedConflict = vi.fn();
    const onSaveSchedule = (
      channelId: string,
      request: ReplaceScheduleRequest,
    ): Promise<ScheduleMutationResult> => {
      requests.push({ channelId, request });
      if (requests.length === 1) {
        return Promise.reject(
          new AquariumApiError(409, {
            code: "revision_conflict",
            message: "State revision changed",
            expectedRevision: request.expectedRevision,
            currentRevision: 9,
          }),
        );
      }
      return Promise.resolve({ revision: request.expectedRevision + 1 });
    };
    const user = userEvent.setup();
    const rendered = render(
      createElement(CombinedScheduleEditor, {
        ref: editorRef,
        channels,
        expectedRevision: 8,
        currentMinuteOfDay: 600,
        timezoneOffsetMinutes: 0,
        onSaveSchedule,
        onAcceptRevisionConflict: acceptedConflict,
      }),
    );

    fireEvent.change(
      screen.getByLabelText("Main light selected point output"),
      { target: { value: "65" } },
    );
    await user.click(screen.getByRole("button", { name: "Apply point" }));
    await user.click(
      within(screen.getByRole("list", { name: "Schedule channels" })).getByRole(
        "button",
        { name: /UV light/u },
      ),
    );
    fireEvent.change(screen.getByLabelText("UV light selected point output"), {
      target: { value: "45" },
    });
    await user.click(screen.getByRole("button", { name: "Apply point" }));

    await act(async () => {
      await expect(editorRef.current?.saveAll(8)).rejects.toThrow(
        "No schedule changes were saved.",
      );
    });
    expect(requests.map(({ request }) => request.expectedRevision)).toEqual([
      8,
    ]);

    rendered.rerender(
      createElement(CombinedScheduleEditor, {
        ref: editorRef,
        channels,
        expectedRevision: 9,
        currentMinuteOfDay: 600,
        timezoneOffsetMinutes: 0,
        onSaveSchedule,
        onAcceptRevisionConflict: acceptedConflict,
      }),
    );
    await user.click(
      await screen.findByRole("button", {
        name: "Keep local draft with refreshed revision",
      }),
    );
    expect(acceptedConflict).toHaveBeenCalledOnce();

    await act(async () => {
      await expect(editorRef.current?.saveAll(9)).resolves.toBe(11);
    });
    expect(requests.map(({ channelId }) => channelId)).toEqual([
      "light-main",
      "light-main",
      "light-uv",
    ]);
    expect(requests.map(({ request }) => request.expectedRevision)).toEqual([
      8, 9, 10,
    ]);
    expect(editorRef.current?.dirty).toBe(false);
  });
});

function combinedChannel(
  id = "light-main",
  name = "Main light",
  color = "#13a4c7",
) {
  const timestamp = "2026-07-13T10:00:00.000Z";
  return {
    color,
    channel: channelSchema.parse({
      id,
      name,
      color,
      typeKey: "light",
      throttleId: "throttle-light",
      displayOrder: 0,
      enabled: true,
      createdAt: timestamp,
      updatedAt: timestamp,
    }),
    schedule: scheduleGraphSchema.parse({
      id: `schedule-${id}`,
      channelId: id,
      name: `${name} schedule`,
      timezone: "UTC",
      enabled: true,
      graphRevision: 2,
      createdAt: timestamp,
      updatedAt: timestamp,
      points: [
        point(`${id}-start`, 0, 0, 0),
        point(`${id}-noon`, 1, 720, 60),
        point(`${id}-end`, 2, 1_439, 0),
      ],
    }),
  };
}

function point(
  id: string,
  position: number,
  minuteOfDay: number,
  percentage: number,
) {
  return {
    id,
    position,
    minuteOfDay,
    percentage,
    editorX: null,
    editorY: null,
  };
}
