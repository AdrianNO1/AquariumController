import {
  alertDetailsSchema,
  alertNotificationV1Schema,
  alertObservationSchema,
  alertRuleSnapshotSchema,
  alertSnapshotSchema,
  alertStateEventPayloadV1Schema,
  boundedTextSchema,
  expectedRevisionSchema,
  identifierSchema,
  mutationResultSchema,
  type MutationResult,
} from "@aquarium/contracts";
import type { Kysely, Selectable } from "kysely";

import {
  commitConditionalStateChange,
  commitStateChange,
  parseStoredStateOutboxEnvelope,
  toCommittedStateEvent,
  type ActiveAlertsTable,
  type AlertConditionStatesTable,
  type AlertRulesTable,
  type StateChangePostOutboxHook,
  type StateDatabaseSchema,
  type StateDatabaseTransaction,
} from "../../infrastructure/database/index.js";
import { parseJsonDocument } from "../../infrastructure/import/index.js";
import type { AlertNotificationDestination } from "./notification-port.js";
import type {
  AlertClock,
  AlertEvaluationDecision,
  AlertEvaluationResult,
  AlertIdGenerator,
  AlertLifecycleTransition,
  AlertNotificationV1,
  AlertObservation,
  AlertRuleSnapshot,
  AlertSnapshot,
  AlertStateEventPayloadV1,
  AlertTransition,
} from "./types.js";

type StoredAlertRule = Selectable<AlertRulesTable>;
type StoredActiveAlert = Selectable<ActiveAlertsTable>;
type StoredPendingCondition = Selectable<AlertConditionStatesTable>;

export interface AlertServiceOptions {
  readonly notificationDestinations?: readonly AlertNotificationDestination[];
  /**
   * Minimum interval between durable `observed` transitions while an alert
   * remains true. Opening, acknowledgement, and recovery are never throttled.
   */
  readonly observationEventIntervalMs?: number;
}

export const DEFAULT_ALERT_OBSERVATION_EVENT_INTERVAL_MS = 60 * 60 * 1_000;

interface ConditionalAcknowledgementResult {
  readonly payload: AlertStateEventPayloadV1 | null;
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

export class AlertConcurrencyError extends Error {
  override readonly name = "AlertConcurrencyError";

  constructor(subject: string, operation: string) {
    super(`${subject} changed concurrently during ${operation}`);
  }
}

export class AlertRevisionConflictError extends Error {
  override readonly name = "AlertRevisionConflictError";

  constructor(
    readonly expectedRevision: number,
    readonly currentRevision: number,
  ) {
    super(
      `Expected state revision ${expectedRevision}, but current revision is ${currentRevision}`,
    );
  }
}

export class InvalidPersistedAlertDataError extends Error {
  override readonly name = "InvalidPersistedAlertDataError";

  constructor(subject: string) {
    super(`Persisted ${subject} failed alert schema validation`);
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

function validateActor(actor: string): string {
  return boundedTextSchema.parse(actor);
}

function validateNote(note: string | null): string | null {
  return note === null ? null : boundedTextSchema.parse(note);
}

function ruleSourceId(rule: StoredAlertRule): string {
  let sourceId: string | null;
  switch (rule.source_type) {
    case "device":
      sourceId = rule.device_id;
      break;
    case "output":
      sourceId = rule.output_id;
      break;
    case "sensor":
      sourceId = rule.sensor_id;
      break;
    case "switch":
      sourceId = rule.switch_id;
      break;
  }
  if (sourceId === null) {
    throw new InvalidAlertRuleError(rule.id, "source reference is missing");
  }
  return identifierSchema.parse(sourceId);
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
  return alertRuleSnapshotSchema.parse({
    id: rule.id,
    name: rule.name,
    sourceType: rule.source_type,
    sourceId: ruleSourceId(rule),
    condition: rule.condition,
    threshold: rule.threshold,
    delayMs: rule.delay_ms,
    severity: rule.severity,
  });
}

function toAlertSnapshot(alert: StoredActiveAlert): AlertSnapshot {
  return alertSnapshotSchema.parse({
    id: alert.id,
    ruleId: alert.alert_rule_id,
    deduplicationKey: alert.deduplication_key,
    state: alert.state,
    openedAtMs: alert.opened_at_ms,
    lastObservedAtMs: alert.last_observed_at_ms,
    acknowledgedAtMs: alert.acknowledged_at_ms,
    recoveredAtMs: alert.recovered_at_ms,
  });
}

function eventTypeFor(transition: AlertLifecycleTransition): string {
  return `alert.${transition}`;
}

function summaryFor(
  transition: AlertLifecycleTransition,
  rule: StoredAlertRule,
): string {
  return boundedTextSchema.parse(`${transition} alert for rule ${rule.id}`);
}

function detailsJson(
  observation: AlertObservation | null,
  note: string | null,
): string {
  return JSON.stringify(
    alertDetailsSchema.parse({ schemaVersion: 1, observation, note }),
  );
}

function parsePendingObservation(
  pending: StoredPendingCondition,
): AlertObservation {
  if (pending.observation_schema_version !== 1) {
    throw new InvalidPersistedAlertDataError("pending observation");
  }
  let observation: AlertObservation;
  try {
    const parsed = parseJsonDocument(
      pending.observation_json,
      "pending alert observation",
    );
    if (parsed.duplicateKeys.length > 0) {
      throw new Error("Pending alert observation contains duplicate keys");
    }
    observation = alertObservationSchema.parse(parsed.value);
  } catch {
    throw new InvalidPersistedAlertDataError("pending observation");
  }
  const deduplicationKey =
    observation.deduplicationKey ??
    `${observation.sourceType}:${observation.sourceId}`;
  if (
    observation.sourceType !== pending.source_type ||
    observation.sourceId !== pending.source_id ||
    deduplicationKey !== pending.deduplication_key
  ) {
    throw new InvalidPersistedAlertDataError("pending observation");
  }
  return observation;
}

function validateStoredAlert(alert: StoredActiveAlert): void {
  toAlertSnapshot(alert);
  if (alert.details_json === null && alert.details_schema_version === null)
    return;
  if (alert.details_json === null || alert.details_schema_version !== 1) {
    throw new InvalidPersistedAlertDataError(`alert ${alert.id} details`);
  }
  try {
    const parsed = parseJsonDocument(
      alert.details_json,
      `alert ${alert.id} details`,
    );
    if (parsed.duplicateKeys.length > 0) {
      throw new Error("Alert details contain duplicate keys");
    }
    alertDetailsSchema.parse(parsed.value);
  } catch {
    throw new InvalidPersistedAlertDataError(`alert ${alert.id} details`);
  }
}

export class AlertService {
  readonly #notificationDestinations: readonly AlertNotificationDestination[];
  readonly #observationEventIntervalMs: number;
  #operationTail: Promise<void> = Promise.resolve();

  constructor(
    private readonly database: Kysely<StateDatabaseSchema>,
    private readonly clock: AlertClock,
    private readonly ids: AlertIdGenerator,
    options: AlertServiceOptions = {},
  ) {
    const observationEventIntervalMs =
      options.observationEventIntervalMs ??
      DEFAULT_ALERT_OBSERVATION_EVENT_INTERVAL_MS;
    if (
      !Number.isSafeInteger(observationEventIntervalMs) ||
      observationEventIntervalMs < 0
    ) {
      throw new RangeError(
        "Alert observation event interval must be a non-negative safe integer",
      );
    }
    this.#observationEventIntervalMs = observationEventIntervalMs;
    const destinations: AlertNotificationDestination[] = [];
    const seen = new Set<string>();
    for (const destination of options.notificationDestinations ?? []) {
      const key = identifierSchema.parse(destination.key);
      const identity = `${destination.kind}:${key}`;
      if (seen.has(identity)) {
        throw new TypeError(
          `Duplicate alert notification destination ${identity}`,
        );
      }
      seen.add(identity);
      destinations.push({ kind: destination.kind, key });
    }
    this.#notificationDestinations = destinations;
  }

  evaluate(
    observation: AlertObservation,
    actor = "alert-evaluator",
  ): Promise<AlertEvaluationResult> {
    return this.runExclusive(() =>
      this.evaluateExclusive(observation, actor, this.clock.nowMs()),
    );
  }

  evaluateAt(
    observation: AlertObservation,
    observedAtMs: number,
    actor = "alert-evaluator",
  ): Promise<AlertEvaluationResult> {
    return this.runExclusive(() =>
      this.evaluateExclusive(observation, actor, observedAtMs),
    );
  }

  acknowledge(
    alertId: string,
    actor: string,
    note: string | null = null,
  ): Promise<AlertTransition | null> {
    return this.runExclusive(() =>
      this.acknowledgeExclusive(alertId, actor, note),
    );
  }

  acknowledgeAtRevision(
    alertId: string,
    actor: string,
    note: string | null,
    expectedRevision: number,
  ): Promise<MutationResult> {
    return this.runExclusive(() =>
      this.acknowledgeAtRevisionExclusive(
        alertId,
        actor,
        note,
        expectedRevision,
      ),
    );
  }

  recover(
    alertId: string,
    actor: string,
    note: string,
  ): Promise<AlertTransition | null> {
    return this.runExclusive(() => this.recoverExclusive(alertId, actor, note));
  }

  private runExclusive<Result>(
    operation: () => Promise<Result>,
  ): Promise<Result> {
    const result = this.#operationTail.then(operation, operation);
    this.#operationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  private async evaluateExclusive(
    rawObservation: AlertObservation,
    rawActor: string,
    nowMs: number,
  ): Promise<AlertEvaluationResult> {
    const observation = alertObservationSchema.parse(rawObservation);
    const actor = validateActor(rawActor);
    assertTimestamp(nowMs);
    const deduplicationKey = boundedTextSchema.parse(
      observation.deduplicationKey ??
        `${observation.sourceType}:${observation.sourceId}`,
    );
    const rules = await this.loadRules(observation);
    const enabledRules = rules.filter((rule) => rule.enabled === 1);
    const evaluations = enabledRules.map((rule) => {
      toRuleSnapshot(rule);
      return { rule, matches: evaluateCondition(rule, observation) };
    });

    for (const rule of rules) {
      if (rule.enabled === 0) {
        await this.database
          .deleteFrom("alert_condition_states")
          .where("alert_rule_id", "=", rule.id)
          .where("source_type", "=", observation.sourceType)
          .where("source_id", "=", observation.sourceId)
          .execute();
      }
    }

    const decisions: AlertEvaluationDecision[] = [];
    for (const evaluation of evaluations) {
      decisions.push(
        await this.evaluateRule({
          ...evaluation,
          observation,
          actor,
          nowMs,
          deduplicationKey,
        }),
      );
    }
    return { evaluatedAtMs: nowMs, decisions };
  }

  private async evaluateRule(options: {
    readonly rule: StoredAlertRule;
    readonly matches: boolean;
    readonly observation: AlertObservation;
    readonly actor: string;
    readonly nowMs: number;
    readonly deduplicationKey: string;
  }): Promise<AlertEvaluationDecision> {
    const activeAlert = await this.database
      .selectFrom("active_alerts")
      .selectAll()
      .where("alert_rule_id", "=", options.rule.id)
      .where("deduplication_key", "=", options.deduplicationKey)
      .executeTakeFirst();
    if (activeAlert !== undefined) validateStoredAlert(activeAlert);
    const storedPending = await this.database
      .selectFrom("alert_condition_states")
      .selectAll()
      .where("alert_rule_id", "=", options.rule.id)
      .where("deduplication_key", "=", options.deduplicationKey)
      .executeTakeFirst();
    if (storedPending !== undefined) parsePendingObservation(storedPending);

    if (!options.matches) {
      if (activeAlert !== undefined && activeAlert.state !== "recovered") {
        const transition = await this.commitExistingTransition({
          alert: activeAlert,
          rule: options.rule,
          transition: "recovered",
          nowMs: options.nowMs,
          actor: options.actor,
          observation: options.observation,
          note: "Condition cleared",
          pending: storedPending,
        });
        return { kind: "transition", ruleId: options.rule.id, transition };
      }
      await this.deletePending(storedPending, "condition clear");
      return { kind: "condition-clear", ruleId: options.rule.id };
    }

    if (activeAlert !== undefined && activeAlert.state !== "recovered") {
      await this.deletePending(storedPending, "active alert observation");
      if (options.nowMs < activeAlert.last_observed_at_ms) {
        throw new RangeError(
          `Alert clock moved backwards for alert ${activeAlert.id}`,
        );
      }
      if (options.nowMs === activeAlert.last_observed_at_ms) {
        return { kind: "unchanged", ruleId: options.rule.id };
      }
      if (
        options.nowMs - activeAlert.last_observed_at_ms <
        this.#observationEventIntervalMs
      ) {
        return { kind: "unchanged", ruleId: options.rule.id };
      }
      const transition = await this.commitExistingTransition({
        alert: activeAlert,
        rule: options.rule,
        transition: "observed",
        nowMs: options.nowMs,
        actor: options.actor,
        observation: options.observation,
        note: null,
        pending: undefined,
      });
      return { kind: "transition", ruleId: options.rule.id, transition };
    }

    const pending = await this.persistPendingCondition({
      existing: storedPending,
      rule: options.rule,
      observation: options.observation,
      deduplicationKey: options.deduplicationKey,
      nowMs: options.nowMs,
    });
    const elapsedMs = options.nowMs - pending.pending_since_ms;
    if (elapsedMs < options.rule.delay_ms) {
      return {
        kind: "pending",
        ruleId: options.rule.id,
        pendingSinceMs: pending.pending_since_ms,
        remainingDelayMs: options.rule.delay_ms - elapsedMs,
      };
    }

    const transition = await this.commitOpenTransition({
      previous: activeAlert,
      rule: options.rule,
      nowMs: options.nowMs,
      actor: options.actor,
      observation: options.observation,
      deduplicationKey: options.deduplicationKey,
      pending,
    });
    return { kind: "transition", ruleId: options.rule.id, transition };
  }

  private async acknowledgeExclusive(
    rawAlertId: string,
    rawActor: string,
    rawNote: string | null,
  ): Promise<AlertTransition | null> {
    const alertId = identifierSchema.parse(rawAlertId);
    const actor = validateActor(rawActor);
    const note = validateNote(rawNote);
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
      pending: undefined,
    });
  }

  private async acknowledgeAtRevisionExclusive(
    rawAlertId: string,
    rawActor: string,
    rawNote: string | null,
    rawExpectedRevision: number,
  ): Promise<MutationResult> {
    const alertId = identifierSchema.parse(rawAlertId);
    const actor = validateActor(rawActor);
    const note = validateNote(rawNote);
    const { expectedRevision } = expectedRevisionSchema.parse({
      expectedRevision: rawExpectedRevision,
    });
    const nowMs = this.clock.nowMs();
    assertTimestamp(nowMs);
    const committed = await commitConditionalStateChange<{
      readonly changed: boolean;
      readonly result: ConditionalAcknowledgementResult;
    }>(
      this.database,
      (result) => {
        if (result.payload === null) {
          throw new Error("Changed alert acknowledgement requires a payload");
        }
        return {
          actor,
          mutationType: eventTypeFor("acknowledged"),
          summary: `Acknowledged alert ${alertId}`,
          eventType: eventTypeFor("acknowledged"),
          entityType: "alert" as const,
          entityId: alertId,
          occurredAtMs: nowMs,
          retentionClass: "critical" as const,
          payloadJson: JSON.stringify(result.payload),
          payloadSchemaVersion: 1,
        };
      },
      async (transaction) => {
        const alert = await transaction
          .selectFrom("active_alerts")
          .selectAll()
          .where("id", "=", alertId)
          .executeTakeFirst();
        if (alert === undefined) throw new AlertNotFoundError(alertId);
        const rule = await transaction
          .selectFrom("alert_rules")
          .selectAll()
          .where("id", "=", alert.alert_rule_id)
          .executeTakeFirstOrThrow();
        validateStoredAlert(alert);
        toRuleSnapshot(rule);
        if (alert.state === "acknowledged") {
          return {
            changed: false as const,
            result: { payload: null },
          };
        }
        if (alert.state !== "open") {
          throw new InvalidAlertTransitionError(
            alert.id,
            alert.state,
            "acknowledged",
          );
        }
        if (nowMs < alert.last_observed_at_ms) {
          throw new RangeError(
            `Alert clock moved backwards for alert ${alert.id}`,
          );
        }
        const nextAlert: StoredActiveAlert = {
          ...alert,
          state: "acknowledged",
          acknowledged_at_ms: nowMs,
          details_json:
            note === null ? alert.details_json : detailsJson(null, note),
          details_schema_version:
            note === null ? alert.details_schema_version : 1,
        };
        const payload = this.buildPayload(
          "acknowledged",
          nextAlert,
          rule,
          null,
          note,
        );
        const updated = await transaction
          .updateTable("active_alerts")
          .set({
            state: nextAlert.state,
            acknowledged_at_ms: nextAlert.acknowledged_at_ms,
            details_json: nextAlert.details_json,
            details_schema_version: nextAlert.details_schema_version,
          })
          .where("id", "=", alert.id)
          .where("state", "=", "open")
          .where("opened_at_ms", "=", alert.opened_at_ms)
          .where("last_observed_at_ms", "=", alert.last_observed_at_ms)
          .executeTakeFirst();
        if (updated.numUpdatedRows !== 1n) {
          throw new AlertConcurrencyError(alert.id, "acknowledged");
        }
        return {
          changed: true as const,
          result: { payload },
        };
      },
      this.createNotificationIntentHook("acknowledged", alertId),
      {
        expectedRevision,
        conflictError: (expected, current) =>
          new AlertRevisionConflictError(expected, current),
      },
    );
    if (!committed.changed) {
      return mutationResultSchema.parse({
        changed: false,
        revision: committed.revision,
        event: null,
      });
    }
    return mutationResultSchema.parse({
      changed: true,
      revision: committed.revision,
      event: toCommittedStateEvent(committed.outboxEvent),
    });
  }

  private async recoverExclusive(
    rawAlertId: string,
    rawActor: string,
    rawNote: string,
  ): Promise<AlertTransition | null> {
    const alertId = identifierSchema.parse(rawAlertId);
    const actor = validateActor(rawActor);
    const note = boundedTextSchema.parse(rawNote);
    const nowMs = this.clock.nowMs();
    assertTimestamp(nowMs);
    const { alert, rule } = await this.loadAlertAndRule(alertId);
    if (alert.state === "recovered") return null;
    if (nowMs < alert.last_observed_at_ms) {
      throw new RangeError(`Alert clock moved backwards for alert ${alert.id}`);
    }
    const pending = await this.database
      .selectFrom("alert_condition_states")
      .selectAll()
      .where("alert_rule_id", "=", alert.alert_rule_id)
      .where("deduplication_key", "=", alert.deduplication_key)
      .executeTakeFirst();
    if (pending !== undefined) parsePendingObservation(pending);
    return this.commitExistingTransition({
      alert,
      rule,
      transition: "recovered",
      nowMs,
      actor,
      observation: null,
      note,
      pending,
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
    validateStoredAlert(alert);
    toRuleSnapshot(rule);
    return { alert, rule };
  }

  private async assertRuleSnapshotInTransaction(
    transaction: StateDatabaseTransaction,
    expected: StoredAlertRule,
  ): Promise<void> {
    const current = await transaction
      .selectFrom("alert_rules")
      .selectAll()
      .where("id", "=", expected.id)
      .executeTakeFirst();
    if (
      current === undefined ||
      current.name !== expected.name ||
      current.source_type !== expected.source_type ||
      current.device_id !== expected.device_id ||
      current.output_id !== expected.output_id ||
      current.sensor_id !== expected.sensor_id ||
      current.switch_id !== expected.switch_id ||
      current.condition !== expected.condition ||
      current.threshold !== expected.threshold ||
      current.delay_ms !== expected.delay_ms ||
      current.severity !== expected.severity ||
      current.enabled !== expected.enabled ||
      current.created_at_ms !== expected.created_at_ms ||
      current.updated_at_ms !== expected.updated_at_ms ||
      current.configuration_json !== expected.configuration_json ||
      current.configuration_schema_version !==
        expected.configuration_schema_version
    ) {
      throw new AlertConcurrencyError(expected.id, "rule evaluation");
    }
  }

  private async persistPendingCondition(options: {
    readonly existing: StoredPendingCondition | undefined;
    readonly rule: StoredAlertRule;
    readonly observation: AlertObservation;
    readonly deduplicationKey: string;
    readonly nowMs: number;
  }): Promise<StoredPendingCondition> {
    const observationJson = JSON.stringify(
      alertObservationSchema.parse(options.observation),
    );
    if (options.existing === undefined) {
      await this.database
        .insertInto("alert_condition_states")
        .values({
          alert_rule_id: options.rule.id,
          deduplication_key: options.deduplicationKey,
          source_type: options.observation.sourceType,
          source_id: options.observation.sourceId,
          pending_since_ms: options.nowMs,
          last_observed_at_ms: options.nowMs,
          observation_json: observationJson,
          observation_schema_version: 1,
          created_at_ms: options.nowMs,
          updated_at_ms: options.nowMs,
        })
        .onConflict((conflict) =>
          conflict.columns(["alert_rule_id", "deduplication_key"]).doNothing(),
        )
        .executeTakeFirst();
    }

    const pending = await this.database
      .selectFrom("alert_condition_states")
      .selectAll()
      .where("alert_rule_id", "=", options.rule.id)
      .where("deduplication_key", "=", options.deduplicationKey)
      .executeTakeFirstOrThrow();
    parsePendingObservation(pending);
    if (options.nowMs < pending.last_observed_at_ms) {
      throw new RangeError(
        `Alert clock moved backwards for rule ${options.rule.id}`,
      );
    }
    if (options.nowMs === pending.last_observed_at_ms) return pending;

    const updated = await this.database
      .updateTable("alert_condition_states")
      .set({
        last_observed_at_ms: options.nowMs,
        observation_json: observationJson,
        observation_schema_version: 1,
        updated_at_ms: options.nowMs,
      })
      .where("alert_rule_id", "=", pending.alert_rule_id)
      .where("deduplication_key", "=", pending.deduplication_key)
      .where("pending_since_ms", "=", pending.pending_since_ms)
      .where("last_observed_at_ms", "=", pending.last_observed_at_ms)
      .executeTakeFirst();
    if (updated.numUpdatedRows !== 1n) {
      throw new AlertConcurrencyError(
        `Pending condition for rule ${options.rule.id}`,
        "observation",
      );
    }
    return {
      ...pending,
      last_observed_at_ms: options.nowMs,
      observation_json: observationJson,
      observation_schema_version: 1,
      updated_at_ms: options.nowMs,
    };
  }

  private async deletePending(
    pending: StoredPendingCondition | undefined,
    operation: string,
  ): Promise<void> {
    if (pending === undefined) return;
    const deleted = await this.database
      .deleteFrom("alert_condition_states")
      .where("alert_rule_id", "=", pending.alert_rule_id)
      .where("deduplication_key", "=", pending.deduplication_key)
      .where("pending_since_ms", "=", pending.pending_since_ms)
      .where("last_observed_at_ms", "=", pending.last_observed_at_ms)
      .executeTakeFirst();
    if (deleted.numDeletedRows !== 1n) {
      throw new AlertConcurrencyError(
        `Pending condition for rule ${pending.alert_rule_id}`,
        operation,
      );
    }
  }

  private async deletePendingInTransaction(
    transaction: StateDatabaseTransaction,
    pending: StoredPendingCondition | undefined,
    operation: string,
  ): Promise<void> {
    if (pending === undefined) return;
    const deleted = await transaction
      .deleteFrom("alert_condition_states")
      .where("alert_rule_id", "=", pending.alert_rule_id)
      .where("deduplication_key", "=", pending.deduplication_key)
      .where("pending_since_ms", "=", pending.pending_since_ms)
      .where("last_observed_at_ms", "=", pending.last_observed_at_ms)
      .executeTakeFirst();
    if (deleted.numDeletedRows !== 1n) {
      throw new AlertConcurrencyError(
        `Pending condition for rule ${pending.alert_rule_id}`,
        operation,
      );
    }
  }

  private async commitOpenTransition(options: {
    readonly previous: StoredActiveAlert | undefined;
    readonly rule: StoredAlertRule;
    readonly nowMs: number;
    readonly actor: string;
    readonly observation: AlertObservation;
    readonly deduplicationKey: string;
    readonly pending: StoredPendingCondition;
  }): Promise<AlertTransition> {
    const alertId = identifierSchema.parse(
      options.previous?.id ?? this.ids.nextAlertId(),
    );
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
    const previousRecoveredAt = options.previous?.recovered_at_ms;
    if (options.previous !== undefined && previousRecoveredAt === null) {
      throw new InvalidPersistedAlertDataError("recovered alert");
    }
    const committed = await commitStateChange(
      this.database,
      {
        actor: options.actor,
        mutationType: eventTypeFor(transition),
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
        await this.assertRuleSnapshotInTransaction(transaction, options.rule);
        if (options.previous === undefined) {
          await transaction
            .insertInto("active_alerts")
            .values(alert)
            .executeTakeFirstOrThrow();
        } else {
          if (previousRecoveredAt === undefined) {
            throw new InvalidPersistedAlertDataError("recovered alert");
          }
          const updated = await transaction
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
            .where("opened_at_ms", "=", options.previous.opened_at_ms)
            .where(
              "last_observed_at_ms",
              "=",
              options.previous.last_observed_at_ms,
            )
            .where("recovered_at_ms", "=", previousRecoveredAt)
            .executeTakeFirst();
          if (updated.numUpdatedRows !== 1n) {
            throw new AlertConcurrencyError(alert.id, transition);
          }
        }
        await this.deletePendingInTransaction(
          transaction,
          options.pending,
          transition,
        );
      },
      this.createNotificationIntentHook(transition, alert.id),
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
    readonly pending: StoredPendingCondition | undefined;
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
        mutationType: eventTypeFor(options.transition),
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
        await this.assertRuleSnapshotInTransaction(transaction, options.rule);
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
          .where("opened_at_ms", "=", options.alert.opened_at_ms)
          .where("last_observed_at_ms", "=", options.alert.last_observed_at_ms)
          .executeTakeFirst();
        if (updated.numUpdatedRows !== 1n) {
          throw new AlertConcurrencyError(nextAlert.id, options.transition);
        }
        await this.deletePendingInTransaction(
          transaction,
          options.pending,
          options.transition,
        );
      },
      this.createNotificationIntentHook(options.transition, nextAlert.id),
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
    return alertStateEventPayloadV1Schema.parse({
      schemaVersion: 1,
      transition,
      alert: toAlertSnapshot(alert),
      rule: toRuleSnapshot(rule),
      observation,
      note,
    });
  }

  private createNotificationIntentHook(
    transition: AlertLifecycleTransition,
    expectedAlertId: string,
  ): StateChangePostOutboxHook | undefined {
    if (
      transition === "observed" ||
      this.#notificationDestinations.length === 0
    ) {
      return undefined;
    }
    return async (transaction, context) => {
      const envelope = parseStoredStateOutboxEnvelope(context.outboxEvent);
      if (envelope.details.schemaVersion !== 1) {
        throw new InvalidPersistedAlertDataError("alert state event");
      }
      let payload: AlertStateEventPayloadV1;
      try {
        payload = alertStateEventPayloadV1Schema.parse(envelope.details.data);
      } catch {
        throw new InvalidPersistedAlertDataError("alert state event");
      }
      if (
        payload.transition !== transition ||
        payload.alert.id !== expectedAlertId
      ) {
        throw new InvalidPersistedAlertDataError("alert state event");
      }
      const notification: AlertNotificationV1 = alertNotificationV1Schema.parse(
        {
          schemaVersion: 1,
          kind: "aquarium.alert",
          eventRevision: context.revision,
          occurredAt: new Date(
            context.outboxEvent.occurred_at_ms,
          ).toISOString(),
          transition,
          alert: payload.alert,
          rule: payload.rule,
          observation: payload.observation,
          note: payload.note,
        },
      );
      const notificationJson = JSON.stringify(notification);

      for (const destination of this.#notificationDestinations) {
        const deduplicationKey = boundedTextSchema.parse(
          `${context.revision}:${destination.kind}:${destination.key}`,
        );
        await transaction
          .insertInto("notification_deliveries")
          .values({
            alert_transition_revision: context.revision,
            alert_id: payload.alert.id,
            transition,
            destination_kind: destination.kind,
            destination_key: destination.key,
            deduplication_key: deduplicationKey,
            notification_json: notificationJson,
            notification_schema_version: 1,
            created_at_ms: context.outboxEvent.occurred_at_ms,
            updated_at_ms: context.outboxEvent.occurred_at_ms,
          })
          .executeTakeFirstOrThrow();
      }
    };
  }
}
