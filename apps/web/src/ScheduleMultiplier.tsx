import type { Throttle } from "@aquarium/contracts";
import { useRef } from "react";

export interface ScheduleMultiplierProps {
  readonly areaLabel: string;
  readonly throttle: Throttle | null;
  readonly value: number;
  readonly dirty: boolean;
  readonly disabled: boolean;
  readonly conflictRevision: number | null;
  readonly conflictReady: boolean;
  readonly onAcceptConflict: () => void;
  readonly onHistoryCheckpoint?: () => void;
  readonly onChange: (value: number) => void;
}

export function ScheduleMultiplier({
  areaLabel,
  throttle,
  value,
  dirty,
  disabled,
  conflictRevision,
  conflictReady,
  onAcceptConflict,
  onHistoryCheckpoint,
  onChange,
}: ScheduleMultiplierProps): React.JSX.Element {
  const checkpointedRef = useRef(false);

  return (
    <section
      className="schedule-multiplier"
      aria-labelledby="schedule-multiplier-heading"
    >
      <p className="eyebrow">Area control</p>
      <div className="multiplier-heading-line">
        <h2 id="schedule-multiplier-heading">Schedule multiplier</h2>
        {dirty ? <span className="unsaved-label">Unsaved</span> : null}
      </div>
      {throttle === null ? (
        <p className="field-error">
          {areaLabel} has no multiplier record, so scaling cannot be changed.
        </p>
      ) : (
        <>
          <div className="multiplier-value">
            <output htmlFor="schedule-multiplier-input">{value}%</output>
            <span>all {areaLabel.toLocaleLowerCase()} channels</span>
          </div>
          <label className="multiplier-range-label">
            <span className="visually-hidden">
              {areaLabel} schedule multiplier
            </span>
            <input
              id="schedule-multiplier-input"
              aria-label={`${areaLabel} schedule multiplier`}
              type="range"
              min="0"
              max="100"
              step="1"
              value={value}
              disabled={disabled}
              onChange={(event) => {
                if (!checkpointedRef.current) {
                  checkpointedRef.current = true;
                  onHistoryCheckpoint?.();
                }
                onChange(event.currentTarget.valueAsNumber);
              }}
              onPointerUp={() => {
                checkpointedRef.current = false;
              }}
              onPointerCancel={() => {
                checkpointedRef.current = false;
              }}
              onKeyUp={() => {
                checkpointedRef.current = false;
              }}
              onBlur={() => {
                checkpointedRef.current = false;
              }}
            />
          </label>
          {conflictRevision === null ? null : (
            <div className="conflict-banner multiplier-conflict" role="alert">
              <span>
                Controller configuration advanced to revision {conflictRevision}
                . The local multiplier was preserved.
              </span>
              <button
                className="text-button"
                type="button"
                disabled={!conflictReady}
                onClick={onAcceptConflict}
              >
                Keep local multiplier with refreshed revision
              </button>
            </div>
          )}
        </>
      )}
    </section>
  );
}
