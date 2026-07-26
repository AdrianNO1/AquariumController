// @vitest-environment jsdom

import type { Throttle } from "@aquarium/contracts";
import { fireEvent, render, screen } from "@testing-library/react";
import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";

import { ScheduleMultiplier } from "./ScheduleMultiplier.js";

const throttle: Throttle = {
  id: "throttle-light",
  typeKey: "light",
  percentage: 80,
  createdAt: "2026-07-13T10:00:00.000Z",
  updatedAt: "2026-07-13T10:00:00.000Z",
};

describe("ScheduleMultiplier", () => {
  it("labels local changes as unsaved and reports the changed percentage", () => {
    const onChange = vi.fn();
    const rendered = render(
      createElement(ScheduleMultiplier, {
        areaLabel: "Lights",
        throttle,
        value: 80,
        dirty: false,
        disabled: false,
        conflictRevision: null,
        conflictReady: true,
        onAcceptConflict: vi.fn(),
        onChange,
      }),
    );

    expect(screen.queryByText("Unsaved")).toBeNull();
    expect(screen.getByText("80%")).toBeTruthy();
    fireEvent.change(
      screen.getByRole("slider", { name: "Lights schedule multiplier" }),
      { target: { value: "73" } },
    );
    expect(onChange).toHaveBeenCalledWith(73);

    rendered.rerender(
      createElement(ScheduleMultiplier, {
        areaLabel: "Lights",
        throttle,
        value: 73,
        dirty: true,
        disabled: false,
        conflictRevision: null,
        conflictReady: true,
        onAcceptConflict: vi.fn(),
        onChange,
      }),
    );
    expect(screen.getByText("Unsaved")).toBeTruthy();
    expect(screen.getByText("73%")).toBeTruthy();
    expect(screen.queryByText("Throttle")).toBeNull();
  });

  it("requires explicit acceptance before rebasing a preserved draft", () => {
    const onAcceptConflict = vi.fn();
    const rendered = render(
      createElement(ScheduleMultiplier, {
        areaLabel: "Lights",
        throttle,
        value: 73,
        dirty: true,
        disabled: false,
        conflictRevision: 12,
        conflictReady: false,
        onAcceptConflict,
        onChange: vi.fn(),
      }),
    );

    const accept = screen.getByRole("button", {
      name: "Keep local multiplier with refreshed revision",
    });
    expect(accept).toHaveProperty("disabled", true);
    rendered.rerender(
      createElement(ScheduleMultiplier, {
        areaLabel: "Lights",
        throttle,
        value: 73,
        dirty: true,
        disabled: false,
        conflictRevision: 12,
        conflictReady: true,
        onAcceptConflict,
        onChange: vi.fn(),
      }),
    );
    fireEvent.click(accept);
    expect(onAcceptConflict).toHaveBeenCalledOnce();
  });
});
