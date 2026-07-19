import {
  manualOverrideTargetSchema,
  type ManualOverrideTarget,
  type OperationSummary,
  type Override,
} from "@aquarium/contracts";

export type ManualOverrideCommandKind =
  "start" | "extend" | "cancel" | "reconcile";

export interface ManualOverrideCommandNotice {
  readonly kind: ManualOverrideCommandKind;
  readonly overrideId: string;
  readonly status: Override["status"];
  readonly revision: number;
}

export interface ManualOverridePanelState {
  readonly targetKey: string;
  readonly percentageText: string;
  readonly conflictRevision: number | null;
  readonly notice: ManualOverrideCommandNotice | null;
}

export type ManualOverridePanelAction =
  | { readonly type: "select_target"; readonly targetKey: string }
  | { readonly type: "set_percentage"; readonly value: string }
  | {
      readonly type: "command_accepted";
      readonly notice: ManualOverrideCommandNotice;
    }
  | { readonly type: "revision_conflict"; readonly currentRevision: number }
  | { readonly type: "accept_conflict" }
  | { readonly type: "dismiss_notice" };

export interface ManualOverrideViewState {
  readonly phase:
    | "pending"
    | "active"
    | "outcome_unknown"
    | "failed"
    | "expired"
    | "cancelled";
  readonly operation: OperationSummary | null;
  readonly remainingMs: number;
  readonly canExtend: boolean;
  readonly canCancel: boolean;
  readonly canReconcile: boolean;
  readonly blocksNewStart: boolean;
}

export function createManualOverridePanelState(
  firstTargetKey: string,
): ManualOverridePanelState {
  return {
    targetKey: firstTargetKey,
    percentageText: "50",
    conflictRevision: null,
    notice: null,
  };
}

export function manualOverridePanelReducer(
  state: ManualOverridePanelState,
  action: ManualOverridePanelAction,
): ManualOverridePanelState {
  switch (action.type) {
    case "select_target":
      return { ...state, targetKey: action.targetKey };
    case "set_percentage":
      return { ...state, percentageText: action.value };
    case "command_accepted":
      return {
        ...state,
        conflictRevision: null,
        notice: action.notice,
      };
    case "revision_conflict":
      return {
        ...state,
        conflictRevision: action.currentRevision,
        notice: null,
      };
    case "accept_conflict":
      return { ...state, conflictRevision: null };
    case "dismiss_notice":
      return { ...state, notice: null };
  }
}

export function manualOverrideTargetKey(target: ManualOverrideTarget): string {
  return `${target.targetType}:${target.targetId}`;
}

export function parseManualOverrideTargetKey(
  targetKey: string,
): ManualOverrideTarget {
  const separator = targetKey.indexOf(":");
  if (separator < 1 || separator === targetKey.length - 1) {
    throw new TypeError("Manual override target selection is invalid");
  }
  return manualOverrideTargetSchema.parse({
    targetType: targetKey.slice(0, separator),
    targetId: targetKey.slice(separator + 1),
  });
}

export function deriveManualOverrideView(
  override: Override,
  operations: readonly OperationSummary[],
  nowMs: number,
): ManualOverrideViewState {
  const operation =
    override.operationId === null
      ? null
      : (operations.find(
          (candidate) => candidate.id === override.operationId,
        ) ?? null);
  const terminalOverride =
    override.status === "failed" ||
    override.status === "expired" ||
    override.status === "cancelled";
  const phase = terminalOverride
    ? override.status
    : operation?.status === "outcome_unknown"
      ? "outcome_unknown"
      : operation?.status === "failed" ||
          operation?.status === "timed_out" ||
          operation?.status === "cancelled"
        ? "failed"
        : override.status;
  const remainingMs = Math.max(0, Date.parse(override.expiresAt) - nowMs);
  const active = phase === "active" && remainingMs > 0;
  return {
    phase,
    operation,
    remainingMs,
    canExtend: active,
    canCancel: active,
    canReconcile: phase === "outcome_unknown",
    blocksNewStart:
      phase === "pending" || phase === "active" || phase === "outcome_unknown",
  };
}

export function formatOverrideRemainingTime(remainingMs: number): string {
  const totalSeconds = Math.max(0, Math.ceil(remainingMs / 1_000));
  if (totalSeconds === 0) return "expired";
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes === 0 ? `${seconds}s` : `${minutes}m ${seconds}s`;
}
