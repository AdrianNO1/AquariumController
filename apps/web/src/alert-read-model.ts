import type {
  ActiveAlert,
  AlertRule,
  ControllerSnapshot,
} from "@aquarium/contracts";

export interface AlertPresentationItem {
  readonly alert: ActiveAlert;
  readonly rule: AlertRule;
}

export interface AlertsReadModel {
  readonly open: readonly AlertPresentationItem[];
  readonly acknowledged: readonly AlertPresentationItem[];
  readonly recovered: readonly AlertPresentationItem[];
}

export function buildAlertsReadModel(
  rules: readonly AlertRule[],
  alerts: readonly ActiveAlert[],
): AlertsReadModel {
  const rulesById = new Map(rules.map((rule) => [rule.id, rule]));
  const items = alerts.map((alert) => {
    const rule = rulesById.get(alert.alertRuleId);
    if (rule === undefined) {
      throw new Error(
        `Alert ${alert.id} references missing rule ${alert.alertRuleId}`,
      );
    }
    return { alert, rule };
  });
  return {
    open: items.filter((item) => item.alert.state === "open"),
    acknowledged: items.filter((item) => item.alert.state === "acknowledged"),
    recovered: items.filter((item) => item.alert.state === "recovered"),
  };
}

export function alertsReadModelFromSnapshot(
  snapshot: ControllerSnapshot,
): AlertsReadModel {
  return buildAlertsReadModel(snapshot.alertRules, snapshot.alerts);
}
