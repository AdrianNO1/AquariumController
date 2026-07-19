import { randomUUID } from "node:crypto";

import type {
  AlertLifecycleTransition as ContractAlertLifecycleTransition,
  AlertNotificationV1 as ContractAlertNotificationV1,
  AlertObservation as ContractAlertObservation,
  AlertRuleSnapshot as ContractAlertRuleSnapshot,
  AlertSnapshot as ContractAlertSnapshot,
  AlertStateEventPayloadV1 as ContractAlertStateEventPayloadV1,
} from "@aquarium/contracts";

export type AlertObservation = ContractAlertObservation;
export type DeviceAlertObservation = Extract<
  AlertObservation,
  { readonly sourceType: "device" }
>;
export type OutputAlertObservation = Extract<
  AlertObservation,
  { readonly sourceType: "output" }
>;
export type SensorAlertObservation = Extract<
  AlertObservation,
  { readonly sourceType: "sensor" }
>;
export type SwitchAlertObservation = Extract<
  AlertObservation,
  { readonly sourceType: "switch" }
>;
export type AlertLifecycleTransition = ContractAlertLifecycleTransition;
export type AlertRuleSnapshot = ContractAlertRuleSnapshot;
export type AlertSeverity = AlertRuleSnapshot["severity"];
export type AlertSnapshot = ContractAlertSnapshot;
export type AlertStateEventPayloadV1 = ContractAlertStateEventPayloadV1;
export type AlertNotificationV1 = ContractAlertNotificationV1;

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
    return randomUUID();
  }
}
