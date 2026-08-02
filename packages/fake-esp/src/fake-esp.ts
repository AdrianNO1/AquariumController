import type { FakeEspClock } from "./clock.js";
import { SystemFakeEspClock } from "./clock.js";
import type {
  FakeEspPersistence,
  FakeEspPersistenceSnapshot,
  FakeEspLastError,
  FakeEspTimeSnapshot,
} from "./persistence.js";
import { MemoryFakeEspPersistence } from "./persistence.js";
import {
  createFakeEspTopics,
  FAKE_ESP_TEST_NAMESPACE,
  type FakeEspTopics,
  type FakeEspTransport,
} from "./transport.js";

export const FAKE_ESP_DEFAULT_NAMESPACE = FAKE_ESP_TEST_NAMESPACE;
export const FAKE_ESP_FIRMWARE_VERSION = "5.0.4";
export const FAKE_ESP_MAX_COMMAND_PAYLOAD_BYTES = 5_120;
export const FAKE_ESP_OVERRIDE_DURATION_MILLISECONDS = 120_000;

const DEFAULT_DEVICE_NAME = "ESP32_Device";
const DEFAULT_FREQUENCY = 5_000;
const DEFAULT_RESOLUTION = 8;
const MINIMUM_RESTORED_TIME = 1_735_689_600;
const MINIMUM_INT32 = -2_147_483_648;
const MAXIMUM_SYNC_TIME = 2_147_483_647;
const LEDC_SOURCE_CLOCK_HERTZ = 80_000_000;
const SCHEDULE_INTERVAL_MILLISECONDS = 1_000;
const SCHEDULE_ATTACH_RETRY_INTERVAL_MILLISECONDS = 60_000;
const OVERRIDE_CHECK_INTERVAL_MILLISECONDS = 200;
const TIME_SAVE_INTERVAL_MILLISECONDS = 3_600_000;
const PERSISTENCE_RETRY_INTERVAL_MILLISECONDS = TIME_SAVE_INTERVAL_MILLISECONDS;
const DIAGNOSTIC_SAVE_INTERVAL_MILLISECONDS = 3_600_000;
const CURRENT_SCHEDULE_BUFFER_BYTES = 4_095;
const MINIMUM_PIN = 0;
const MAXIMUM_PIN = 63;
const UINT32_MODULUS = 0x1_0000_0000;

export interface FakeEspResponseFaults {
  readonly delayMilliseconds?: number;
  readonly drop?: boolean;
  readonly dropNextResponseForCommand?: string | null;
  readonly duplicateResponses?: number;
  readonly malformed?: boolean;
}

export interface NormalizedFakeEspResponseFaults {
  readonly delayMilliseconds: number;
  readonly drop: boolean;
  readonly dropNextResponseForCommand: string | null;
  readonly duplicateResponses: number;
  readonly malformed: boolean;
}

export interface FakeEspActorOptions {
  readonly transport: FakeEspTransport;
  readonly clock?: FakeEspClock;
  readonly persistence?: FakeEspPersistence;
  readonly namespace?: string;
  readonly defaultDeviceName?: string;
  readonly firmwareVersion?: string;
  readonly idGenerator?: () => string;
  readonly responseFaults?: FakeEspResponseFaults;
  readonly pinAttachmentFailures?: readonly number[];
}

export interface FakeEspPinSnapshot {
  readonly attached: boolean;
  readonly outputValue: number;
  readonly lastManualValue: number;
  readonly overwritten: boolean;
  readonly overwriteExpiryMilliseconds?: number;
  readonly analogValue?: number;
}

export interface FakeEspPinStateSnapshot extends FakeEspPinSnapshot {
  readonly pin: number;
}

interface FirmwareLink {
  readonly sourceTime: number;
  readonly sourcePercentage: number;
  readonly targetTime: number;
  readonly targetPercentage: number;
}

interface FirmwareChannel {
  readonly pin: number;
  readonly type: number;
  readonly links: readonly FirmwareLink[];
}

interface ActiveChannel {
  readonly pin: number;
  currentValue: number;
  readonly type: number;
}

interface PinState {
  lastValue: number;
  isOverwritten: boolean;
  overwriteStartedAtMilliseconds: number;
}

interface PendingPublication {
  readonly dueAtMilliseconds: number;
  readonly payload: string;
}

interface CommandResponse {
  readonly index: number;
  readonly response: string;
}

interface RequestEnvelope {
  readonly commands: string;
  readonly requestId?: string;
}

export class FakeEspActor {
  public readonly topics: FakeEspTopics;

  private readonly transport: FakeEspTransport;
  private readonly clock: FakeEspClock;
  private readonly persistence: FakeEspPersistence;
  private readonly defaultDeviceName: string;
  private readonly firmwareVersion: string;
  private readonly idGenerator: () => string;
  private readonly attachedPins = new Set<number>();
  private readonly outputValues = new Map<number, number>();
  private readonly lastPinValues = new Map<number, number>();
  private readonly pinStates = new Map<number, PinState>();
  private readonly analogValues = new Map<number, number>();
  private readonly pinAttachmentFailures = new Set<number>();
  private readonly pendingResponses: PendingPublication[] = [];
  private unsubscribe: (() => void) | undefined;
  private connected = false;
  private deviceName = DEFAULT_DEVICE_NAME;
  private deviceId = "";
  private frequency = DEFAULT_FREQUENCY;
  private resolution = DEFAULT_RESOLUTION;
  private persistedTime: FakeEspTimeSnapshot | undefined;
  private timeInitialized = false;
  private timeBaseEpochSeconds = 0;
  private timeBaseMilliseconds = 0;
  private currentSchedule = "";
  private activeChannels: ActiveChannel[] = [];
  private readonly bootClockMilliseconds: number;
  private lastScheduleUpdateMilliseconds: number;
  private lastScheduleAttachRetryMilliseconds: number;
  private lastOverwriteCheckMilliseconds: number;
  private responseFaults: NormalizedFakeEspResponseFaults;
  private lastError: FakeEspLastError | undefined;
  private timeCheckpointPending = false;
  private timeCheckpointImmediate = false;
  private freshTimeCheckpointCommittedThisBoot = false;
  private timeCheckpointFailed = false;
  private timeCheckpointAttemptMilliseconds: number;
  private timeCheckpointSuccessMilliseconds: number;
  private diagnosticPersistenceDirty = false;
  private diagnosticPersistedThisBoot = false;
  private diagnosticPersistenceFailed = false;
  private diagnosticPersistenceAttemptMilliseconds: number;
  private diagnosticPersistenceSuccessMilliseconds: number;
  private diagnosticAnnouncementPending = false;

  public constructor(options: FakeEspActorOptions) {
    this.transport = options.transport;
    this.clock = options.clock ?? new SystemFakeEspClock();
    this.bootClockMilliseconds = this.clock.nowMilliseconds();
    const bootMilliseconds = this.firmwareMillis(this.bootClockMilliseconds);
    this.lastScheduleUpdateMilliseconds = bootMilliseconds;
    this.lastScheduleAttachRetryMilliseconds = bootMilliseconds;
    this.lastOverwriteCheckMilliseconds = bootMilliseconds;
    this.timeCheckpointAttemptMilliseconds = bootMilliseconds;
    this.timeCheckpointSuccessMilliseconds = bootMilliseconds;
    this.diagnosticPersistenceAttemptMilliseconds = bootMilliseconds;
    this.diagnosticPersistenceSuccessMilliseconds = bootMilliseconds;
    this.persistence = options.persistence ?? new MemoryFakeEspPersistence();
    this.defaultDeviceName = options.defaultDeviceName ?? DEFAULT_DEVICE_NAME;
    this.firmwareVersion = options.firmwareVersion ?? FAKE_ESP_FIRMWARE_VERSION;
    this.idGenerator = options.idGenerator ?? generateDeviceId;
    this.responseFaults = normalizeFakeEspResponseFaults(
      options.responseFaults,
    );
    for (const pin of options.pinAttachmentFailures ?? []) {
      assertInteger(pin, "Pin attachment failure");
      if (!validPin(pin)) {
        throw new RangeError("Pin attachment failure must target pin 0-63");
      }
      this.pinAttachmentFailures.add(pin);
    }

    this.topics = createFakeEspTopics(
      options.namespace ?? FAKE_ESP_DEFAULT_NAMESPACE,
    );

    this.bootFromPersistence();
  }

  public connect(): void {
    if (this.connected) {
      return;
    }
    this.connected = true;
    this.unsubscribe = this.transport.subscribe(
      this.topics.command,
      (topic, payload) => {
        this.receive(topic, payload);
      },
    );
    this.announcePresence();
  }

  public disconnect(): void {
    this.unsubscribe?.();
    this.unsubscribe = undefined;
    this.connected = false;
  }

  public reconnect(): void {
    this.disconnect();
    this.connect();
  }

  public isReady(): boolean {
    return this.connected;
  }

  public identity(): {
    readonly deviceName: string;
    readonly deviceId: string;
    readonly frequency: number;
    readonly resolution: number;
  } {
    return {
      deviceName: this.deviceName,
      deviceId: this.deviceId,
      frequency: this.frequency,
      resolution: this.resolution,
    };
  }

  public persistenceSnapshot(): FakeEspPersistenceSnapshot {
    return this.persistence.read();
  }

  public setAnalogValue(pin: number, value: number): void {
    assertInteger(pin, "Analog pin");
    assertInteger(value, "Analog value");
    this.analogValues.set(pin, value);
  }

  public pinSnapshot(pin: number): FakeEspPinSnapshot {
    assertInteger(pin, "Pin");
    const state = this.pinStates.get(pin);
    const analogValue = this.analogValues.get(pin);
    return {
      attached: this.attachedPins.has(pin),
      outputValue: this.outputValues.get(pin) ?? 0,
      lastManualValue: this.lastPinValues.get(pin) ?? 0,
      overwritten: state?.isOverwritten ?? false,
      ...(state?.isOverwritten === true
        ? {
            overwriteExpiryMilliseconds: toUint32(
              state.overwriteStartedAtMilliseconds +
                FAKE_ESP_OVERRIDE_DURATION_MILLISECONDS,
            ),
          }
        : {}),
      ...(analogValue === undefined ? {} : { analogValue }),
    };
  }

  public pinSnapshots(): readonly FakeEspPinStateSnapshot[] {
    const pins = new Set<number>([
      ...this.attachedPins,
      ...this.outputValues.keys(),
      ...this.lastPinValues.keys(),
      ...this.pinStates.keys(),
      ...this.analogValues.keys(),
    ]);
    return [...pins]
      .sort((left, right) => left - right)
      .map((pin) => ({ pin, ...this.pinSnapshot(pin) }));
  }

  public reportedFirmwareVersion(): string {
    return this.firmwareVersion;
  }

  public setResponseFaults(faults: FakeEspResponseFaults): void {
    this.responseFaults = normalizeFakeEspResponseFaults(faults);
  }

  public setPinAttachmentFailure(pin: number, failing: boolean): void {
    assertInteger(pin, "Pin attachment failure");
    if (!validPin(pin)) {
      throw new RangeError("Pin attachment failure must target pin 0-63");
    }
    if (failing) {
      this.pinAttachmentFailures.add(pin);
    } else {
      this.pinAttachmentFailures.delete(pin);
    }
  }

  public currentEpochSeconds(): number {
    if (!this.timeInitialized) {
      return 0;
    }
    return (
      this.timeBaseEpochSeconds +
      Math.floor(
        (this.clock.nowMilliseconds() - this.timeBaseMilliseconds) / 1_000,
      )
    );
  }

  public currentMinuteOfDay(): number {
    const epochSeconds = this.currentEpochSeconds();
    if (epochSeconds === 0) {
      return 0;
    }
    const date = new Date(epochSeconds * 1_000);
    return date.getUTCHours() * 60 + date.getUTCMinutes();
  }

  public runLoop(): void {
    const clockNow = this.clock.nowMilliseconds();
    const now = this.firmwareMillis(clockNow);

    this.serviceTimeCheckpoint(now, clockNow);
    this.serviceDiagnosticPersistence(now);

    if (
      uint32Elapsed(now, this.lastOverwriteCheckMilliseconds) >=
      OVERRIDE_CHECK_INTERVAL_MILLISECONDS
    ) {
      this.checkOverwriteExpiries(now);
      this.lastOverwriteCheckMilliseconds = now;
    }

    if (
      this.currentSchedule.length > 0 &&
      uint32Elapsed(now, this.lastScheduleAttachRetryMilliseconds) >=
        SCHEDULE_ATTACH_RETRY_INTERVAL_MILLISECONDS
    ) {
      this.lastScheduleAttachRetryMilliseconds = now;
      this.retryMissingSchedulePins();
    }

    if (
      this.currentSchedule.length > 0 &&
      uint32Elapsed(now, this.lastScheduleUpdateMilliseconds) >=
        SCHEDULE_INTERVAL_MILLISECONDS
    ) {
      this.lastScheduleUpdateMilliseconds = now;
      this.processScheduledOutputs();
    }

    this.flushPendingResponses(clockNow);
    if (this.diagnosticAnnouncementPending && this.connected) {
      this.announcePresence();
    }
  }

  private queueTimeCheckpoint(immediate: boolean): void {
    this.timeCheckpointPending = true;
    if (
      immediate &&
      !this.freshTimeCheckpointCommittedThisBoot &&
      !this.timeCheckpointImmediate
    ) {
      this.timeCheckpointImmediate = true;
      this.timeCheckpointFailed = false;
    }
    this.serviceTimeCheckpoint(
      this.firmwareMillis(),
      this.clock.nowMilliseconds(),
    );
  }

  private serviceTimeCheckpoint(now: number, clockNow: number): void {
    if (!this.timeInitialized) {
      return;
    }
    if (
      !this.timeCheckpointPending &&
      uint32Elapsed(now, this.timeCheckpointSuccessMilliseconds) >=
        TIME_SAVE_INTERVAL_MILLISECONDS
    ) {
      this.timeCheckpointPending = true;
    }
    if (!this.timeCheckpointPending) {
      return;
    }

    const due = this.timeCheckpointFailed
      ? uint32Elapsed(now, this.timeCheckpointAttemptMilliseconds) >=
        PERSISTENCE_RETRY_INTERVAL_MILLISECONDS
      : this.timeCheckpointImmediate &&
          !this.freshTimeCheckpointCommittedThisBoot
        ? true
        : uint32Elapsed(now, this.timeCheckpointSuccessMilliseconds) >=
          TIME_SAVE_INTERVAL_MILLISECONDS;
    if (!due) {
      return;
    }

    this.timeCheckpointAttemptMilliseconds = now;
    const checkpoint = this.currentEpochSeconds();
    if (!validRestoredEpochSeconds(checkpoint)) {
      this.timeCheckpointFailed = true;
      return;
    }
    const previousPersistedTime = this.persistedTime;
    this.persistedTime = { lastSavedEpochSeconds: checkpoint };
    try {
      this.persistEeprom();
    } catch {
      this.persistedTime = previousPersistedTime;
      this.timeCheckpointFailed = true;
      return;
    }

    this.timeBaseEpochSeconds = checkpoint;
    this.timeBaseMilliseconds = clockNow;
    const committingFreshTime = this.timeCheckpointImmediate;
    this.timeCheckpointPending = false;
    this.timeCheckpointImmediate = false;
    if (committingFreshTime) {
      this.freshTimeCheckpointCommittedThisBoot = true;
    }
    this.timeCheckpointFailed = false;
    this.timeCheckpointSuccessMilliseconds = now;
  }

  private serviceDiagnosticPersistence(now: number): void {
    if (!this.diagnosticPersistenceDirty || this.lastError === undefined) {
      return;
    }
    const due = this.diagnosticPersistenceFailed
      ? uint32Elapsed(now, this.diagnosticPersistenceAttemptMilliseconds) >=
        PERSISTENCE_RETRY_INTERVAL_MILLISECONDS
      : !this.diagnosticPersistedThisBoot
        ? true
        : uint32Elapsed(now, this.diagnosticPersistenceSuccessMilliseconds) >=
          DIAGNOSTIC_SAVE_INTERVAL_MILLISECONDS;
    if (!due) {
      return;
    }

    this.diagnosticPersistenceAttemptMilliseconds = now;
    try {
      this.persistence.writeLastError(this.lastError);
    } catch {
      this.diagnosticPersistenceFailed = true;
      return;
    }
    this.diagnosticPersistenceDirty = false;
    this.diagnosticPersistedThisBoot = true;
    this.diagnosticPersistenceFailed = false;
    this.diagnosticPersistenceSuccessMilliseconds = now;
  }

  private queueDiagnosticTransition(): void {
    this.diagnosticPersistenceDirty = true;
    this.diagnosticAnnouncementPending = true;
    this.serviceDiagnosticPersistence(this.firmwareMillis());
  }

  private bootFromPersistence(): void {
    const snapshot = this.persistence.read();
    const restoredName = sanitizePrintableAscii(snapshot.deviceName ?? "");
    this.deviceName =
      restoredName.length > 0 ? restoredName : this.defaultDeviceName;
    const restoredId = sanitizePrintableAscii(snapshot.deviceId ?? "");
    this.deviceId = restoredId.length > 0 ? restoredId : this.idGenerator();
    this.frequency = validFrequency(snapshot.frequency)
      ? snapshot.frequency
      : DEFAULT_FREQUENCY;
    this.resolution = validResolution(snapshot.resolution)
      ? snapshot.resolution
      : DEFAULT_RESOLUTION;
    if (!validPwmConfiguration(this.frequency, this.resolution)) {
      this.frequency = DEFAULT_FREQUENCY;
      this.resolution = DEFAULT_RESOLUTION;
    }
    const restoredTime =
      snapshot.time !== undefined &&
      validRestoredEpochSeconds(snapshot.time.lastSavedEpochSeconds)
        ? snapshot.time
        : undefined;
    this.persistedTime = restoredTime;
    this.lastError =
      snapshot.lastError !== undefined &&
      validFirmwareDiagnostic(snapshot.lastError)
        ? snapshot.lastError
        : undefined;
    this.persistEeprom();

    if (restoredTime !== undefined) {
      this.timeInitialized = true;
      this.timeBaseEpochSeconds = restoredTime.lastSavedEpochSeconds;
      this.timeBaseMilliseconds = this.clock.nowMilliseconds();
    }

    if (snapshot.schedule !== undefined && snapshot.schedule.length > 0) {
      this.processSchedule(snapshot.schedule, false);
    }
  }

  private receive(topic: string, message: string): void {
    if (!this.connected || topic !== this.topics.command) {
      return;
    }
    if (
      new TextEncoder().encode(message).length >
      FAKE_ESP_MAX_COMMAND_PAYLOAD_BYTES
    ) {
      return;
    }

    this.flushPendingResponses(this.clock.nowMilliseconds());
    if (message === "discover") {
      this.announcePresence();
      return;
    }
    if (message === "clear") {
      this.clearEeprom();
      this.publishResponse("EEPROM cleared");
      return;
    }
    this.processCompleteMessage(message);
  }

  private clearEeprom(): void {
    this.persistence.clearEeprom();
    this.persistedTime = undefined;
    this.deviceName = this.defaultDeviceName;
    this.deviceId = this.idGenerator();
    this.frequency = DEFAULT_FREQUENCY;
    this.resolution = DEFAULT_RESOLUTION;
    this.persistEeprom();
  }

  private announcePresence(): void {
    if (!this.connected) {
      return;
    }
    this.transport.publish(
      this.topics.announce,
      JSON.stringify({
        name: this.deviceName,
        freq: this.frequency,
        res: this.resolution,
        id: this.deviceId,
        status: "online",
        version: this.firmwareVersion,
        ...(this.lastError === undefined
          ? {}
          : { lastError: { ...this.lastError } }),
        scheduleHash: this.scheduleHash(),
      }),
    );
    this.diagnosticAnnouncementPending = false;
  }

  private scheduleHash(): string {
    if (this.currentSchedule.length === 0) {
      return "0";
    }
    const parsed = parseJson(this.currentSchedule);
    const channels = isJsonRecord(parsed) ? (parsed.c ?? null) : null;
    return djb2Hash(JSON.stringify({ c: channels })).toString();
  }

  private processCompleteMessage(message: string): void {
    const envelope = parseRequestEnvelope(message);
    if (envelope === undefined) {
      return;
    }
    const responseId = this.deviceId;
    const responseName = this.deviceName;
    const responses: CommandResponse[] = [];
    const commands = envelope.commands.split(";");
    if (envelope.commands.endsWith(";")) {
      commands.pop();
    }
    const commandNames = commands.map((command) =>
      this.commandName(command, responseId, responseName),
    );

    commands.forEach((command, index) => {
      const response = this.processCommand(command);
      if (response.length > 0) {
        responses.push({ index, response });
      }
    });

    if (responses.length > 0) {
      this.publishResponse(
        JSON.stringify({
          id: responseId,
          name: responseName,
          ...(envelope.requestId === undefined
            ? {}
            : { requestId: envelope.requestId }),
          responses,
        }),
        commandNames,
      );
    }
  }

  private processCommand(message: string): string {
    const firstSpace = message.indexOf(" ");
    if (firstSpace === -1) {
      return "";
    }
    const targetDevice = message.slice(0, firstSpace);
    if (targetDevice !== this.deviceName && targetDevice !== this.deviceId) {
      return "";
    }

    const remainder = message.slice(firstSpace + 1);
    if (remainder.startsWith("sc ")) {
      return this.handleScheduleCommand(remainder.slice(3));
    }

    const secondSpace = remainder.indexOf(" ");
    const command =
      secondSpace === -1 ? remainder : remainder.slice(0, secondSpace);
    const args = secondSpace === -1 ? "" : remainder.slice(secondSpace + 1);
    return this.handleCommand(command, args);
  }

  private handleScheduleCommand(scheduleJson: string): string {
    if (
      new TextEncoder().encode(scheduleJson).length >
      CURRENT_SCHEDULE_BUFFER_BYTES
    ) {
      return "E: Schedule too large";
    }
    const parsed = parseJson(scheduleJson);
    if (parsed === undefined) {
      return "E: Invalid JSON";
    }
    if (!validScheduleDocument(parsed)) {
      return "E: Invalid schedule";
    }
    this.processSchedule(scheduleJson, true);
    return "schedule_ok";
  }

  private handleCommand(command: string, args: string): string {
    if (command === "s") {
      return this.handleSetCommand(args);
    }
    if (command === "p") {
      return "o";
    }
    if (command === "e") {
      return this.handleEditCommand(args);
    }
    if (command === "sync") {
      const serverTime = parseSyncTime(args);
      if (serverTime !== undefined) {
        this.timeInitialized = true;
        this.timeBaseEpochSeconds = serverTime;
        this.timeBaseMilliseconds = this.clock.nowMilliseconds();
        this.queueTimeCheckpoint(true);
        return String(serverTime);
      }
      return "E: Invalid time value";
    }
    if (command === "r") {
      return this.handleReadCommand(args);
    }
    return "E: Invalid command";
  }

  private handleSetCommand(args: string): string {
    const match = /^\s*([+-]?\d+)\s+([+-]?\d+)\s+([+-]?\d+)\s*$/.exec(args);
    if (match === null) {
      return "E: Invalid arguments";
    }
    const pin = Number(match[1]);
    const value = Number(match[2]);
    const overwrite = Number(match[3]);
    if (
      !validFirmwareInteger(pin) ||
      !validFirmwareInteger(value) ||
      !validFirmwareInteger(overwrite)
    ) {
      return "E: Invalid arguments";
    }
    if (!validPin(pin)) {
      return "E: Invalid pin";
    }
    if (value < 0 || value > 255 || (overwrite !== 0 && overwrite !== 1)) {
      return "E: Invalid value or overwrite parameter";
    }

    const pwmValue = scaleNormalizedPwmValue(value, this.resolution);
    if (!this.attachedPins.has(pin) && !this.attachPin(pin, pwmValue)) {
      this.recordLastError(
        "pin_attach_failed",
        "error",
        `LEDC attach failed on pin ${pin}`,
      );
      return "E: LEDC attach failed";
    }
    this.resolveLastErrorForPin("pin_attach_failed", pin);
    this.outputValues.set(pin, pwmValue);
    this.lastPinValues.set(pin, pwmValue);
    this.pinStates.set(pin, {
      lastValue: pwmValue,
      isOverwritten: overwrite === 1,
      overwriteStartedAtMilliseconds:
        overwrite === 1 ? this.firmwareMillis() : 0,
    });
    return `s ${pin} ${value} ${overwrite}`;
  }

  private handleEditCommand(args: string): string {
    const match = /^\s*([!-~]{1,31})\s+([+-]?\d+)\s+([+-]?\d+)\s*$/.exec(args);
    if (match === null) {
      return "E: Invalid configuration";
    }
    const newName = match[1] ?? "";
    const newFrequency = Number(match[2]);
    const newResolution = Number(match[3]);
    if (
      !validFrequency(newFrequency) ||
      !validResolution(newResolution) ||
      !validPwmConfiguration(newFrequency, newResolution)
    ) {
      return "E: Invalid configuration";
    }
    const reattach =
      newFrequency !== this.frequency || newResolution !== this.resolution;
    const priorResolution = this.resolution;

    if (newName !== this.deviceName) {
      this.deviceName = newName;
    }
    this.frequency = newFrequency;
    this.resolution = newResolution;
    this.persistEeprom();

    if (reattach) {
      for (const pin of this.attachedPins) {
        const rescaledValue = rescalePwmValue(
          this.lastPinValues.get(pin) ?? 0,
          priorResolution,
          newResolution,
        );
        this.outputValues.set(pin, rescaledValue);
        this.lastPinValues.set(pin, rescaledValue);
        const state = this.pinStates.get(pin);
        if (state !== undefined) {
          state.lastValue = rescaledValue;
        }
        const channel = this.activeChannels.find(
          (candidate) => candidate.pin === pin,
        );
        if (channel !== undefined) {
          channel.currentValue = -1;
        }
      }
    }
    return `${this.deviceName} ${this.frequency} ${this.resolution}`;
  }

  private handleReadCommand(args: string): string {
    const match = /^\s*([+-]?\d+)/.exec(args);
    if (match === null) {
      return "E: Invalid arguments";
    }
    if (args.slice(match[0].length).trimStart().length > 0) {
      return "E: Metadata not supported";
    }
    const pin = Number(match[1]);
    if (!validFirmwareInteger(pin)) {
      return "E: Invalid arguments";
    }
    if (!validPin(pin)) {
      return "E: Invalid pin";
    }
    if (this.attachedPins.has(pin)) {
      return "E: Pin is configured as output";
    }
    return `r ${pin} ${this.analogValues.get(pin) ?? 0}`;
  }

  private processSchedule(schedule: string, persist: boolean): void {
    if (
      new TextEncoder().encode(schedule).length > CURRENT_SCHEDULE_BUFFER_BYTES
    ) {
      return;
    }
    const parsed = parseJson(schedule);
    if (parsed === undefined) {
      return;
    }
    if (!validScheduleDocument(parsed)) {
      return;
    }
    const channels = scheduleChannels(parsed);
    const nextPins = new Set(channels.map((channel) => channel.pin));
    for (const previousChannel of this.activeChannels) {
      if (nextPins.has(previousChannel.pin)) {
        continue;
      }
      this.outputValues.set(previousChannel.pin, 0);
      this.lastPinValues.set(previousChannel.pin, 0);
      this.attachedPins.delete(previousChannel.pin);
      this.pinStates.delete(previousChannel.pin);
    }
    if (persist) {
      this.persistence.writeSchedule(schedule);
    }
    this.currentSchedule = schedule;
    this.activeChannels = channels.map((channel) => ({
      pin: channel.pin,
      currentValue: -1,
      type: channel.type,
    }));

    const failedPins: number[] = [];
    for (const channel of channels) {
      if (this.attachedPins.has(channel.pin)) {
        continue;
      }
      if (!this.attachPin(channel.pin, 0)) {
        failedPins.push(channel.pin);
      } else {
        this.resolveLastErrorForPin("pin_attach_failed", channel.pin);
      }
    }
    this.lastScheduleAttachRetryMilliseconds = this.firmwareMillis();
    this.reportScheduleAttachFailures(failedPins);
  }

  private processScheduledOutputs(): void {
    if (!this.timeInitialized) {
      return;
    }
    const parsed = parseJson(this.currentSchedule);
    if (parsed === undefined) {
      return;
    }
    const minute = this.currentMinuteOfDay();

    for (const channel of scheduleChannels(parsed)) {
      const activeChannel = this.activeChannels.find(
        (candidate) => candidate.pin === channel.pin,
      );
      if (activeChannel === undefined || !this.attachedPins.has(channel.pin)) {
        continue;
      }
      if (this.pinStates.get(channel.pin)?.isOverwritten === true) {
        continue;
      }
      const targetValue = firmwareScheduledValue(channel.links, minute);
      if (activeChannel.currentValue !== targetValue) {
        const pwmValue = Math.trunc(
          (targetValue * pwmMaximumForResolution(this.resolution)) / 100,
        );
        this.outputValues.set(channel.pin, pwmValue);
        this.lastPinValues.set(channel.pin, pwmValue);
        const state = this.pinStates.get(channel.pin);
        if (state !== undefined) {
          state.lastValue = pwmValue;
        }
        activeChannel.currentValue = targetValue;
      }
    }
  }

  private retryMissingSchedulePins(): void {
    const failedPins: number[] = [];
    for (const channel of this.activeChannels) {
      if (this.attachedPins.has(channel.pin)) {
        continue;
      }
      if (!this.attachPin(channel.pin, 0)) {
        failedPins.push(channel.pin);
      } else {
        this.resolveLastErrorForPin("pin_attach_failed", channel.pin);
      }
    }
    this.reportScheduleAttachFailures(failedPins);
  }

  private reportScheduleAttachFailures(failedPins: readonly number[]): void {
    if (failedPins.length === 0) {
      return;
    }
    this.recordLastError(
      "pin_attach_failed",
      "error",
      `LEDC attach failed on pin ${failedPins[0] ?? -1}`,
    );
  }

  private recordLastError(
    code: string,
    severity: "warning" | "error",
    message: string,
  ): void {
    const boundedMessage = message.slice(0, 160);
    if (!/^[a-z0-9_]{1,48}$/u.test(code) || boundedMessage.length === 0) {
      return;
    }
    if (
      this.lastError?.code === code &&
      this.lastError.severity === severity &&
      this.lastError.message === boundedMessage &&
      this.lastError.active
    ) {
      return;
    }
    const sequence =
      this.lastError?.sequence === 0xffff_ffff
        ? 1
        : (this.lastError?.sequence ?? 0) + 1;
    this.lastError = {
      code,
      severity,
      message: boundedMessage,
      sequence,
      active: true,
      at: Math.min(this.currentEpochSeconds(), MAXIMUM_SYNC_TIME),
    };
    this.queueDiagnosticTransition();
  }

  private resolveLastError(code: string): void {
    if (this.lastError?.code !== code || !this.lastError.active) {
      return;
    }
    this.lastError = {
      ...this.lastError,
      sequence:
        this.lastError.sequence === 0xffff_ffff
          ? 1
          : this.lastError.sequence + 1,
      active: false,
    };
    this.queueDiagnosticTransition();
  }

  private resolveLastErrorForPin(code: "pin_attach_failed", pin: number): void {
    if (
      this.lastError?.code === code &&
      this.lastError.message === `LEDC attach failed on pin ${pin}`
    ) {
      this.resolveLastError(code);
    }
  }

  private checkOverwriteExpiries(now: number): void {
    for (const [pin, state] of this.pinStates) {
      if (
        !state.isOverwritten ||
        uint32Elapsed(now, state.overwriteStartedAtMilliseconds) <
          FAKE_ESP_OVERRIDE_DURATION_MILLISECONDS
      ) {
        continue;
      }
      state.isOverwritten = false;
      const controlledBySchedule =
        this.currentSchedule.length > 0 &&
        this.activeChannels.some((channel) => channel.pin === pin);
      if (!controlledBySchedule || !this.timeInitialized) {
        this.outputValues.set(pin, 0);
        this.lastPinValues.set(pin, 0);
        state.lastValue = 0;
      } else {
        const channel = this.activeChannels.find(
          (candidate) => candidate.pin === pin,
        );
        if (channel !== undefined) {
          channel.currentValue = -1;
        }
      }
    }
  }

  private attachPin(pin: number, value: number): boolean {
    if (this.pinAttachmentFailures.has(pin)) {
      return false;
    }
    this.attachedPins.add(pin);
    this.outputValues.set(pin, value);
    if (!this.lastPinValues.has(pin)) {
      this.lastPinValues.set(pin, 0);
    }
    return true;
  }

  private publishResponse(
    payload: string,
    commandNames: readonly (string | null)[] = [],
  ): void {
    if (this.responseFaults.drop) {
      return;
    }
    const dropCommand = this.responseFaults.dropNextResponseForCommand;
    if (dropCommand !== null && commandNames.includes(dropCommand)) {
      this.responseFaults = {
        ...this.responseFaults,
        dropNextResponseForCommand: null,
      };
      return;
    }
    const publishedPayload = this.responseFaults.malformed ? "{" : payload;
    const publicationCount = 1 + this.responseFaults.duplicateResponses;
    const dueAtMilliseconds =
      this.clock.nowMilliseconds() + this.responseFaults.delayMilliseconds;
    for (let index = 0; index < publicationCount; index += 1) {
      if (this.responseFaults.delayMilliseconds === 0) {
        if (this.connected) {
          this.transport.publish(this.topics.response, publishedPayload);
        }
      } else {
        this.pendingResponses.push({
          dueAtMilliseconds,
          payload: publishedPayload,
        });
      }
    }
  }

  private commandName(
    message: string,
    deviceId: string,
    deviceName: string,
  ): string | null {
    const firstSpace = message.indexOf(" ");
    if (firstSpace === -1) {
      return null;
    }
    const targetDevice = message.slice(0, firstSpace);
    if (targetDevice !== deviceName && targetDevice !== deviceId) {
      return null;
    }
    const remainder = message.slice(firstSpace + 1);
    const secondSpace = remainder.indexOf(" ");
    return secondSpace === -1 ? remainder : remainder.slice(0, secondSpace);
  }

  private flushPendingResponses(now: number): void {
    if (!this.connected) {
      return;
    }
    const remaining: PendingPublication[] = [];
    for (const publication of this.pendingResponses) {
      if (publication.dueAtMilliseconds <= now) {
        this.transport.publish(this.topics.response, publication.payload);
      } else {
        remaining.push(publication);
      }
    }
    this.pendingResponses.length = 0;
    this.pendingResponses.push(...remaining);
  }

  private persistEeprom(): void {
    this.persistence.writeEeprom({
      deviceName: this.deviceName,
      deviceId: this.deviceId,
      frequency: this.frequency,
      resolution: this.resolution,
      ...(this.persistedTime === undefined ? {} : { time: this.persistedTime }),
    });
  }

  private firmwareMillis(
    clockMilliseconds = this.clock.nowMilliseconds(),
  ): number {
    return toUint32(clockMilliseconds - this.bootClockMilliseconds + 1);
  }
}

export function normalizeFakeEspResponseFaults(
  faults: FakeEspResponseFaults = {},
): NormalizedFakeEspResponseFaults {
  const delayMilliseconds = faults.delayMilliseconds ?? 0;
  const duplicateResponses = faults.duplicateResponses ?? 0;
  const dropNextResponseForCommand = faults.dropNextResponseForCommand ?? null;
  if (!Number.isSafeInteger(delayMilliseconds) || delayMilliseconds < 0) {
    throw new RangeError(
      "Response delay must be a non-negative integer millisecond value",
    );
  }
  if (!Number.isSafeInteger(duplicateResponses) || duplicateResponses < 0) {
    throw new RangeError(
      "Duplicate response count must be a non-negative integer",
    );
  }
  if (
    dropNextResponseForCommand !== null &&
    !/^[a-z]{1,16}$/u.test(dropNextResponseForCommand)
  ) {
    throw new RangeError(
      "One-shot response fault command must contain 1-16 lowercase letters",
    );
  }
  return {
    delayMilliseconds,
    drop: faults.drop ?? false,
    dropNextResponseForCommand,
    duplicateResponses,
    malformed: faults.malformed ?? false,
  };
}

function generateDeviceId(): string {
  let id = "";
  for (let index = 0; index < 8; index += 1) {
    id += Math.floor(Math.random() * 16)
      .toString(16)
      .toUpperCase();
  }
  return id;
}

function sanitizePrintableAscii(value: string): string {
  return [...value]
    .filter((character) => {
      const code = character.charCodeAt(0);
      return code >= 32 && code <= 126;
    })
    .join("");
}

function validFrequency(value: number | undefined): value is number {
  return (
    value !== undefined &&
    Number.isInteger(value) &&
    value > 0 &&
    value <= 40_000
  );
}

function validResolution(value: number | undefined): value is number {
  return (
    value !== undefined && Number.isInteger(value) && value >= 1 && value <= 16
  );
}

function validRestoredEpochSeconds(value: number): boolean {
  return (
    Number.isSafeInteger(value) &&
    value >= MINIMUM_RESTORED_TIME &&
    value <= MAXIMUM_SYNC_TIME &&
    !Number.isNaN(new Date(value * 1_000).getTime())
  );
}

function validFirmwareDiagnostic(value: FakeEspLastError): boolean {
  return (
    /^[a-z0-9_]{1,48}$/u.test(value.code) &&
    (value.severity === "warning" || value.severity === "error") &&
    value.message.length >= 1 &&
    value.message.length <= 160 &&
    Number.isSafeInteger(value.sequence) &&
    value.sequence >= 1 &&
    value.sequence <= 0xffff_ffff &&
    typeof value.active === "boolean" &&
    Number.isSafeInteger(value.at) &&
    value.at >= 0 &&
    value.at <= MAXIMUM_SYNC_TIME
  );
}

function validPin(value: number): boolean {
  return (
    Number.isInteger(value) && value >= MINIMUM_PIN && value <= MAXIMUM_PIN
  );
}

function validFirmwareInteger(value: number): boolean {
  return (
    Number.isInteger(value) &&
    value >= MINIMUM_INT32 &&
    value <= MAXIMUM_SYNC_TIME
  );
}

function validPwmConfiguration(frequency: number, resolution: number): boolean {
  return frequency * 2 ** resolution <= LEDC_SOURCE_CLOCK_HERTZ;
}

function pwmMaximumForResolution(resolution: number): number {
  return 2 ** resolution - 1;
}

function rescalePwmValue(
  value: number,
  sourceResolution: number,
  targetResolution: number,
): number {
  return Math.trunc(
    (value * pwmMaximumForResolution(targetResolution)) /
      pwmMaximumForResolution(sourceResolution),
  );
}

function scaleNormalizedPwmValue(
  value: number,
  targetResolution: number,
): number {
  return rescalePwmValue(value, 8, targetResolution);
}

function parseSyncTime(value: string): number | undefined {
  if (!/^\d+$/.test(value)) {
    return undefined;
  }
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) &&
    parsed >= MINIMUM_RESTORED_TIME &&
    parsed <= MAXIMUM_SYNC_TIME
    ? parsed
    : undefined;
}

function parseRequestEnvelope(message: string): RequestEnvelope | undefined {
  if (!message.startsWith("request:")) {
    return { commands: message };
  }
  const separator = message.indexOf("|", 8);
  if (separator === -1) {
    return undefined;
  }
  const requestId = message.slice(8, separator);
  const commands = message.slice(separator + 1);
  if (
    requestId.length > 64 ||
    !/^[A-Za-z0-9_-]+$/u.test(requestId) ||
    commands.length === 0
  ) {
    return undefined;
  }
  return { commands, requestId };
}

function validScheduleDocument(schedule: unknown): boolean {
  if (
    !isJsonRecord(schedule) ||
    !Array.isArray(schedule.c) ||
    typeof schedule.syncTime !== "number" ||
    !Number.isSafeInteger(schedule.syncTime) ||
    schedule.syncTime < 1 ||
    schedule.syncTime > MAXIMUM_SYNC_TIME
  ) {
    return false;
  }
  if (schedule.c.length > MAXIMUM_PIN + 1) {
    return false;
  }
  const seenPins = new Set<number>();
  for (const rawChannel of schedule.c) {
    if (
      !isJsonRecord(rawChannel) ||
      typeof rawChannel.o !== "number" ||
      !validPin(rawChannel.o) ||
      (rawChannel.t !== 108 && rawChannel.t !== 112) ||
      !Array.isArray(rawChannel.l) ||
      seenPins.has(rawChannel.o)
    ) {
      return false;
    }
    for (const rawLink of rawChannel.l) {
      if (
        !isJsonRecord(rawLink) ||
        !validSchedulePoint(rawLink.s) ||
        !validSchedulePoint(rawLink.d)
      ) {
        return false;
      }
    }
    seenPins.add(rawChannel.o);
  }
  return true;
}

function validSchedulePoint(value: unknown): boolean {
  return (
    isJsonRecord(value) &&
    typeof value.t === "number" &&
    Number.isInteger(value.t) &&
    value.t >= 0 &&
    value.t <= 1_439 &&
    typeof value.p === "number" &&
    Number.isInteger(value.p) &&
    value.p >= 0 &&
    value.p <= 100
  );
}

function assertInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value)) {
    throw new TypeError(`${label} must be an integer`);
  }
}

function arduinoToInteger(value: string): number {
  const match = /^\s*([+-]?\d+)/.exec(value);
  return match === null ? 0 : Number(match[1]);
}

function parseJson(value: string): unknown | undefined {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return undefined;
  }
}

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function firmwareInteger(value: unknown): number {
  if (typeof value === "number" && Number.isFinite(value)) {
    return Math.trunc(value);
  }
  if (typeof value === "string") {
    return arduinoToInteger(value);
  }
  if (typeof value === "boolean") {
    return value ? 1 : 0;
  }
  return 0;
}

function scheduleChannels(schedule: unknown): readonly FirmwareChannel[] {
  if (!isJsonRecord(schedule) || !Array.isArray(schedule.c)) {
    return [];
  }
  return schedule.c.map((rawChannel) => {
    const channel = isJsonRecord(rawChannel) ? rawChannel : {};
    const rawLinks = Array.isArray(channel.l) ? channel.l : [];
    return {
      pin: firmwareInteger(channel.o),
      type: firmwareInteger(channel.t),
      links: rawLinks.map((rawLink) => {
        const link = isJsonRecord(rawLink) ? rawLink : {};
        const source = isJsonRecord(link.s) ? link.s : {};
        const target = isJsonRecord(link.d) ? link.d : {};
        return {
          sourceTime: firmwareInteger(source.t),
          sourcePercentage: firmwareInteger(source.p),
          targetTime: firmwareInteger(target.t),
          targetPercentage: firmwareInteger(target.p),
        };
      }),
    };
  });
}

function firmwareScheduledValue(
  links: readonly FirmwareLink[],
  minute: number,
): number {
  for (const link of links) {
    if (minute >= link.sourceTime && minute <= link.targetTime) {
      if (link.targetTime === link.sourceTime) {
        return link.sourcePercentage;
      }
      // The deployed sketch stores progress as a 32-bit C++ float. Preserve
      // the intermediate rounding before the final truncating int conversion.
      const progress = Math.fround(
        (minute - link.sourceTime) / (link.targetTime - link.sourceTime),
      );
      const delta = Math.fround(
        (link.targetPercentage - link.sourcePercentage) * progress,
      );
      return Math.trunc(Math.fround(link.sourcePercentage + delta));
    }
  }
  return 0;
}

function djb2Hash(value: string): number {
  let hash = 5_381;
  for (const byte of new TextEncoder().encode(value)) {
    hash = (Math.imul(hash, 33) + byte) >>> 0;
  }
  return hash;
}

function toUint32(value: number): number {
  const remainder = value % UINT32_MODULUS;
  return remainder < 0 ? remainder + UINT32_MODULUS : remainder;
}

function uint32Elapsed(now: number, previous: number): number {
  return toUint32(now - previous);
}
