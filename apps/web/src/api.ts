import {
  acknowledgeAlertRequestSchema,
  alertHistoryListRequestSchema,
  alertHistoryListResponseSchema,
  alertParamsSchema,
  apiErrorResponseSchema,
  channelParamsSchema,
  controllerSnapshotSchema,
  createChannelRequestSchema,
  deviceParamsSchema,
  expectedRevisionSchema,
  healthResponseSchema,
  logExportRequestSchema,
  logsListRequestSchema,
  logsListResponseSchema,
  manualOverrideCommandResponseSchema,
  manualOverrideParamsSchema,
  manualOverrideStateResponseSchema,
  mappingProfileParamsSchema,
  mutationResultSchema,
  operationDetailsResponseSchema,
  operationParamsSchema,
  patchDeviceConfigurationRequestSchema,
  reconcileManualOverrideRequestSchema,
  renameChannelRequestSchema,
  replaceMappingProfileRequestSchema,
  replaceScheduleRequestSchema,
  setDeviceEnabledRequestSchema,
  startManualOverrideRequestSchema,
  throttleParamsSchema,
  updateThrottleRequestSchema,
  cancelManualOverrideRequestSchema,
  extendManualOverrideRequestSchema,
  type AcknowledgeAlertRequest,
  type AlertHistoryListRequest,
  type AlertHistoryListResponse,
  type ApiErrorResponse,
  type ControllerSnapshot,
  type CreateChannelRequest,
  type HealthResponse,
  type LogExportRequest,
  type LogFilter,
  type LogsListRequest,
  type LogsListResponse,
  type MutationResult,
  type ManualOverrideCommandResponse,
  type ManualOverrideStateResponse,
  type OperationDetailsResponse,
  type PatchDeviceConfigurationRequest,
  type RenameChannelRequest,
  type ReplaceMappingProfileRequest,
  type ReplaceScheduleRequest,
  type SetDeviceEnabledRequest,
  type StartManualOverrideRequest,
  type UpdateThrottleRequest,
  type CancelManualOverrideRequest,
  type ExtendManualOverrideRequest,
  type ReconcileManualOverrideRequest,
} from "@aquarium/contracts";

export class AquariumApiError extends Error {
  override readonly name = "AquariumApiError";

  constructor(
    readonly status: number,
    readonly details: ApiErrorResponse,
  ) {
    super(details.message);
  }
}

async function throwApiError(response: Response): Promise<never> {
  const details = apiErrorResponseSchema.parse(await response.json());
  throw new AquariumApiError(response.status, details);
}

async function requestConfigurationMutation(
  path: string,
  method: "DELETE" | "PATCH" | "POST" | "PUT",
  body: object,
): Promise<MutationResult> {
  const response = await fetch(path, {
    method,
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    return throwApiError(response);
  }
  return mutationResultSchema.parse(await response.json());
}

async function requestTypedPost<Output>(
  path: string,
  body: object,
  schema: { readonly parse: (value: object) => Output },
): Promise<Output> {
  const response = await fetch(path, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });
  if (!response.ok) {
    return throwApiError(response);
  }
  return schema.parse((await response.json()) as object);
}

function appendLogFilters(search: URLSearchParams, filters: LogFilter): void {
  if (filters.startAtMs !== undefined) {
    search.set("startAtMs", String(filters.startAtMs));
  }
  if (filters.endAtMs !== undefined) {
    search.set("endAtMs", String(filters.endAtMs));
  }
  if (filters.direction !== undefined) {
    search.set("direction", filters.direction);
  }
  if (filters.kind !== undefined) {
    search.set("kind", filters.kind);
  }
  if (filters.severity !== undefined) {
    search.set("severity", filters.severity);
  }
  if (filters.deviceId !== undefined) {
    search.set("deviceId", filters.deviceId);
  }
  if (filters.operationId !== undefined) {
    search.set("operationId", filters.operationId);
  }
  if (filters.correlationId !== undefined) {
    search.set("correlationId", filters.correlationId);
  }
  if (filters.outcome !== undefined) {
    search.set("outcome", filters.outcome);
  }
  if (filters.retentionClass !== undefined) {
    search.set("retentionClass", filters.retentionClass);
  }
}

export async function fetchHealth(): Promise<HealthResponse> {
  const response = await fetch("/api/health", {
    headers: { Accept: "application/json" },
  });
  if (!response.ok) {
    throw new Error(`Health request failed with HTTP ${response.status}`);
  }

  return healthResponseSchema.parse(await response.json());
}

export async function fetchControllerSnapshot(
  signal?: AbortSignal,
): Promise<ControllerSnapshot> {
  const response = await fetch("/api/snapshot", {
    headers: { Accept: "application/json" },
    ...(signal === undefined ? {} : { signal }),
  });
  if (!response.ok) {
    throw new Error(`Snapshot request failed with HTTP ${response.status}`);
  }

  return controllerSnapshotSchema.parse(await response.json());
}

export function createChannel(
  request: CreateChannelRequest,
): Promise<MutationResult> {
  return requestConfigurationMutation(
    "/api/channels",
    "POST",
    createChannelRequestSchema.parse(request),
  );
}

export function renameChannel(
  channelId: string,
  request: RenameChannelRequest,
): Promise<MutationResult> {
  const params = channelParamsSchema.parse({ channelId });
  return requestConfigurationMutation(
    `/api/channels/${encodeURIComponent(params.channelId)}`,
    "PATCH",
    renameChannelRequestSchema.parse(request),
  );
}

export function deleteChannel(
  channelId: string,
  expectedRevision: number,
): Promise<MutationResult> {
  const params = channelParamsSchema.parse({ channelId });
  const body = expectedRevisionSchema.parse({ expectedRevision });
  return requestConfigurationMutation(
    `/api/channels/${encodeURIComponent(params.channelId)}`,
    "DELETE",
    body,
  );
}

export function replaceSchedule(
  channelId: string,
  request: ReplaceScheduleRequest,
): Promise<MutationResult> {
  const params = channelParamsSchema.parse({ channelId });
  return requestConfigurationMutation(
    `/api/channels/${encodeURIComponent(params.channelId)}/schedule`,
    "PUT",
    replaceScheduleRequestSchema.parse(request),
  );
}

export function updateThrottle(
  typeKey: string,
  request: UpdateThrottleRequest,
): Promise<MutationResult> {
  const params = throttleParamsSchema.parse({ typeKey });
  return requestConfigurationMutation(
    `/api/throttles/${encodeURIComponent(params.typeKey)}`,
    "PUT",
    updateThrottleRequestSchema.parse(request),
  );
}

export function replaceMappingProfile(
  profileId: string,
  request: ReplaceMappingProfileRequest,
): Promise<MutationResult> {
  const params = mappingProfileParamsSchema.parse({ profileId });
  return requestConfigurationMutation(
    `/api/mapping-profiles/${encodeURIComponent(params.profileId)}`,
    "PUT",
    replaceMappingProfileRequestSchema.parse(request),
  );
}

export function patchDeviceConfiguration(
  deviceId: string,
  request: PatchDeviceConfigurationRequest,
): Promise<MutationResult> {
  const params = deviceParamsSchema.parse({ deviceId });
  return requestConfigurationMutation(
    `/api/devices/${encodeURIComponent(params.deviceId)}/configuration`,
    "PATCH",
    patchDeviceConfigurationRequestSchema.parse(request),
  );
}

export function setDeviceEnabled(
  deviceId: string,
  request: SetDeviceEnabledRequest,
): Promise<MutationResult> {
  const params = deviceParamsSchema.parse({ deviceId });
  return requestConfigurationMutation(
    `/api/devices/${encodeURIComponent(params.deviceId)}/enabled`,
    "PATCH",
    setDeviceEnabledRequestSchema.parse(request),
  );
}

export async function fetchOperationDetails(
  operationId: string,
  signal?: AbortSignal,
): Promise<OperationDetailsResponse> {
  const params = operationParamsSchema.parse({ operationId });
  const response = await fetch(
    `/api/operations/${encodeURIComponent(params.operationId)}`,
    {
      headers: { Accept: "application/json" },
      ...(signal === undefined ? {} : { signal }),
    },
  );
  if (!response.ok) {
    return throwApiError(response);
  }
  return operationDetailsResponseSchema.parse(await response.json());
}

export function reconcileDeviceOperation(
  operationId: string,
  expectedRevision: number,
): Promise<MutationResult> {
  const params = operationParamsSchema.parse({ operationId });
  const body = expectedRevisionSchema.parse({ expectedRevision });
  return requestConfigurationMutation(
    `/api/operations/${encodeURIComponent(params.operationId)}/reconcile`,
    "POST",
    body,
  );
}

export function startManualOverride(
  request: StartManualOverrideRequest,
): Promise<ManualOverrideCommandResponse> {
  return requestTypedPost(
    "/api/overrides",
    startManualOverrideRequestSchema.parse(request),
    manualOverrideCommandResponseSchema,
  );
}

export function extendManualOverride(
  overrideId: string,
  request: ExtendManualOverrideRequest,
): Promise<ManualOverrideStateResponse> {
  const params = manualOverrideParamsSchema.parse({ overrideId });
  return requestTypedPost(
    `/api/overrides/${encodeURIComponent(params.overrideId)}/extend`,
    extendManualOverrideRequestSchema.parse(request),
    manualOverrideStateResponseSchema,
  );
}

export function cancelManualOverride(
  overrideId: string,
  request: CancelManualOverrideRequest,
): Promise<ManualOverrideCommandResponse> {
  const params = manualOverrideParamsSchema.parse({ overrideId });
  return requestTypedPost(
    `/api/overrides/${encodeURIComponent(params.overrideId)}/cancel`,
    cancelManualOverrideRequestSchema.parse(request),
    manualOverrideCommandResponseSchema,
  );
}

export function reconcileManualOverride(
  overrideId: string,
  request: ReconcileManualOverrideRequest,
): Promise<ManualOverrideStateResponse> {
  const params = manualOverrideParamsSchema.parse({ overrideId });
  return requestTypedPost(
    `/api/overrides/${encodeURIComponent(params.overrideId)}/reconcile`,
    reconcileManualOverrideRequestSchema.parse(request),
    manualOverrideStateResponseSchema,
  );
}

export async function fetchLogs(
  request: LogsListRequest,
  signal?: AbortSignal,
): Promise<LogsListResponse> {
  const parsed = logsListRequestSchema.parse(request);
  const search = new URLSearchParams();
  appendLogFilters(search, parsed.filters);
  if (parsed.cursor !== undefined) {
    search.set("cursor", parsed.cursor);
  }
  search.set("pageSize", String(parsed.pageSize));

  const response = await fetch(`/api/logs?${search.toString()}`, {
    headers: { Accept: "application/json" },
    ...(signal === undefined ? {} : { signal }),
  });
  if (!response.ok) {
    return throwApiError(response);
  }
  return logsListResponseSchema.parse(await response.json());
}

export function buildLogExportUrl(request: LogExportRequest): string {
  const parsed = logExportRequestSchema.parse(request);
  const search = new URLSearchParams();
  appendLogFilters(search, parsed.filters);
  search.set("format", parsed.format);
  search.set("maxRows", String(parsed.maxRows));
  return `/api/logs/export?${search.toString()}`;
}

export async function acknowledgeAlert(
  alertId: string,
  request: AcknowledgeAlertRequest,
): Promise<MutationResult> {
  const params = alertParamsSchema.parse({ alertId });
  const body = acknowledgeAlertRequestSchema.parse(request);
  const response = await fetch(
    `/api/alerts/${encodeURIComponent(params.alertId)}/acknowledge`,
    {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
    },
  );
  if (!response.ok) {
    return throwApiError(response);
  }
  return mutationResultSchema.parse(await response.json());
}

export async function fetchAlertHistory(
  request: AlertHistoryListRequest,
  signal?: AbortSignal,
): Promise<AlertHistoryListResponse> {
  const parsed = alertHistoryListRequestSchema.parse(request);
  const search = new URLSearchParams({
    state: parsed.state,
    pageSize: String(parsed.pageSize),
  });
  if (parsed.cursor !== undefined) {
    search.set("cursor", parsed.cursor);
  }
  const response = await fetch(`/api/alerts?${search.toString()}`, {
    headers: { Accept: "application/json" },
    ...(signal === undefined ? {} : { signal }),
  });
  if (!response.ok) {
    return throwApiError(response);
  }
  return alertHistoryListResponseSchema.parse(await response.json());
}
