import {
  alertHistoryStateFilterSchema,
  type AlertHistoryStateFilter,
  type AlertRule,
  type NotificationDelivery,
} from "@aquarium/contracts";
import { keepPreviousData, useMutation, useQuery } from "@tanstack/react-query";
import { useMemo, useState, type FormEvent } from "react";
import { useSearchParams } from "react-router";

import {
  acknowledgeAlert,
  AquariumApiError,
  fetchAlertHistory,
} from "./api.js";
import {
  buildAlertsReadModel,
  type AlertPresentationItem,
  type AlertsReadModel,
} from "./alert-read-model.js";
import {
  buildAlertSearchParams,
  parseAlertSearchParams,
} from "./alert-search-state.js";
import { useControllerState } from "./use-controller-state.js";
import { useDraftRevision } from "./use-draft-revision.js";

interface AcknowledgeVariables {
  readonly alertId: string;
  readonly expectedRevision: number;
  readonly note: string | null;
}

interface AlertCardProps {
  readonly item: AlertPresentationItem;
  readonly snapshotRevision: number;
  readonly actionsDisabled: boolean;
  readonly showStateWarning: boolean;
  readonly deliveriesTruncated: boolean;
  readonly acknowledgement: ReturnType<typeof useAlertAcknowledgement>;
}

const STORAGE_SENSOR_PRESENTATION: Readonly<
  Record<
    string,
    {
      readonly source: string;
      readonly condition: (threshold: number) => string;
    }
  >
> = {
  "controller-storage-filesystem-free-bytes": {
    source: "Controller filesystem free space",
    condition: (threshold) => `Free space below ${formatBytes(threshold)}`,
  },
  "controller-storage-projected-one-year-bytes": {
    source: "Projected controller storage after one year",
    condition: (threshold) =>
      `Projected storage above ${formatBytes(threshold)}`,
  },
  "controller-storage-failed-retention-runs": {
    source: "Retention maintenance",
    condition: () => "One or more unresolved failures",
  },
  "controller-storage-failed-archives": {
    source: "Event archiving",
    condition: () => "One or more unresolved failures",
  },
  "controller-storage-latest-backup-failed": {
    source: "Latest controller backup",
    condition: () => "Latest backup failed",
  },
  "controller-storage-successful-backup-missing-or-stale": {
    source: "Successful controller backups",
    condition: () => "No recent verified backup",
  },
};

function conditionLabel(rule: AlertRule): string {
  const storagePresentation =
    rule.source.type === "sensor"
      ? STORAGE_SENSOR_PRESENTATION[rule.source.id]
      : undefined;
  if (storagePresentation !== undefined && "threshold" in rule.condition) {
    return storagePresentation.condition(rule.condition.threshold);
  }
  const kind = rule.condition.kind.replaceAll("_", " ");
  return "threshold" in rule.condition
    ? `${kind} ${rule.condition.threshold}`
    : kind;
}

function sourceLabel(rule: AlertRule): string {
  if (rule.source.type === "sensor") {
    return (
      STORAGE_SENSOR_PRESENTATION[rule.source.id]?.source ??
      `Sensor: ${humanizeIdentifier(rule.source.id)}`
    );
  }
  return `${capitalize(rule.source.type)}: ${rule.source.id}`;
}

function humanizeIdentifier(value: string): string {
  return value.replaceAll(/[-_]+/gu, " ");
}

function capitalize(value: string): string {
  return `${value.slice(0, 1).toUpperCase()}${value.slice(1)}`;
}

function formatBytes(bytes: number): string {
  const gibibytes = bytes / 1024 ** 3;
  if (gibibytes >= 1) {
    return `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 1 }).format(gibibytes)} GiB`;
  }
  const mebibytes = bytes / 1024 ** 2;
  return `${new Intl.NumberFormat(undefined, { maximumFractionDigits: 0 }).format(mebibytes)} MiB`;
}

function deliveryLabel(delivery: NotificationDelivery): string {
  return `${delivery.destinationKind} ${delivery.transition.replaceAll("_", " ")}`;
}

function acknowledgementError(error: Error): string {
  if (
    error instanceof AquariumApiError &&
    error.details.code === "revision_conflict"
  ) {
    return `Controller state advanced to revision ${error.details.currentRevision}. A fresh snapshot was requested; review this alert before retrying.`;
  }
  return error.message;
}

function useAlertAcknowledgement(refresh: () => void) {
  return useMutation({
    mutationFn: (variables: AcknowledgeVariables) =>
      acknowledgeAlert(variables.alertId, {
        expectedRevision: variables.expectedRevision,
        note: variables.note,
      }),
    onSuccess: refresh,
    onError: (error) => {
      if (
        error instanceof AquariumApiError &&
        error.details.code === "revision_conflict"
      ) {
        refresh();
      }
    },
  });
}

function DeliveryList({
  deliveries,
}: {
  readonly deliveries: readonly NotificationDelivery[];
}): React.JSX.Element {
  if (deliveries.length === 0) {
    return <p className="muted-copy">No notification delivery recorded.</p>;
  }
  return (
    <ul className="delivery-list">
      {deliveries.map((delivery) => {
        const failed = ["failed", "outcome_unknown"].includes(delivery.status);
        return (
          <li key={delivery.id} className={failed ? "delivery-failed" : ""}>
            <strong>{deliveryLabel(delivery)}</strong>
            <span>Status: {delivery.status.replaceAll("_", " ")}</span>
            {delivery.lastError === null ? null : (
              <span role="alert">
                {delivery.lastError.code}: {delivery.lastError.message}
              </span>
            )}
          </li>
        );
      })}
    </ul>
  );
}

function AlertCard({
  item,
  snapshotRevision,
  actionsDisabled,
  showStateWarning,
  deliveriesTruncated,
  acknowledgement,
}: AlertCardProps): React.JSX.Element {
  const [note, setNote] = useState("");
  const draftRevision = useDraftRevision(snapshotRevision);
  const { alert, rule } = item;
  const isThisMutation = acknowledgement.variables?.alertId === alert.id;
  const pending = isThisMutation && acknowledgement.isPending;
  const succeeded = isThisMutation && acknowledgement.isSuccess;
  const error =
    isThisMutation && acknowledgement.isError
      ? acknowledgementError(acknowledgement.error)
      : null;
  const conflictRevision =
    isThisMutation && acknowledgement.isError
      ? currentAlertConflictRevision(acknowledgement.error)
      : null;
  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const trimmedNote = note.trim();
    acknowledgement.mutate(
      {
        alertId: alert.id,
        expectedRevision: draftRevision.revision,
        note: trimmedNote.length === 0 ? null : trimmedNote,
      },
      {
        onSuccess: draftRevision.reset,
      },
    );
  };

  return (
    <article className={`alert-card alert-${rule.severity}`}>
      <header>
        <div>
          <span className="alert-severity">{rule.severity}</span>
          <h3>{rule.name}</h3>
        </div>
        <span className="state-pill">{alert.state}</span>
      </header>
      <dl className="alert-facts">
        <div>
          <dt>Source</dt>
          <dd>{sourceLabel(rule)}</dd>
        </div>
        <div>
          <dt>Condition</dt>
          <dd>{conditionLabel(rule)}</dd>
        </div>
        <div>
          <dt>Opened</dt>
          <dd>{new Date(alert.openedAt).toLocaleString()}</dd>
        </div>
        <div>
          <dt>Last observed</dt>
          <dd>{new Date(alert.lastObservedAt).toLocaleString()}</dd>
        </div>
        {alert.acknowledgedAt === null ? null : (
          <div>
            <dt>Acknowledged</dt>
            <dd>{new Date(alert.acknowledgedAt).toLocaleString()}</dd>
          </div>
        )}
        {alert.recoveredAt === null ? null : (
          <div>
            <dt>Recovered</dt>
            <dd>{new Date(alert.recoveredAt).toLocaleString()}</dd>
          </div>
        )}
      </dl>

      {alert.details?.note === null ||
      alert.details?.note === undefined ? null : (
        <p className="alert-note">{alert.details.note}</p>
      )}

      <section aria-label={`Notification delivery for ${rule.name}`}>
        <h4>Notification delivery</h4>
        <DeliveryList deliveries={alert.notificationDeliveries} />
        {deliveriesTruncated ? (
          <p className="information-banner">
            Only the most recent notification deliveries are included for this
            alert.
          </p>
        ) : null}
      </section>

      {alert.state !== "open" ? null : (
        <form
          className="acknowledgement-form"
          onFocusCapture={draftRevision.pin}
          onSubmit={submit}
        >
          <label htmlFor={`ack-note-${alert.id}`}>
            Acknowledgement note (optional)
          </label>
          <input
            id={`ack-note-${alert.id}`}
            value={note}
            maxLength={256}
            onChange={(event) => {
              const nextNote = event.target.value;
              if (nextNote.length === 0) {
                draftRevision.reset();
              } else {
                draftRevision.pin();
              }
              setNote(nextNote);
            }}
            disabled={pending || succeeded}
          />
          <button
            className="primary-button"
            type="submit"
            disabled={actionsDisabled || pending || succeeded}
          >
            {pending
              ? "Acknowledging…"
              : succeeded
                ? "Acknowledgement sent"
                : "Acknowledge alert"}
          </button>
          {showStateWarning ? (
            <p className="field-error" role="status">
              Acknowledgement is disabled until the authoritative snapshot is
              current.
            </p>
          ) : null}
          {error === null ? null : (
            <p className="field-error" role="alert">
              {error}
            </p>
          )}
          {conflictRevision === null ? null : (
            <button
              className="text-button"
              type="button"
              disabled={snapshotRevision < conflictRevision}
              onClick={() => {
                draftRevision.rebase();
                acknowledgement.reset();
              }}
            >
              Keep acknowledgement draft with refreshed revision
            </button>
          )}
        </form>
      )}
    </article>
  );
}

function currentAlertConflictRevision(error: Error): number | null {
  return error instanceof AquariumApiError &&
    error.details.code === "revision_conflict"
    ? error.details.currentRevision
    : null;
}

function AlertSection({
  id,
  title,
  emptyMessage,
  items,
  snapshotRevision,
  actionsDisabled,
  showStateWarning,
  truncatedDeliveryIds,
  acknowledgement,
}: {
  readonly id: string;
  readonly title: string;
  readonly emptyMessage: string;
  readonly items: readonly AlertPresentationItem[];
  readonly snapshotRevision: number;
  readonly actionsDisabled: boolean;
  readonly showStateWarning: boolean;
  readonly truncatedDeliveryIds: ReadonlySet<string>;
  readonly acknowledgement: ReturnType<typeof useAlertAcknowledgement>;
}): React.JSX.Element {
  return (
    <section className="alert-section" aria-labelledby={id}>
      <h2 id={id}>
        {title} <span>{items.length}</span>
      </h2>
      {items.length === 0 ? (
        <p className="empty-panel">{emptyMessage}</p>
      ) : (
        <div className="alert-grid">
          {items.map((item) => (
            <AlertCard
              key={item.alert.id}
              item={item}
              snapshotRevision={snapshotRevision}
              actionsDisabled={actionsDisabled}
              showStateWarning={showStateWarning}
              deliveriesTruncated={truncatedDeliveryIds.has(item.alert.id)}
              acknowledgement={acknowledgement}
            />
          ))}
        </div>
      )}
    </section>
  );
}

function AlertsPresentation({
  model,
  snapshotRevision,
  actionsDisabled,
  showStateWarning,
  stateFilter,
  truncatedDeliveryIds,
  acknowledgement,
}: {
  readonly model: AlertsReadModel;
  readonly snapshotRevision: number;
  readonly actionsDisabled: boolean;
  readonly showStateWarning: boolean;
  readonly stateFilter: AlertHistoryStateFilter;
  readonly truncatedDeliveryIds: ReadonlySet<string>;
  readonly acknowledgement: ReturnType<typeof useAlertAcknowledgement>;
}): React.JSX.Element {
  return (
    <>
      <section className="summary-strip" aria-label="Alert summary">
        <div>
          <span>Open</span>
          <strong>{model.open.length}</strong>
        </div>
        <div>
          <span>Acknowledged</span>
          <strong>{model.acknowledged.length}</strong>
        </div>
        <div>
          <span>Recovered in view</span>
          <strong>{model.recovered.length}</strong>
        </div>
      </section>
      {stateFilter === "active" ||
      stateFilter === "open" ||
      stateFilter === "all" ? (
        <AlertSection
          id="open-alerts"
          title="Open"
          emptyMessage="No open alerts on this page."
          items={model.open}
          snapshotRevision={snapshotRevision}
          actionsDisabled={actionsDisabled}
          showStateWarning={showStateWarning}
          truncatedDeliveryIds={truncatedDeliveryIds}
          acknowledgement={acknowledgement}
        />
      ) : null}
      {stateFilter === "active" ||
      stateFilter === "acknowledged" ||
      stateFilter === "all" ? (
        <AlertSection
          id="acknowledged-alerts"
          title="Acknowledged"
          emptyMessage="No acknowledged alerts on this page."
          items={model.acknowledged}
          snapshotRevision={snapshotRevision}
          actionsDisabled={actionsDisabled}
          showStateWarning={showStateWarning}
          truncatedDeliveryIds={truncatedDeliveryIds}
          acknowledgement={acknowledgement}
        />
      ) : null}
      {stateFilter === "recovered" || stateFilter === "all" ? (
        <AlertSection
          id="recovered-alerts"
          title="Recovered"
          emptyMessage="No recovered alerts on this page."
          items={model.recovered}
          snapshotRevision={snapshotRevision}
          actionsDisabled={actionsDisabled}
          showStateWarning={showStateWarning}
          truncatedDeliveryIds={truncatedDeliveryIds}
          acknowledgement={acknowledgement}
        />
      ) : null}
    </>
  );
}

export function AlertsPage(): React.JSX.Element {
  const controller = useControllerState();
  const snapshot = controller.snapshot;
  const [searchParams, setSearchParams] = useSearchParams();
  const searchKey = searchParams.toString();
  const parsedSearch = useMemo(
    () => parseAlertSearchParams(new URLSearchParams(searchKey)),
    [searchKey],
  );
  const request = parsedSearch.success ? parsedSearch.request : null;
  const [cursorHistory, setCursorHistory] = useState<readonly string[]>([]);
  const history = useQuery({
    queryKey: ["alert-history", searchKey, snapshot?.revision ?? null],
    queryFn: ({ signal }) => {
      if (request === null) {
        throw new Error("Cannot query alerts with invalid URL filters");
      }
      return fetchAlertHistory(request, signal);
    },
    enabled: request !== null && snapshot !== null,
    placeholderData: keepPreviousData,
  });
  const refreshAll = (): void => {
    controller.refresh();
    void history.refetch();
  };
  const acknowledgement = useAlertAcknowledgement(refreshAll);
  const model = useMemo(
    () =>
      snapshot === null || history.data === undefined
        ? null
        : buildAlertsReadModel(snapshot.alertRules, history.data.items),
    [history.data, snapshot],
  );
  const truncatedDeliveryIds = useMemo(
    () => new Set(history.data?.deliveriesTruncatedAlertIds ?? []),
    [history.data],
  );

  const changeFilters = (
    state: AlertHistoryStateFilter,
    pageSize: number,
  ): void => {
    setCursorHistory([]);
    setSearchParams(buildAlertSearchParams(state, pageSize));
  };
  const goToNextPage = (): void => {
    if (
      request === null ||
      history.data?.nextCursor === null ||
      history.data === undefined
    ) {
      return;
    }
    setCursorHistory((current) => [...current, request.cursor ?? ""]);
    const next = new URLSearchParams(searchKey);
    next.set("cursor", history.data.nextCursor);
    setSearchParams(next);
  };
  const goToPreviousPage = (): void => {
    const priorCursor = cursorHistory.at(-1);
    if (priorCursor === undefined) {
      return;
    }
    const next = new URLSearchParams(searchKey);
    if (priorCursor.length === 0) {
      next.delete("cursor");
    } else {
      next.set("cursor", priorCursor);
    }
    setCursorHistory((current) => current.slice(0, -1));
    setSearchParams(next);
  };

  return (
    <main className="page operations-page">
      <header className="page-heading">
        <div>
          <p className="eyebrow">Controller conditions</p>
          <h1>Alerts</h1>
          <p>
            Active alert lifecycle and one-attempt notification delivery state.
          </p>
        </div>
        <button
          className="secondary-button"
          type="button"
          onClick={refreshAll}
          disabled={history.isPending}
        >
          Refresh alerts
        </button>
      </header>

      <section className="filter-panel alert-filter" aria-label="Alert filters">
        <label>
          Lifecycle state
          <select
            value={request?.state ?? "active"}
            onChange={(event) =>
              changeFilters(
                alertHistoryStateFilterSchema.parse(event.target.value),
                request?.pageSize ?? 25,
              )
            }
          >
            <option value="active">Active</option>
            <option value="open">Open</option>
            <option value="acknowledged">Acknowledged</option>
            <option value="recovered">Recovered</option>
            <option value="all">All lifecycle states</option>
          </select>
        </label>
        <label>
          Rows per page
          <select
            value={String(request?.pageSize ?? 25)}
            onChange={(event) =>
              changeFilters(
                request?.state ?? "active",
                Number(event.target.value),
              )
            }
          >
            <option value="10">10</option>
            <option value="25">25</option>
            <option value="50">50</option>
          </select>
        </label>
      </section>

      {controller.error === null ? null : (
        <div className="error-banner" role="alert">
          <span>{controller.error}</span>
          <button type="button" onClick={controller.retry}>
            Retry state connection
          </button>
        </div>
      )}
      {!parsedSearch.success ? (
        <p className="error-banner" role="alert">
          {parsedSearch.message}
        </p>
      ) : null}
      {history.isError ? (
        <div className="error-banner" role="alert">
          <span>{history.error.message}</span>
          <button type="button" onClick={() => void history.refetch()}>
            Retry alert query
          </button>
        </div>
      ) : null}
      {model === null || snapshot === null || request === null ? (
        history.isError ? null : (
          <p className="loading-panel" role="status">
            {parsedSearch.success
              ? "Loading alert history…"
              : "Correct the alert filters to load history."}
          </p>
        )
      ) : (
        <>
          <AlertsPresentation
            model={model}
            snapshotRevision={snapshot.revision}
            actionsDisabled={
              controller.dataStale ||
              controller.status !== "connected" ||
              history.isPlaceholderData
            }
            showStateWarning={
              controller.status !== "connected" &&
              controller.status !== "loading"
            }
            stateFilter={request.state}
            truncatedDeliveryIds={truncatedDeliveryIds}
            acknowledgement={acknowledgement}
          />
          <nav className="pagination" aria-label="Alert pages">
            <button
              className="secondary-button"
              type="button"
              disabled={cursorHistory.length === 0 || history.isPlaceholderData}
              onClick={goToPreviousPage}
            >
              Previous page
            </button>
            <button
              className="secondary-button"
              type="button"
              disabled={!history.data?.hasMore || history.isPlaceholderData}
              onClick={goToNextPage}
            >
              Next page
            </button>
          </nav>
        </>
      )}
    </main>
  );
}
