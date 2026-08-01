import { z } from "zod";

import { committedStateEventSchema } from "./controller.js";
import {
  controlAreaSlugSchema,
  identifierSchema,
  isoTimestampSchema,
} from "./primitives.js";

export * from "./controller.js";
export * from "./logs.js";
export * from "./manual-overrides.js";
export * from "./primitives.js";

export const healthResponseSchema = z.strictObject({
  service: z.literal("aquarium-controller"),
  status: z.literal("ok"),
  version: z.string().min(1),
  now: isoTimestampSchema,
  capabilities: z.tuple([z.literal("http"), z.literal("sse")]),
});

export type HealthResponse = z.infer<typeof healthResponseSchema>;

export const streamReadyEventSchema = z.strictObject({
  type: z.literal("system.stream-ready"),
  occurredAt: isoTimestampSchema,
  data: z.strictObject({
    currentRevision: z.number().int().nonnegative(),
    replayedCount: z.number().int().nonnegative(),
  }),
});

export const resyncRequiredEventSchema = z.strictObject({
  type: z.literal("system.resync-required"),
  occurredAt: isoTimestampSchema,
  data: z.strictObject({
    requestedRevision: z.number().int().nonnegative(),
    earliestAvailableRevision: z.number().int().nonnegative(),
    currentRevision: z.number().int().nonnegative(),
    reason: z.string().min(1),
  }),
});

export const streamHeartbeatEventSchema = z.strictObject({
  type: z.literal("system.heartbeat"),
  occurredAt: isoTimestampSchema,
  data: z.strictObject({
    currentRevision: z.number().int().nonnegative(),
    serverNow: isoTimestampSchema,
  }),
});

export const deviceContactEventSchema = z.strictObject({
  type: z.literal("device.contact"),
  occurredAt: isoTimestampSchema,
  data: z.strictObject({
    deviceId: identifierSchema,
  }),
});

export const systemStreamEventSchema = z.discriminatedUnion("type", [
  streamReadyEventSchema,
  resyncRequiredEventSchema,
  streamHeartbeatEventSchema,
  deviceContactEventSchema,
]);

export type SystemStreamEvent = z.infer<typeof systemStreamEventSchema>;

export const controllerStreamEventSchema = z.union([
  systemStreamEventSchema,
  committedStateEventSchema,
]);

export type ControllerStreamEvent = z.infer<typeof controllerStreamEventSchema>;

export const legacyControlAreaSchema = controlAreaSlugSchema;
export type LegacyControlArea = z.infer<typeof legacyControlAreaSchema>;
