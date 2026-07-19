import { useContext } from "react";

import {
  ControllerStateContext,
  type ControllerStateContextValue,
} from "./controller-state-context.js";

export function useControllerState(): ControllerStateContextValue {
  const value = useContext(ControllerStateContext);
  if (value === null) {
    throw new Error("useControllerState requires ControllerStateProvider");
  }
  return value;
}
