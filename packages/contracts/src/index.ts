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

export const systemConnectedEventSchema = z.object({
  id: z.string().regex(/^\d+$/),
  type: z.literal("system.connected"),
  occurredAt: isoTimestampSchema,
  data: z.object({
    revision: z.number().int().nonnegative(),
  }),
});

export const resyncRequiredEventSchema = z.object({
  id: z.string().regex(/^\d+$/),
  type: z.literal("system.resync-required"),
  occurredAt: isoTimestampSchema,
  data: z.object({
    earliestAvailableRevision: z.number().int().nonnegative(),
  }),
});

export const systemEventSchema = z.discriminatedUnion("type", [
  systemConnectedEventSchema,
  resyncRequiredEventSchema,
]);

export type SystemEvent = z.infer<typeof systemEventSchema>;

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
