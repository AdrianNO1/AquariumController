import {
  alertHistoryListRequestSchema,
  type AlertHistoryListRequest,
  type AlertHistoryStateFilter,
} from "@aquarium/contracts";

export type ParsedAlertSearch =
  | { readonly success: true; readonly request: AlertHistoryListRequest }
  | { readonly success: false; readonly message: string };

export function parseAlertSearchParams(
  search: URLSearchParams,
): ParsedAlertSearch {
  const seenKeys = new Set<string>();
  for (const key of search.keys()) {
    if (!["state", "cursor", "pageSize"].includes(key)) {
      return { success: false, message: `Unsupported alert filter: ${key}` };
    }
    if (seenKeys.has(key)) {
      return { success: false, message: `Duplicate alert filter: ${key}` };
    }
    seenKeys.add(key);
  }

  const rawPageSize = search.get("pageSize");
  if (rawPageSize !== null && !/^[1-9]\d*$/u.test(rawPageSize)) {
    return {
      success: false,
      message: "Alert page size must be a canonical positive integer",
    };
  }
  const result = alertHistoryListRequestSchema.safeParse({
    ...(search.get("state") === null ? {} : { state: search.get("state") }),
    ...(search.get("cursor") === null ? {} : { cursor: search.get("cursor") }),
    ...(rawPageSize === null ? {} : { pageSize: Number(rawPageSize) }),
  });
  return result.success
    ? { success: true, request: result.data }
    : {
        success: false,
        message: result.error.issues[0]?.message ?? "Invalid alert filters",
      };
}

export function buildAlertSearchParams(
  state: AlertHistoryStateFilter,
  pageSize: number,
): URLSearchParams {
  const request = alertHistoryListRequestSchema.parse({ state, pageSize });
  return new URLSearchParams({
    state: request.state,
    pageSize: String(request.pageSize),
  });
}
