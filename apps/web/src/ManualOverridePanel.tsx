import type {
  Channel,
  ManualOverrideCommandResponse,
  ManualOverrideStateResponse,
  OperationSummary,
  Output,
  Override,
} from "@aquarium/contracts";
import { useMutation } from "@tanstack/react-query";
import { useEffect, useMemo, useReducer, useState } from "react";

import {
  cancelManualOverride,
  extendManualOverride,
  reconcileManualOverride,
  startManualOverride,
} from "./api.js";
import {
  configurationErrorMessage,
  currentRevisionFromError,
} from "./configuration-ui.js";
import {
  createManualOverridePanelState,
  deriveManualOverrideView,
  formatOverrideRemainingTime,
  manualOverridePanelReducer,
  manualOverrideTargetKey,
  parseManualOverrideTargetKey,
  type ManualOverrideCommandKind,
} from "./manual-override-state.js";
import { useDraftRevision } from "./use-draft-revision.js";

export interface ManualOverridePanelProps {
  readonly channels: readonly Channel[];
  readonly outputs: readonly Output[];
  readonly overrides: readonly Override[];
  readonly operations: readonly OperationSummary[];
  readonly expectedRevision: number;
  readonly refresh: () => void;
  readonly nowMs?: () => number;
}

interface OverrideTargetOption {
  readonly key: string;
  readonly label: string;
}

export function ManualOverridePanel({
  channels,
  outputs,
  overrides,
  operations,
  expectedRevision,
  refresh,
  nowMs = systemNowMs,
}: ManualOverridePanelProps): React.JSX.Element {
  const targets = useMemo<readonly OverrideTargetOption[]>(
    () => [
      ...channels
        .filter((channel) => channel.enabled)
        .map((channel) => ({
          key: manualOverrideTargetKey({
            targetType: "channel",
            targetId: channel.id,
          }),
          label: `Channel · ${channel.name}`,
        })),
      ...outputs
        .filter((output) => output.enabled)
        .map((output) => ({
          key: manualOverrideTargetKey({
            targetType: "output",
            targetId: output.id,
          }),
          label: `Output · ${output.name}`,
        })),
    ],
    [channels, outputs],
  );
  const [state, dispatch] = useReducer(
    manualOverridePanelReducer,
    targets[0]?.key ?? "",
    createManualOverridePanelState,
  );
  const startRevision = useDraftRevision(expectedRevision);
  const currentTimeMs = useCurrentTime(nowMs);
  const effectiveTargetKey = targets.some(
    (target) => target.key === state.targetKey,
  )
    ? state.targetKey
    : (targets[0]?.key ?? "");
  const blockedTargetKeys = new Set(
    overrides.flatMap((override) =>
      deriveManualOverrideView(override, operations, currentTimeMs)
        .blocksNewStart
        ? [
            manualOverrideTargetKey({
              targetType: override.targetType,
              targetId: override.targetId,
            }),
          ]
        : [],
    ),
  );
  const percentage = Number(state.percentageText);
  const validPercentage =
    Number.isFinite(percentage) && percentage >= 0 && percentage <= 100;
  const start = useMutation({
    retry: false,
    mutationFn: () =>
      startManualOverride({
        expectedRevision: startRevision.revision,
        target: parseManualOverrideTargetKey(effectiveTargetKey),
        valuePercentage: percentage,
      }),
    onSuccess: (response) => {
      startRevision.reset();
      dispatch({
        type: "command_accepted",
        notice: {
          kind: "start",
          overrideId: response.override.id,
          status: response.override.status,
          revision: response.mutation.revision,
        },
      });
      refresh();
    },
    onError: (error) => handleConflict(error, refresh, dispatch),
  });
  const waitingForStartSnapshot =
    start.data !== undefined && expectedRevision < start.data.mutation.revision;
  const selectedBlocked = blockedTargetKeys.has(effectiveTargetKey);

  return (
    <section className="control-panel" aria-labelledby="override-heading">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Server-authoritative safety window</p>
          <h2 id="override-heading">Manual overrides</h2>
        </div>
        <span className="section-count">{overrides.length} recorded</span>
      </div>

      <form
        className="override-start-form"
        onSubmit={(event) => {
          event.preventDefault();
          start.mutate();
        }}
      >
        <fieldset
          disabled={start.isPending || waitingForStartSnapshot}
          onFocusCapture={startRevision.pin}
        >
          <legend>Start a temporary override</legend>
          <label>
            Channel or output
            <select
              value={effectiveTargetKey}
              onChange={(event) => {
                startRevision.pin();
                dispatch({
                  type: "select_target",
                  targetKey: event.currentTarget.value,
                });
              }}
              required
            >
              {targets.map((target) => (
                <option key={target.key} value={target.key}>
                  {target.label}
                </option>
              ))}
            </select>
          </label>
          <label htmlFor="manual-override-percentage">
            Override percentage
            <span className="percentage-input">
              <input
                id="manual-override-percentage"
                type="number"
                min="0"
                max="100"
                step="0.1"
                value={state.percentageText}
                onChange={(event) => {
                  startRevision.pin();
                  dispatch({
                    type: "set_percentage",
                    value: event.currentTarget.value,
                  });
                }}
                required
              />
              <span aria-hidden="true">%</span>
            </span>
          </label>
          <button
            className="primary-button"
            type="submit"
            disabled={
              targets.length === 0 ||
              selectedBlocked ||
              !validPercentage ||
              start.isPending ||
              waitingForStartSnapshot
            }
          >
            {start.isPending ? "Recording override…" : "Start manual override"}
          </button>
        </fieldset>
      </form>
      {targets.length === 0 ? (
        <p className="empty-panel">
          This area has no channel or output that can receive an override.
        </p>
      ) : null}
      {selectedBlocked ? (
        <p className="information-banner">
          The selected target already has a pending, active, or unknown
          override. Resolve that state before starting another.
        </p>
      ) : null}
      {start.error === null || state.conflictRevision !== null ? null : (
        <p className="field-error" role="alert">
          {configurationErrorMessage(start.error)}
        </p>
      )}
      {state.conflictRevision === null ? null : (
        <div className="conflict-banner" role="alert">
          <span>
            Controller state advanced to revision {state.conflictRevision}. The
            override was not started; review the refreshed state before rebasing
            this draft.
          </span>
          <button
            className="text-button"
            type="button"
            disabled={expectedRevision < state.conflictRevision}
            onClick={() => {
              startRevision.rebase();
              dispatch({ type: "accept_conflict" });
            }}
          >
            Keep override draft with refreshed revision
          </button>
        </div>
      )}
      {state.notice === null ? null : (
        <div className="override-command-notice" role="status">
          <span>
            {commandLabel(state.notice.kind)} for {state.notice.overrideId} was
            recorded as {state.notice.status} at revision{" "}
            {state.notice.revision}. Device state will be shown only from
            authoritative updates.
          </span>
          <button
            className="text-button"
            type="button"
            onClick={() => dispatch({ type: "dismiss_notice" })}
          >
            Dismiss
          </button>
        </div>
      )}

      {overrides.length === 0 ? (
        <p className="muted-copy">No override records for this area.</p>
      ) : (
        <div className="override-card-list">
          {overrides.map((override) => (
            <ManualOverrideCard
              key={override.id}
              override={override}
              operations={operations}
              expectedRevision={expectedRevision}
              nowMs={currentTimeMs}
              refresh={refresh}
              onAccepted={(kind, acceptedOverride, revision) =>
                dispatch({
                  type: "command_accepted",
                  notice: {
                    kind,
                    overrideId: acceptedOverride.id,
                    status: acceptedOverride.status,
                    revision,
                  },
                })
              }
              onConflict={(currentRevision) =>
                dispatch({ type: "revision_conflict", currentRevision })
              }
            />
          ))}
        </div>
      )}
      <p className="information-banner">
        A recorded request is not an actuator success. Pending and unknown
        outcomes remain explicit, and commands are never retried automatically.
      </p>
    </section>
  );
}

type OverrideActionResult = {
  readonly kind: Exclude<ManualOverrideCommandKind, "start">;
  readonly override: Override;
  readonly revision: number;
};

interface ManualOverrideCardProps {
  readonly override: Override;
  readonly operations: readonly OperationSummary[];
  readonly expectedRevision: number;
  readonly nowMs: number;
  readonly refresh: () => void;
  readonly onAccepted: (
    kind: Exclude<ManualOverrideCommandKind, "start">,
    override: Override,
    revision: number,
  ) => void;
  readonly onConflict: (currentRevision: number) => void;
}

function ManualOverrideCard({
  override,
  operations,
  expectedRevision,
  nowMs,
  refresh,
  onAccepted,
  onConflict,
}: ManualOverrideCardProps): React.JSX.Element {
  const action = useMutation({
    retry: false,
    mutationFn: async (
      kind: Exclude<ManualOverrideCommandKind, "start">,
    ): Promise<OverrideActionResult> => {
      const response = await executeOverrideAction(
        kind,
        override.id,
        expectedRevision,
      );
      return {
        kind,
        override: response.override,
        revision: response.mutation.revision,
      };
    },
    onSuccess: (result) => {
      onAccepted(result.kind, result.override, result.revision);
      refresh();
    },
    onError: (error) => {
      const currentRevision = currentRevisionFromError(error);
      if (currentRevision !== null) {
        onConflict(currentRevision);
        refresh();
      }
    },
  });
  const accepted = action.data;
  const waitingForSnapshot =
    accepted !== undefined && expectedRevision < accepted.revision;
  const effectiveOverride = waitingForSnapshot ? accepted.override : override;
  const view = deriveManualOverrideView(effectiveOverride, operations, nowMs);

  return (
    <article className={`override-card override-${view.phase}`}>
      <div className="override-card-heading">
        <div>
          <strong>{effectiveOverride.targetId}</strong>
          <span>
            {effectiveOverride.targetType} · {effectiveOverride.valuePercentage}
            %
          </span>
        </div>
        <span className={`status-pill override-status-${view.phase}`}>
          {view.phase.replaceAll("_", " ")}
        </span>
      </div>
      <p>{overridePhaseMessage(view.phase)}</p>
      {view.phase === "pending" ||
      view.phase === "active" ||
      view.phase === "outcome_unknown" ? (
        <div className="override-deadline">
          <span>Server expiry</span>
          <strong>{formatOverrideRemainingTime(view.remainingMs)}</strong>
          <time dateTime={effectiveOverride.expiresAt}>
            {formatUtc(effectiveOverride.expiresAt)}
          </time>
        </div>
      ) : null}
      {view.operation === null ? null : (
        <p className="override-operation-reference">
          Operation {view.operation.id}: {view.operation.status}
        </p>
      )}
      <div className="button-row">
        {view.canExtend ? (
          <button
            className="secondary-button"
            type="button"
            disabled={action.isPending || waitingForSnapshot}
            onClick={() => action.mutate("extend")}
          >
            Extend {effectiveOverride.targetId}
          </button>
        ) : null}
        {view.canCancel ? (
          <button
            className="danger-button"
            type="button"
            disabled={action.isPending || waitingForSnapshot}
            onClick={() => action.mutate("cancel")}
          >
            Cancel {effectiveOverride.targetId}
          </button>
        ) : null}
        {view.canReconcile ? (
          <button
            className="secondary-button"
            type="button"
            disabled={action.isPending || waitingForSnapshot}
            onClick={() => action.mutate("reconcile")}
          >
            Reconcile unknown outcome
          </button>
        ) : null}
      </div>
      {action.isPending ? (
        <p className="muted-copy" role="status">
          Recording {action.variables} request…
        </p>
      ) : null}
      {waitingForSnapshot ? (
        <p className="muted-copy" role="status">
          Waiting for authoritative revision {accepted.revision} before another
          command.
        </p>
      ) : null}
      {action.error === null ||
      currentRevisionFromError(action.error) !== null ? null : (
        <p className="field-error" role="alert">
          {configurationErrorMessage(action.error)}
        </p>
      )}
    </article>
  );
}

async function executeOverrideAction(
  kind: Exclude<ManualOverrideCommandKind, "start">,
  overrideId: string,
  expectedRevision: number,
): Promise<ManualOverrideCommandResponse | ManualOverrideStateResponse> {
  switch (kind) {
    case "extend":
      return extendManualOverride(overrideId, { expectedRevision });
    case "cancel":
      return cancelManualOverride(overrideId, { expectedRevision });
    case "reconcile":
      return reconcileManualOverride(overrideId, { expectedRevision });
  }
}

function useCurrentTime(readNowMs: () => number): number {
  const [nowMs, setNowMs] = useState(readNowMs);
  useEffect(() => {
    const interval = window.setInterval(() => setNowMs(readNowMs()), 1_000);
    return () => window.clearInterval(interval);
  }, [readNowMs]);
  return nowMs;
}

function handleConflict(
  error: Error,
  refresh: () => void,
  dispatch: React.Dispatch<Parameters<typeof manualOverridePanelReducer>[1]>,
): void {
  const currentRevision = currentRevisionFromError(error);
  if (currentRevision !== null) {
    dispatch({ type: "revision_conflict", currentRevision });
    refresh();
  }
}

function commandLabel(kind: ManualOverrideCommandKind): string {
  switch (kind) {
    case "start":
      return "Start request";
    case "extend":
      return "Extension";
    case "cancel":
      return "Cancellation";
    case "reconcile":
      return "Reconciliation";
  }
}

function overridePhaseMessage(
  phase: ReturnType<typeof deriveManualOverrideView>["phase"],
): string {
  switch (phase) {
    case "pending":
      return "Pending: the controller recorded a command, but no actuator success is claimed yet.";
    case "active":
      return "Active: the controller has an authoritative successful start outcome.";
    case "outcome_unknown":
      return "Outcome unknown: actuator state is not claimed. Reconcile only after the server safety window permits it.";
    case "failed":
      return "Failed: the controller did not establish a successful override.";
    case "expired":
      return "Expired: the server safety deadline ended this override.";
    case "cancelled":
      return "Cancelled: the controller recorded a successful release.";
  }
}

function formatUtc(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "medium",
    timeZone: "UTC",
  }).format(new Date(value));
}

function systemNowMs(): number {
  return Date.now();
}
