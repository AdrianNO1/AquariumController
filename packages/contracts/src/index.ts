import { z } from "zod";

export const isoTimestampSchema = z.string().datetime({ offset: true });

export const healthResponseSchema = z.object({
  service: z.literal("aquarium-controller"),
  status: z.literal("ok"),
  version: z.string().min(1),
  now: isoTimestampSchema,
  capabilities: z.tuple([z.literal("http"), z.literal("sse")]),
});

export type HealthResponse = z.infer<typeof healthResponseSchema>;

export const streamReadyEventSchema = z.object({
  type: z.literal("system.stream-ready"),
  occurredAt: isoTimestampSchema,
  data: z.object({
    currentRevision: z.number().int().nonnegative(),
    replayedCount: z.number().int().nonnegative(),
  }),
});

export const resyncRequiredEventSchema = z.object({
  type: z.literal("system.resync-required"),
  occurredAt: isoTimestampSchema,
  data: z.object({
    requestedRevision: z.number().int().nonnegative(),
    earliestAvailableRevision: z.number().int().nonnegative(),
    currentRevision: z.number().int().nonnegative(),
    reason: z.string().min(1),
  }),
});

export const streamHeartbeatEventSchema = z.object({
  type: z.literal("system.heartbeat"),
  occurredAt: isoTimestampSchema,
  data: z.object({
    currentRevision: z.number().int().nonnegative(),
    serverNow: isoTimestampSchema,
  }),
});

export const systemStreamEventSchema = z.discriminatedUnion("type", [
  streamReadyEventSchema,
  resyncRequiredEventSchema,
  streamHeartbeatEventSchema,
]);

export type SystemStreamEvent = z.infer<typeof systemStreamEventSchema>;

export const committedStateEventSchema = z.strictObject({
  revision: z.number().int().positive(),
  type: z.string().min(1),
  occurredAt: isoTimestampSchema,
  entity: z.strictObject({
    type: z.string().min(1),
    id: z.string().min(1).nullable(),
  }),
  schemaVersion: z.number().int().positive(),
  data: z.json(),
});

export type CommittedStateEvent = z.infer<typeof committedStateEventSchema>;

export const controllerStreamEventSchema = z.union([
  systemStreamEventSchema,
  committedStateEventSchema,
]);

export type ControllerStreamEvent = z.infer<typeof controllerStreamEventSchema>;

export const legacyControlAreaSchema = z.enum([
  "lights",
  "pumps",
  "testlights",
  "bad",
  "loft",
  "biljard",
  "frag",
  "qt1",
  "qt2",
  "qt3",
  "qt4",
]);

export type LegacyControlArea = z.infer<typeof legacyControlAreaSchema>;
