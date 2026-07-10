import { systemEventSchema, type SystemEvent } from "@aquarium/contracts";

export function formatSseEvent(event: SystemEvent): string {
  const validatedEvent = systemEventSchema.parse(event);
  return `id: ${validatedEvent.id}\ndata: ${JSON.stringify(validatedEvent)}\n\n`;
}
