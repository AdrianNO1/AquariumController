import {
  batchLegacyCommands,
  encodeLegacyMessage,
  espAnnouncementSchema,
  espCommandResponseSchema,
  utf8ByteLength,
} from "@aquarium/esp-protocol";
import type {
  EspAnnouncement,
  EspTopicSet,
  LegacyCommandBatch,
} from "@aquarium/esp-protocol";

import {
  QOS_ZERO,
  type LegacyMqttClientFactory,
  type LegacyMqttClientPort,
} from "./client-port.js";

const NON_RETAINED_QOS_ZERO = {
  qos: QOS_ZERO,
  retain: false,
} as const;
const QOS_ZERO_SUBSCRIPTION = { qos: QOS_ZERO } as const;
const DEFAULT_RESPONSE_TIMEOUT_MS = 5_000;
const MAX_RAW_PAYLOAD_PREVIEW = 2_048;
const MIN_LEGACY_PIN = 0;
const MAX_LEGACY_PIN = 63;
const MIN_ANALOG_VALUE = 0;
const MAX_ANALOG_VALUE = 4_095;

export interface LegacyDeviceTarget {
  /** Stable ESP chip identifier used on the wire. */
  readonly id: string;
  /** Accepted input aliases, normally the currently reported device name. */
  readonly aliases?: readonly string[];
}

export type LegacyExpectedResponse =
  | {
      readonly kind: "exact";
      readonly value: string;
    }
  | {
      readonly kind: "analog_read";
      readonly pin: number;
    };

export interface LegacyWireCommand {
  readonly command: string;
  readonly target: LegacyDeviceTarget;
  readonly expectedResponse: LegacyExpectedResponse;
}

interface OutcomeBase {
  readonly index: number;
  readonly command: string;
  readonly targetId: string;
}

export type LegacyCommandOutcome =
  | (OutcomeBase & {
      readonly status: "succeeded";
      readonly response: string;
      readonly analogValue: number | null;
    })
  | (OutcomeBase & {
      readonly status: "failed";
      readonly response: string;
      readonly expectedResponse: LegacyExpectedResponse;
    })
  | (OutcomeBase & {
      readonly status: "outcome_unknown";
      readonly reason:
        "timeout" | "publish_failed" | "disconnected" | "transport_stopped";
    })
  | (OutcomeBase & {
      readonly status: "not_attempted";
      readonly reason:
        "prior_batch_outcome_unknown" | "disconnected" | "transport_stopped";
    });

export interface LegacyWireOperationResult {
  readonly operationId: string;
  readonly startedAtMs: number;
  readonly completedAtMs: number;
  readonly outcomes: readonly LegacyCommandOutcome[];
}

export interface LegacyAnnouncementEvent {
  readonly announcement: EspAnnouncement;
  readonly receivedAtMs: number;
  readonly payloadBytes: number;
}

export type IgnoredResponseReason =
  | "no_active_batch"
  | "index_out_of_range"
  | "wrong_device"
  | "premature_response"
  | "duplicate";

export type LegacyMqttInteraction =
  | {
      readonly kind: "lifecycle";
      readonly state: "starting" | "ready" | "disconnected" | "stopped";
      readonly atMs: number;
    }
  | {
      readonly kind: "discovery_published";
      readonly atMs: number;
    }
  | {
      readonly kind: "malformed_message";
      readonly topic: string;
      readonly payloadPreview: string;
      readonly payloadBytes: number;
      readonly previewTruncated: boolean;
      readonly detail: string;
      readonly atMs: number;
    }
  | {
      readonly kind: "ignored_message";
      readonly topic: string;
      readonly payloadPreview: string;
      readonly payloadBytes: number;
      readonly previewTruncated: boolean;
      readonly atMs: number;
    }
  | {
      readonly kind: "ignored_response";
      readonly reason: IgnoredResponseReason;
      readonly responderId: string;
      readonly responseIndex: number;
      readonly payloadBytes: number;
      readonly atMs: number;
    }
  | {
      readonly kind: "batch_published";
      readonly operationId: string;
      readonly batchIndex: number;
      readonly frameCount: number;
      readonly payloadBytes: number;
      readonly atMs: number;
    }
  | {
      readonly kind: "command_outcome";
      readonly operationId: string;
      readonly outcome: LegacyCommandOutcome;
      readonly atMs: number;
    }
  | {
      readonly kind: "transport_error";
      readonly phase:
        | "client"
        | "connect"
        | "publish"
        | "announcement_callback"
        | "interaction_callback";
      readonly detail: string;
      readonly atMs: number;
    };

export interface LegacyMqttTransportCallbacks {
  readonly onAnnouncement?: (event: LegacyAnnouncementEvent) => void;
  readonly onInteraction?: (interaction: LegacyMqttInteraction) => void;
  readonly onCallbackError?: (error: Error) => void;
}

export interface LegacyMqttTransportOptions {
  readonly clientFactory: LegacyMqttClientFactory;
  readonly topics: EspTopicSet;
  readonly responseTimeoutMs?: number;
  readonly callbacks?: LegacyMqttTransportCallbacks;
  readonly now?: () => number;
}

interface NormalizedCommand {
  readonly command: string;
  readonly targetId: string;
  readonly expectedResponse: LegacyExpectedResponse;
}

export type LegacyDiscoveryRequestResult = "published" | "skipped_busy";

interface QueuedOperation {
  readonly operationId: string;
  readonly commands: readonly NormalizedCommand[];
  readonly resolve: (result: LegacyWireOperationResult) => void;
  readonly reject: (error: Error) => void;
}

interface BatchExpectation {
  readonly localIndex: number;
  readonly originalIndex: number;
  readonly command: NormalizedCommand;
}

interface ActiveBatch {
  readonly operationId: string;
  readonly batchIndex: number;
  readonly expectations: ReadonlyMap<number, BatchExpectation>;
  readonly outcomes: Map<number, LegacyCommandOutcome>;
  readonly responsesEnabled: () => boolean;
  readonly enableResponses: () => void;
  readonly promise: Promise<readonly LegacyCommandOutcome[]>;
  readonly settleUnknown: (
    reason: "timeout" | "publish_failed" | "disconnected" | "transport_stopped",
  ) => void;
  readonly settleIfComplete: () => void;
}

export class LegacyMqttUnavailableError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "LegacyMqttUnavailableError";
  }
}

export class LegacyMqttOutcomeUnknownError extends Error {
  public constructor() {
    super(
      "A prior MQTT operation has an unknown outcome; reconcile device state and explicitly acknowledge it before sending more commands",
    );
    this.name = "LegacyMqttOutcomeUnknownError";
  }
}

export class LegacyMqttTransport {
  private readonly clientFactory: LegacyMqttClientFactory;
  private readonly topics: EspTopicSet;
  private readonly responseTimeoutMs: number;
  private readonly callbacks: LegacyMqttTransportCallbacks;
  private readonly now: () => number;
  private readonly operationQueue: QueuedOperation[] = [];
  private client: LegacyMqttClientPort | undefined;
  private removeClientListeners: Array<() => void> = [];
  private started = false;
  private ready = false;
  private pumping = false;
  private outcomeUnknown = false;
  private operationSequence = 0;
  private connectionGeneration = 0;
  private activeBatch: ActiveBatch | undefined;

  public constructor(options: LegacyMqttTransportOptions) {
    assertTopicSet(options.topics);
    const responseTimeoutMs =
      options.responseTimeoutMs ?? DEFAULT_RESPONSE_TIMEOUT_MS;
    if (!Number.isSafeInteger(responseTimeoutMs) || responseTimeoutMs <= 0) {
      throw new RangeError("responseTimeoutMs must be a positive integer");
    }

    this.clientFactory = options.clientFactory;
    this.topics = options.topics;
    this.responseTimeoutMs = responseTimeoutMs;
    this.callbacks = options.callbacks ?? {};
    this.now = options.now ?? Date.now;
  }

  public start(): void {
    if (this.started) {
      return;
    }

    const client = this.clientFactory();
    this.client = client;
    this.started = true;
    this.ready = false;
    ++this.connectionGeneration;
    this.removeClientListeners = [
      client.onConnected(() => {
        const generation = ++this.connectionGeneration;
        void this.handleConnected(client, generation);
      }),
      client.onDisconnected(() => {
        ++this.connectionGeneration;
        this.handleDisconnected();
      }),
      client.onError((error) => {
        this.emitInteraction({
          kind: "transport_error",
          phase: "client",
          detail: error.message,
          atMs: this.now(),
        });
      }),
      client.onMessage((topic, payload) => this.handleMessage(topic, payload)),
    ];
    this.emitLifecycle("starting");
    try {
      client.start();
    } catch (error) {
      this.started = false;
      this.client = undefined;
      ++this.connectionGeneration;
      for (const removeListener of this.removeClientListeners.splice(0)) {
        removeListener();
      }
      const normalizedError = toError(error);
      this.emitInteraction({
        kind: "transport_error",
        phase: "client",
        detail: normalizedError.message,
        atMs: this.now(),
      });
      throw normalizedError;
    }
  }

  public async stop(): Promise<void> {
    if (!this.started) {
      return;
    }

    this.started = false;
    this.ready = false;
    ++this.connectionGeneration;
    this.activeBatch?.settleUnknown("transport_stopped");
    this.rejectQueued(
      new LegacyMqttUnavailableError(
        "MQTT transport was stopped before sending",
      ),
    );

    const client = this.client;
    this.client = undefined;
    try {
      if (client !== undefined) {
        await client.stop();
      }
    } finally {
      for (const removeListener of this.removeClientListeners.splice(0)) {
        removeListener();
      }
      this.emitLifecycle("stopped");
    }
  }

  /**
   * Clears the fail-closed timeout latch only after an owner has reconciled the
   * affected device state. This method never retries the uncertain command.
   */
  public acknowledgeUnknownOutcome(): void {
    if (this.activeBatch !== undefined) {
      throw new LegacyMqttOutcomeUnknownError();
    }
    this.outcomeUnknown = false;
    void this.pumpQueue();
  }

  public executeCommands(
    commands: readonly LegacyWireCommand[],
  ): Promise<LegacyWireOperationResult> {
    if (!this.started || !this.ready) {
      return Promise.reject(
        new LegacyMqttUnavailableError("MQTT transport is not ready"),
      );
    }
    if (this.outcomeUnknown) {
      return Promise.reject(new LegacyMqttOutcomeUnknownError());
    }

    const normalizedCommands = commands.map(normalizeCommand);
    const operationId = `wire-${++this.operationSequence}`;
    return new Promise<LegacyWireOperationResult>((resolve, reject) => {
      this.operationQueue.push({
        operationId,
        commands: normalizedCommands,
        resolve,
        reject,
      });
      void this.pumpQueue();
    });
  }

  /**
   * Publishes an explicit discovery request only at an idle wire boundary.
   * Periodic scheduling and catch-up policy belong to the runtime owner.
   */
  public async requestDiscovery(): Promise<LegacyDiscoveryRequestResult> {
    const client = this.client;
    if (!this.started || !this.ready || client === undefined) {
      throw new LegacyMqttUnavailableError("MQTT transport is not ready");
    }
    if (
      this.pumping ||
      this.activeBatch !== undefined ||
      this.operationQueue.length > 0
    ) {
      return "skipped_busy";
    }

    this.pumping = true;
    const generation = this.connectionGeneration;
    try {
      await client.publish(
        this.topics.command,
        "discover",
        NON_RETAINED_QOS_ZERO,
      );
      if (!this.isCurrentConnection(client, generation) || !this.ready) {
        throw new LegacyMqttUnavailableError(
          "MQTT disconnected while publishing discovery",
        );
      }
      this.emitInteraction({ kind: "discovery_published", atMs: this.now() });
      return "published";
    } catch (error) {
      const normalizedError = toError(error);
      this.emitInteraction({
        kind: "transport_error",
        phase: "publish",
        detail: normalizedError.message,
        atMs: this.now(),
      });
      throw normalizedError;
    } finally {
      this.pumping = false;
      void this.pumpQueue();
    }
  }

  private async handleConnected(
    client: LegacyMqttClientPort,
    generation: number,
  ): Promise<void> {
    try {
      await client.subscribe(
        [this.topics.announce, this.topics.response],
        QOS_ZERO_SUBSCRIPTION,
      );
      if (!this.isCurrentConnection(client, generation)) {
        return;
      }

      await client.publish(
        this.topics.command,
        "discover",
        NON_RETAINED_QOS_ZERO,
      );
      if (!this.isCurrentConnection(client, generation)) {
        return;
      }

      this.ready = true;
      this.emitInteraction({ kind: "discovery_published", atMs: this.now() });
      this.emitLifecycle("ready");
      void this.pumpQueue();
    } catch (error) {
      this.ready = false;
      if (!this.isCurrentConnection(client, generation)) {
        return;
      }
      this.emitInteraction({
        kind: "transport_error",
        phase: "connect",
        detail: toError(error).message,
        atMs: this.now(),
      });
    }
  }

  private handleDisconnected(): void {
    if (!this.started) {
      return;
    }
    this.ready = false;
    this.activeBatch?.settleUnknown("disconnected");
    this.rejectQueued(
      new LegacyMqttUnavailableError(
        "MQTT disconnected before the queued operation was sent",
      ),
    );
    this.emitLifecycle("disconnected");
  }

  private handleMessage(topic: string, payload: Uint8Array): void {
    const decoded = decodePayload(payload);
    if (!decoded.ok) {
      this.emitMalformed(
        topic,
        decoded.preview,
        payload.byteLength,
        decoded.previewTruncated,
        decoded.detail,
      );
      return;
    }

    if (topic === this.topics.announce) {
      this.handleAnnouncement(decoded.value, payload.byteLength);
      return;
    }
    if (topic === this.topics.response) {
      this.handleResponse(decoded.value, payload.byteLength);
      return;
    }

    this.emitInteraction({
      kind: "ignored_message",
      topic,
      payloadPreview: preview(decoded.value),
      payloadBytes: payload.byteLength,
      previewTruncated: isPreviewTruncated(decoded.value),
      atMs: this.now(),
    });
  }

  private handleAnnouncement(rawPayload: string, payloadBytes: number): void {
    const parsedJson = parseJson(rawPayload);
    if (!parsedJson.ok) {
      this.emitMalformed(
        this.topics.announce,
        preview(rawPayload),
        payloadBytes,
        isPreviewTruncated(rawPayload),
        parsedJson.detail,
      );
      return;
    }
    const parsedAnnouncement = espAnnouncementSchema.safeParse(
      parsedJson.value,
    );
    if (!parsedAnnouncement.success) {
      this.emitMalformed(
        this.topics.announce,
        preview(rawPayload),
        payloadBytes,
        isPreviewTruncated(rawPayload),
        parsedAnnouncement.error.message,
      );
      return;
    }

    try {
      this.callbacks.onAnnouncement?.({
        announcement: parsedAnnouncement.data,
        receivedAtMs: this.now(),
        payloadBytes,
      });
    } catch (error) {
      this.emitCallbackError("announcement_callback", error);
    }
  }

  private handleResponse(rawPayload: string, payloadBytes: number): void {
    const parsedJson = parseJson(rawPayload);
    if (!parsedJson.ok) {
      this.emitMalformed(
        this.topics.response,
        preview(rawPayload),
        payloadBytes,
        isPreviewTruncated(rawPayload),
        parsedJson.detail,
      );
      return;
    }
    const parsedResponse = espCommandResponseSchema.safeParse(parsedJson.value);
    if (!parsedResponse.success) {
      this.emitMalformed(
        this.topics.response,
        preview(rawPayload),
        payloadBytes,
        isPreviewTruncated(rawPayload),
        parsedResponse.error.message,
      );
      return;
    }

    const activeBatch = this.activeBatch;
    for (const response of parsedResponse.data.responses) {
      if (activeBatch === undefined) {
        this.emitIgnoredResponse(
          "no_active_batch",
          parsedResponse.data.id,
          response.index,
          payloadBytes,
        );
        continue;
      }

      const expectation = activeBatch.expectations.get(response.index);
      if (expectation === undefined) {
        this.emitIgnoredResponse(
          "index_out_of_range",
          parsedResponse.data.id,
          response.index,
          payloadBytes,
        );
        continue;
      }
      if (expectation.command.targetId !== parsedResponse.data.id) {
        this.emitIgnoredResponse(
          "wrong_device",
          parsedResponse.data.id,
          response.index,
          payloadBytes,
        );
        continue;
      }
      if (!activeBatch.responsesEnabled()) {
        this.emitIgnoredResponse(
          "premature_response",
          parsedResponse.data.id,
          response.index,
          payloadBytes,
        );
        continue;
      }
      if (activeBatch.outcomes.has(response.index)) {
        this.emitIgnoredResponse(
          "duplicate",
          parsedResponse.data.id,
          response.index,
          payloadBytes,
        );
        continue;
      }

      const responseMatch = matchExpectedResponse(
        expectation.command.expectedResponse,
        response.response,
      );
      const outcome: LegacyCommandOutcome = responseMatch.matched
        ? {
            index: expectation.originalIndex,
            command: expectation.command.command,
            targetId: expectation.command.targetId,
            status: "succeeded",
            response: response.response,
            analogValue: responseMatch.analogValue,
          }
        : {
            index: expectation.originalIndex,
            command: expectation.command.command,
            targetId: expectation.command.targetId,
            status: "failed",
            response: response.response,
            expectedResponse: expectation.command.expectedResponse,
          };
      activeBatch.outcomes.set(response.index, outcome);
      this.emitCommandOutcome(activeBatch.operationId, outcome);
      activeBatch.settleIfComplete();
    }
  }

  private async pumpQueue(): Promise<void> {
    if (this.pumping) {
      return;
    }
    this.pumping = true;
    try {
      while (this.operationQueue.length > 0) {
        const queued = this.operationQueue.shift();
        if (queued === undefined) {
          break;
        }
        if (!this.started || !this.ready) {
          queued.reject(
            new LegacyMqttUnavailableError("MQTT transport is not ready"),
          );
          continue;
        }
        if (this.outcomeUnknown) {
          queued.reject(new LegacyMqttOutcomeUnknownError());
          continue;
        }

        try {
          queued.resolve(await this.executeQueuedOperation(queued));
        } catch (error) {
          queued.reject(toError(error));
        }
      }
    } finally {
      this.pumping = false;
    }
  }

  private async executeQueuedOperation(
    operation: QueuedOperation,
  ): Promise<LegacyWireOperationResult> {
    const startedAtMs = this.now();
    if (operation.commands.length === 0) {
      return {
        operationId: operation.operationId,
        startedAtMs,
        completedAtMs: this.now(),
        outcomes: [],
      };
    }

    const batches = batchLegacyCommands(
      operation.commands.map((command) => command.command),
    );
    const outcomes = new Map<number, LegacyCommandOutcome>();

    for (const [batchIndex, batch] of batches.entries()) {
      if (!this.started || !this.ready || this.outcomeUnknown) {
        const reason = this.started
          ? "prior_batch_outcome_unknown"
          : "transport_stopped";
        addNotAttemptedOutcomes(operation.commands, outcomes, reason);
        break;
      }

      const batchOutcomes = await this.executeBatch(
        operation.operationId,
        batchIndex,
        batch,
        operation.commands,
      );
      for (const outcome of batchOutcomes) {
        outcomes.set(outcome.index, outcome);
      }
      if (
        batchOutcomes.some((outcome) => outcome.status === "outcome_unknown")
      ) {
        this.outcomeUnknown = true;
        addNotAttemptedOutcomes(
          operation.commands,
          outcomes,
          "prior_batch_outcome_unknown",
        );
        break;
      }
    }

    return {
      operationId: operation.operationId,
      startedAtMs,
      completedAtMs: this.now(),
      outcomes: [...outcomes.values()].sort(
        (left, right) => left.index - right.index,
      ),
    };
  }

  private async executeBatch(
    operationId: string,
    batchIndex: number,
    batch: LegacyCommandBatch,
    commands: readonly NormalizedCommand[],
  ): Promise<readonly LegacyCommandOutcome[]> {
    const client = this.client;
    if (client === undefined) {
      throw new LegacyMqttUnavailableError("MQTT client is unavailable");
    }

    const activeBatch = this.createActiveBatch(
      operationId,
      batchIndex,
      batch,
      commands,
    );
    this.activeBatch = activeBatch;
    const frames = encodeLegacyMessage(batch.payload);
    let publishedFrames = 0;

    for (const [frameIndex, frame] of frames.entries()) {
      if (frameIndex === frames.length - 1) {
        activeBatch.enableResponses();
      }
      const publishResult = client
        .publish(this.topics.command, frame, NON_RETAINED_QOS_ZERO)
        .then(
          () => ({ kind: "published" as const }),
          (error: Error) => ({ kind: "publish_failed" as const, error }),
        );
      const raceResult = await Promise.race([
        publishResult,
        activeBatch.promise.then(() => ({ kind: "settled" as const })),
      ]);
      if (raceResult.kind === "settled") {
        break;
      }
      if (raceResult.kind === "publish_failed") {
        this.emitInteraction({
          kind: "transport_error",
          phase: "publish",
          detail: raceResult.error.message,
          atMs: this.now(),
        });
        activeBatch.settleUnknown("publish_failed");
        break;
      }
      publishedFrames += 1;
    }

    if (publishedFrames === frames.length) {
      this.emitInteraction({
        kind: "batch_published",
        operationId,
        batchIndex,
        frameCount: frames.length,
        payloadBytes: frames.reduce(
          (total, frame) => total + utf8ByteLength(frame),
          0,
        ),
        atMs: this.now(),
      });
    }
    const outcomes = await activeBatch.promise;
    if (this.activeBatch === activeBatch) {
      this.activeBatch = undefined;
    }
    return outcomes;
  }

  private createActiveBatch(
    operationId: string,
    batchIndex: number,
    batch: LegacyCommandBatch,
    commands: readonly NormalizedCommand[],
  ): ActiveBatch {
    const expectations = new Map<number, BatchExpectation>();
    batch.originalIndexes.forEach((originalIndex, localIndex) => {
      const command = commands[originalIndex];
      if (command === undefined) {
        throw new RangeError("Protocol batch referenced a missing command");
      }
      expectations.set(localIndex, { localIndex, originalIndex, command });
    });

    const outcomes = new Map<number, LegacyCommandOutcome>();
    let responsesEnabled = false;
    let settled = false;
    let resolveOutcomes: (
      outcomes: readonly LegacyCommandOutcome[],
    ) => void = () => undefined;
    const promise = new Promise<readonly LegacyCommandOutcome[]>((resolve) => {
      resolveOutcomes = resolve;
    });
    const finish = (): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeoutHandle);
      resolveOutcomes(
        [...outcomes.values()].sort((left, right) => left.index - right.index),
      );
    };
    const settleUnknown = (
      reason:
        "timeout" | "publish_failed" | "disconnected" | "transport_stopped",
    ): void => {
      if (settled) {
        return;
      }
      for (const expectation of expectations.values()) {
        if (outcomes.has(expectation.localIndex)) {
          continue;
        }
        const outcome: LegacyCommandOutcome = {
          index: expectation.originalIndex,
          command: expectation.command.command,
          targetId: expectation.command.targetId,
          status: "outcome_unknown",
          reason,
        };
        outcomes.set(expectation.localIndex, outcome);
        this.emitCommandOutcome(operationId, outcome);
      }
      finish();
    };
    const timeoutHandle = setTimeout(
      () => settleUnknown("timeout"),
      this.responseTimeoutMs,
    );

    return {
      operationId,
      batchIndex,
      expectations,
      outcomes,
      responsesEnabled: () => responsesEnabled,
      enableResponses: () => {
        responsesEnabled = true;
      },
      promise,
      settleUnknown,
      settleIfComplete: () => {
        if (outcomes.size === expectations.size) {
          finish();
        }
      },
    };
  }

  private isCurrentConnection(
    client: LegacyMqttClientPort,
    generation: number,
  ): boolean {
    return (
      this.started &&
      this.client === client &&
      this.connectionGeneration === generation
    );
  }

  private rejectQueued(error: Error): void {
    for (const queued of this.operationQueue.splice(0)) {
      queued.reject(error);
    }
  }

  private emitMalformed(
    topic: string,
    payloadPreview: string,
    payloadBytes: number,
    previewTruncated: boolean,
    detail: string,
  ): void {
    this.emitInteraction({
      kind: "malformed_message",
      topic,
      payloadPreview,
      payloadBytes,
      previewTruncated,
      detail,
      atMs: this.now(),
    });
  }

  private emitIgnoredResponse(
    reason: IgnoredResponseReason,
    responderId: string,
    responseIndex: number,
    payloadBytes: number,
  ): void {
    this.emitInteraction({
      kind: "ignored_response",
      reason,
      responderId,
      responseIndex,
      payloadBytes,
      atMs: this.now(),
    });
  }

  private emitCommandOutcome(
    operationId: string,
    outcome: LegacyCommandOutcome,
  ): void {
    this.emitInteraction({
      kind: "command_outcome",
      operationId,
      outcome,
      atMs: this.now(),
    });
  }

  private emitLifecycle(
    state: Extract<LegacyMqttInteraction, { kind: "lifecycle" }>["state"],
  ): void {
    this.emitInteraction({ kind: "lifecycle", state, atMs: this.now() });
  }

  private emitInteraction(interaction: LegacyMqttInteraction): void {
    try {
      this.callbacks.onInteraction?.(interaction);
    } catch (error) {
      if (interaction.kind !== "transport_error") {
        this.emitCallbackError("interaction_callback", error);
      }
    }
  }

  private emitCallbackError(
    phase: "announcement_callback" | "interaction_callback",
    error: unknown,
  ): void {
    const normalizedError = toError(error);
    try {
      this.callbacks.onCallbackError?.(normalizedError);
    } catch {
      // A callback failure must never escape the MQTT client's event emitter.
    }
    if (phase === "announcement_callback") {
      this.emitInteraction({
        kind: "transport_error",
        phase,
        detail: normalizedError.message,
        atMs: this.now(),
      });
    }
  }
}

function normalizeCommand(command: LegacyWireCommand): NormalizedCommand {
  assertTargetToken(command.target.id, "target id");
  for (const alias of command.target.aliases ?? []) {
    assertTargetToken(alias, "target alias");
  }

  const trimmed = command.command.trim();
  const separatorIndex = trimmed.search(/\s/);
  if (separatorIndex <= 0) {
    throw new TypeError("Legacy command requires a target and operation");
  }
  const suppliedTarget = trimmed.slice(0, separatorIndex);
  const acceptedTargets = new Set([
    command.target.id,
    ...(command.target.aliases ?? []),
  ]);
  if (!acceptedTargets.has(suppliedTarget)) {
    throw new TypeError(
      `Command target ${suppliedTarget} does not identify ${command.target.id}`,
    );
  }

  return {
    command: `${command.target.id}${trimmed.slice(separatorIndex)}`,
    targetId: command.target.id,
    expectedResponse: normalizeExpectedResponse(command.expectedResponse),
  };
}

function normalizeExpectedResponse(
  expectedResponse: LegacyExpectedResponse,
): LegacyExpectedResponse {
  if (expectedResponse.kind === "exact") {
    if (typeof expectedResponse.value !== "string") {
      throw new TypeError("Exact legacy response value must be a string");
    }
    return { kind: "exact", value: expectedResponse.value };
  }
  if (expectedResponse.kind === "analog_read") {
    assertIntegerInRange(
      expectedResponse.pin,
      MIN_LEGACY_PIN,
      MAX_LEGACY_PIN,
      "Analog-read pin",
    );
    return { kind: "analog_read", pin: expectedResponse.pin };
  }
  throw new TypeError("Unsupported legacy expected-response descriptor");
}

type ExpectedResponseMatch =
  | { readonly matched: true; readonly analogValue: number | null }
  | { readonly matched: false };

function matchExpectedResponse(
  expectedResponse: LegacyExpectedResponse,
  response: string,
): ExpectedResponseMatch {
  if (expectedResponse.kind === "exact") {
    return response === expectedResponse.value
      ? { matched: true, analogValue: null }
      : { matched: false };
  }

  const prefix = `r ${expectedResponse.pin} `;
  if (!response.startsWith(prefix)) {
    return { matched: false };
  }
  const valueText = response.slice(prefix.length);
  const value = Number(valueText);
  const valid =
    valueText.length > 0 &&
    Number.isInteger(value) &&
    value >= MIN_ANALOG_VALUE &&
    value <= MAX_ANALOG_VALUE &&
    String(value) === valueText;
  return valid ? { matched: true, analogValue: value } : { matched: false };
}

function assertIntegerInRange(
  value: number,
  minimum: number,
  maximum: number,
  description: string,
): void {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    throw new RangeError(
      `${description} must be an integer from ${minimum} to ${maximum}`,
    );
  }
}

function assertTargetToken(value: string, description: string): void {
  if (value.length === 0 || /[;\s\0]/.test(value)) {
    throw new TypeError(`Legacy ${description} must be a non-empty wire token`);
  }
}

function assertTopicSet(topics: EspTopicSet): void {
  const values = [topics.command, topics.announce, topics.response];
  if (
    values.some(
      (topic) =>
        topic.trim().length === 0 ||
        topic.includes("#") ||
        topic.includes("+") ||
        topic.includes("\0"),
    )
  ) {
    throw new TypeError(
      "MQTT topics must be explicit non-wildcard topic names",
    );
  }
  if (new Set(values).size !== values.length) {
    throw new TypeError(
      "MQTT command, announce, and response topics must differ",
    );
  }
}

function addNotAttemptedOutcomes(
  commands: readonly NormalizedCommand[],
  outcomes: Map<number, LegacyCommandOutcome>,
  reason: Extract<LegacyCommandOutcome, { status: "not_attempted" }>["reason"],
): void {
  commands.forEach((command, index) => {
    if (!outcomes.has(index)) {
      outcomes.set(index, {
        index,
        command: command.command,
        targetId: command.targetId,
        status: "not_attempted",
        reason,
      });
    }
  });
}

type DecodedPayload =
  | { readonly ok: true; readonly value: string }
  | {
      readonly ok: false;
      readonly preview: string;
      readonly previewTruncated: boolean;
      readonly detail: string;
    };

function decodePayload(payload: Uint8Array): DecodedPayload {
  try {
    return {
      ok: true,
      value: new TextDecoder("utf-8", { fatal: true }).decode(payload),
    };
  } catch (error) {
    const lossyDecoded = new TextDecoder().decode(payload);
    return {
      ok: false,
      preview: preview(lossyDecoded),
      previewTruncated: isPreviewTruncated(lossyDecoded),
      detail: toError(error).message,
    };
  }
}

type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };

type ParsedJson =
  | { readonly ok: true; readonly value: JsonValue }
  | { readonly ok: false; readonly detail: string };

function parseJson(payload: string): ParsedJson {
  try {
    const parsed = JSON.parse(payload) as JsonValue;
    return { ok: true, value: parsed };
  } catch (error) {
    return { ok: false, detail: toError(error).message };
  }
}

function preview(payload: string): string {
  return payload.slice(0, MAX_RAW_PAYLOAD_PREVIEW);
}

function isPreviewTruncated(payload: string): boolean {
  return payload.length > MAX_RAW_PAYLOAD_PREVIEW;
}

function toError(error: unknown): Error {
  return error instanceof Error ? error : new Error(String(error));
}
