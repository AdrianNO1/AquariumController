import {
  apiErrorResponseSchema,
  logExportRequestSchema,
  logsListRequestSchema,
  logsListResponseSchema,
  type LogExportMetadata,
  type LogExportRequest,
  type LogsListRequest,
  type LogsListResponse,
} from "@aquarium/contracts";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import type { LogExportSink } from "./application/logs/index.js";

const nonnegativeIntegerQuerySchema = z
  .string()
  .regex(/^(0|[1-9]\d*)$/u)
  .transform((value) => Number(value))
  .pipe(z.number().int().min(0).max(Number.MAX_SAFE_INTEGER));

const positiveIntegerQuerySchema = z
  .string()
  .regex(/^[1-9]\d*$/u)
  .transform((value) => Number(value))
  .pipe(z.number().int().min(1).max(Number.MAX_SAFE_INTEGER));

const logFilterQueryShape = {
  startAtMs: nonnegativeIntegerQuerySchema.optional(),
  endAtMs: nonnegativeIntegerQuerySchema.optional(),
  direction: z.string().optional(),
  kind: z.string().optional(),
  severity: z.string().optional(),
  deviceId: z.string().optional(),
  operationId: z.string().optional(),
  correlationId: z.string().optional(),
  outcome: z.string().optional(),
  retentionClass: z.string().optional(),
};

const logsListQuerySchema = z
  .strictObject({
    ...logFilterQueryShape,
    cursor: z.string().optional(),
    pageSize: positiveIntegerQuerySchema.optional(),
  })
  .transform(({ cursor, pageSize, ...filters }) =>
    logsListRequestSchema.parse({
      filters,
      ...(cursor === undefined ? {} : { cursor }),
      ...(pageSize === undefined ? {} : { pageSize }),
    }),
  );

const logExportQuerySchema = z
  .strictObject({
    ...logFilterQueryShape,
    format: z.string(),
    maxRows: positiveIntegerQuerySchema.optional(),
  })
  .transform(({ format, maxRows, ...filters }) =>
    logExportRequestSchema.parse({
      filters,
      format,
      ...(maxRows === undefined ? {} : { maxRows }),
    }),
  );

export interface LogsRouteService {
  list(request: LogsListRequest): Promise<LogsListResponse>;
  export(
    request: LogExportRequest,
    sink: LogExportSink,
  ): Promise<LogExportMetadata>;
}

export interface LogsRouteDependencies {
  readonly logsService?: LogsRouteService;
}

class LogsServiceUnavailableError extends Error {
  override readonly name = "LogsServiceUnavailableError";

  constructor() {
    super("logs service is not configured");
  }
}

function requireLogsService(
  dependencies: LogsRouteDependencies,
): LogsRouteService {
  if (dependencies.logsService === undefined) {
    throw new LogsServiceUnavailableError();
  }
  return dependencies.logsService;
}

function invalidRequestReply(
  reply: FastifyReply,
  error: z.ZodError,
): FastifyReply {
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

async function writeExportChunk(
  reply: FastifyReply,
  chunk: string,
): Promise<void> {
  if (reply.raw.destroyed || reply.raw.writableEnded) {
    throw new Error("Log export client disconnected");
  }
  await new Promise<void>((resolve, reject) => {
    reply.raw.write(chunk, "utf8", (error) => {
      if (error === null || error === undefined) {
        resolve();
      } else {
        reject(error);
      }
    });
  });
}

export function registerLogsRoutes(
  app: FastifyInstance,
  dependencies: LogsRouteDependencies,
): void {
  app.get("/api/logs", async (request, reply) => {
    let query: LogsListRequest;
    try {
      query = logsListQuerySchema.parse(request.query);
    } catch (error) {
      if (error instanceof z.ZodError) {
        return invalidRequestReply(reply, error);
      }
      throw error;
    }

    try {
      const response = await requireLogsService(dependencies).list(query);
      return reply.code(200).send(logsListResponseSchema.parse(response));
    } catch (error) {
      if (error instanceof LogsServiceUnavailableError) {
        return reply.code(503).send(
          apiErrorResponseSchema.parse({
            code: "service_unavailable",
            message: error.message,
            service: "logs service",
          }),
        );
      }
      app.log.error({ err: error, requestId: request.id }, "Log query failed");
      return reply.code(500).send(
        apiErrorResponseSchema.parse({
          code: "internal_error",
          message: "Log query failed",
          requestId: request.id,
        }),
      );
    }
  });

  app.get(
    "/api/logs/export",
    { exposeHeadRoute: false },
    async (request: FastifyRequest, reply: FastifyReply) => {
      let query: LogExportRequest;
      let service: LogsRouteService;
      try {
        query = logExportQuerySchema.parse(request.query);
        service = requireLogsService(dependencies);
      } catch (error) {
        if (error instanceof z.ZodError) {
          return invalidRequestReply(reply, error);
        }
        if (error instanceof LogsServiceUnavailableError) {
          return reply.code(503).send(
            apiErrorResponseSchema.parse({
              code: "service_unavailable",
              message: error.message,
              service: "logs service",
            }),
          );
        }
        throw error;
      }

      const extension = query.format === "csv" ? "csv" : "ndjson";
      const contentType =
        query.format === "csv"
          ? "text/csv; charset=utf-8"
          : "application/x-ndjson; charset=utf-8";
      reply.hijack();
      reply.raw.writeHead(200, {
        "Cache-Control": "no-store",
        "Content-Disposition": `attachment; filename="aquarium-logs.${extension}"`,
        "Content-Type": contentType,
        Trailer: "X-Aquarium-Log-Row-Count, X-Aquarium-Log-Truncated",
      });

      try {
        const metadata = await service.export(query, {
          write: (chunk) => writeExportChunk(reply, chunk),
        });
        if (!reply.raw.destroyed) {
          reply.raw.addTrailers({
            "X-Aquarium-Log-Row-Count": String(metadata.rowCount),
            "X-Aquarium-Log-Truncated": String(metadata.truncated),
          });
          reply.raw.end();
        }
      } catch (error) {
        app.log.error(
          { err: error, requestId: request.id },
          "Log export failed after streaming began",
        );
        reply.raw.destroy(
          error instanceof Error
            ? error
            : new Error("Log export failed after streaming began"),
        );
      }
      return undefined;
    },
  );
}
