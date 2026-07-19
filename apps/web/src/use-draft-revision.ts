import { useCallback, useState } from "react";

export interface DraftRevision {
  readonly revision: number;
  readonly pin: () => void;
  readonly reset: () => void;
  readonly rebase: () => void;
}

/** Keeps a mutation token fixed while a user-owned draft is in progress. */
export function useDraftRevision(currentRevision: number): DraftRevision {
  const [pinnedRevision, setPinnedRevision] = useState<number | null>(null);
  const pin = useCallback(() => {
    setPinnedRevision((existing) => existing ?? currentRevision);
  }, [currentRevision]);
  const reset = useCallback(() => setPinnedRevision(null), []);
  const rebase = useCallback(
    () => setPinnedRevision(currentRevision),
    [currentRevision],
  );

  return {
    revision: pinnedRevision ?? currentRevision,
    pin,
    reset,
    rebase,
  };
}
