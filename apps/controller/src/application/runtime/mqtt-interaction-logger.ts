import { utf8ByteLength, type EspTopicSet } from "@aquarium/esp-protocol";

import type {
  LegacyAnnouncementEvent,
  LegacyCommandOutcome,
  LegacyMqttInteraction,
} from "../../infrastructure/mqtt/index.js";
import type {
  InteractionLogInput,
  InteractionRepository,
} from "../../infrastructure/storage/interaction-repository.js";
import type {
  DeviceOperationPriority,
  DeviceOperationRequest,
} from "../operations/device-operation-types.js";

export interface PersistentOperationInteraction {
  readonly occurredAtMs: number;
  readonly deviceId: string;
  readonly correlationId: string | null;
  readonly operationId: string;
  readonly request: DeviceOperationRequest;
  readonly outcome:
    "succeeded" | "failed" | "timed_out" | "outcome_unknown" | "ignored";
  readonly durationMs: number;
  readonly commandBytes: number;
  readonly priority: DeviceOperationPriority;
}

/** Persists metadata-only MQTT interactions; raw wire payloads are not stored. */
export class MqttInteractionLogger {
  readonly #repository: InteractionRepository;
  readonly #topics: EspTopicSet;
  readonly #lastDiagnosticSignatures = new Map<string, string>();

  constructor(repository: InteractionRepository, topics: EspTopicSet) {
    this.#repository = repository;
    this.#topics = topics;
  }

  async logAnnouncement(event: LegacyAnnouncementEvent): Promise<void> {
    const diagnostic = event.announcement.lastError;
    if (diagnostic === undefined) {
      this.#lastDiagnosticSignatures.delete(event.announcement.id);
      return;
    }

    const signature = `${diagnostic.sequence}\0${diagnostic.code}\0${diagnostic.active}`;
    if (
      this.#lastDiagnosticSignatures.get(event.announcement.id) === signature
    ) {
      return;
    }
    await this.#repository.log({
      occurredAtMs: event.receivedAtMs,
      direction: "inbound",
      kind: "mqtt.device-diagnostic",
      severity: diagnostic.severity,
      topic: this.#topics.announce,
      deviceId: event.announcement.id,
      outcome: diagnostic.active ? "failed" : "succeeded",
      byteCount: event.payloadBytes,
      retentionClass:
        diagnostic.active && diagnostic.severity === "error"
          ? "critical"
          : "audit",
      payload: {
        code: diagnostic.code,
        message: diagnostic.message,
        sequence: diagnostic.sequence,
        active: diagnostic.active,
        recordedAtEpochSeconds: diagnostic.at,
      },
      payloadSchemaVersion: 1,
    });
    this.#lastDiagnosticSignatures.set(event.announcement.id, signature);
  }

  async logTransportInteraction(
    interaction: LegacyMqttInteraction,
  ): Promise<void> {
    if (
      interaction.kind === "discovery_published" ||
      interaction.kind === "batch_published" ||
      (interaction.kind === "command_outcome" &&
        interaction.outcome.status === "succeeded")
    ) {
      return;
    }
    await this.#repository.log(this.#toLogInput(interaction));
  }

  async logPersistentOperation(
    interaction: PersistentOperationInteraction,
  ): Promise<void> {
    if (
      interaction.priority === "background" &&
      interaction.request.kind === "set_pwm" &&
      interaction.outcome === "succeeded"
    ) {
      return;
    }
    const routinePwmSuccess =
      interaction.request.kind === "set_pwm" &&
      interaction.outcome === "succeeded";
    await this.#repository.log({
      occurredAtMs: interaction.occurredAtMs,
      direction:
        interaction.outcome === "timed_out" || interaction.outcome === "ignored"
          ? "internal"
          : "outbound",
      kind: "mqtt.device-operation",
      severity: routinePwmSuccess
        ? "debug"
        : interaction.outcome === "succeeded"
          ? "info"
          : interaction.outcome === "ignored"
            ? "warning"
            : "error",
      topic: this.#topics.command,
      deviceId: interaction.deviceId,
      ...(interaction.correlationId === null
        ? {}
        : { correlationId: interaction.correlationId }),
      operationId: interaction.operationId,
      outcome: interaction.outcome,
      durationMs: interaction.durationMs,
      byteCount: interaction.commandBytes,
      retentionClass:
        interaction.outcome === "outcome_unknown"
          ? "critical"
          : routinePwmSuccess
            ? "raw"
            : "audit",
      payload: {
        commandKind: interaction.request.kind,
        responsePayloadStored: false,
      },
      payloadSchemaVersion: 1,
    });
  }

  logDiscoverySkipped(atMs: number): Promise<void> {
    void atMs;
    return Promise.resolve();
  }

  #toLogInput(interaction: LegacyMqttInteraction): InteractionLogInput {
    switch (interaction.kind) {
      case "lifecycle":
        return {
          occurredAtMs: interaction.atMs,
          direction: "internal",
          kind: "mqtt.lifecycle",
          severity: interaction.state === "disconnected" ? "warning" : "info",
          outcome:
            interaction.state === "disconnected" ? "failed" : "succeeded",
          byteCount: 0,
          retentionClass: "operational",
          payload: { state: interaction.state },
          payloadSchemaVersion: 1,
        };
      case "discovery_published":
        return {
          occurredAtMs: interaction.atMs,
          direction: "outbound",
          kind: "mqtt.discovery",
          severity: "debug",
          topic: this.#topics.command,
          outcome: "succeeded",
          byteCount: utf8ByteLength("discover"),
          retentionClass: "raw",
        };
      case "malformed_message":
        return {
          occurredAtMs: interaction.atMs,
          direction: "inbound",
          kind: "mqtt.malformed-message",
          severity: "warning",
          topic: interaction.topic,
          outcome: "failed",
          byteCount: interaction.payloadBytes,
          retentionClass: "audit",
          payload: {
            payloadStored: false,
            previewWasTruncated: interaction.previewTruncated,
          },
          payloadSchemaVersion: 1,
        };
      case "ignored_message":
        return {
          occurredAtMs: interaction.atMs,
          direction: "inbound",
          kind: "mqtt.ignored-message",
          severity: "debug",
          topic: interaction.topic,
          outcome: "ignored",
          byteCount: interaction.payloadBytes,
          retentionClass: "raw",
          payload: {
            payloadStored: false,
            previewWasTruncated: interaction.previewTruncated,
          },
          payloadSchemaVersion: 1,
        };
      case "ignored_response":
        return {
          occurredAtMs: interaction.atMs,
          direction: "inbound",
          kind: "mqtt.ignored-response",
          severity: "warning",
          topic: this.#topics.response,
          deviceId: interaction.responderId,
          outcome: "ignored",
          byteCount: interaction.payloadBytes,
          retentionClass: "audit",
          payload: {
            reason: interaction.reason,
            responseIndex: interaction.responseIndex,
            payloadStored: false,
          },
          payloadSchemaVersion: 1,
        };
      case "batch_published":
        return {
          occurredAtMs: interaction.atMs,
          direction: "outbound",
          kind: "mqtt.command-batch",
          severity: "debug",
          topic: this.#topics.command,
          deviceId: interaction.targetId,
          correlationId: interaction.requestId,
          operationId: interaction.operationId,
          outcome: "succeeded",
          byteCount: interaction.payloadBytes,
          retentionClass: "raw",
          payload: {
            batchIndex: interaction.batchIndex,
            frameCount: interaction.frameCount,
            payloadStored: false,
          },
          payloadSchemaVersion: 1,
        };
      case "command_outcome":
        return commandOutcomeLogInput(
          interaction.operationId,
          interaction.outcome,
          interaction.atMs,
          this.#topics,
        );
      case "transport_error":
        return {
          occurredAtMs: interaction.atMs,
          direction: "internal",
          kind: "mqtt.transport-error",
          severity: "error",
          outcome: "failed",
          byteCount: 0,
          retentionClass: "critical",
          payload: { phase: interaction.phase, detailStored: false },
          payloadSchemaVersion: 1,
        };
    }
  }
}

function commandOutcomeLogInput(
  correlationId: string,
  outcome: LegacyCommandOutcome,
  occurredAtMs: number,
  topics: EspTopicSet,
): InteractionLogInput {
  if (outcome.status === "succeeded" || outcome.status === "failed") {
    return {
      occurredAtMs,
      direction: "inbound",
      kind: "mqtt.command-response",
      severity: outcome.status === "succeeded" ? "debug" : "warning",
      topic: topics.response,
      deviceId: outcome.targetId,
      correlationId,
      outcome: outcome.status,
      byteCount: utf8ByteLength(outcome.response),
      retentionClass: outcome.status === "succeeded" ? "raw" : "audit",
      payload: {
        commandIndex: outcome.index,
        payloadStored: false,
        responseMatched: outcome.status === "succeeded",
      },
      payloadSchemaVersion: 1,
    };
  }
  if (outcome.status === "outcome_unknown") {
    return {
      occurredAtMs,
      direction: "outbound",
      kind: "mqtt.command-outcome",
      severity: "error",
      topic: topics.command,
      deviceId: outcome.targetId,
      correlationId,
      outcome: "outcome_unknown",
      byteCount: utf8ByteLength(outcome.command),
      retentionClass: "critical",
      payload: { commandIndex: outcome.index, reason: outcome.reason },
      payloadSchemaVersion: 1,
    };
  }
  return {
    occurredAtMs,
    direction: "internal",
    kind: "mqtt.command-not-attempted",
    severity: "warning",
    deviceId: outcome.targetId,
    correlationId,
    outcome: "ignored",
    byteCount: 0,
    retentionClass: "audit",
    payload: { commandIndex: outcome.index, reason: outcome.reason },
    payloadSchemaVersion: 1,
  };
}
