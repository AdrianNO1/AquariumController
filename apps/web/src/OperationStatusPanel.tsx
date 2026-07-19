import type { OperationSummary } from "@aquarium/contracts";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";

import { fetchOperationDetails } from "./api.js";

interface OperationStatusPanelProps {
  readonly operations: readonly OperationSummary[];
  readonly truncated: boolean;
}

export function OperationStatusPanel({
  operations,
  truncated,
}: OperationStatusPanelProps): React.JSX.Element {
  const [selectedOperationId, setSelectedOperationId] = useState<string | null>(
    null,
  );
  return (
    <section className="control-panel" aria-labelledby="operations-heading">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Authoritative outcomes</p>
          <h2 id="operations-heading">Recent operations</h2>
        </div>
        <span className="section-count">{operations.length} shown</span>
      </div>
      {operations.length === 0 ? (
        <p className="empty-panel">
          No recent device operations for this area.
        </p>
      ) : (
        <ul className="operation-list">
          {operations.map((operation) => (
            <li key={operation.id}>
              <span
                className={`operation-symbol operation-${operation.status}`}
                aria-hidden="true"
              >
                {operationSymbol(operation.status)}
              </span>
              <span>
                <strong>{operation.kind.replaceAll("_", " ")}</strong>
                <small>
                  {operation.deviceId ?? "Controller"} · {operation.status}
                </small>
              </span>
              <time dateTime={operation.requestedAt}>
                {formatUtc(operation.requestedAt)}
              </time>
              <button
                className="text-button"
                type="button"
                onClick={() => setSelectedOperationId(operation.id)}
              >
                Inspect {operation.id}
              </button>
            </li>
          ))}
        </ul>
      )}
      {truncated ? (
        <p className="information-banner">
          The snapshot operation window is truncated; older operations remain in
          controller storage.
        </p>
      ) : null}
      {selectedOperationId === null ? null : (
        <OperationDetails
          operationId={selectedOperationId}
          onClose={() => setSelectedOperationId(null)}
        />
      )}
    </section>
  );
}

function OperationDetails({
  operationId,
  onClose,
}: {
  readonly operationId: string;
  readonly onClose: () => void;
}): React.JSX.Element {
  const query = useQuery({
    queryKey: ["operation-details", operationId],
    queryFn: ({ signal }) => fetchOperationDetails(operationId, signal),
  });
  return (
    <div className="operation-details" aria-live="polite">
      <div className="section-heading compact-heading">
        <h3>Operation {operationId}</h3>
        <button className="text-button" type="button" onClick={onClose}>
          Close details
        </button>
      </div>
      {query.isPending ? <p>Loading operation details…</p> : null}
      {query.error === null ? null : (
        <div className="error-banner" role="alert">
          <span>{query.error.message}</span>
          <button type="button" onClick={() => void query.refetch()}>
            Retry details
          </button>
        </div>
      )}
      {query.data === undefined ? null : (
        <>
          <dl className="operation-detail-summary">
            <div>
              <dt>Status</dt>
              <dd>{query.data.operation.status}</dd>
            </div>
            <div>
              <dt>Requested</dt>
              <dd>{formatUtc(query.data.operation.requestedAt)}</dd>
            </div>
            <div>
              <dt>Completed</dt>
              <dd>
                {query.data.operation.completedAt === null
                  ? "Not completed"
                  : formatUtc(query.data.operation.completedAt)}
              </dd>
            </div>
          </dl>
          <details>
            <summary>Request payload</summary>
            <pre>{JSON.stringify(query.data.request.data, null, 2)}</pre>
          </details>
          <details>
            <summary>Result payload</summary>
            <pre>
              {query.data.result === null
                ? "No terminal result"
                : JSON.stringify(query.data.result.data, null, 2)}
            </pre>
          </details>
        </>
      )}
    </div>
  );
}

function operationSymbol(status: OperationSummary["status"]): string {
  switch (status) {
    case "succeeded":
      return "✓";
    case "failed":
    case "timed_out":
    case "outcome_unknown":
    case "cancelled":
      return "!";
    case "pending":
    case "in_flight":
      return "…";
  }
}

function formatUtc(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(new Date(value));
}
