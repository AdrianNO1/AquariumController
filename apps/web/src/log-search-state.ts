import {
  logsListRequestSchema,
  type LogsListRequest,
} from "@aquarium/contracts";

const logSearchKeys = new Set([
  "startAtMs",
  "endAtMs",
  "direction",
  "kind",
  "severity",
  "deviceId",
  "operationId",
  "correlationId",
  "outcome",
  "retentionClass",
  "cursor",
  "pageSize",
]);

export interface LogFilterFormState {
  readonly startAtMs: string;
  readonly endAtMs: string;
  readonly direction: string;
  readonly kind: string;
  readonly severity: string;
  readonly deviceId: string;
  readonly operationId: string;
  readonly correlationId: string;
  readonly outcome: string;
  readonly retentionClass: string;
  readonly pageSize: string;
}

export type ParsedLogSearch =
  | { readonly success: true; readonly request: LogsListRequest }
  | { readonly success: false; readonly message: string };

function optionalInteger(
  search: URLSearchParams,
  key: "startAtMs" | "endAtMs" | "pageSize",
): number | undefined {
  const value = search.get(key);
  if (value === null) {
    return undefined;
  }
  if (!/^(0|[1-9]\d*)$/u.test(value)) {
    throw new TypeError(`${key} must be a canonical non-negative integer`);
  }
  return Number(value);
}

export function parseLogSearchParams(search: URLSearchParams): ParsedLogSearch {
  const seenKeys = new Set<string>();
  for (const key of search.keys()) {
    if (!logSearchKeys.has(key)) {
      return { success: false, message: `Unsupported log filter: ${key}` };
    }
    if (seenKeys.has(key)) {
      return { success: false, message: `Duplicate log filter: ${key}` };
    }
    seenKeys.add(key);
  }

  try {
    const startAtMs = optionalInteger(search, "startAtMs");
    const endAtMs = optionalInteger(search, "endAtMs");
    const pageSize = optionalInteger(search, "pageSize");
    const result = logsListRequestSchema.safeParse({
      filters: {
        ...(startAtMs === undefined ? {} : { startAtMs }),
        ...(endAtMs === undefined ? {} : { endAtMs }),
        ...(search.get("direction") === null
          ? {}
          : { direction: search.get("direction") }),
        ...(search.get("kind") === null ? {} : { kind: search.get("kind") }),
        ...(search.get("severity") === null
          ? {}
          : { severity: search.get("severity") }),
        ...(search.get("deviceId") === null
          ? {}
          : { deviceId: search.get("deviceId") }),
        ...(search.get("operationId") === null
          ? {}
          : { operationId: search.get("operationId") }),
        ...(search.get("correlationId") === null
          ? {}
          : { correlationId: search.get("correlationId") }),
        ...(search.get("outcome") === null
          ? {}
          : { outcome: search.get("outcome") }),
        ...(search.get("retentionClass") === null
          ? {}
          : { retentionClass: search.get("retentionClass") }),
      },
      ...(search.get("cursor") === null
        ? {}
        : { cursor: search.get("cursor") }),
      ...(pageSize === undefined ? {} : { pageSize }),
    });
    if (!result.success) {
      return {
        success: false,
        message: result.error.issues[0]?.message ?? "Invalid log filters",
      };
    }
    return { success: true, request: result.data };
  } catch (error) {
    return {
      success: false,
      message: error instanceof Error ? error.message : "Invalid log filters",
    };
  }
}

export function logFilterFormFromRequest(
  request: LogsListRequest,
): LogFilterFormState {
  return {
    startAtMs:
      request.filters.startAtMs === undefined
        ? ""
        : String(request.filters.startAtMs),
    endAtMs:
      request.filters.endAtMs === undefined
        ? ""
        : String(request.filters.endAtMs),
    direction: request.filters.direction ?? "",
    kind: request.filters.kind ?? "",
    severity: request.filters.severity ?? "",
    deviceId: request.filters.deviceId ?? "",
    operationId: request.filters.operationId ?? "",
    correlationId: request.filters.correlationId ?? "",
    outcome: request.filters.outcome ?? "",
    retentionClass: request.filters.retentionClass ?? "",
    pageSize: String(request.pageSize),
  };
}

export function buildLogSearchParams(
  form: LogFilterFormState,
):
  | { readonly success: true; readonly search: URLSearchParams }
  | { readonly success: false; readonly message: string } {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(form)) {
    if (value.length > 0) {
      search.set(key, value);
    }
  }
  const parsed = parseLogSearchParams(search);
  return parsed.success
    ? { success: true, search }
    : { success: false, message: parsed.message };
}
