import type { OperationSummary, Override } from "@aquarium/contracts";
import { describe, expect, it } from "vitest";

import {
  createManualOverridePanelState,
  deriveManualOverrideView,
  formatOverrideRemainingTime,
  manualOverridePanelReducer,
  manualOverrideTargetKey,
  parseManualOverrideTargetKey,
} from "./manual-override-state.js";

describe("manual override panel state", () => {
  it("retains form input while recording accepted commands and conflicts", () => {
    const initial = createManualOverridePanelState("channel:light-main");
    const edited = manualOverridePanelReducer(
      manualOverridePanelReducer(initial, {
        type: "select_target",
        targetKey: "output:moonlight",
      }),
      { type: "set_percentage", value: "37.5" },
    );
    expect(edited).toMatchObject({
      targetKey: "output:moonlight",
      percentageText: "37.5",
    });

    const accepted = manualOverridePanelReducer(edited, {
      type: "command_accepted",
      notice: {
        kind: "start",
        overrideId: "override-one",
        status: "pending",
        revision: 9,
      },
    });
    expect(accepted.notice).toMatchObject({
      overrideId: "override-one",
      status: "pending",
    });

    const conflicted = manualOverridePanelReducer(accepted, {
      type: "revision_conflict",
      currentRevision: 10,
    });
    expect(conflicted).toMatchObject({ conflictRevision: 10, notice: null });
    expect(
      manualOverridePanelReducer(conflicted, { type: "accept_conflict" }),
    ).toMatchObject({
      targetKey: "output:moonlight",
      percentageText: "37.5",
      conflictRevision: null,
    });
    expect(
      manualOverridePanelReducer(accepted, { type: "dismiss_notice" }).notice,
    ).toBeNull();
  });

  it("round-trips typed channel and output selection keys", () => {
    const output = { targetType: "output" as const, targetId: "moonlight" };
    expect(
      parseManualOverrideTargetKey(manualOverrideTargetKey(output)),
    ).toEqual(output);
    expect(() => parseManualOverrideTargetKey("invalid")).toThrow(
      "Manual override target selection is invalid",
    );
  });

  it("derives permitted actions from authoritative override and operation state", () => {
    const active = deriveManualOverrideView(
      override("active"),
      [operation("succeeded")],
      Date.parse("2026-07-13T10:01:00.000Z"),
    );
    expect(active).toMatchObject({
      phase: "active",
      remainingMs: 120_000,
      canExtend: true,
      canCancel: true,
      canReconcile: false,
      blocksNewStart: true,
    });
    expect(
      deriveManualOverrideView(
        override("active"),
        [operation("succeeded")],
        Date.parse("2026-07-13T10:04:00.000Z"),
      ),
    ).toMatchObject({
      remainingMs: 0,
      canExtend: true,
      canCancel: true,
      blocksNewStart: true,
    });

    const outcomeUnknown = deriveManualOverrideView(
      override("active"),
      [operation("outcome_unknown")],
      Date.parse("2026-07-13T10:01:00.000Z"),
    );
    expect(outcomeUnknown).toMatchObject({
      phase: "outcome_unknown",
      canExtend: true,
      canCancel: true,
      canReconcile: true,
      blocksNewStart: true,
    });

    const reconciledUnknown = deriveManualOverrideView(
      override("active"),
      [operation("outcome_unknown", false)],
      Date.parse("2026-07-13T10:01:00.000Z"),
    );
    expect(reconciledUnknown).toMatchObject({
      phase: "outcome_unknown",
      canExtend: true,
      canCancel: true,
      canReconcile: false,
      blocksNewStart: true,
    });

    const failed = deriveManualOverrideView(
      override("pending"),
      [operation("timed_out")],
      Date.parse("2026-07-13T10:01:00.000Z"),
    );
    expect(failed).toMatchObject({
      phase: "failed",
      canExtend: false,
      canCancel: false,
      canReconcile: false,
      blocksNewStart: false,
    });

    const cancelled = deriveManualOverrideView(
      { ...override("active"), status: "cancelled" },
      [],
      Date.parse("2026-07-13T10:01:00.000Z"),
    );
    expect(cancelled.phase).toBe("cancelled");
    expect(cancelled.blocksNewStart).toBe(false);
  });

  it("formats a ceiling countdown directly from the server deadline", () => {
    expect(formatOverrideRemainingTime(0)).toBe("expired");
    expect(formatOverrideRemainingTime(999)).toBe("1s");
    expect(formatOverrideRemainingTime(61_001)).toBe("1m 2s");
    expect(formatOverrideRemainingTime(120_000)).toBe("2m 0s");
  });
});

function override(status: Override["status"]): Override {
  return {
    id: "override-one",
    targetType: "channel",
    targetId: "light-main",
    valuePercentage: 55,
    status,
    requestedAt: "2026-07-13T10:00:00.000Z",
    startsAt: status === "active" ? "2026-07-13T10:00:01.000Z" : null,
    expiresAt: "2026-07-13T10:03:00.000Z",
    completedAt:
      status === "cancelled" || status === "expired" || status === "failed"
        ? "2026-07-13T10:02:00.000Z"
        : null,
    operationId: "operation-one",
  };
}

function operation(
  status: OperationSummary["status"],
  outcomeUnresolved?: boolean,
): OperationSummary {
  const summary: OperationSummary = {
    id: "operation-one",
    deviceId: null,
    kind: "manual_override_start",
    status,
    requestedAt: "2026-07-13T10:00:00.000Z",
    deadlineAt: "2026-07-13T10:00:30.000Z",
    completedAt:
      status === "pending" || status === "in_flight"
        ? null
        : "2026-07-13T10:00:02.000Z",
  };
  return outcomeUnresolved === undefined
    ? summary
    : { ...summary, outcomeUnresolved };
}
