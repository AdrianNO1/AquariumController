import { z } from "zod";

export const nonnegativeSafeIntegerSchema = z
  .number()
  .int()
  .nonnegative()
  .max(Number.MAX_SAFE_INTEGER);

export const positiveSafeIntegerSchema = z
  .number()
  .int()
  .positive()
  .max(Number.MAX_SAFE_INTEGER);

export const isoTimestampSchema = z.string().datetime({ offset: true });

export const MAX_IDENTIFIER_LENGTH = 128;

export const identifierSchema = z
  .string()
  .min(1)
  .max(MAX_IDENTIFIER_LENGTH)
  .regex(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/u);

export const boundedTextSchema = z
  .string()
  .min(1)
  .max(256)
  .refine((value) => value.trim() === value, {
    message: "Text must not have leading or trailing whitespace",
  })
  .refine(
    (value) =>
      !Array.from(value).some((character) => {
        const code = character.charCodeAt(0);
        return code <= 0x1f || code === 0x7f;
      }),
    { message: "Text must not contain control characters" },
  );

export const percentageSchema = z.number().min(0).max(100);
export const gainSchema = z.number().min(0).max(1);

export const canonicalHexColorSchema = z.string().regex(/^#[0-9a-f]{6}$/u);

export const CHANNEL_COLOR_PALETTE = [
  "#6f5bd5",
  "#a747a9",
  "#3c66db",
  "#13a4c7",
  "#80909a",
  "#dc5450",
  "#2aa7a0",
  "#e0953b",
  "#5caf62",
  "#d46a9a",
  "#7b74d8",
  "#bc6c3e",
] as const;

export const canonicalUint32HashSchema = z
  .string()
  .regex(/^(0|[1-9][0-9]{0,9})$/u)
  .refine((value) => Number(value) <= 4_294_967_295, {
    message: "Hash must be an unsigned 32-bit decimal value",
  });

export const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);

export const controlTypeKeySchema = z.enum([
  "light",
  "pump",
  "testlight",
  "bad",
  "loft",
  "biljard",
  "frag",
  "qt1",
  "qt2",
  "qt3",
  "qt4",
]);

export const controlAreaSlugSchema = z.enum([
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

export const deviceStatusSchema = z.enum([
  "unknown",
  "online",
  "stale",
  "offline",
  "error",
]);

export const operationStatusSchema = z.enum([
  "pending",
  "in_flight",
  "succeeded",
  "failed",
  "timed_out",
  "outcome_unknown",
  "cancelled",
]);

export const overrideStatusSchema = z.enum([
  "pending",
  "active",
  "expired",
  "cancelled",
  "failed",
]);

export const alertStateSchema = z.enum(["open", "acknowledged", "recovered"]);

export const alertSeveritySchema = z.enum([
  "info",
  "warning",
  "error",
  "critical",
]);

export const notificationDeliveryStatusSchema = z.enum([
  "pending",
  "attempting",
  "delivered",
  "failed",
  "outcome_unknown",
]);

export const eventDirectionSchema = z.enum(["inbound", "outbound", "internal"]);

export const eventOutcomeSchema = z.enum([
  "pending",
  "succeeded",
  "failed",
  "timed_out",
  "outcome_unknown",
  "ignored",
]);

export const retentionClassSchema = z.enum([
  "critical",
  "audit",
  "operational",
  "raw",
  "aggregate",
]);

export type ControlTypeKey = z.infer<typeof controlTypeKeySchema>;
export type ControlAreaSlug = z.infer<typeof controlAreaSlugSchema>;
