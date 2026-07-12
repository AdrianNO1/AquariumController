import type { Kysely, Selectable } from "kysely";

import {
  commitStateChange,
  type ActiveAlertsTable,
  type AlertRulesTable,
  type StateDatabaseSchema,
} from "../../infrastructure/database/index.js";
import type {
  AlertClock,
  AlertEvaluationDecision,
  AlertEvaluationResult,
  AlertIdGenerator,
  AlertLifecycleTransition,
  AlertObservation,
  AlertRuleSnapshot,
  AlertSeverity,
  AlertSnapshot,
  AlertStateEventPayloadV1,
  AlertTransition,
} from "./types.js";

type StoredAlertRule = Selectable<AlertRulesTable>;
type StoredActiveAlert = Selectable<ActiveAlertsTable>;

interface PendingCondition {
  readonly ruleId: string;
  readonly sinceMs: number;
  readonly sourceType: AlertObservation["sourceType"];
  readonly sourceId: string;
}

export class AlertNotFoundError extends Error {
  override readonly name = "AlertNotFoundError";

  constructor(alertId: string) {
    super(`Alert ${alertId} does not exist`);
  }
}

export class InvalidAlertTransitionError extends Error {
  override readonly name = "InvalidAlertTransitionError";

  constructor(alertId: string, state: string, requestedTransition: string) {
    super(
      `Alert ${alertId} cannot transition from ${state} to ${requestedTransition}`,
    );
  }
}

export class InvalidAlertRuleError extends Error {
  override readonly name = "InvalidAlertRuleError";
  readonly ruleId: string;

  constructor(ruleId: string, reason: string) {
    super(`Alert rule ${ruleId} is invalid: ${reason}`);
    this.ruleId = ruleId;
  }
}

function assertTimestamp(value: number): void {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new RangeError("Alert clock must return a non-negative safe integer");
  }
  if (!Number.isFinite(new Date(value).getTime())) {
    throw new RangeError("Alert clock returned an unrepresentable timestamp");
  }
}

function assertNonEmpty(value: string, field: string): void {
  if (value.trim().length === 0) {
    throw new TypeError(`${field} must not be empty`);
  }
}

function validateObservation(observation: AlertObservation): void {
  assertNonEmpty(observation.sourceId, "observation.sourceId");
  if (observation.deduplicationKey !== undefined) {
    assertNonEmpty(
      observation.deduplicationKey,
      "observation.deduplicationKey",
    );
  }

  if (observation.sourceType === "output") {
    if (
      !Number.isFinite(observation.valuePercentage) ||
      observation.valuePercentage < 0 ||
      observation.valuePercentage > 100
    ) {
      throw new RangeError(
        "Output observation valuePercentage must be between 0 and 100",
      );
    }
  } else if (
    observation.sourceType === "sensor" &&
    !Number.isFinite(observation.value)
  ) {
    throw new RangeError("Sensor observation value must be finite");
  }
}

function parseSeverity(rule: StoredAlertRule): AlertSeverity {
  switch (rule.severity) {
    case "info":
    case "warning":
    case "error":
    case "critical":
      return rule.severity;
    default:
      throw new InvalidAlertRuleError(
        rule.id,
        `unsupported severity ${rule.severity}`,
      );
  }
}

function ruleSourceId(rule: StoredAlertRule): string {
  switch (rule.source_type) {
    case "device":
      if (rule.device_id !== null) return rule.device_id;
      break;
    case "output":
      if (rule.output_id !== null) return rule.output_id;
      break;
    case "sensor":
      if (rule.sensor_id !== null) return rule.sensor_id;
      break;
    case "switch":
      if (rule.switch_id !== null) return rule.switch_id;
      break;
  }
  throw new InvalidAlertRuleError(rule.id, "source reference is missing");
}

function requireThreshold(rule: StoredAlertRule): number {
  if (rule.threshold === null || !Number.isFinite(rule.threshold)) {
    throw new InvalidAlertRuleError(
      rule.id,
      `condition ${rule.condition} requires a finite threshold`,
    );
  }
  return rule.threshold;
}

function rejectThreshold(rule: StoredAlertRule): void {
  if (rule.threshold !== null) {
    throw new InvalidAlertRuleError(
      rule.id,
      `condition ${rule.condition} does not accept a threshold`,
    );
  }
}

function evaluateNumericCondition(
  rule: StoredAlertRule,
  value: number,
): boolean {
  const threshold = requireThreshold(rule);
  switch (rule.condition) {
    case "above":
      return value > threshold;
    case "at_or_above":
      return value >= threshold;
    case "below":
      return value < threshold;
    case "at_or_below":
      return value <= threshold;
    case "equal":
      return value === threshold;
    default:
      throw new InvalidAlertRuleError(
        rule.id,
        `unsupported numeric condition ${rule.condition}`,
      );
  }
}

function evaluateCondition(
  rule: StoredAlertRule,
  observation: AlertObservation,
): boolean {
  if (rule.source_type !== observation.sourceType) {
    throw new InvalidAlertRuleError(
      rule.id,
      `source type ${rule.source_type} does not match the observation`,
    );
  }

  switch (observation.sourceType) {
    case "device":
      rejectThreshold(rule);
      switch (rule.condition) {
        case "offline":
        case "stale":
        case "error":
          return observation.status === rule.condition;
        case "not_online":
          return observation.status !== "online";
        default:
          throw new InvalidAlertRuleError(
            rule.id,
            `unsupported device condition ${rule.condition}`,
          );
      }
    case "output":
      return evaluateNumericCondition(rule, observation.valuePercentage);
    case "sensor":
      return evaluateNumericCondition(rule, observation.value);
    case "switch":
      rejectThreshold(rule);
      if (rule.condition === "open") return observation.isOpen;
      if (rule.condition === "closed") return !observation.isOpen;
      throw new InvalidAlertRuleError(
        rule.id,
        `unsupported switch condition ${rule.condition}`,
      );
  }
}

function toRuleSnapshot(rule: StoredAlertRule): AlertRuleSnapshot {
  return {
    id: rule.id,
    name: rule.name,
    sourceType: rule.source_type,
    sourceId: ruleSourceId(rule),
    condition: rule.condition,
    threshold: rule.threshold,
    delayMs: rule.delay_ms,
    severity: parseSeverity(rule),
  };
}

function toAlertSnapshot(alert: StoredActiveAlert): AlertSnapshot {
  return {
    id: alert.id,
    ruleId: alert.alert_rule_id,
    deduplicationKey: alert.deduplication_key,
    state: alert.state,
    openedAtMs: alert.opened_at_ms,
    lastObservedAtMs: alert.last_observed_at_ms,
    acknowledgedAtMs: alert.acknowledged_at_ms,
    recoveredAtMs: alert.recovered_at_ms,
  };
}

function eventTypeFor(transition: AlertLifecycleTransition): string {
  return `alert.${transition}`;
}

function mutationTypeFor(transition: AlertLifecycleTransition): string {
  return `alert.${transition}`;
}

function summaryFor(
  transition: AlertLifecycleTransition,
  rule: StoredAlertRule,
): string {
  return `${transition} alert for rule ${rule.name}`;
}

function detailsJson(
  observation: AlertObservation | null,
  note: string | null,
): string {
  return JSON.stringify({ schemaVersion: 1, observation, note });
}

function pendingKey(ruleId: string, deduplicationKey: string): string {
  return JSON.stringify([ruleId, deduplicationKey]);
}

export class AlertService {
  private readonly pendingConditions = new Map<string, PendingCondition>();

  constructor(
    private readonly database: Kysely<StateDatabaseSchema>,
    private readonly clock: AlertClock,
    private readonly ids: AlertIdGenerator,
  ) {}

  async evaluate(
    observation: AlertObservation,
    actor = "alert-evaluator",
  ): Promise<AlertEvaluationResult> {
    validateObservation(observation);
    assertNonEmpty(actor, "actor");
    const nowMs = this.clock.nowMs();
    assertTimestamp(nowMs);
    const deduplicationKey =
      observation.deduplicationKey ??
      `${observation.sourceType}:${observation.sourceId}`;
    const rules = await this.loadRules(observation);
    const enabledRules = rules.filter((rule) => rule.enabled === 1);

    // Validate every enabled rule before any write so one malformed rule cannot
    // leave a partially evaluated observation behind.
    const evaluations = enabledRules.map((rule) => ({
      rule,
      matches: evaluateCondition(rule, observation),
    }));
    const enabledRuleIds = new Set(enabledRules.map((rule) => rule.id));
    for (const [key, pending] of this.pendingConditions) {
      if (
        pending.sourceType === observation.sourceType &&
        pending.sourceId === observation.sourceId &&
        !enabledRuleIds.has(pending.ruleId)
      ) {
        this.pendingConditions.delete(key);
      }
    }

    const decisions: AlertEvaluationDecision[] = [];
    for (const evaluation of evaluations) {
      const { rule, matches } = evaluation;
      const key = pendingKey(rule.id, deduplicationKey);
      const activeAlert = await this.database
        .selectFrom("active_alerts")
        .selectAll()
        .where("alert_rule_id", "=", rule.id)
        .where("deduplication_key", "=", deduplicationKey)
        .executeTakeFirst();

      if (!matches) {
        this.pendingConditions.delete(key);
        if (
          activeAlert !== undefined &&
          activeAlert.state !== "recovered"
        ) {
          const transition = await this.commitExistingTransition({
            alert: activeAlert,
            rule,
            transition: "recovered",
            nowMs,
            actor,
            observation,
            note: "Condition cleared",
          });
          decisions.push({ kind: "transition", ruleId: rule.id, transition });
        } else {
          decisions.push({ kind: "condition-clear", ruleId: rule.id });
        }
        continue;
      }

      if (
        activeAlert !== undefined &&
        activeAlert.state !== "recovered"
      ) {
        this.pendingConditions.delete(key);
        if (nowMs < activeAlert.last_observed_at_ms) {
          throw new RangeError(
            `Alert clock moved backwards for alert ${activeAlert.id}`,
          );
        }
        if (nowMs === activeAlert.last_observed_at_ms) {
          decisions.push({ kind: "unchanged", ruleId: rule.id });
          continue;
        }
        const transition = await this.commitExistingTransition({
          alert: activeAlert,
          rule,
          transition: "observed",
          nowMs,
          actor,
          observation,
          note: null,
        });
        decisions.push({ kind: "transition", ruleId: rule.id, transition });
        continue;
      }

      const existingPending = this.pendingConditions.get(key);
      const pending = existingPending ?? {
        ruleId: rule.id,
        sinceMs: nowMs,
        sourceType: observation.sourceType,
        sourceId: observation.sourceId,
      };
      if (nowMs < pending.sinceMs) {
        throw new RangeError(`Alert clock moved backwards for rule ${rule.id}`);
      }
      this.pendingConditions.set(key, pending);
      const elapsedMs = nowMs - pending.sinceMs;
      if (elapsedMs < rule.delay_ms) {
        decisions.push({
          kind: "pending",
          ruleId: rule.id,
          pendingSinceMs: pending.sinceMs,
          remainingDelayMs: rule.delay_ms - elapsedMs,
        });
        continue;
      }

      const transition = await this.commitOpenTransition({
        previous: activeAlert,
        rule,
        nowMs,
        actor,
        observation,
        deduplicationKey,
      });
      this.pendingConditions.delete(key);
      decisions.push({ kind: "transition", ruleId: rule.id, transition });
    }

    return { evaluatedAtMs: nowMs, decisions };
  }

  async acknowledge(
    alertId: string,
    actor: string,
    note: string | null = null,
  ): Promise<AlertTransition | null> {
    assertNonEmpty(alertId, "alertId");
    assertNonEmpty(actor, "actor");
    if (note !== null) assertNonEmpty(note, "note");
    const nowMs = this.clock.nowMs();
    assertTimestamp(nowMs);
    const { alert, rule } = await this.loadAlertAndRule(alertId);
    if (alert.state === "acknowledged") return null;
    if (alert.state !== "open") {
      throw new InvalidAlertTransitionError(
        alert.id,
        alert.state,
        "acknowledged",
      );
    }
    if (nowMs < alert.last_observed_at_ms) {
      throw new RangeError(`Alert clock moved backwards for alert ${alert.id}`);
    }

    return this.commitExistingTransition({
      alert,
      rule,
      transition: "acknowledged",
      nowMs,
      actor,
      observation: null,
      note,
    });
  }

  async recover(
    alertId: string,
    actor: string,
    note: string,
  ): Promise<AlertTransition | null> {
    assertNonEmpty(alertId, "alertId");
    assertNonEmpty(actor, "actor");
    assertNonEmpty(note, "note");
    const nowMs = this.clock.nowMs();
    assertTimestamp(nowMs);
    const { alert, rule } = await this.loadAlertAndRule(alertId);
    if (alert.state === "recovered") return null;
    if (nowMs < alert.last_observed_at_ms) {
      throw new RangeError(`Alert clock moved backwards for alert ${alert.id}`);
    }

    this.pendingConditions.delete(
      pendingKey(alert.alert_rule_id, alert.deduplication_key),
    );
    return this.commitExistingTransition({
      alert,
      rule,
      transition: "recovered",
      nowMs,
      actor,
      observation: null,
      note,
    });
  }

  private async loadRules(
    observation: AlertObservation,
  ): Promise<readonly StoredAlertRule[]> {
    const query = this.database.selectFrom("alert_rules").selectAll();
    switch (observation.sourceType) {
      case "device":
        return query
          .where("source_type", "=", "device")
          .where("device_id", "=", observation.sourceId)
          .orderBy("id")
          .execute();
      case "output":
        return query
          .where("source_type", "=", "output")
          .where("output_id", "=", observation.sourceId)
          .orderBy("id")
          .execute();
      case "sensor":
        return query
          .where("source_type", "=", "sensor")
          .where("sensor_id", "=", observation.sourceId)
          .orderBy("id")
          .execute();
      case "switch":
        return query
          .where("source_type", "=", "switch")
          .where("switch_id", "=", observation.sourceId)
          .orderBy("id")
          .execute();
    }
  }

  private async loadAlertAndRule(
    alertId: string,
  ): Promise<{ alert: StoredActiveAlert; rule: StoredAlertRule }> {
    const alert = await this.database
      .selectFrom("active_alerts")
      .selectAll()
      .where("id", "=", alertId)
      .executeTakeFirst();
    if (alert === undefined) throw new AlertNotFoundError(alertId);
    const rule = await this.database
      .selectFrom("alert_rules")
      .selectAll()
      .where("id", "=", alert.alert_rule_id)
      .executeTakeFirstOrThrow();
    return { alert, rule };
  }

  private async commitOpenTransition(options: {
    readonly previous: StoredActiveAlert | undefined;
    readonly rule: StoredAlertRule;
    readonly nowMs: number;
    readonly actor: string;
    readonly observation: AlertObservation;
    readonly deduplicationKey: string;
  }): Promise<AlertTransition> {
    const alertId = options.previous?.id ?? this.ids.nextAlertId();
    assertNonEmpty(alertId, "generated alert id");
    const transition: AlertLifecycleTransition =
      options.previous === undefined ? "opened" : "reopened";
    const alert: StoredActiveAlert = {
      id: alertId,
      alert_rule_id: options.rule.id,
      deduplication_key: options.deduplicationKey,
      state: "open",
      opened_at_ms: options.nowMs,
      last_observed_at_ms: options.nowMs,
      acknowledged_at_ms: null,
      recovered_at_ms: null,
      details_json: detailsJson(options.observation, null),
      details_schema_version: 1,
    };
    const payload = this.buildPayload(
      transition,
      alert,
      options.rule,
      options.observation,
      null,
    );
    const committed = await commitStateChange(
      this.database,
      {
        actor: options.actor,
        mutationType: mutationTypeFor(transition),
        summary: summaryFor(transition, options.rule),
        eventType: eventTypeFor(transition),
        entityType: "alert",
        entityId: alert.id,
        occurredAtMs: options.nowMs,
        retentionClass: "critical",
        payloadJson: JSON.stringify(payload),
        payloadSchemaVersion: 1,
      },
      async (transaction) => {
        if (options.previous === undefined) {
          await transaction
            .insertInto("active_alerts")
            .values(alert)
            .executeTakeFirstOrThrow();
        } else {
          await transaction
            .updateTable("active_alerts")
            .set({
              state: alert.state,
              opened_at_ms: alert.opened_at_ms,
              last_observed_at_ms: alert.last_observed_at_ms,
              acknowledged_at_ms: null,
              recovered_at_ms: null,
              details_json: alert.details_json,
              details_schema_version: 1,
            })
            .where("id", "=", alert.id)
            .where("state", "=", "recovered")
            .executeTakeFirstOrThrow();
        }
      },
    );
    return {
      revision: committed.revision,
      occurredAtMs: options.nowMs,
      transition,
      payload,
    };
  }

  private async commitExistingTransition(options: {
    readonly alert: StoredActiveAlert;
    readonly rule: StoredAlertRule;
    readonly transition: "observed" | "acknowledged" | "recovered";
    readonly nowMs: number;
    readonly actor: string;
    readonly observation: AlertObservation | null;
    readonly note: string | null;
  }): Promise<AlertTransition> {
    const nextAlert: StoredActiveAlert = {
      ...options.alert,
      state:
        options.transition === "acknowledged"
          ? "acknowledged"
          : options.transition === "recovered"
            ? "recovered"
            : options.alert.state,
      last_observed_at_ms:
        options.transition === "acknowledged"
          ? options.alert.last_observed_at_ms
          : options.nowMs,
      acknowledged_at_ms:
        options.transition === "acknowledged"
          ? options.nowMs
          : options.alert.acknowledged_at_ms,
      recovered_at_ms:
        options.transition === "recovered"
          ? options.nowMs
          : options.alert.recovered_at_ms,
      details_json:
        options.observation === null && options.note === null
          ? options.alert.details_json
          : detailsJson(options.observation, options.note),
      details_schema_version: 1,
    };
    const payload = this.buildPayload(
      options.transition,
      nextAlert,
      options.rule,
      options.observation,
      options.note,
    );
    const committed = await commitStateChange(
      this.database,
      {
        actor: options.actor,
        mutationType: mutationTypeFor(options.transition),
        summary: summaryFor(options.transition, options.rule),
        eventType: eventTypeFor(options.transition),
        entityType: "alert",
        entityId: nextAlert.id,
        occurredAtMs: options.nowMs,
        retentionClass:
          options.transition === "observed" ? "operational" : "critical",
        payloadJson: JSON.stringify(payload),
        payloadSchemaVersion: 1,
      },
      async (transaction) => {
        const updated = await transaction
          .updateTable("active_alerts")
          .set({
            state: nextAlert.state,
            last_observed_at_ms: nextAlert.last_observed_at_ms,
            acknowledged_at_ms: nextAlert.acknowledged_at_ms,
            recovered_at_ms: nextAlert.recovered_at_ms,
            details_json: nextAlert.details_json,
            details_schema_version: nextAlert.details_schema_version,
          })
          .where("id", "=", nextAlert.id)
          .where("state", "=", options.alert.state)
          .executeTakeFirst();
        if (updated.numUpdatedRows !== 1n) {
          throw new Error(
            `Alert ${nextAlert.id} changed concurrently during ${options.transition}`,
          );
        }
      },
    );
    return {
      revision: committed.revision,
      occurredAtMs: options.nowMs,
      transition: options.transition,
      payload,
    };
  }

  private buildPayload(
    transition: AlertLifecycleTransition,
    alert: StoredActiveAlert,
    rule: StoredAlertRule,
    observation: AlertObservation | null,
    note: string | null,
  ): AlertStateEventPayloadV1 {
    return {
      schemaVersion: 1,
      transition,
      alert: toAlertSnapshot(alert),
      rule: toRuleSnapshot(rule),
      observation,
      note,
    };
  }
}
