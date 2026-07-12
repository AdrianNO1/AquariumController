import {
  healthResponseSchema,
  streamHeartbeatEventSchema,
  streamReadyEventSchema,
  type HealthResponse,
} from "@aquarium/contracts";
import Fastify, { type FastifyInstance } from "fastify";
import { z } from "zod";

import type { StateEventStreamHub } from "./realtime/state-event-stream.js";
import { formatTransientSseEvent, resolveSseAfterRevision } from "./sse.js";

const eventQuerySchema = z.strictObject({
  afterRevision: z.string().optional(),
});

export interface BuildAppOptions {
  readonly logger?: boolean;
  readonly now?: () => Date;
  readonly version?: string;
  readonly eventStreamHub?: StateEventStreamHub;
}

export function buildApp(options: BuildAppOptions = {}): FastifyInstance {
  const app = Fastify({ logger: options.logger ?? false });
  const now = options.now ?? (() => new Date());
  const version = options.version ?? "0.1.0";

  app.get("/api/health", async (): Promise<HealthResponse> => {
    return healthResponseSchema.parse({
      service: "aquarium-controller",
      status: "ok",
      version,
      now: now().toISOString(),
      capabilities: ["http", "sse"],
    });
  });

  app.get("/api/events", async (request, reply) => {
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

      const heartbeat = setInterval(() => {
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
      }, 15_000);
      heartbeat.unref();

      request.raw.once("close", () => {
        clearInterval(heartbeat);
      });
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

  return app;
}
