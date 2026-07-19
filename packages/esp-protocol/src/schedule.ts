import { z } from "zod";

import { assertLegacyScheduleFits, LEGACY_MAX_SYNC_TIME } from "./limits.js";

export const LEGACY_LIGHT_CHANNEL_TYPE = 108;
export const LEGACY_PUMP_CHANNEL_TYPE = 112;

const legacySchedulePointSchema = z.strictObject({
  t: z.number().int().min(0).max(1_439),
  p: z.number().int().min(0).max(100),
});

const legacyScheduleLinkSchema = z.strictObject({
  s: legacySchedulePointSchema,
  d: legacySchedulePointSchema,
});

export const legacyScheduleChannelSchema = z.strictObject({
  o: z.number().int().min(0).max(63),
  t: z.union([
    z.literal(LEGACY_LIGHT_CHANNEL_TYPE),
    z.literal(LEGACY_PUMP_CHANNEL_TYPE),
  ]),
  l: z.array(legacyScheduleLinkSchema),
});

export const legacyScheduleCoreSchema = z.strictObject({
  c: z.array(legacyScheduleChannelSchema),
});

export const legacyScheduleDocumentSchema = legacyScheduleCoreSchema.extend({
  syncTime: z.number().int().positive().max(LEGACY_MAX_SYNC_TIME),
});

export type LegacyScheduleChannel = z.infer<typeof legacyScheduleChannelSchema>;
export type LegacyScheduleCore = z.infer<typeof legacyScheduleCoreSchema>;
export type LegacyScheduleDocument = z.infer<
  typeof legacyScheduleDocumentSchema
>;

/**
 * Produces the same compact key order as legacy Python json.dumps(...,
 * separators=(",", ":")) and the ArduinoJson channels-only hash document.
 */
export function serializeLegacyScheduleCore(
  schedule: LegacyScheduleCore,
): string {
  const validated = legacyScheduleCoreSchema.parse(schedule);
  const serialized = JSON.stringify({ c: validated.c });
  assertLegacyScheduleFits(serialized);
  return serialized;
}

/** Adds syncTime after c, matching the active legacy host's insertion order. */
export function serializeLegacyScheduleDocument(
  schedule: LegacyScheduleCore,
  syncTime: number,
): string {
  const validated = legacyScheduleDocumentSchema.parse({
    c: schedule.c,
    syncTime,
  });
  const serialized = JSON.stringify({
    c: validated.c,
    syncTime: validated.syncTime,
  });
  assertLegacyScheduleFits(serialized);
  return serialized;
}

/**
 * Firmware hashes UTF-8 bytes with DJB2 and unsigned 32-bit overflow. Schedule
 * documents are ASCII today, but byte-based hashing also remains correct if a
 * future metadata-free protocol revision admits non-ASCII text.
 */
export function unsignedDjb2(value: string): number {
  let hash = 5_381;
  for (const byte of new TextEncoder().encode(value)) {
    hash = (Math.imul(hash, 33) + byte) >>> 0;
  }
  return hash;
}

export function calculateLegacyScheduleHash(
  schedule: LegacyScheduleCore,
): string {
  return String(unsignedDjb2(serializeLegacyScheduleCore(schedule)));
}
