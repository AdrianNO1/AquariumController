import { createContext } from "react";

import type { ControllerClientState } from "./controller-state-coordinator.js";

export interface ControllerStateContextValue extends ControllerClientState {
  readonly refresh: () => void;
  readonly retry: () => void;
}

export const ControllerStateContext =
  createContext<ControllerStateContextValue | null>(null);
