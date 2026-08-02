import { randomBytes } from "node:crypto";

import {
  batchLegacyCommands,
  encodeCorrelatedLegacyRequest,
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
const DEFAULT_MAX_CONCURRENT_DEVICE_LANES = 16;
const MAX_CONCURRENT_DEVICE_LANES = 32;
const MAX_RAW_PAYLOAD_PREVIEW = 2_048;
const MIN_LEGACY_PIN = 0;
const MAX_LEGACY_PIN = 63;
const MIN_ANALOG_VALUE = 0;
const MAX_ANALOG_VALUE = 4_095;
const MAX_REQUEST_SESSION_ID_LENGTH = 24;

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

export type LegacyCommandPriority = "interactive" | "background";

export interface LegacyCommandExecutionOptions {
  readonly priority?: LegacyCommandPriority;
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
      readonly reason: "disconnected" | "transport_stopped";
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
  | "wrong_request"
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
      readonly requestId: string;
      readonly targetId: string;
      readonly batchIndex: number;
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
  readonly maxConcurrentDeviceLanes?: number;
  readonly callbacks?: LegacyMqttTransportCallbacks;
  readonly now?: () => number;
  /** Stable only for this transport instance; injectable for deterministic tests. */
  readonly requestSessionId?: string;
}

interface NormalizedCommand {
  readonly originalIndex: number;
  readonly command: string;
  readonly targetId: string;
  readonly expectedResponse: LegacyExpectedResponse;
}

export type LegacyDiscoveryRequestResult = "published" | "skipped_busy";

interface QueuedDeviceOperation {
  readonly operationId: string;
  readonly targetId: string;
  readonly priority: LegacyCommandPriority;
  readonly commands: readonly NormalizedCommand[];
  readonly resolve: (result: DeviceWireOperationResult) => void;
  readonly reject: (error: Error) => void;
}

interface DeviceWireOperationResult {
  readonly startedAtMs: number;
  readonly completedAtMs: number;
  readonly outcomes: readonly LegacyCommandOutcome[];
}

interface BatchExpectation {
  readonly localIndex: number;
  readonly originalIndex: number;
  readonly command: NormalizedCommand;
}

interface ActiveBatch {
  readonly operationId: string;
  readonly requestId: string;
  readonly batchIndex: number;
  readonly expectations: ReadonlyMap<number, BatchExpectation>;
  readonly outcomes: Map<number, LegacyCommandOutcome>;
  readonly responsesEnabled: () => boolean;
  readonly enableResponses: () => void;
  readonly armTimeout: () => void;
  readonly promise: Promise<readonly LegacyCommandOutcome[]>;
  readonly settleUnknown: (
    reason: "timeout" | "publish_failed" | "disconnected" | "transport_stopped",
  ) => void;
  readonly settleIfComplete: () => void;
}

type PublicationCancellationReason = "disconnected" | "transport_stopped";

interface PublicationGeneration {
  readonly generation: number;
  readonly promise: Promise<PublicationCancellationReason>;
  readonly reason: () => PublicationCancellationReason | null;
  readonly cancel: (reason: PublicationCancellationReason) => void;
}

export class LegacyMqttUnavailableError extends Error {
  public constructor(message: string) {
    super(message);
    this.name = "LegacyMqttUnavailableError";
  }
}

class UnsentLegacyMqttOperationError extends LegacyMqttUnavailableError {
  public constructor(
    message: string,
    readonly reason: "disconnected" | "transport_stopped",
  ) {
    super(message);
    this.name = "UnsentLegacyMqttOperationError";
  }
}

export class LegacyMqttTransport {
  private readonly clientFactory: LegacyMqttClientFactory;
  private readonly topics: EspTopicSet;
  private readonly responseTimeoutMs: number;
  private readonly maxConcurrentDeviceLanes: number;
  private readonly callbacks: LegacyMqttTransportCallbacks;
  private readonly now: () => number;
  private readonly requestSessionId: string;
  private readonly deviceQueues = new Map<string, QueuedDeviceOperation[]>();
  private readonly runnableInteractiveDeviceIds: string[] = [];
  private readonly runnableBackgroundDeviceIds: string[] = [];
  private readonly runnablePriorityByDevice = new Map<
    string,
    LegacyCommandPriority
  >();
  private readonly activeDeviceIds = new Set<string>();
  private readonly activeBatches = new Map<string, ActiveBatch>();
  private client: LegacyMqttClientPort | undefined;
  private removeClientListeners: Array<() => void> = [];
  private started = false;
  private ready = false;
  private discoveryPublishing = false;
  private activeDeviceLaneCount = 0;
  private publicationQueueDepth = 0;
  private publicationTail: Promise<void> = Promise.resolve();
  private operationSequence = 0;
  private requestSequence = 0;
  private connectionGeneration = 0;
  private publicationGeneration = createPublicationGeneration(0);

  public constructor(options: LegacyMqttTransportOptions) {
    assertTopicSet(options.topics);
    const responseTimeoutMs =
      options.responseTimeoutMs ?? DEFAULT_RESPONSE_TIMEOUT_MS;
    if (!Number.isSafeInteger(responseTimeoutMs) || responseTimeoutMs <= 0) {
      throw new RangeError("responseTimeoutMs must be a positive integer");
    }
    const maxConcurrentDeviceLanes =
      options.maxConcurrentDeviceLanes ?? DEFAULT_MAX_CONCURRENT_DEVICE_LANES;
    if (
      !Number.isSafeInteger(maxConcurrentDeviceLanes) ||
      maxConcurrentDeviceLanes < 1 ||
      maxConcurrentDeviceLanes > MAX_CONCURRENT_DEVICE_LANES
    ) {
      throw new RangeError(
        `maxConcurrentDeviceLanes must be an integer from 1 to ${MAX_CONCURRENT_DEVICE_LANES}`,
      );
    }

    this.clientFactory = options.clientFactory;
    this.topics = options.topics;
    this.responseTimeoutMs = responseTimeoutMs;
    this.maxConcurrentDeviceLanes = maxConcurrentDeviceLanes;
    this.callbacks = options.callbacks ?? {};
    this.now = options.now ?? Date.now;
    this.requestSessionId = normalizeRequestSessionId(options.requestSessionId);
  }

  public start(): void {
    if (this.started) {
      return;
    }

    const client = this.clientFactory();
    this.client = client;
    this.started = true;
    this.ready = false;
    this.rotatePublicationGeneration("transport_stopped");
    this.removeClientListeners = [
      client.onConnected(() => {
        const replacedReadyConnection = this.ready;
        this.ready = false;
        const generation = this.rotatePublicationGeneration("disconnected");
        if (replacedReadyConnection) {
          this.rejectQueued(
            new UnsentLegacyMqttOperationError(
              "MQTT connection was replaced before queued work was sent",
              "disconnected",
            ),
          );
        }
        void this.handleConnected(client, generation);
      }),
      client.onDisconnected(() => {
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
      this.rotatePublicationGeneration("transport_stopped");
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
    this.rotatePublicationGeneration("transport_stopped");
    this.rejectQueued(
      new UnsentLegacyMqttOperationError(
        "MQTT transport was stopped before sending",
        "transport_stopped",
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

  public executeCommands(
    commands: readonly LegacyWireCommand[],
    options: LegacyCommandExecutionOptions = {},
  ): Promise<LegacyWireOperationResult> {
    if (!this.started || !this.ready) {
      return Promise.reject(
        new LegacyMqttUnavailableError("MQTT transport is not ready"),
      );
    }
    const normalizedCommands = commands.map((command, originalIndex) =>
      normalizeCommand(command, originalIndex),
    );
    const priority = normalizeCommandPriority(options.priority);
    const operationId = `wire-${++this.operationSequence}`;
    return this.executePartitionedOperation(
      operationId,
      normalizedCommands,
      priority,
    );
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
      this.discoveryPublishing ||
      this.publicationQueueDepth > 0 ||
      this.activeDeviceLaneCount > 0 ||
      this.hasQueuedOperations()
    ) {
      return "skipped_busy";
    }

    this.discoveryPublishing = true;
    const generation = this.connectionGeneration;
    try {
      await this.withPublicationLock(generation, async () => {
        if (!this.isCurrentConnection(client, generation) || !this.ready) {
          throw new LegacyMqttUnavailableError(
            "MQTT disconnected before publishing discovery",
          );
        }
        await client.publish(
          this.topics.command,
          "discover",
          NON_RETAINED_QOS_ZERO,
        );
      });
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
      this.discoveryPublishing = false;
      this.pumpDeviceQueues();
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

      const discoveryPublished = await this.withPublicationLock(
        generation,
        async () => {
          if (!this.isCurrentConnection(client, generation)) {
            return false;
          }
          await client.publish(
            this.topics.command,
            "discover",
            NON_RETAINED_QOS_ZERO,
          );
          return true;
        },
      );
      if (
        !discoveryPublished ||
        !this.isCurrentConnection(client, generation)
      ) {
        return;
      }

      this.ready = true;
      this.emitInteraction({ kind: "discovery_published", atMs: this.now() });
      this.emitLifecycle("ready");
      this.pumpDeviceQueues();
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
    this.rotatePublicationGeneration("disconnected");
    this.rejectQueued(
      new UnsentLegacyMqttOperationError(
        "MQTT disconnected before the queued operation was sent",
        "disconnected",
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
      this.handleAttributableMalformedResponse(parsedJson.value, payloadBytes);
      return;
    }

    const activeBatch = this.activeBatches.get(parsedResponse.data.requestId);
    if (activeBatch === undefined) {
      const reason =
        this.activeBatches.size === 0 ? "no_active_batch" : "wrong_request";
      if (parsedResponse.data.responses.length === 0) {
        this.emitIgnoredResponse(
          reason,
          parsedResponse.data.id,
          -1,
          payloadBytes,
        );
      }
      for (const response of parsedResponse.data.responses) {
        this.emitIgnoredResponse(
          reason,
          parsedResponse.data.id,
          response.index,
          payloadBytes,
        );
      }
      return;
    }
    if (parsedResponse.data.responses.length === 0) {
      this.handleEmptyCorrelatedResponse(
        activeBatch,
        parsedResponse.data.id,
        payloadBytes,
      );
      return;
    }

    for (const response of parsedResponse.data.responses) {
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

  private handleEmptyCorrelatedResponse(
    activeBatch: ActiveBatch,
    responderId: string,
    payloadBytes: number,
  ): void {
    if (!activeBatch.responsesEnabled()) {
      this.emitIgnoredResponse(
        "premature_response",
        responderId,
        -1,
        payloadBytes,
      );
      return;
    }
    const matchingExpectations = [...activeBatch.expectations.values()].filter(
      ({ command }) => command.targetId === responderId,
    );
    if (matchingExpectations.length === 0) {
      this.emitIgnoredResponse("wrong_device", responderId, -1, payloadBytes);
      return;
    }
    const unansweredExpectations = matchingExpectations.filter(
      ({ localIndex }) => !activeBatch.outcomes.has(localIndex),
    );
    if (unansweredExpectations.length === 0) {
      this.emitIgnoredResponse("duplicate", responderId, -1, payloadBytes);
      return;
    }
    for (const expectation of unansweredExpectations) {
      const outcome: LegacyCommandOutcome = {
        index: expectation.originalIndex,
        command: expectation.command.command,
        targetId: expectation.command.targetId,
        status: "failed",
        response: "",
        expectedResponse: expectation.command.expectedResponse,
      };
      activeBatch.outcomes.set(expectation.localIndex, outcome);
      this.emitCommandOutcome(activeBatch.operationId, outcome);
    }
    activeBatch.settleIfComplete();
  }

  private handleAttributableMalformedResponse(
    value: JsonValue,
    payloadBytes: number,
  ): void {
    const identity = responseIdentity(value);
    const activeBatch =
      identity === null
        ? undefined
        : this.activeBatches.get(identity.requestId);
    if (
      identity === null ||
      activeBatch === undefined ||
      !activeBatch.responsesEnabled()
    ) {
      return;
    }
    const matchingExpectations = [...activeBatch.expectations.values()].filter(
      ({ command }) => command.targetId === identity.id,
    );
    if (matchingExpectations.length === 0) {
      this.emitIgnoredResponse("wrong_device", identity.id, -1, payloadBytes);
      return;
    }
    for (const expectation of matchingExpectations) {
      if (activeBatch.outcomes.has(expectation.localIndex)) {
        continue;
      }
      const outcome: LegacyCommandOutcome = {
        index: expectation.originalIndex,
        command: expectation.command.command,
        targetId: expectation.command.targetId,
        status: "failed",
        response: "[malformed response envelope]",
        expectedResponse: expectation.command.expectedResponse,
      };
      activeBatch.outcomes.set(expectation.localIndex, outcome);
      this.emitCommandOutcome(activeBatch.operationId, outcome);
    }
    activeBatch.settleIfComplete();
  }

  private async executePartitionedOperation(
    operationId: string,
    commands: readonly NormalizedCommand[],
    priority: LegacyCommandPriority,
  ): Promise<LegacyWireOperationResult> {
    const startedAtMs = this.now();
    if (commands.length === 0) {
      return {
        operationId,
        startedAtMs,
        completedAtMs: this.now(),
        outcomes: [],
      };
    }

    const groups = partitionCommandsByDevice(commands);
    const groupResults = await Promise.all(
      groups.map(async ({ targetId, commands: deviceCommands }) => {
        try {
          return {
            kind: "completed" as const,
            commands: deviceCommands,
            result: await this.enqueueDeviceOperation({
              operationId,
              targetId,
              priority,
              commands: deviceCommands,
            }),
          };
        } catch (error) {
          return {
            kind: "rejected" as const,
            commands: deviceCommands,
            error: toError(error),
          };
        }
      }),
    );
    const unexpectedFailure = groupResults.find(
      (result) =>
        result.kind === "rejected" &&
        !(result.error instanceof UnsentLegacyMqttOperationError),
    );
    if (unexpectedFailure?.kind === "rejected") {
      throw unexpectedFailure.error;
    }
    const completedGroups = groupResults.filter(
      (
        result,
      ): result is Extract<
        (typeof groupResults)[number],
        { kind: "completed" }
      > => result.kind === "completed",
    );
    if (completedGroups.length === 0) {
      const rejection = groupResults.find(
        (
          result,
        ): result is Extract<
          (typeof groupResults)[number],
          { kind: "rejected" }
        > => result.kind === "rejected",
      );
      throw (
        rejection?.error ??
        new LegacyMqttUnavailableError("MQTT operation could not be sent")
      );
    }

    const outcomes = new Map<number, LegacyCommandOutcome>();
    for (const group of completedGroups) {
      for (const outcome of group.result.outcomes) {
        outcomes.set(outcome.index, outcome);
      }
    }
    for (const group of groupResults) {
      if (
        group.kind !== "rejected" ||
        !(group.error instanceof UnsentLegacyMqttOperationError)
      ) {
        continue;
      }
      addNotAttemptedOutcomes(group.commands, outcomes, group.error.reason);
    }
    return {
      operationId,
      startedAtMs,
      completedAtMs: this.now(),
      outcomes: [...outcomes.values()].sort(
        (left, right) => left.index - right.index,
      ),
    };
  }

  private enqueueDeviceOperation(
    operation: Omit<QueuedDeviceOperation, "resolve" | "reject">,
  ): Promise<DeviceWireOperationResult> {
    return new Promise<DeviceWireOperationResult>((resolve, reject) => {
      const queue = this.deviceQueues.get(operation.targetId) ?? [];
      queue.push({ ...operation, resolve, reject });
      this.deviceQueues.set(operation.targetId, queue);
      this.scheduleRunnableDevice(operation.targetId);
      this.pumpDeviceQueues();
    });
  }

  private pumpDeviceQueues(): void {
    if (!this.started || !this.ready || this.discoveryPublishing) {
      return;
    }
    while (
      this.activeDeviceLaneCount < this.maxConcurrentDeviceLanes &&
      (this.runnableInteractiveDeviceIds.length > 0 ||
        this.runnableBackgroundDeviceIds.length > 0)
    ) {
      const runnable = this.takeNextRunnableDevice();
      if (runnable === null || this.activeDeviceIds.has(runnable.targetId)) {
        continue;
      }
      const queue = this.deviceQueues.get(runnable.targetId);
      const operation = queue?.shift();
      if (queue === undefined || operation === undefined) {
        this.deviceQueues.delete(runnable.targetId);
        continue;
      }

      this.activeDeviceIds.add(runnable.targetId);
      this.activeDeviceLaneCount += 1;
      const task = this.executeQueuedDeviceOperation(operation);
      void task
        .then(operation.resolve, (error) => operation.reject(toError(error)))
        .finally(() => {
          this.activeDeviceIds.delete(runnable.targetId);
          this.activeDeviceLaneCount -= 1;
          const remaining = this.deviceQueues.get(runnable.targetId);
          if (remaining === undefined || remaining.length === 0) {
            this.deviceQueues.delete(runnable.targetId);
          } else {
            this.scheduleRunnableDevice(runnable.targetId);
          }
          this.pumpDeviceQueues();
        });
    }
  }

  private scheduleRunnableDevice(targetId: string): void {
    if (this.activeDeviceIds.has(targetId)) {
      return;
    }
    const queue = this.deviceQueues.get(targetId);
    const priority = queue?.[0]?.priority ?? null;
    const currentPriority = this.runnablePriorityByDevice.get(targetId);
    if (currentPriority === priority) {
      return;
    }
    if (currentPriority !== undefined) {
      removeArrayValue(
        currentPriority === "interactive"
          ? this.runnableInteractiveDeviceIds
          : this.runnableBackgroundDeviceIds,
        targetId,
      );
      this.runnablePriorityByDevice.delete(targetId);
    }
    if (priority === null) {
      return;
    }
    const runnableDeviceIds =
      priority === "interactive"
        ? this.runnableInteractiveDeviceIds
        : this.runnableBackgroundDeviceIds;
    runnableDeviceIds.push(targetId);
    this.runnablePriorityByDevice.set(targetId, priority);
  }

  private takeNextRunnableDevice(): {
    readonly targetId: string;
    readonly priority: LegacyCommandPriority;
  } | null {
    const priority: LegacyCommandPriority =
      this.runnableInteractiveDeviceIds.length > 0
        ? "interactive"
        : "background";
    const runnableDeviceIds =
      priority === "interactive"
        ? this.runnableInteractiveDeviceIds
        : this.runnableBackgroundDeviceIds;
    const targetId = runnableDeviceIds.shift();
    if (targetId === undefined) {
      return null;
    }
    this.runnablePriorityByDevice.delete(targetId);
    return { targetId, priority };
  }

  private async executeQueuedDeviceOperation(
    operation: QueuedDeviceOperation,
  ): Promise<DeviceWireOperationResult> {
    const startedAtMs = this.now();
    const batches = batchLegacyCommands(
      operation.commands.map((command) => command.command),
    );
    const outcomes = new Map<number, LegacyCommandOutcome>();

    for (const [batchIndex, batch] of batches.entries()) {
      if (!this.started || !this.ready) {
        const reason = this.started ? "disconnected" : "transport_stopped";
        addNotAttemptedOutcomes(operation.commands, outcomes, reason);
        break;
      }

      let batchOutcomes: readonly LegacyCommandOutcome[];
      try {
        batchOutcomes = await this.executeBatch(
          operation.operationId,
          operation.targetId,
          batchIndex,
          batch,
          operation.commands,
        );
      } catch (error) {
        if (
          !(error instanceof UnsentLegacyMqttOperationError) ||
          outcomes.size === 0
        ) {
          throw error;
        }
        addNotAttemptedOutcomes(operation.commands, outcomes, error.reason);
        break;
      }
      for (const outcome of batchOutcomes) {
        outcomes.set(outcome.index, outcome);
      }
    }

    return {
      startedAtMs,
      completedAtMs: this.now(),
      outcomes: [...outcomes.values()].sort(
        (left, right) => left.index - right.index,
      ),
    };
  }

  private async executeBatch(
    operationId: string,
    targetId: string,
    batchIndex: number,
    batch: LegacyCommandBatch,
    commands: readonly NormalizedCommand[],
  ): Promise<readonly LegacyCommandOutcome[]> {
    const client = this.client;
    const generation = this.connectionGeneration;
    if (client === undefined) {
      throw new UnsentLegacyMqttOperationError(
        "MQTT client was unavailable before publication",
        this.started ? "disconnected" : "transport_stopped",
      );
    }
    const requestId = this.nextRequestId();
    const payload = encodeLegacyMessage(
      encodeCorrelatedLegacyRequest(requestId, batch.payload),
    );
    let activeBatch: ActiveBatch | undefined;
    try {
      await this.withPublicationLock(generation, async () => {
        if (!this.ready || !this.isCurrentConnection(client, generation)) {
          throw new UnsentLegacyMqttOperationError(
            "MQTT transport became unavailable before publication",
            this.started ? "disconnected" : "transport_stopped",
          );
        }

        activeBatch = this.createActiveBatch(
          operationId,
          requestId,
          batchIndex,
          batch,
          commands,
        );
        this.activeBatches.set(requestId, activeBatch);
        activeBatch.enableResponses();
        const publishResult = client
          .publish(this.topics.command, payload, NON_RETAINED_QOS_ZERO)
          .then(
            () => ({ kind: "published" as const }),
            (error: Error) => ({
              kind: "publish_failed" as const,
              error,
            }),
          );
        const raceResult = await Promise.race([
          publishResult,
          activeBatch.promise.then((outcomes) => ({
            kind: "settled" as const,
            outcomes,
          })),
        ]);
        if (raceResult.kind === "publish_failed") {
          this.emitInteraction({
            kind: "transport_error",
            phase: "publish",
            detail: raceResult.error.message,
            atMs: this.now(),
          });
          activeBatch.settleUnknown("publish_failed");
        } else if (
          raceResult.kind === "published" ||
          raceResult.outcomes.every(
            ({ status }) => status === "succeeded" || status === "failed",
          )
        ) {
          this.emitInteraction({
            kind: "batch_published",
            operationId,
            requestId,
            targetId,
            batchIndex,
            payloadBytes: utf8ByteLength(payload),
            atMs: this.now(),
          });
          if (raceResult.kind === "published") {
            activeBatch.armTimeout();
          }
        }
      });
    } catch (error) {
      if (
        activeBatch === undefined ||
        !(error instanceof UnsentLegacyMqttOperationError)
      ) {
        throw error;
      }
    }
    if (activeBatch === undefined) {
      throw new Error("MQTT batch publication completed without active state");
    }
    try {
      return await activeBatch.promise;
    } finally {
      if (this.activeBatches.get(requestId) === activeBatch) {
        this.activeBatches.delete(requestId);
      }
    }
  }

  private createActiveBatch(
    operationId: string,
    requestId: string,
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
      expectations.set(localIndex, {
        localIndex,
        originalIndex: command.originalIndex,
        command,
      });
    });

    const outcomes = new Map<number, LegacyCommandOutcome>();
    let responsesEnabled = false;
    let settled = false;
    let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
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
      if (timeoutHandle !== null) {
        clearTimeout(timeoutHandle);
        timeoutHandle = null;
      }
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
    return {
      operationId,
      requestId,
      batchIndex,
      expectations,
      outcomes,
      responsesEnabled: () => responsesEnabled,
      enableResponses: () => {
        responsesEnabled = true;
      },
      armTimeout: () => {
        if (settled || timeoutHandle !== null) {
          return;
        }
        timeoutHandle = setTimeout(
          () => settleUnknown("timeout"),
          this.responseTimeoutMs,
        );
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

  private nextRequestId(): string {
    if (this.requestSequence >= Number.MAX_SAFE_INTEGER) {
      throw new RangeError("MQTT request sequence exhausted");
    }
    this.requestSequence += 1;
    return `${this.requestSessionId}-request-${this.requestSequence}`;
  }

  /** Serialize publication without holding the lock during ESP response waits. */
  private async withPublicationLock<Result>(
    generation: number,
    task: () => Promise<Result>,
  ): Promise<Result> {
    const cancellation = this.publicationCancellationFor(generation);
    const predecessor = this.publicationTail;
    let release: () => void = () => undefined;
    this.publicationTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    this.publicationQueueDepth += 1;
    await predecessor;
    try {
      const cancelledReason = cancellation.reason();
      if (cancelledReason !== null) {
        throw publicationCancelledError(cancelledReason);
      }
      return await Promise.race([
        task(),
        cancellation.promise.then((reason) => {
          throw publicationCancelledError(reason);
        }),
      ]);
    } finally {
      this.publicationQueueDepth -= 1;
      release();
    }
  }

  private publicationCancellationFor(
    generation: number,
  ): PublicationGeneration {
    if (this.publicationGeneration.generation === generation) {
      return this.publicationGeneration;
    }
    const cancelled = createPublicationGeneration(generation);
    cancelled.cancel(this.started ? "disconnected" : "transport_stopped");
    return cancelled;
  }

  private rotatePublicationGeneration(
    reason: PublicationCancellationReason,
  ): number {
    for (const activeBatch of this.activeBatches.values()) {
      activeBatch.settleUnknown(reason);
    }
    this.publicationGeneration.cancel(reason);
    this.connectionGeneration += 1;
    this.publicationGeneration = createPublicationGeneration(
      this.connectionGeneration,
    );
    return this.connectionGeneration;
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
    this.runnableInteractiveDeviceIds.splice(0);
    this.runnableBackgroundDeviceIds.splice(0);
    this.runnablePriorityByDevice.clear();
    for (const [targetId, queue] of this.deviceQueues) {
      for (const queued of queue.splice(0)) {
        queued.reject(error);
      }
      if (!this.activeDeviceIds.has(targetId)) {
        this.deviceQueues.delete(targetId);
      }
    }
  }

  private hasQueuedOperations(): boolean {
    for (const queue of this.deviceQueues.values()) {
      if (queue.length > 0) {
        return true;
      }
    }
    return false;
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

function normalizeCommand(
  command: LegacyWireCommand,
  originalIndex: number,
): NormalizedCommand {
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
    originalIndex,
    command: `${command.target.id}${trimmed.slice(separatorIndex)}`,
    targetId: command.target.id,
    expectedResponse: normalizeExpectedResponse(command.expectedResponse),
  };
}

function partitionCommandsByDevice(
  commands: readonly NormalizedCommand[],
): readonly {
  readonly targetId: string;
  readonly commands: readonly NormalizedCommand[];
}[] {
  const commandsByDevice = new Map<string, NormalizedCommand[]>();
  for (const command of commands) {
    const deviceCommands = commandsByDevice.get(command.targetId) ?? [];
    deviceCommands.push(command);
    commandsByDevice.set(command.targetId, deviceCommands);
  }
  return [...commandsByDevice].map(([targetId, deviceCommands]) => ({
    targetId,
    commands: deviceCommands,
  }));
}

function normalizeCommandPriority(
  priority: LegacyCommandPriority | undefined,
): LegacyCommandPriority {
  if (priority === undefined) {
    return "interactive";
  }
  if (priority === "interactive" || priority === "background") {
    return priority;
  }
  throw new TypeError("Unsupported legacy command priority");
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
  commands.forEach((command) => {
    if (!outcomes.has(command.originalIndex)) {
      outcomes.set(command.originalIndex, {
        index: command.originalIndex,
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

function responseIdentity(
  value: JsonValue,
): { readonly id: string; readonly requestId: string } | null {
  if (!isJsonObject(value)) {
    return null;
  }
  const id = value["id"];
  const requestId = value["requestId"];
  return typeof id === "string" && typeof requestId === "string"
    ? { id, requestId }
    : null;
}

function isJsonObject(
  value: JsonValue,
): value is { readonly [key: string]: JsonValue } {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function normalizeRequestSessionId(value: string | undefined): string {
  const sessionId = value ?? randomBytes(8).toString("hex");
  if (
    sessionId.length < 1 ||
    sessionId.length > MAX_REQUEST_SESSION_ID_LENGTH ||
    !/^[A-Za-z0-9_-]+$/u.test(sessionId)
  ) {
    throw new TypeError(
      `requestSessionId must be 1-${MAX_REQUEST_SESSION_ID_LENGTH} wire-safe characters`,
    );
  }
  return sessionId;
}

function createPublicationGeneration(
  generation: number,
): PublicationGeneration {
  let cancelledReason: PublicationCancellationReason | null = null;
  let resolveCancellation: (
    reason: PublicationCancellationReason,
  ) => void = () => undefined;
  const promise = new Promise<PublicationCancellationReason>((resolve) => {
    resolveCancellation = resolve;
  });
  return {
    generation,
    promise,
    reason: () => cancelledReason,
    cancel: (reason) => {
      if (cancelledReason !== null) {
        return;
      }
      cancelledReason = reason;
      resolveCancellation(reason);
    },
  };
}

function publicationCancelledError(
  reason: PublicationCancellationReason,
): UnsentLegacyMqttOperationError {
  return new UnsentLegacyMqttOperationError(
    reason === "disconnected"
      ? "MQTT disconnected during command publication"
      : "MQTT transport stopped during command publication",
    reason,
  );
}

function removeArrayValue(values: string[], value: string): void {
  const index = values.indexOf(value);
  if (index >= 0) {
    values.splice(index, 1);
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
