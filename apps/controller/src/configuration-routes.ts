import {
  acknowledgeAlertRequestSchema,
  alertParamsSchema,
  alertRuleParamsSchema,
  alertRulesResponseSchema,
  apiErrorResponseSchema,
  channelParamsSchema,
  createAlertRuleRequestSchema,
  createChannelRequestSchema,
  deviceParamsSchema,
  expectedRevisionSchema,
  mappingProfileParamsSchema,
  mutationResultSchema,
  operationDetailsResponseSchema,
  operationParamsSchema,
  patchAlertRuleRequestSchema,
  patchDeviceConfigurationRequestSchema,
  renameChannelRequestSchema,
  replaceMappingProfileRequestSchema,
  replaceScheduleRequestSchema,
  setDeviceEnabledRequestSchema,
  throttleParamsSchema,
  updateChannelRequestSchema,
  updateThrottleRequestSchema,
} from "@aquarium/contracts";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ZodError, ZodType } from "zod";

import {
  ConfigurationNotFoundError,
  ConfigurationRelationalConflictError,
  ConfigurationRevisionConflictError,
  ConfigurationValidationError,
  type AlertAcknowledgementCommandPort,
  type ControllerConfigurationService,
  type DeviceConfigurationCommandPort,
} from "./application/configuration/index.js";

export interface ConfigurationRouteDependencies {
  readonly configurationService?: ControllerConfigurationService;
  readonly deviceConfigurationCommands?: DeviceConfigurationCommandPort;
  readonly alertAcknowledgementCommands?: AlertAcknowledgementCommandPort;
  readonly deviceDiscoveryCommands?: DeviceDiscoveryCommandPort;
}

export interface DeviceDiscoveryCommandPort {
  requestDeviceDiscovery(): void;
}

class ConfigurationServiceUnavailableError extends Error {
  override readonly name = "ConfigurationServiceUnavailableError";

  constructor(readonly service: string) {
    super(`${service} is not configured`);
  }
}

class ConfigurationRequestValidationError extends Error {
  override readonly name = "ConfigurationRequestValidationError";

  constructor(readonly issues: ZodError["issues"]) {
    super("Request validation failed");
  }
}

type SafeRouteHandler = (
  request: FastifyRequest,
  reply: FastifyReply,
) => Promise<FastifyReply>;

function parseRequest<Output>(schema: ZodType<Output>, value: unknown): Output {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new ConfigurationRequestValidationError(parsed.error.issues);
  }
  return parsed.data;
}

function configurationService(
  dependencies: ConfigurationRouteDependencies,
): ControllerConfigurationService {
  if (dependencies.configurationService === undefined) {
    throw new ConfigurationServiceUnavailableError(
      "controller configuration service",
    );
  }
  return dependencies.configurationService;
}

function deviceCommands(
  dependencies: ConfigurationRouteDependencies,
): DeviceConfigurationCommandPort {
  if (dependencies.deviceConfigurationCommands === undefined) {
    throw new ConfigurationServiceUnavailableError(
      "device configuration command service",
    );
  }
  return dependencies.deviceConfigurationCommands;
}

function alertCommands(
  dependencies: ConfigurationRouteDependencies,
): AlertAcknowledgementCommandPort {
  if (dependencies.alertAcknowledgementCommands === undefined) {
    throw new ConfigurationServiceUnavailableError(
      "alert acknowledgement service",
    );
  }
  return dependencies.alertAcknowledgementCommands;
}

function safeRoute(
  app: FastifyInstance,
  handler: SafeRouteHandler,
): SafeRouteHandler {
  return async (request, reply) => {
    try {
      return await handler(request, reply);
    } catch (error) {
      if (error instanceof ConfigurationRequestValidationError) {
        return reply.code(400).send(
          apiErrorResponseSchema.parse({
            code: "invalid_request",
            message: "Request validation failed",
            issues: error.issues.slice(0, 100).map((issue) => ({
              path: issue.path.map((part) =>
                typeof part === "number" ? part : String(part),
              ),
              code: issue.code,
              message: issue.message,
            })),
          }),
        );
      }
      if (error instanceof ConfigurationValidationError) {
        return reply.code(400).send(
          apiErrorResponseSchema.parse({
            code: "invalid_request",
            message: error.message,
            issues: error.issues,
          }),
        );
      }
      if (error instanceof ConfigurationNotFoundError) {
        return reply.code(404).send(
          apiErrorResponseSchema.parse({
            code: "not_found",
            message: error.message,
            resource: error.resource,
            id: error.resourceId,
          }),
        );
      }
      if (error instanceof ConfigurationRevisionConflictError) {
        return reply.code(409).send(
          apiErrorResponseSchema.parse({
            code: "revision_conflict",
            message: error.message,
            expectedRevision: error.expectedRevision,
            currentRevision: error.currentRevision,
          }),
        );
      }
      if (error instanceof ConfigurationRelationalConflictError) {
        return reply.code(409).send(
          apiErrorResponseSchema.parse({
            code: "relational_conflict",
            message: error.message,
            conflicts: error.conflicts,
          }),
        );
      }
      if (error instanceof ConfigurationServiceUnavailableError) {
        return reply.code(503).send(
          apiErrorResponseSchema.parse({
            code: "service_unavailable",
            message: error.message,
            service: error.service,
          }),
        );
      }
      app.log.error(
        { err: error, requestId: request.id },
        "Controller configuration request failed",
      );
      return reply.code(500).send(
        apiErrorResponseSchema.parse({
          code: "internal_error",
          message: "Controller configuration request failed",
          requestId: request.id,
        }),
      );
    }
  };
}

export function registerConfigurationRoutes(
  app: FastifyInstance,
  dependencies: ConfigurationRouteDependencies,
): void {
  app.post(
    "/api/channels",
    safeRoute(app, async (request, reply) => {
      const body = parseRequest(createChannelRequestSchema, request.body);
      const result =
        await configurationService(dependencies).createChannel(body);
      return reply.code(200).send(mutationResultSchema.parse(result));
    }),
  );

  app.patch(
    "/api/channels/:channelId",
    safeRoute(app, async (request, reply) => {
      const { channelId } = parseRequest(channelParamsSchema, request.params);
      const update = updateChannelRequestSchema.safeParse(request.body);
      const result = update.success
        ? await configurationService(dependencies).updateChannel(
            channelId,
            update.data,
          )
        : await configurationService(dependencies).renameChannel(
            channelId,
            parseRequest(renameChannelRequestSchema, request.body),
          );
      return reply.code(200).send(mutationResultSchema.parse(result));
    }),
  );

  app.delete(
    "/api/channels/:channelId",
    safeRoute(app, async (request, reply) => {
      const { channelId } = parseRequest(channelParamsSchema, request.params);
      const { expectedRevision } = parseRequest(
        expectedRevisionSchema,
        request.body,
      );
      const result = await configurationService(dependencies).deleteChannel(
        channelId,
        expectedRevision,
      );
      return reply.code(200).send(mutationResultSchema.parse(result));
    }),
  );

  app.put(
    "/api/channels/:channelId/schedule",
    safeRoute(app, async (request, reply) => {
      const { channelId } = parseRequest(channelParamsSchema, request.params);
      const body = parseRequest(replaceScheduleRequestSchema, request.body);
      const result = await configurationService(dependencies).replaceSchedule(
        channelId,
        body,
      );
      return reply.code(200).send(mutationResultSchema.parse(result));
    }),
  );

  app.put(
    "/api/throttles/:typeKey",
    safeRoute(app, async (request, reply) => {
      const { typeKey } = parseRequest(throttleParamsSchema, request.params);
      const body = parseRequest(updateThrottleRequestSchema, request.body);
      const result = await configurationService(dependencies).updateThrottle(
        typeKey,
        body,
      );
      return reply.code(200).send(mutationResultSchema.parse(result));
    }),
  );

  app.put(
    "/api/mapping-profiles/:profileId",
    safeRoute(app, async (request, reply) => {
      const { profileId } = parseRequest(
        mappingProfileParamsSchema,
        request.params,
      );
      const body = parseRequest(
        replaceMappingProfileRequestSchema,
        request.body,
      );
      const result = await configurationService(
        dependencies,
      ).replaceMappingProfile(profileId, body);
      return reply.code(200).send(mutationResultSchema.parse(result));
    }),
  );

  app.delete(
    "/api/mapping-profiles/:profileId",
    safeRoute(app, async (request, reply) => {
      const { profileId } = parseRequest(
        mappingProfileParamsSchema,
        request.params,
      );
      const { expectedRevision } = parseRequest(
        expectedRevisionSchema,
        request.body,
      );
      const result = await configurationService(
        dependencies,
      ).deleteMappingProfile(profileId, expectedRevision);
      return reply.code(200).send(mutationResultSchema.parse(result));
    }),
  );

  app.patch(
    "/api/devices/:deviceId/enabled",
    safeRoute(app, async (request, reply) => {
      const { deviceId } = parseRequest(deviceParamsSchema, request.params);
      const body = parseRequest(setDeviceEnabledRequestSchema, request.body);
      const result = await configurationService(dependencies).setDeviceEnabled(
        deviceId,
        body,
      );
      if (body.enabled) {
        dependencies.deviceDiscoveryCommands?.requestDeviceDiscovery();
      }
      return reply.code(200).send(mutationResultSchema.parse(result));
    }),
  );

  app.patch(
    "/api/devices/:deviceId/configuration",
    safeRoute(app, async (request, reply) => {
      const { deviceId } = parseRequest(deviceParamsSchema, request.params);
      const body = parseRequest(
        patchDeviceConfigurationRequestSchema,
        request.body,
      );
      const result = await deviceCommands(
        dependencies,
      ).patchDeviceConfiguration(deviceId, body);
      return reply.code(200).send(mutationResultSchema.parse(result));
    }),
  );

  app.get(
    "/api/operations/:operationId",
    safeRoute(app, async (request, reply) => {
      const { operationId } = parseRequest(
        operationParamsSchema,
        request.params,
      );
      const result =
        await configurationService(dependencies).getOperation(operationId);
      return reply.code(200).send(operationDetailsResponseSchema.parse(result));
    }),
  );

  app.post(
    "/api/operations/:operationId/reconcile",
    safeRoute(app, async (request, reply) => {
      const { operationId } = parseRequest(
        operationParamsSchema,
        request.params,
      );
      const { expectedRevision } = parseRequest(
        expectedRevisionSchema,
        request.body,
      );
      const result = await deviceCommands(
        dependencies,
      ).reconcileDeviceOperation(operationId, expectedRevision);
      return reply.code(200).send(mutationResultSchema.parse(result));
    }),
  );

  app.get(
    "/api/alert-rules",
    safeRoute(app, async (_request, reply) => {
      const result = await configurationService(dependencies).listAlertRules();
      return reply.code(200).send(alertRulesResponseSchema.parse(result));
    }),
  );

  app.post(
    "/api/alert-rules",
    safeRoute(app, async (request, reply) => {
      const body = parseRequest(createAlertRuleRequestSchema, request.body);
      const result =
        await configurationService(dependencies).createAlertRule(body);
      return reply.code(200).send(mutationResultSchema.parse(result));
    }),
  );

  app.patch(
    "/api/alert-rules/:alertRuleId",
    safeRoute(app, async (request, reply) => {
      const { alertRuleId } = parseRequest(
        alertRuleParamsSchema,
        request.params,
      );
      const body = parseRequest(patchAlertRuleRequestSchema, request.body);
      const result = await configurationService(dependencies).patchAlertRule(
        alertRuleId,
        body,
      );
      return reply.code(200).send(mutationResultSchema.parse(result));
    }),
  );

  app.delete(
    "/api/alert-rules/:alertRuleId",
    safeRoute(app, async (request, reply) => {
      const { alertRuleId } = parseRequest(
        alertRuleParamsSchema,
        request.params,
      );
      const { expectedRevision } = parseRequest(
        expectedRevisionSchema,
        request.body,
      );
      const result = await configurationService(dependencies).deleteAlertRule(
        alertRuleId,
        expectedRevision,
      );
      return reply.code(200).send(mutationResultSchema.parse(result));
    }),
  );

  app.post(
    "/api/alerts/:alertId/acknowledge",
    safeRoute(app, async (request, reply) => {
      const { alertId } = parseRequest(alertParamsSchema, request.params);
      const body = parseRequest(acknowledgeAlertRequestSchema, request.body);
      const result = await alertCommands(dependencies).acknowledgeAlert(
        alertId,
        body,
      );
      return reply.code(200).send(mutationResultSchema.parse(result));
    }),
  );
}
