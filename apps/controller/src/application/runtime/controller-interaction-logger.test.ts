import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it } from "vitest";

import { buildApp } from "../../app.js";
import {
  openControllerDatabases,
  type ControllerDatabases,
} from "../../infrastructure/database/index.js";
import {
  InteractionRepository,
  type InteractionLogInput,
} from "../../infrastructure/storage/index.js";
import {
  ControllerInteractionLogger,
  type HttpResponseMetadata,
} from "./controller-interaction-logger.js";

const openDatabases: ControllerDatabases[] = [];
const openApps: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(openApps.splice(0).map((app) => app.close()));
  await Promise.all(
    openDatabases.splice(0).map(async (databases) => {
      await Promise.all([
        databases.state.destroy(),
        databases.events.destroy(),
      ]);
    }),
  );
});

describe("controller interaction logger", () => {
  it("persists mutation outcomes and server errors without healthy reads", async () => {
    const databases = await openDatabasesForTest();
    let occurredAtMs = 1_000;
    const logger = new ControllerInteractionLogger(
      new InteractionRepository(databases.events),
      {
        now: () => occurredAtMs++,
        onPersistenceError: (error) => {
          throw error;
        },
      },
    );

    logger.recordHttpResponse({
      method: "GET",
      routeTemplate: "/api/health",
      statusCode: 200,
    });
    logger.recordHttpResponse({
      method: "GET",
      routeTemplate: null,
      statusCode: 404,
    });
    logger.recordHttpResponse({
      method: "post",
      routeTemplate: "/api/channels",
      statusCode: 201,
    });
    logger.recordHttpResponse({
      method: "PATCH",
      routeTemplate: "/api/channels/:channelId",
      statusCode: 409,
    });
    logger.recordHttpResponse({
      method: "DELETE",
      routeTemplate: "/api/channels/:channelId",
      statusCode: 503,
    });
    logger.recordHttpResponse({
      method: "GET",
      routeTemplate: "/api/snapshot",
      statusCode: 500,
    });
    await logger.drain();

    const rows = await new InteractionRepository(databases.events).listRange({
      rangeStartMs: 0,
      rangeEndMs: 10_000,
    });
    expect(rows).toHaveLength(4);
    expect(rows).toMatchObject([
      {
        kind: "http.response-outcome",
        severity: "info",
        outcome: "succeeded",
        retentionClass: "audit",
        byteCount: 0,
        payload: {
          method: "POST",
          routeTemplate: "/api/channels",
          statusCode: 201,
        },
      },
      {
        severity: "warning",
        outcome: "failed",
        retentionClass: "audit",
        payload: {
          method: "PATCH",
          routeTemplate: "/api/channels/:channelId",
          statusCode: 409,
        },
      },
      {
        severity: "critical",
        outcome: "failed",
        retentionClass: "critical",
        payload: {
          method: "DELETE",
          routeTemplate: "/api/channels/:channelId",
          statusCode: 503,
        },
      },
      {
        severity: "critical",
        outcome: "failed",
        retentionClass: "critical",
        payload: {
          method: "GET",
          routeTemplate: "/api/snapshot",
          statusCode: 500,
        },
      },
    ]);
  });

  it("stores only sanitized runtime error identity and safe HTTP metadata", async () => {
    const databases = await openDatabasesForTest();
    const logger = new ControllerInteractionLogger(
      new InteractionRepository(databases.events),
      { now: () => 2_000, onPersistenceError: () => undefined },
    );
    const failure = new AquariumRuntimeFailure("super-secret callback detail");
    failure.name = "Bearer super-secret";

    logger.recordRuntimeCallbackFailure(failure);
    logger.recordHttpResponse({
      method: "secret-method",
      routeTemplate: "/api/items/:itemId?token=super-secret",
      statusCode: 500,
    });
    await logger.drain();

    const rows = await new InteractionRepository(databases.events).listRange({
      rangeStartMs: 0,
      rangeEndMs: 10_000,
    });
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({
      kind: "controller.runtime-callback-error",
      severity: "critical",
      retentionClass: "critical",
      payload: {
        errorClass: "AquariumRuntimeFailure",
        errorName: "Error",
      },
    });
    expect(rows[1]).toMatchObject({
      kind: "http.response-outcome",
      payload: {
        method: "OTHER",
        routeTemplate: null,
        statusCode: 500,
      },
    });
    expect(JSON.stringify(rows)).not.toContain("super-secret");
    expect(JSON.stringify(rows)).not.toContain("callback detail");
  });

  it("drains detached writes and reports persistence failures", async () => {
    let releaseWrite: () => void = () => {
      throw new Error("Write gate was not initialized");
    };
    const writeGate = new Promise<void>((resolve) => {
      releaseWrite = resolve;
    });
    const inputs: InteractionLogInput[] = [];
    const reported: Error[] = [];
    const logger = new ControllerInteractionLogger(
      {
        async log(input): Promise<object> {
          inputs.push(input);
          await writeGate;
          throw new Error("events database unavailable");
        },
      },
      {
        now: () => 3_000,
        onPersistenceError: (error) => reported.push(error),
      },
    );

    logger.recordHttpResponse({
      method: "POST",
      routeTemplate: "/api/channels",
      statusCode: 200,
    });
    let drained = false;
    const draining = logger.drain().then(() => {
      drained = true;
    });
    await Promise.resolve();
    expect(inputs).toHaveLength(1);
    expect(drained).toBe(false);

    releaseWrite();
    await draining;
    expect(drained).toBe(true);
    expect(reported).toHaveLength(1);
    expect(reported[0]?.message).toBe("events database unavailable");
  });

  it("keeps an onResponse recorder failure out of the committed response", async () => {
    const recorded: HttpResponseMetadata[] = [];
    const app = buildApp({
      httpInteractionRecorder: {
        recordHttpResponse(metadata) {
          recorded.push(metadata);
          throw new Error("unable to enqueue audit write");
        },
      },
    });
    openApps.push(app);

    const response = await app.inject({
      method: "POST",
      url: "/api/channels",
      payload: {},
    });

    expect(response.statusCode).toBe(400);
    expect(recorded).toEqual([
      {
        method: "POST",
        routeTemplate: "/api/channels",
        statusCode: 400,
      },
    ]);
  });
});

class AquariumRuntimeFailure extends Error {}

async function openDatabasesForTest(): Promise<ControllerDatabases> {
  const databases = await openControllerDatabases({
    state: { filename: ":memory:" },
    events: { filename: ":memory:" },
  });
  openDatabases.push(databases);
  return databases;
}
