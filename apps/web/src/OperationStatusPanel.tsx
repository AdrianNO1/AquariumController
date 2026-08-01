import type {
  Device,
  OperationDetailsResponse,
  OperationSummary,
} from "@aquarium/contracts";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { z } from "zod";

import { fetchOperationDetails, reconcileDeviceOperation } from "./api.js";
import { configurationErrorMessage } from "./configuration-ui.js";

interface OperationStatusPanelProps {
  readonly operations: readonly OperationSummary[];
  readonly devices?: readonly Device[];
  readonly truncated: boolean;
  readonly expectedRevision: number;
  readonly refresh: () => void;
}

interface OperationStatusPanelCopy {
  readonly headingId: string;
  readonly eyebrow: string;
  readonly heading: string;
  readonly empty: string;
  readonly truncated: string;
}

const recentOperationCopy: OperationStatusPanelCopy = {
  headingId: "operations-heading",
  eyebrow: "Authoritative outcomes",
  heading: "Recent operations",
  empty: "No recent device operations for this area.",
  truncated:
    "The snapshot operation window is truncated; older operations remain in controller storage.",
};

const unresolvedOperationCopy: OperationStatusPanelCopy = {
  headingId: "unresolved-operations-heading",
  eyebrow: "Safety recovery",
  heading: "Unresolved device outcomes",
  empty: "No device operations currently require operator reconciliation.",
  truncated:
    "The unresolved outcome window is full. Reconcile the displayed outcomes to reveal any remaining operations.",
};

export function OperationStatusPanel(
  props: OperationStatusPanelProps,
): React.JSX.Element {
  return <OperationListPanel {...props} copy={recentOperationCopy} />;
}

export function UnresolvedOperationStatusPanel(
  props: OperationStatusPanelProps,
): React.JSX.Element {
  return <OperationListPanel {...props} copy={unresolvedOperationCopy} />;
}

function OperationListPanel({
  operations,
  devices = [],
  truncated,
  expectedRevision,
  refresh,
  copy,
}: OperationStatusPanelProps & {
  readonly copy: OperationStatusPanelCopy;
}): React.JSX.Element {
  const [selectedOperationId, setSelectedOperationId] = useState<string | null>(
    null,
  );
  const deviceNames = new Map(
    devices.map((device) => [device.id, device.desired.name]),
  );
  return (
    <section className="control-panel" aria-labelledby={copy.headingId}>
      <div className="section-heading">
        <div>
          <p className="eyebrow">{copy.eyebrow}</p>
          <h2 id={copy.headingId}>{copy.heading}</h2>
        </div>
        <span className="section-count">{operations.length} shown</span>
      </div>
      {operations.length === 0 ? (
        <p className="empty-panel">{copy.empty}</p>
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
                  {operation.deviceId === null
                    ? "Controller"
                    : (deviceNames.get(operation.deviceId) ??
                      operation.deviceId)}{" "}
                  · {operation.status}
                </small>
              </span>
              <time dateTime={operation.requestedAt}>
                {formatLocalTime(operation.requestedAt)}
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
        <p className="information-banner">{copy.truncated}</p>
      ) : null}
      {selectedOperationId === null ? null : (
        <OperationDetails
          key={selectedOperationId}
          operationId={selectedOperationId}
          expectedRevision={expectedRevision}
          refresh={refresh}
          onClose={() => setSelectedOperationId(null)}
        />
      )}
    </section>
  );
}

function OperationDetails({
  operationId,
  expectedRevision,
  refresh,
  onClose,
}: {
  readonly operationId: string;
  readonly expectedRevision: number;
  readonly refresh: () => void;
  readonly onClose: () => void;
}): React.JSX.Element {
  const [physicalStateVerified, setPhysicalStateVerified] = useState(false);
  const query = useQuery({
    queryKey: ["operation-details", operationId],
    queryFn: ({ signal }) => fetchOperationDetails(operationId, signal),
  });
  const reconciliation = useMutation({
    retry: false,
    mutationFn: () => reconcileDeviceOperation(operationId, expectedRevision),
    onSuccess: refresh,
  });
  const deviceOutcome =
    query.data === undefined ? null : readDeviceUnknownOutcome(query.data);
  const canReconcile =
    deviceOutcome?.reconciledAtMs === null && reconciliation.data === undefined;

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
              <dd>{formatLocalTime(query.data.operation.requestedAt)}</dd>
            </div>
            <div>
              <dt>Completed</dt>
              <dd>
                {query.data.operation.completedAt === null
                  ? "Not completed"
                  : formatLocalTime(query.data.operation.completedAt)}
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
          {canReconcile ? (
            <div className="operation-reconcile-warning" role="alert">
              <strong>Device outcome is unknown.</strong>
              <p>
                Verify the aquarium output and the device&apos;s physical state
                before reconciling. Reconciliation records that verification; it
                does not prove whether the command ran.
              </p>
              <label>
                <input
                  type="checkbox"
                  checked={physicalStateVerified}
                  onChange={(event) =>
                    setPhysicalStateVerified(event.currentTarget.checked)
                  }
                />
                I have verified the physical and device state.
              </label>
              <button
                className="danger-button"
                type="button"
                disabled={!physicalStateVerified || reconciliation.isPending}
                onClick={() => reconciliation.mutate()}
              >
                Reconcile this unknown device outcome
              </button>
            </div>
          ) : null}
          {reconciliation.isPending ? (
            <p className="muted-copy" role="status">
              Recording operator reconciliation...
            </p>
          ) : null}
          {reconciliation.error === null ? null : (
            <p className="field-error" role="alert">
              {configurationErrorMessage(reconciliation.error)}
            </p>
          )}
          {reconciliation.data === undefined ? null : (
            <p className="information-banner" role="status">
              Reconciliation recorded at authoritative revision{" "}
              {reconciliation.data.revision}. The original device outcome
              remains unknown.
            </p>
          )}
          {deviceOutcome?.reconciledAtMs === undefined ||
          deviceOutcome.reconciledAtMs === null ? null : (
            <p className="information-banner">
              This unknown device outcome was reconciled at{" "}
              {formatLocalTime(
                new Date(deviceOutcome.reconciledAtMs).toISOString(),
              )}
              .
            </p>
          )}
        </>
      )}
    </div>
  );
}

const deviceUnknownOutcomeSchema = z.object({
  status: z.literal("outcome_unknown"),
  reconciledAtMs: z.number().int().nonnegative().nullable(),
});

function readDeviceUnknownOutcome(
  details: OperationDetailsResponse,
): z.infer<typeof deviceUnknownOutcomeSchema> | null {
  if (
    details.operation.deviceId === null ||
    details.operation.status !== "outcome_unknown" ||
    details.result === null
  ) {
    return null;
  }
  const result = deviceUnknownOutcomeSchema.safeParse(details.result.data);
  return result.success ? result.data : null;
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

function formatLocalTime(value: string): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}
