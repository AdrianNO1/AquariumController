import {
  alertHistoryListRequestSchema,
  alertHistoryListResponseSchema,
  apiErrorResponseSchema,
  type AlertHistoryListRequest,
  type AlertHistoryListResponse,
} from "@aquarium/contracts";
import type { FastifyInstance, FastifyReply } from "fastify";
import { z } from "zod";

import { InvalidAlertHistoryCursorError } from "./infrastructure/database/index.js";

const positiveIntegerQuerySchema = z
  .string()
  .regex(/^[1-9]\d*$/u)
  .transform((value) => Number(value))
  .pipe(z.number().int().min(1).max(Number.MAX_SAFE_INTEGER));

const alertHistoryQuerySchema = z
  .strictObject({
    state: z.string().optional(),
    cursor: z.string().optional(),
    pageSize: positiveIntegerQuerySchema.optional(),
  })
  .transform((query) => alertHistoryListRequestSchema.parse(query));

export interface AlertHistoryRouteReader {
  list(request: AlertHistoryListRequest): Promise<AlertHistoryListResponse>;
}

export interface AlertHistoryRouteDependencies {
  readonly alertHistoryReader?: AlertHistoryRouteReader;
}

function invalidRequestReply(
  reply: FastifyReply,
  issues: z.ZodError["issues"],
): FastifyReply {
  return reply.code(400).send(
    apiErrorResponseSchema.parse({
      code: "invalid_request",
      message: "Request validation failed",
      issues: issues.slice(0, 100).map((issue) => ({
        path: issue.path.map((part) =>
          typeof part === "number" ? part : String(part),
        ),
        code: issue.code,
        message: issue.message,
      })),
    }),
  );
}

export function registerAlertHistoryRoutes(
  app: FastifyInstance,
  dependencies: AlertHistoryRouteDependencies,
): void {
  app.get("/api/alerts", async (request, reply) => {
    let query: AlertHistoryListRequest;
    try {
      query = alertHistoryQuerySchema.parse(request.query);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return invalidRequestReply(reply, error.issues);
      }
      throw error;
    }
    if (dependencies.alertHistoryReader === undefined) {
      return reply.code(503).send(
        apiErrorResponseSchema.parse({
          code: "service_unavailable",
          message: "alert history service is not configured",
          service: "alert history service",
        }),
      );
    }
    try {
      const result = await dependencies.alertHistoryReader.list(query);
      return reply.code(200).send(alertHistoryListResponseSchema.parse(result));
    } catch (error) {
      if (error instanceof InvalidAlertHistoryCursorError) {
        return invalidRequestReply(reply, [
          {
            code: "custom",
            path: ["cursor"],
            message: error.message,
            input: query.cursor,
          },
        ]);
      }
      app.log.error(
        { err: error, requestId: request.id },
        "Alert history query failed",
      );
      return reply.code(500).send(
        apiErrorResponseSchema.parse({
          code: "internal_error",
          message: "Alert history query failed",
          requestId: request.id,
        }),
      );
    }
  });
}
