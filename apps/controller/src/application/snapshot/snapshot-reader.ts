import type { ControllerSnapshot } from "@aquarium/contracts";

export interface ControllerSnapshotReader {
  read(): Promise<ControllerSnapshot>;
}
