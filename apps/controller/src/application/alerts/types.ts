import type { DeviceStatus } from "../../infrastructure/database/index.js";

export type AlertSeverity = "info" | "warning" | "error" | "critical";

interface ObservationBase {
  readonly sourceId: string;
  readonly deduplicationKey?: string;
}

export interface DeviceAlertObservation extends ObservationBase {
  readonly sourceType: "device";
  readonly status: DeviceStatus;
}

export interface OutputAlertObservation extends ObservationBase {
  readonly sourceType: "output";
  readonly valuePercentage: number;
}

export interface SensorAlertObservation extends ObservationBase {
  readonly sourceType: "sensor";
  readonly value: number;
}

export interface SwitchAlertObservation extends ObservationBase {
  readonly sourceType: "switch";
  readonly isOpen: boolean;
}

export type AlertObservation =
  | DeviceAlertObservation
  | OutputAlertObservation
  | SensorAlertObservation
  | SwitchAlertObservation;

export type AlertLifecycleTransition =
  | "opened"
  | "observed"
  | "acknowledged"
  | "recovered"
  | "reopened";

export interface AlertRuleSnapshot {
  readonly id: string;
  readonly name: string;
  readonly sourceType: AlertObservation["sourceType"];
  readonly sourceId: string;
  readonly condition: string;
  readonly threshold: number | null;
  readonly delayMs: number;
  readonly severity: AlertSeverity;
}

export interface AlertSnapshot {
  readonly id: string;
  readonly ruleId: string;
  readonly deduplicationKey: string;
  readonly state: "open" | "acknowledged" | "recovered";
  readonly openedAtMs: number;
  readonly lastObservedAtMs: number;
  readonly acknowledgedAtMs: number | null;
  readonly recoveredAtMs: number | null;
}

export interface AlertStateEventPayloadV1 {
  readonly schemaVersion: 1;
  readonly transition: AlertLifecycleTransition;
  readonly alert: AlertSnapshot;
  readonly rule: AlertRuleSnapshot;
  readonly observation: AlertObservation | null;
  readonly note: string | null;
}

export interface AlertTransition {
  readonly revision: number;
  readonly occurredAtMs: number;
  readonly transition: AlertLifecycleTransition;
  readonly payload: AlertStateEventPayloadV1;
}

export type AlertEvaluationDecision =
  | {
      readonly kind: "condition-clear" | "unchanged";
      readonly ruleId: string;
    }
  | {
      readonly kind: "pending";
      readonly ruleId: string;
      readonly pendingSinceMs: number;
      readonly remainingDelayMs: number;
    }
  | {
      readonly kind: "transition";
      readonly ruleId: string;
      readonly transition: AlertTransition;
    };

export interface AlertEvaluationResult {
  readonly evaluatedAtMs: number;
  readonly decisions: readonly AlertEvaluationDecision[];
}

export interface AlertNotificationV1 {
  readonly schemaVersion: 1;
  readonly kind: "aquarium.alert";
  readonly eventRevision: number;
  readonly occurredAt: string;
  readonly transition: Exclude<AlertLifecycleTransition, "observed">;
  readonly alert: AlertSnapshot;
  readonly rule: AlertRuleSnapshot;
  readonly observation: AlertObservation | null;
  readonly note: string | null;
}

export interface AlertClock {
  nowMs(): number;
}

export interface AlertIdGenerator {
  nextAlertId(): string;
}

export class SystemAlertClock implements AlertClock {
  nowMs(): number {
    return Date.now();
  }
}

export class RandomAlertIdGenerator implements AlertIdGenerator {
  nextAlertId(): string {
    return crypto.randomUUID();
  }
}
