import {
  controllerStreamEventSchema,
  type ControllerStreamEvent,
} from "@aquarium/contracts";
import { useEffect, useState } from "react";

export type EventConnectionState =
  "connecting" | "live" | "reconnecting" | "resync-required" | "protocol-error";

export interface ControllerEventsState {
  readonly connection: EventConnectionState;
  readonly lastEvent: ControllerStreamEvent | null;
  readonly currentRevision: number;
}

export function useControllerEvents(afterRevision = 0): ControllerEventsState {
  const [connection, setConnection] =
    useState<EventConnectionState>("connecting");
  const [lastEvent, setLastEvent] = useState<ControllerStreamEvent | null>(
    null,
  );
  const [currentRevision, setCurrentRevision] = useState(afterRevision);

  useEffect(() => {
    let appliedRevision = afterRevision;
    const source = new EventSource(
      `/api/events?afterRevision=${encodeURIComponent(String(afterRevision))}`,
    );

    source.onmessage = (message) => {
      try {
        const parsed = controllerStreamEventSchema.safeParse(
          JSON.parse(message.data),
        );
        if (!parsed.success) {
          setConnection("protocol-error");
          return;
        }
        if ("revision" in parsed.data) {
          if (parsed.data.revision <= appliedRevision) {
            return;
          }
          if (parsed.data.revision !== appliedRevision + 1) {
            setConnection("resync-required");
            source.close();
            return;
          }
          appliedRevision = parsed.data.revision;
          setCurrentRevision(appliedRevision);
          setLastEvent(parsed.data);
        } else if (parsed.data.type === "system.stream-ready") {
          if (parsed.data.data.currentRevision !== appliedRevision) {
            setConnection("resync-required");
            source.close();
            return;
          }
          setLastEvent(parsed.data);
          setConnection("live");
        } else if (parsed.data.type === "system.resync-required") {
          setLastEvent(parsed.data);
          setConnection("resync-required");
          source.close();
        } else if (parsed.data.data.currentRevision > appliedRevision) {
          setConnection("resync-required");
          source.close();
        } else {
          setLastEvent(parsed.data);
        }
      } catch {
        setConnection("protocol-error");
      }
    };
    source.onerror = () => {
      setConnection("reconnecting");
    };

    return () => {
      source.close();
    };
  }, [afterRevision]);

  return { connection, lastEvent, currentRevision };
}
