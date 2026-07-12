import {
  committedStateEventSchema,
  systemStreamEventSchema,
  type CommittedStateEvent,
  type SystemStreamEvent,
} from "@aquarium/contracts";
import { z } from "zod";

const revisionStringSchema = z
  .string()
  .regex(/^\d+$/)
  .transform(Number)
  .pipe(z.number().int().nonnegative().safe());

export function formatTransientSseEvent(event: SystemStreamEvent): string {
  const validatedEvent = systemStreamEventSchema.parse(event);
  return `data: ${JSON.stringify(validatedEvent)}\n\n`;
}

export function formatCommittedSseEvent(event: CommittedStateEvent): string {
  const validatedEvent = committedStateEventSchema.parse(event);
  return `id: ${validatedEvent.revision}\ndata: ${JSON.stringify(validatedEvent)}\n\n`;
}

export function resolveSseAfterRevision(
  afterRevision: string | undefined,
  lastEventId: string | undefined,
): number {
  const candidate =
    lastEventId !== undefined && lastEventId.length > 0
      ? lastEventId
      : (afterRevision ?? "0");
  return revisionStringSchema.parse(candidate);
}
