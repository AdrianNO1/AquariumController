import { systemEventSchema, type SystemEvent } from "@aquarium/contracts";
import { useEffect, useState } from "react";

export type EventConnectionState = "connecting" | "live" | "reconnecting";

export interface ControllerEventsState {
  readonly connection: EventConnectionState;
  readonly lastEvent: SystemEvent | null;
}

export function useControllerEvents(): ControllerEventsState {
  const [connection, setConnection] =
    useState<EventConnectionState>("connecting");
  const [lastEvent, setLastEvent] = useState<SystemEvent | null>(null);

  useEffect(() => {
    const source = new EventSource("/api/events");

    source.onopen = () => {
      setConnection("live");
    };
    source.onmessage = (message) => {
      const parsed = systemEventSchema.safeParse(JSON.parse(message.data));
      if (parsed.success) {
        setLastEvent(parsed.data);
      }
    };
    source.onerror = () => {
      setConnection("reconnecting");
    };

    return () => {
      source.close();
    };
  }, []);

  return { connection, lastEvent };
}
