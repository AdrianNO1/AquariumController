import {
  logExportFormatSchema,
  logExportRequestSchema,
  logsListRequestSchema,
  type LogEntry,
  type LogExportRequest,
  type LogsListRequest,
} from "@aquarium/contracts";
import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useMemo, useState, type FormEvent } from "react";
import { useSearchParams } from "react-router";

import { buildLogExportUrl, fetchLogs } from "./api.js";
import {
  buildLogSearchParams,
  logFilterFormFromRequest,
  parseLogSearchParams,
  type LogFilterFormState,
} from "./log-search-state.js";

const defaultLogsRequest = logsListRequestSchema.parse({});

const directionOptions = ["inbound", "outbound", "internal"] as const;
const severityOptions = [
  "debug",
  "info",
  "warning",
  "error",
  "critical",
] as const;
const outcomeOptions = [
  "pending",
  "succeeded",
  "failed",
  "timed_out",
  "outcome_unknown",
  "ignored",
] as const;
const retentionOptions = [
  "critical",
  "audit",
  "operational",
  "raw",
  "aggregate",
] as const;

interface LogsFilterFormProps {
  readonly request: LogsListRequest;
  readonly onApply: (search: URLSearchParams) => void;
  readonly onReset: () => void;
}

function LogsFilterForm({
  request,
  onApply,
  onReset,
}: LogsFilterFormProps): React.JSX.Element {
  const [form, setForm] = useState<LogFilterFormState>(() =>
    logFilterFormFromRequest(request),
  );
  const [error, setError] = useState<string | null>(null);
  const update = (field: keyof LogFilterFormState, value: string): void => {
    setForm((current) => ({ ...current, [field]: value }));
  };
  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const result = buildLogSearchParams(form);
    if (!result.success) {
      setError(result.message);
      return;
    }
    setError(null);
    onApply(result.search);
  };

  return (
    <form className="filter-panel" onSubmit={submit}>
      <fieldset>
        <legend>Log filters</legend>
        <div className="filter-grid">
          <label>
            Direction
            <select
              value={form.direction}
              onChange={(event) => update("direction", event.target.value)}
            >
              <option value="">All directions</option>
              {directionOptions.map((direction) => (
                <option key={direction} value={direction}>
                  {direction}
                </option>
              ))}
            </select>
          </label>
          <label>
            Severity
            <select
              value={form.severity}
              onChange={(event) => update("severity", event.target.value)}
            >
              <option value="">All severities</option>
              {severityOptions.map((severity) => (
                <option key={severity} value={severity}>
                  {severity}
                </option>
              ))}
            </select>
          </label>
          <label>
            Kind
            <input
              value={form.kind}
              maxLength={256}
              onChange={(event) => update("kind", event.target.value)}
              placeholder="mqtt.command"
            />
          </label>
          <label>
            Device ID
            <input
              value={form.deviceId}
              maxLength={128}
              onChange={(event) => update("deviceId", event.target.value)}
            />
          </label>
        </div>

        <details className="advanced-filters">
          <summary>Advanced filters</summary>
          <div className="filter-grid">
            <label>
              Start epoch (ms)
              <input
                value={form.startAtMs}
                inputMode="numeric"
                onChange={(event) => update("startAtMs", event.target.value)}
              />
            </label>
            <label>
              End epoch (ms)
              <input
                value={form.endAtMs}
                inputMode="numeric"
                onChange={(event) => update("endAtMs", event.target.value)}
              />
            </label>
            <label>
              Operation ID
              <input
                value={form.operationId}
                maxLength={128}
                onChange={(event) => update("operationId", event.target.value)}
              />
            </label>
            <label>
              Correlation ID
              <input
                value={form.correlationId}
                maxLength={128}
                onChange={(event) =>
                  update("correlationId", event.target.value)
                }
              />
            </label>
            <label>
              Outcome
              <select
                value={form.outcome}
                onChange={(event) => update("outcome", event.target.value)}
              >
                <option value="">All outcomes</option>
                {outcomeOptions.map((outcome) => (
                  <option key={outcome} value={outcome}>
                    {outcome.replaceAll("_", " ")}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Retention class
              <select
                value={form.retentionClass}
                onChange={(event) =>
                  update("retentionClass", event.target.value)
                }
              >
                <option value="">All classes</option>
                {retentionOptions.map((retentionClass) => (
                  <option key={retentionClass} value={retentionClass}>
                    {retentionClass}
                  </option>
                ))}
              </select>
            </label>
            <label>
              Rows per page
              <select
                value={form.pageSize}
                onChange={(event) => update("pageSize", event.target.value)}
              >
                <option value="25">25</option>
                <option value="50">50</option>
                <option value="100">100</option>
              </select>
            </label>
          </div>
        </details>
      </fieldset>
      {error === null ? null : (
        <p className="field-error" role="alert">
          {error}
        </p>
      )}
      <div className="button-row">
        <button className="primary-button" type="submit">
          Apply filters
        </button>
        <button className="secondary-button" type="button" onClick={onReset}>
          Reset filters
        </button>
      </div>
    </form>
  );
}

function LogEntryRow({
  entry,
}: {
  readonly entry: LogEntry;
}): React.JSX.Element {
  const occurredAt = new Date(entry.occurredAtMs);
  const validTime = Number.isFinite(occurredAt.getTime());
  return (
    <li className={`log-entry severity-${entry.severity}`}>
      <article>
        <div className="log-entry-primary">
          <span className="log-kind">{entry.kind}</span>
          <span className="log-severity">{entry.severity}</span>
        </div>
        <div>
          <span className="mobile-field-label">Occurred</span>
          <time {...(validTime ? { dateTime: occurredAt.toISOString() } : {})}>
            {validTime
              ? occurredAt.toLocaleString()
              : `Epoch ${entry.occurredAtMs}`}
          </time>
        </div>
        <div>
          <span className="mobile-field-label">Direction / outcome</span>
          {entry.direction} · {entry.outcome.replaceAll("_", " ")}
        </div>
        <div>
          <span className="mobile-field-label">Source</span>
          {entry.deviceId ?? entry.topic ?? "Controller"}
        </div>
        <details className="log-details">
          <summary>Inspect log {entry.id}</summary>
          <dl>
            <div>
              <dt>Retention</dt>
              <dd>{entry.retentionClass}</dd>
            </div>
            <div>
              <dt>Bytes</dt>
              <dd>{entry.byteCount.toLocaleString()}</dd>
            </div>
            <div>
              <dt>Duration</dt>
              <dd>
                {entry.durationMs === null
                  ? "Not recorded"
                  : `${entry.durationMs} ms`}
              </dd>
            </div>
            <div>
              <dt>Operation</dt>
              <dd>{entry.operationId ?? "None"}</dd>
            </div>
            <div>
              <dt>Correlation</dt>
              <dd>{entry.correlationId ?? "None"}</dd>
            </div>
            <div>
              <dt>Payload hash</dt>
              <dd>{entry.payloadSha256 ?? "No payload"}</dd>
            </div>
          </dl>
          {entry.payload === null ? (
            <p>No persisted payload.</p>
          ) : (
            <pre>{JSON.stringify(entry.payload, null, 2)}</pre>
          )}
        </details>
      </article>
    </li>
  );
}

function LogsExport({
  request,
}: {
  readonly request: LogsListRequest;
}): React.JSX.Element {
  const [format, setFormat] = useState<LogExportRequest["format"]>("csv");
  const [maxRows, setMaxRows] = useState("10000");
  const exportRequest = logExportRequestSchema.safeParse({
    filters: request.filters,
    format,
    maxRows: Number(maxRows),
  });

  return (
    <section className="export-panel" aria-labelledby="export-heading">
      <div>
        <p className="eyebrow">Bounded export</p>
        <h2 id="export-heading">Download inspected logs</h2>
        <p>
          The export uses the current filters and never exceeds the reviewed row
          limit.
        </p>
      </div>
      <div className="export-controls">
        <label>
          Format
          <select
            value={format}
            onChange={(event) =>
              setFormat(logExportFormatSchema.parse(event.target.value))
            }
          >
            <option value="csv">CSV</option>
            <option value="ndjson">NDJSON</option>
          </select>
        </label>
        <label>
          Maximum rows
          <input
            type="number"
            min="1"
            max="100000"
            value={maxRows}
            onChange={(event) => setMaxRows(event.target.value)}
          />
        </label>
        {exportRequest.success ? (
          <a
            className="primary-button export-link"
            href={buildLogExportUrl(exportRequest.data)}
            download
          >
            Download {format.toUpperCase()} export
          </a>
        ) : (
          <span className="field-error" role="alert">
            Choose a row limit from 1 to 100,000.
          </span>
        )}
      </div>
    </section>
  );
}

export function LogsPage(): React.JSX.Element {
  const [searchParams, setSearchParams] = useSearchParams();
  const searchKey = searchParams.toString();
  const parsedSearch = useMemo(
    () => parseLogSearchParams(new URLSearchParams(searchKey)),
    [searchKey],
  );
  const request = parsedSearch.success ? parsedSearch.request : null;
  const [cursorHistory, setCursorHistory] = useState<readonly string[]>([]);
  const logs = useQuery({
    queryKey: ["logs", searchKey],
    queryFn: ({ signal }) => {
      if (request === null) {
        throw new Error("Cannot query logs with invalid URL filters");
      }
      return fetchLogs(request, signal);
    },
    enabled: request !== null,
    placeholderData: keepPreviousData,
  });

  const goToNextPage = (): void => {
    if (
      request === null ||
      logs.data?.nextCursor === null ||
      logs.data === undefined
    ) {
      return;
    }
    setCursorHistory((history) => [...history, request.cursor ?? ""]);
    const next = new URLSearchParams(searchKey);
    next.set("cursor", logs.data.nextCursor);
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
    setCursorHistory((history) => history.slice(0, -1));
    setSearchParams(next);
  };

  return (
    <main className="page operations-page">
      <header className="page-heading">
        <div>
          <p className="eyebrow">Structured events</p>
          <h1>Logs</h1>
          <p>Validated, redacted controller and device interactions.</p>
        </div>
        <button
          className="secondary-button"
          type="button"
          onClick={() => void logs.refetch()}
          disabled={request === null || logs.isFetching}
        >
          {logs.isFetching ? "Refreshing…" : "Refresh logs"}
        </button>
      </header>

      <LogsFilterForm
        key={searchKey}
        request={request ?? defaultLogsRequest}
        onApply={(next) => {
          setCursorHistory([]);
          setSearchParams(next);
        }}
        onReset={() => {
          setCursorHistory([]);
          setSearchParams(new URLSearchParams());
        }}
      />

      {!parsedSearch.success ? (
        <p className="error-banner" role="alert">
          {parsedSearch.message}
        </p>
      ) : null}
      {logs.isError ? (
        <div className="error-banner" role="alert">
          <span>{logs.error.message}</span>
          <button type="button" onClick={() => void logs.refetch()}>
            Retry log query
          </button>
        </div>
      ) : null}
      {logs.isPending && request !== null ? (
        <p className="loading-panel" role="status">
          Loading logs…
        </p>
      ) : null}

      {logs.data === undefined ? null : (
        <>
          <section className="summary-strip" aria-label="Log page summary">
            <div>
              <span>Rows</span>
              <strong>{logs.data.summary.returnedCount}</strong>
            </div>
            <div>
              <span>Payload bytes</span>
              <strong>
                {logs.data.summary.totalByteCount.toLocaleString()}
              </strong>
            </div>
            <div>
              <span>Page state</span>
              <strong>
                {logs.data.hasMore ? "More available" : "Last page"}
              </strong>
            </div>
          </section>

          {logs.data.items.length === 0 ? (
            <p className="empty-panel">No logs match the current filters.</p>
          ) : (
            <section aria-labelledby="log-results-heading">
              <h2 id="log-results-heading" className="visually-hidden">
                Log results
              </h2>
              <div className="log-list-header" aria-hidden="true">
                <span>Event</span>
                <span>Occurred</span>
                <span>Direction / outcome</span>
                <span>Source</span>
                <span>Details</span>
              </div>
              <ol className="log-list">
                {logs.data.items.map((entry) => (
                  <LogEntryRow key={entry.id} entry={entry} />
                ))}
              </ol>
            </section>
          )}

          <nav className="pagination" aria-label="Log pages">
            <button
              className="secondary-button"
              type="button"
              disabled={cursorHistory.length === 0 || logs.isPlaceholderData}
              onClick={goToPreviousPage}
            >
              Previous page
            </button>
            <button
              className="secondary-button"
              type="button"
              disabled={!logs.data.hasMore || logs.isPlaceholderData}
              onClick={goToNextPage}
            >
              Next page
            </button>
          </nav>

          {request === null ? null : <LogsExport request={request} />}
        </>
      )}
    </main>
  );
}
