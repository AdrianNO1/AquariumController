import {
  apiErrorResponseSchema,
  cancelManualOverrideRequestSchema,
  extendManualOverrideRequestSchema,
  manualOverrideCommandResponseSchema,
  manualOverrideParamsSchema,
  manualOverrideStateResponseSchema,
  reconcileManualOverrideRequestSchema,
  startManualOverrideRequestSchema,
} from "@aquarium/contracts";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import type { ZodError, ZodType } from "zod";

import {
  InvalidManualOverrideTransitionError,
  ManualOverrideConflictError,
  ManualOverrideNotFoundError,
  ManualOverrideRevisionConflictError,
  ManualOverrideUnavailableError,
  type ManualOverrideCommandService,
} from "./application/overrides/index.js";

export interface ManualOverrideRouteDependencies {
  readonly manualOverrideCommands?: ManualOverrideCommandService;
}

class ManualOverrideRequestValidationError extends Error {
  override readonly name = "ManualOverrideRequestValidationError";

  constructor(readonly issues: ZodError["issues"]) {
    super("Manual override request validation failed");
  }
}

type SafeRouteHandler = (
  request: FastifyRequest,
  reply: FastifyReply,
) => Promise<FastifyReply>;

export function registerManualOverrideRoutes(
  app: FastifyInstance,
  dependencies: ManualOverrideRouteDependencies,
): void {
  app.post(
    "/api/overrides",
    safeRoute(app, async (request, reply) => {
      const body = parseRequest(startManualOverrideRequestSchema, request.body);
      const result = await commands(dependencies).startOverride(body);
      return reply
        .code(200)
        .send(manualOverrideCommandResponseSchema.parse(result));
    }),
  );

  app.post(
    "/api/overrides/:overrideId/extend",
    safeRoute(app, async (request, reply) => {
      const { overrideId } = parseRequest(
        manualOverrideParamsSchema,
        request.params,
      );
      const body = parseRequest(
        extendManualOverrideRequestSchema,
        request.body,
      );
      const result = await commands(dependencies).extendOverride(
        overrideId,
        body,
      );
      return reply
        .code(200)
        .send(manualOverrideStateResponseSchema.parse(result));
    }),
  );

  app.post(
    "/api/overrides/:overrideId/cancel",
    safeRoute(app, async (request, reply) => {
      const { overrideId } = parseRequest(
        manualOverrideParamsSchema,
        request.params,
      );
      const body = parseRequest(
        cancelManualOverrideRequestSchema,
        request.body,
      );
      const result = await commands(dependencies).cancelOverride(
        overrideId,
        body,
      );
      return reply
        .code(200)
        .send(manualOverrideCommandResponseSchema.parse(result));
    }),
  );

  app.post(
    "/api/overrides/:overrideId/reconcile",
    safeRoute(app, async (request, reply) => {
      const { overrideId } = parseRequest(
        manualOverrideParamsSchema,
        request.params,
      );
      const body = parseRequest(
        reconcileManualOverrideRequestSchema,
        request.body,
      );
      const result = await commands(dependencies).reconcileOverride(
        overrideId,
        body,
      );
      return reply
        .code(200)
        .send(manualOverrideStateResponseSchema.parse(result));
    }),
  );
}

function commands(
  dependencies: ManualOverrideRouteDependencies,
): ManualOverrideCommandService {
  if (dependencies.manualOverrideCommands === undefined) {
    throw new ManualOverrideUnavailableError(
      "manual override service is not configured",
    );
  }
  return dependencies.manualOverrideCommands;
}

function parseRequest<Output>(schema: ZodType<Output>, value: unknown): Output {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new ManualOverrideRequestValidationError(parsed.error.issues);
  }
  return parsed.data;
}

function safeRoute(
  app: FastifyInstance,
  handler: SafeRouteHandler,
): SafeRouteHandler {
  return async (request, reply) => {
    try {
      return await handler(request, reply);
    } catch (error) {
      if (error instanceof ManualOverrideRequestValidationError) {
        return reply.code(400).send(
          apiErrorResponseSchema.parse({
            code: "invalid_request",
            message: "Manual override request validation failed",
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
      if (error instanceof ManualOverrideNotFoundError) {
        return reply.code(404).send(
          apiErrorResponseSchema.parse({
            code: "not_found",
            message: error.message,
            resource: error.resource,
            id: error.resourceId,
          }),
        );
      }
      if (error instanceof ManualOverrideRevisionConflictError) {
        return reply.code(409).send(
          apiErrorResponseSchema.parse({
            code: "revision_conflict",
            message: error.message,
            expectedRevision: error.expectedRevision,
            currentRevision: error.currentRevision,
          }),
        );
      }
      if (
        error instanceof ManualOverrideConflictError ||
        error instanceof InvalidManualOverrideTransitionError
      ) {
        const conflict =
          error instanceof ManualOverrideConflictError
            ? {
                resource: error.resource,
                id: error.resourceId,
                relation: error.relation,
                message: error.message,
              }
            : {
                resource: "override",
                id: null,
                relation: "status",
                message: error.message,
              };
        return reply.code(409).send(
          apiErrorResponseSchema.parse({
            code: "relational_conflict",
            message: "Manual override state conflicts with the request",
            conflicts: [conflict],
          }),
        );
      }
      if (error instanceof ManualOverrideUnavailableError) {
        return reply.code(503).send(
          apiErrorResponseSchema.parse({
            code: "service_unavailable",
            message: error.message,
            service: "manual override service",
          }),
        );
      }
      app.log.error(
        { err: error, requestId: request.id },
        "Manual override request failed",
      );
      return reply.code(500).send(
        apiErrorResponseSchema.parse({
          code: "internal_error",
          message: "Manual override request failed",
          requestId: request.id,
        }),
      );
    }
  };
}
