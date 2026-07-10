import {
  healthResponseSchema,
  systemConnectedEventSchema,
  type HealthResponse,
} from "@aquarium/contracts";
import Fastify, { type FastifyInstance } from "fastify";

import { formatSseEvent } from "./sse.js";

export interface BuildAppOptions {
  readonly logger?: boolean;
  readonly now?: () => Date;
  readonly version?: string;
}

export function buildApp(options: BuildAppOptions = {}): FastifyInstance {
  const app = Fastify({ logger: options.logger ?? false });
  const now = options.now ?? (() => new Date());
  const version = options.version ?? "0.1.0";
  let revision = 0;

  app.get("/api/health", async (): Promise<HealthResponse> => {
    return healthResponseSchema.parse({
      service: "aquarium-controller",
      status: "ok",
      version,
      now: now().toISOString(),
      capabilities: ["http", "sse"],
    });
  });

  app.get("/api/events", (request, reply) => {
    reply.hijack();
    reply.raw.writeHead(200, {
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
      "Content-Type": "text/event-stream; charset=utf-8",
      "X-Accel-Buffering": "no",
    });

    revision += 1;
    const connectedEvent = systemConnectedEventSchema.parse({
      id: revision.toString(),
      type: "system.connected",
      occurredAt: now().toISOString(),
      data: { revision },
    });
    reply.raw.write(formatSseEvent(connectedEvent));

    const heartbeat = setInterval(() => {
      reply.raw.write(": heartbeat\n\n");
    }, 15_000);
    heartbeat.unref();

    request.raw.once("close", () => {
      clearInterval(heartbeat);
    });
  });

  return app;
}
