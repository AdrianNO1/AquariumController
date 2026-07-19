import { useEffect, useMemo, useSyncExternalStore } from "react";

import { fetchControllerSnapshot } from "./api.js";
import {
  ControllerStateContext,
  type ControllerStateContextValue,
} from "./controller-state-context.js";
import {
  ControllerStateCoordinator,
  type ControllerEventStream,
} from "./controller-state-coordinator.js";

interface ControllerStateProviderProps {
  readonly children: React.ReactNode;
  readonly coordinator?: ControllerStateCoordinator;
}

function createBrowserEventStream(url: string): ControllerEventStream {
  const source = new EventSource(url);
  return {
    listen: (handlers) => {
      source.addEventListener("open", handlers.open);
      source.addEventListener("message", (event: MessageEvent<string>) =>
        handlers.message(event.data),
      );
      source.addEventListener("error", handlers.error);
    },
    close: () => source.close(),
  };
}

export function ControllerStateProvider({
  children,
  coordinator,
}: ControllerStateProviderProps): React.JSX.Element {
  const activeCoordinator = useMemo(
    () =>
      coordinator ??
      new ControllerStateCoordinator({
        fetchSnapshot: fetchControllerSnapshot,
        createEventStream: createBrowserEventStream,
      }),
    [coordinator],
  );
  const state = useSyncExternalStore(
    activeCoordinator.subscribe,
    activeCoordinator.getState,
    activeCoordinator.getState,
  );

  useEffect(() => {
    activeCoordinator.start();
    return () => activeCoordinator.stop();
  }, [activeCoordinator]);

  const value = useMemo<ControllerStateContextValue>(
    () => ({
      ...state,
      refresh: activeCoordinator.refresh,
      retry: activeCoordinator.retry,
    }),
    [activeCoordinator, state],
  );

  return (
    <ControllerStateContext.Provider value={value}>
      {children}
    </ControllerStateContext.Provider>
  );
}
