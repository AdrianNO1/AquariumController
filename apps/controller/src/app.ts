import {
  apiErrorResponseSchema,
  controllerSnapshotSchema,
  healthResponseSchema,
  MAX_IDENTIFIER_LENGTH,
  streamHeartbeatEventSchema,
  streamReadyEventSchema,
  type HealthResponse,
} from "@aquarium/contracts";
import helmet from "@fastify/helmet";
import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";
import { extname, isAbsolute, sep } from "node:path";
import { z } from "zod";

import {
  registerAlertHistoryRoutes,
  type AlertHistoryRouteReader,
} from "./alert-history-routes.js";
import type { ControllerSnapshotReader } from "./application/snapshot/index.js";
import type {
  AlertAcknowledgementCommandPort,
  ControllerConfigurationService,
  DeviceConfigurationCommandPort,
} from "./application/configuration/index.js";
import type { ManualOverrideCommandService } from "./application/overrides/index.js";
import type { HttpResponseInteractionRecorder } from "./application/runtime/controller-interaction-logger.js";
import {
  registerConfigurationRoutes,
  type DeviceDiscoveryCommandPort,
} from "./configuration-routes.js";
import { registerLogsRoutes, type LogsRouteService } from "./logs-routes.js";
import { registerManualOverrideRoutes } from "./manual-override-routes.js";
import type { StateEventStreamHub } from "./realtime/state-event-stream.js";
import { formatTransientSseEvent, resolveSseAfterRevision } from "./sse.js";

const eventQuerySchema = z.strictObject({
  afterRevision: z.string().optional(),
});

export const CONTROLLER_LOG_REDACTION_PATHS = [
  "req.headers.authorization",
  "req.headers.cookie",
  'res.headers["set-cookie"]',
  "authorization",
  "password",
  "secret",
  "token",
] as const;

export interface BuildAppOptions {
  readonly logger?: boolean;
  readonly now?: () => Date;
  readonly version?: string;
  readonly eventStreamHub?: StateEventStreamHub;
  readonly snapshotReader?: ControllerSnapshotReader;
  readonly configurationService?: ControllerConfigurationService;
  readonly deviceConfigurationCommands?: DeviceConfigurationCommandPort;
  readonly alertAcknowledgementCommands?: AlertAcknowledgementCommandPort;
  readonly deviceDiscoveryCommands?: DeviceDiscoveryCommandPort;
  readonly alertHistoryReader?: AlertHistoryRouteReader;
  readonly logsService?: LogsRouteService;
  readonly manualOverrideCommands?: ManualOverrideCommandService;
  readonly httpInteractionRecorder?: HttpResponseInteractionRecorder;
  readonly readinessProbe?: () => Promise<void>;
  readonly webRoot?: string;
}

export function buildApp(options: BuildAppOptions = {}): FastifyInstance {
  const app = Fastify({
    routerOptions: { maxParamLength: MAX_IDENTIFIER_LENGTH },
    logger:
      options.logger === true
        ? {
            redact: {
              paths: [...CONTROLLER_LOG_REDACTION_PATHS],
              censor: "[REDACTED]",
            },
          }
        : false,
  });
  const now = options.now ?? (() => new Date());
  const version = options.version ?? "0.1.0";
  const standaloneStreamClosers = new Set<() => void>();

  app.addHook("preClose", async () => {
    for (const close of [...standaloneStreamClosers]) {
      close();
    }
    standaloneStreamClosers.clear();
    options.eventStreamHub?.closeAllConnections();
  });

  if (options.webRoot !== undefined) {
    if (!isAbsolute(options.webRoot)) {
      throw new TypeError("Controller web root must be an absolute path");
    }
    app.register(helmet, {
      contentSecurityPolicy: {
        directives: {
          defaultSrc: ["'self'"],
          connectSrc: ["'self'"],
          imgSrc: ["'self'", "data:"],
          scriptSrc: ["'self'"],
          styleSrc: ["'self'"],
        },
      },
    });
  }

  if (options.httpInteractionRecorder !== undefined) {
    app.addHook("onResponse", (request, reply, done) => {
      try {
        options.httpInteractionRecorder?.recordHttpResponse({
          method: request.method,
          routeTemplate: request.routeOptions.url ?? null,
          statusCode: reply.statusCode,
        });
      } catch (error) {
        app.log.error(error, "Unable to enqueue controller HTTP interaction");
      }
      done();
    });
  }

  registerConfigurationRoutes(app, options);
  registerAlertHistoryRoutes(app, options);
  registerLogsRoutes(app, options);
  registerManualOverrideRoutes(app, options);

  const healthResponse = (): HealthResponse =>
    healthResponseSchema.parse({
      service: "aquarium-controller",
      status: "ok",
      version,
      now: now().toISOString(),
      capabilities: ["http", "sse"],
    });

  app.get("/api/health", async (): Promise<HealthResponse> => {
    return healthResponse();
  });

  app.get("/api/health/live", async (): Promise<HealthResponse> => {
    return healthResponse();
  });

  app.get("/api/health/ready", async (_request, reply) => {
    try {
      await options.readinessProbe?.();
      return reply.code(200).send(healthResponse());
    } catch {
      return reply.code(503).send({
        service: "aquarium-controller",
        status: "not_ready",
        now: now().toISOString(),
      });
    }
  });

  app.get("/api/snapshot", async (request, reply) => {
    try {
      if (options.snapshotReader === undefined) {
        throw new Error("Controller snapshot reader is not configured");
      }
      const snapshot = controllerSnapshotSchema.parse(
        await options.snapshotReader.read(),
      );
      return reply.code(200).send(snapshot);
    } catch (error) {
      app.log.error(
        { err: error, requestId: request.id },
        "Unable to generate controller snapshot",
      );
      return reply.code(500).send(
        apiErrorResponseSchema.parse({
          code: "internal_error",
          message: "Controller snapshot generation failed",
          requestId: request.id,
        }),
      );
    }
  });

  app.get("/api/events", { exposeHeadRoute: false }, async (request, reply) => {
    const parsedQuery = eventQuerySchema.safeParse(request.query);
    const lastEventId = request.headers["last-event-id"];
    if (
      !parsedQuery.success ||
      (lastEventId !== undefined && typeof lastEventId !== "string")
    ) {
      return reply.code(400).send({ error: "Invalid SSE revision cursor" });
    }

    let afterRevision: number;
    try {
      afterRevision = resolveSseAfterRevision(
        parsedQuery.data.afterRevision,
        lastEventId,
      );
    } catch {
      return reply.code(400).send({ error: "Invalid SSE revision cursor" });
    }

    reply.hijack();
    reply.raw.writeHead(200, {
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "Content-Type": "text/event-stream; charset=utf-8",
      "X-Accel-Buffering": "no",
    });

    if (options.eventStreamHub === undefined) {
      const streamReadyEvent = streamReadyEventSchema.parse({
        type: "system.stream-ready",
        occurredAt: now().toISOString(),
        data: { currentRevision: 0, replayedCount: 0 },
      });
      reply.raw.write(formatTransientSseEvent(streamReadyEvent));

      let closed = false;
      const closeStream = (): void => {
        if (closed) return;
        closed = true;
        clearInterval(heartbeat);
        standaloneStreamClosers.delete(closeStream);
        if (!reply.raw.writableEnded) {
          reply.raw.end();
        }
      };
      standaloneStreamClosers.add(closeStream);
      request.raw.once("close", closeStream);
      const heartbeat = setInterval(() => {
        try {
          reply.raw.write(": heartbeat\n\n");
          const serverNow = now().toISOString();
          reply.raw.write(
            formatTransientSseEvent(
              streamHeartbeatEventSchema.parse({
                type: "system.heartbeat",
                occurredAt: serverNow,
                data: { currentRevision: 0, serverNow },
              }),
            ),
          );
        } catch (error) {
          app.log.error(error, "Unable to write state-stream heartbeat");
          closeStream();
        }
      }, 15_000);
      heartbeat.unref();
      return;
    }

    let connection:
      Awaited<ReturnType<StateEventStreamHub["open"]>> | undefined;
    let heartbeat: NodeJS.Timeout | undefined;
    const closeConnection = (): void => {
      if (heartbeat !== undefined) {
        clearInterval(heartbeat);
      }
      connection?.close();
    };
    request.raw.once("close", closeConnection);

    try {
      connection = await options.eventStreamHub.open(
        {
          write: (frame) => reply.raw.write(frame),
          close: () => {
            if (!reply.raw.writableEnded) {
              reply.raw.end();
            }
          },
        },
        { afterRevision, now },
      );
      if (connection.closed || request.raw.destroyed) {
        connection.close();
        return;
      }
      reply.raw.on("drain", () => connection?.drain());
      heartbeat = setInterval(() => connection?.heartbeat(now()), 15_000);
      heartbeat.unref();
    } catch (error) {
      app.log.error(error, "Unable to establish state event stream");
      if (!reply.raw.writableEnded) {
        reply.raw.end();
      }
    }
  });

  if (options.webRoot !== undefined) {
    const webRoot = options.webRoot;
    app.register(fastifyStatic, {
      root: webRoot,
      wildcard: false,
      index: "index.html",
      dotfiles: "deny",
      cacheControl: false,
      setHeaders: (response, filePath) => {
        response.header(
          "Cache-Control",
          filePath.endsWith(`${sep}index.html`)
            ? "no-cache"
            : "public, max-age=31536000, immutable",
        );
      },
    });
    app.setNotFoundHandler((request, reply) => {
      const pathname = new URL(request.url, "http://controller.invalid")
        .pathname;
      if (
        request.method !== "GET" ||
        pathname === "/api" ||
        pathname.startsWith("/api/") ||
        extname(pathname) !== ""
      ) {
        return reply.code(404).send({
          message: `Route ${request.method}:${pathname} not found`,
          error: "Not Found",
          statusCode: 404,
        });
      }
      return reply.sendFile("index.html", {
        cacheControl: false,
      });
    });
  }

  return app;
}
