import type {
  Channel,
  OperationSummary,
  Override,
  ScheduleGraph,
} from "@aquarium/contracts";
import { useMutation } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";

import {
  AquariumApiError,
  cancelManualOverride,
  reconcileManualOverride,
  startManualOverride,
} from "./api.js";
import {
  configurationErrorMessage,
  currentRevisionFromError,
} from "./configuration-ui.js";
import { scheduleValueAt } from "./combined-schedule-state.js";
import { deriveManualOverrideView } from "./manual-override-state.js";
import { useDraftRevision } from "./use-draft-revision.js";

export interface OverrideChannel {
  readonly channel: Channel;
  readonly schedule: ScheduleGraph | null;
}

export interface ManualOverridePanelProps {
  readonly channels: readonly OverrideChannel[];
  readonly commandableChannelIds: ReadonlySet<string>;
  readonly multiplierPercentage: number;
  readonly overrides: readonly Override[];
  readonly operations: readonly OperationSummary[];
  readonly expectedRevision: number;
  readonly refresh: () => void;
  readonly onAcceptedRevision?: (revision: number) => void;
  readonly onBusyChange?: (busy: boolean) => void;
  readonly nowMs?: () => number;
  readonly disabled?: boolean;
}

type OverrideBatchKind = "apply" | "release";

interface OverrideBatchRequest {
  readonly kind: OverrideBatchKind;
  readonly expectedRevision: number;
  readonly overrides: readonly Override[];
  readonly releaseOverrideIds: readonly string[];
  readonly operations: readonly OperationSummary[];
  readonly nowMs: number;
  readonly channels: readonly Channel[];
  readonly valuesByChannel: ReadonlyMap<string, number>;
  readonly durationSeconds: number;
}

interface OverrideBatchResult {
  readonly kind: OverrideBatchKind;
  readonly revision: number;
  readonly operationIds: readonly string[];
  readonly blockedChannelNames: readonly string[];
  readonly releasedOverrideIds: readonly string[];
}

type OverrideBatchConfirmation = "pending" | "succeeded" | "failed";

const durationChoices = [
  { seconds: 60, label: "1 minute" },
  { seconds: 120, label: "2 minutes" },
  { seconds: 300, label: "5 minutes" },
  { seconds: 600, label: "10 minutes" },
] as const;

export function ManualOverridePanel({
  channels,
  commandableChannelIds,
  multiplierPercentage,
  overrides,
  operations,
  expectedRevision,
  refresh,
  onAcceptedRevision,
  onBusyChange,
  nowMs = Date.now,
  disabled = false,
}: ManualOverridePanelProps): React.JSX.Element {
  const [durationSeconds, setDurationSeconds] = useState(120);
  const [draftValues, setDraftValues] = useState<ReadonlyMap<string, number>>(
    () => new Map(),
  );
  const [releasedOverrideIds, setReleasedOverrideIds] = useState<
    ReadonlySet<string>
  >(() => new Set());
  const draftRevision = useDraftRevision(expectedRevision);
  const currentTimeMs = useCurrentTime(nowMs);
  const currentMinute = utcMinuteOfDay(currentTimeMs);
  const scheduledValues = useMemo(
    () =>
      new Map(
        channels.map(({ channel, schedule }) => [
          channel.id,
          Math.round(
            scheduleValueAt(schedule?.points ?? [], currentMinute) *
              (multiplierPercentage / 100),
          ),
        ]),
      ),
    [channels, currentMinute, multiplierPercentage],
  );
  const liveOverrideByChannel = new Map(
    overrides
      .filter(
        (override) =>
          !releasedOverrideIds.has(override.id) &&
          override.targetType === "channel" &&
          (override.status === "pending" || override.status === "active"),
      )
      .map((override) => [override.targetId, override]),
  );
  const batch = useMutation({
    retry: false,
    mutationFn: async (
      request: OverrideBatchRequest,
    ): Promise<OverrideBatchResult> => {
      let revision = request.expectedRevision;
      const operationIds: string[] = [];
      const blockedChannelNames: string[] = [];
      const releasedIds: string[] = [];

      if (request.kind === "release") {
        for (const overrideId of request.releaseOverrideIds) {
          const response = await runRevisionedCommand(
            revision,
            (nextRevision) =>
              cancelManualOverride(overrideId, {
                expectedRevision: nextRevision,
              }),
          );
          revision = response.mutation.revision;
          operationIds.push(response.operation.id);
          releasedIds.push(overrideId);
        }
        return {
          kind: request.kind,
          revision,
          operationIds,
          blockedChannelNames,
          releasedOverrideIds: releasedIds,
        };
      }

      for (const channel of request.channels) {
        const targetOverrides = request.overrides.filter(
          (override) =>
            override.targetType === "channel" &&
            override.targetId === channel.id,
        );
        let blocked = false;
        let replaceOverrideId: string | undefined;
        for (const override of targetOverrides) {
          const view = deriveManualOverrideView(
            override,
            request.operations,
            request.nowMs,
          );
          if (!view.blocksNewStart) continue;
          if (view.phase === "active") {
            replaceOverrideId = override.id;
            continue;
          }
          blocked = true;
          break;
        }
        if (blocked) {
          blockedChannelNames.push(channel.name);
          continue;
        }
        try {
          const response = await runRevisionedCommand(
            revision,
            (nextRevision) =>
              startManualOverride({
                expectedRevision: nextRevision,
                ...(replaceOverrideId === undefined
                  ? {}
                  : { replaceOverrideId }),
                target: { targetType: "channel", targetId: channel.id },
                valuePercentage: request.valuesByChannel.get(channel.id) ?? 0,
                durationSeconds: request.durationSeconds,
              }),
          );
          revision = response.mutation.revision;
          operationIds.push(response.operation.id);
        } catch (error) {
          if (
            error instanceof AquariumApiError &&
            isUnusedOverrideTarget(error)
          ) {
            continue;
          }
          throw error;
        }
      }
      return {
        kind: request.kind,
        revision,
        operationIds,
        blockedChannelNames,
        releasedOverrideIds: releasedIds,
      };
    },
    onSuccess: (result) => {
      draftRevision.reset();
      onAcceptedRevision?.(result.revision);
      if (result.kind === "release") {
        setDraftValues(new Map());
        setReleasedOverrideIds(
          (current) => new Set([...current, ...result.releasedOverrideIds]),
        );
      }
      refresh();
    },
    onError: (error) => {
      if (currentRevisionFromError(error) !== null) refresh();
    },
  });
  const batchData = batch.data;
  const resetBatch = batch.reset;
  const batchConfirmation =
    batchData === undefined
      ? null
      : overrideBatchConfirmation(batchData.operationIds, operations);
  const batchKind = batchData?.kind ?? batch.variables?.kind;
  const confirmationPending = batchConfirmation === "pending";
  const busy = batch.isPending || confirmationPending;
  useEffect(() => {
    onBusyChange?.(busy);
  }, [busy, onBusyChange]);
  useEffect(() => {
    if (
      batchData === undefined ||
      batchConfirmation === null ||
      batchConfirmation === "pending"
    ) {
      return;
    }
    const timeout = window.setTimeout(() => resetBatch(), 3_000);
    return () => window.clearTimeout(timeout);
  }, [batchConfirmation, batchData, resetBatch]);
  const releaseOverrideIds = overrides
    .filter(
      (override) =>
        !releasedOverrideIds.has(override.id) && override.status === "active",
    )
    .map((override) => override.id);
  const activeCount = releaseOverrideIds.length;

  function batchRequest(kind: OverrideBatchKind): OverrideBatchRequest {
    return {
      kind,
      expectedRevision: draftRevision.revision,
      overrides,
      releaseOverrideIds,
      operations,
      nowMs: currentTimeMs,
      channels: channels
        .map(({ channel }) => channel)
        .filter((channel) => commandableChannelIds.has(channel.id)),
      valuesByChannel: new Map(
        channels.map(({ channel }) => [
          channel.id,
          draftValues.get(channel.id) ??
            liveOverrideByChannel.get(channel.id)?.valuePercentage ??
            scheduledValues.get(channel.id) ??
            0,
        ]),
      ),
      durationSeconds,
    };
  }

  return (
    <section
      className="temporary-overrides"
      aria-labelledby="temporary-overrides-heading"
    >
      <div className="override-heading">
        <div>
          <p className="eyebrow">Live testing</p>
          <h2 id="temporary-overrides-heading">Temporary overrides</h2>
        </div>
        <div className="override-heading-meta">
          <label>
            Duration
            <select
              value={durationSeconds}
              disabled={busy || disabled}
              onChange={(event) => {
                draftRevision.pin();
                setDurationSeconds(Number(event.currentTarget.value));
              }}
            >
              {durationChoices.map((choice) => (
                <option key={choice.seconds} value={choice.seconds}>
                  {choice.label}
                </option>
              ))}
            </select>
          </label>
        </div>
      </div>

      {channels.length === 0 ? (
        <p className="empty-panel">This area has no channels to test.</p>
      ) : (
        <div className="override-bank">
          {channels.map(({ channel }) => {
            const activeOverride = liveOverrideByChannel.get(channel.id);
            const scheduled = scheduledValues.get(channel.id) ?? 0;
            const value =
              draftValues.get(channel.id) ??
              activeOverride?.valuePercentage ??
              scheduled;
            return (
              <label className="override-slider" key={channel.id}>
                <span
                  className="override-channel-color"
                  style={{ backgroundColor: channel.color }}
                  aria-hidden="true"
                />
                <strong>{channel.name}</strong>
                <output>{Math.round(value)}%</output>
                <input
                  aria-label={`${channel.name} temporary override`}
                  className="vertical-range"
                  type="range"
                  min="0"
                  max="100"
                  step="1"
                  value={value}
                  disabled={busy || disabled}
                  onChange={(event) => {
                    const next = new Map(draftValues);
                    next.set(channel.id, event.currentTarget.valueAsNumber);
                    draftRevision.pin();
                    setDraftValues(next);
                  }}
                />
                <small>
                  {activeOverride === undefined
                    ? `Scheduled ${scheduled}%`
                    : activeOverride.status}
                </small>
              </label>
            );
          })}
        </div>
      )}

      <div className="override-actions">
        <button
          className="secondary-button"
          type="button"
          disabled={activeCount === 0 || busy || disabled}
          onClick={() => batch.mutate(batchRequest("release"))}
        >
          {confirmationPending && batchKind === "release"
            ? "Confirming…"
            : batch.isPending && batch.variables.kind === "release"
              ? "Releasing…"
              : "Release all"}
        </button>
        <button
          className="primary-button"
          type="button"
          disabled={channels.length === 0 || busy || disabled}
          onClick={() => {
            draftRevision.pin();
            batch.mutate(batchRequest("apply"));
          }}
        >
          {confirmationPending && batchKind === "apply"
            ? "Confirming…"
            : batch.isPending && batch.variables.kind === "apply"
              ? "Applying…"
              : "Apply test levels"}
        </button>
      </div>

      {batch.error === null ? null : (
        <p className="field-error" role="alert">
          {configurationErrorMessage(batch.error)} Some earlier commands in this
          batch may already have been accepted; refresh and review the
          authoritative override state.
        </p>
      )}
      {batch.data === undefined ||
      batchConfirmation === null ? null : batchConfirmation === "failed" ? (
        <p className="field-error" role="alert">
          An ESP did not confirm the requested output. Review the device status
          and unresolved operations before trying again.
        </p>
      ) : (
        <p className="override-command-notice" role="status">
          {batchConfirmation === "pending"
            ? "Waiting for ESP confirmation…"
            : "Success"}
          {batch.data.blockedChannelNames.length === 0
            ? ""
            : ` Unresolved override state blocked: ${batch.data.blockedChannelNames.join(", ")}.`}
        </p>
      )}

      <UnresolvedOverrides
        overrides={overrides}
        operations={operations}
        channelNames={
          new Map(channels.map(({ channel }) => [channel.id, channel.name]))
        }
        expectedRevision={expectedRevision}
        nowMs={currentTimeMs}
        disabled={disabled}
        refresh={refresh}
      />
    </section>
  );
}

function overrideBatchConfirmation(
  operationIds: readonly string[],
  operations: readonly OperationSummary[],
): OverrideBatchConfirmation {
  if (operationIds.length === 0) return "succeeded";
  const operationsById = new Map(
    operations.map((operation) => [operation.id, operation]),
  );
  const acceptedOperations = operationIds.map((id) => operationsById.get(id));
  if (
    acceptedOperations.some(
      (operation) =>
        operation === undefined ||
        operation.status === "pending" ||
        operation.status === "in_flight",
    )
  ) {
    return "pending";
  }
  return acceptedOperations.every(
    (operation) => operation?.status === "succeeded",
  )
    ? "succeeded"
    : "failed";
}

function isUnusedOverrideTarget(error: AquariumApiError): boolean {
  return (
    error.details.code === "relational_conflict" &&
    error.details.conflicts.some(
      (conflict) => conflict.relation === "enabled_pin_mapping",
    )
  );
}

function UnresolvedOverrides({
  overrides,
  operations,
  channelNames,
  expectedRevision,
  nowMs,
  disabled,
  refresh,
}: {
  readonly overrides: readonly Override[];
  readonly operations: readonly OperationSummary[];
  readonly channelNames: ReadonlyMap<string, string>;
  readonly expectedRevision: number;
  readonly nowMs: number;
  readonly disabled: boolean;
  readonly refresh: () => void;
}): React.JSX.Element | null {
  const unresolved = overrides
    .map((override) => ({
      override,
      view: deriveManualOverrideView(override, operations, nowMs),
    }))
    .filter(({ view }) => view.phase === "outcome_unknown");
  const reconcile = useMutation({
    retry: false,
    mutationFn: (overrideId: string) =>
      reconcileManualOverride(overrideId, { expectedRevision }),
    onSuccess: refresh,
    onError: (error) => {
      if (currentRevisionFromError(error) !== null) refresh();
    },
  });
  if (unresolved.length === 0) return null;
  return (
    <div className="unresolved-overrides" role="alert">
      <strong>Unknown override outcome</strong>
      {unresolved.map(({ override, view }) => (
        <div key={override.id}>
          <span>
            {channelNames.get(override.targetId) ?? "Unknown target"}: the
            controller cannot safely claim the current actuator state.
          </span>
          {view.canReconcile ? (
            <button
              className="secondary-button"
              type="button"
              disabled={reconcile.isPending || disabled}
              onClick={() => reconcile.mutate(override.id)}
            >
              Reconcile
            </button>
          ) : null}
        </div>
      ))}
      {reconcile.error === null ? null : (
        <p className="field-error">
          {configurationErrorMessage(reconcile.error)}
        </p>
      )}
    </div>
  );
}

function utcMinuteOfDay(epochMs: number): number {
  const date = new Date(epochMs);
  return date.getUTCHours() * 60 + date.getUTCMinutes();
}

async function runRevisionedCommand<
  Response extends { readonly mutation: { readonly revision: number } },
>(
  initialRevision: number,
  command: (expectedRevision: number) => Promise<Response>,
): Promise<Response> {
  let revision = initialRevision;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      return await command(revision);
    } catch (error) {
      const currentRevision =
        error instanceof Error ? currentRevisionFromError(error) : null;
      if (currentRevision === null || currentRevision <= revision) throw error;
      // A revision conflict guarantees that this command was rejected before
      // dispatch. Rebasing that unaccepted member keeps a best-effort batch
      // moving while never retrying an ambiguous actuator outcome.
      revision = currentRevision;
    }
  }
  throw new Error(
    "Controller state kept changing while the override batch was being recorded.",
  );
}

function useCurrentTime(readNowMs: () => number): number {
  const [nowMs, setNowMs] = useState(readNowMs);
  useEffect(() => {
    const interval = window.setInterval(() => setNowMs(readNowMs()), 30_000);
    return () => window.clearInterval(interval);
  }, [readNowMs]);
  return nowMs;
}
