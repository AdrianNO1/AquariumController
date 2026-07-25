import type {
  AcknowledgeAlertRequest,
  AlertRulesResponse,
  CreateAlertRuleRequest,
  CreateChannelRequest,
  MutationResult,
  OperationDetailsResponse,
  PatchAlertRuleRequest,
  PatchDeviceConfigurationRequest,
  RenameChannelRequest,
  ReplaceMappingProfileRequest,
  ReplaceScheduleRequest,
  UpdateThrottleRequest,
} from "@aquarium/contracts";

export interface ValidationIssue {
  readonly path: readonly (string | number)[];
  readonly code: string;
  readonly message: string;
}

export interface RelationConflict {
  readonly resource: string;
  readonly id: string | null;
  readonly relation: string;
  readonly message: string;
}

export class ConfigurationValidationError extends Error {
  override readonly name = "ConfigurationValidationError";

  constructor(readonly issues: readonly ValidationIssue[]) {
    super("Configuration mutation failed validation");
  }
}

export class ConfigurationNotFoundError extends Error {
  override readonly name = "ConfigurationNotFoundError";

  constructor(
    readonly resource: string,
    readonly resourceId: string,
  ) {
    super(`${resource} ${resourceId} does not exist`);
  }
}

export class ConfigurationRevisionConflictError extends Error {
  override readonly name = "ConfigurationRevisionConflictError";

  constructor(
    readonly expectedRevision: number,
    readonly currentRevision: number,
  ) {
    super(
      `Expected state revision ${expectedRevision}, but current revision is ${currentRevision}`,
    );
  }
}

export class ConfigurationRelationalConflictError extends Error {
  override readonly name = "ConfigurationRelationalConflictError";

  constructor(readonly conflicts: readonly RelationConflict[]) {
    super("Configuration mutation conflicts with related state");
  }
}

export interface ControllerConfigurationService {
  createChannel(request: CreateChannelRequest): Promise<MutationResult>;
  renameChannel(
    channelId: string,
    request: RenameChannelRequest,
  ): Promise<MutationResult>;
  deleteChannel(
    channelId: string,
    expectedRevision: number,
  ): Promise<MutationResult>;
  replaceSchedule(
    channelId: string,
    request: ReplaceScheduleRequest,
  ): Promise<MutationResult>;
  updateThrottle(
    typeKey: string,
    request: UpdateThrottleRequest,
  ): Promise<MutationResult>;
  replaceMappingProfile(
    profileId: string,
    request: ReplaceMappingProfileRequest,
  ): Promise<MutationResult>;
  getOperation(operationId: string): Promise<OperationDetailsResponse>;
  listAlertRules(): Promise<AlertRulesResponse>;
  createAlertRule(request: CreateAlertRuleRequest): Promise<MutationResult>;
  patchAlertRule(
    alertRuleId: string,
    request: PatchAlertRuleRequest,
  ): Promise<MutationResult>;
  deleteAlertRule(
    alertRuleId: string,
    expectedRevision: number,
  ): Promise<MutationResult>;
}

export interface DeviceConfigurationCommandPort {
  patchDeviceConfiguration(
    deviceId: string,
    request: PatchDeviceConfigurationRequest,
  ): Promise<MutationResult>;
  reconcileDeviceOperation(
    operationId: string,
    expectedRevision: number,
  ): Promise<MutationResult>;
}

export interface AlertAcknowledgementCommandPort {
  acknowledgeAlert(
    alertId: string,
    request: AcknowledgeAlertRequest,
  ): Promise<MutationResult>;
}
