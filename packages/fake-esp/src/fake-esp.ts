import type { FakeEspClock } from "./clock.js";
import { SystemFakeEspClock } from "./clock.js";
import type {
  FakeEspPersistence,
  FakeEspPersistenceSnapshot,
  FakeEspTimeSnapshot,
} from "./persistence.js";
import { MemoryFakeEspPersistence } from "./persistence.js";
import type { FakeEspTransport } from "./transport.js";

export const FAKE_ESP_DEFAULT_NAMESPACE = "test/aquarium";
export const FAKE_ESP_FIRMWARE_VERSION = "3.2w";
export const FAKE_ESP_CHUNK_DATA_BYTES = 200;
export const FAKE_ESP_MAX_CHUNKS = 50;
export const FAKE_ESP_CHUNK_TIMEOUT_MILLISECONDS = 10_000;
export const FAKE_ESP_OVERRIDE_DURATION_MILLISECONDS = 120_000;

const DEFAULT_DEVICE_NAME = "ESP32_Device";
const DEFAULT_FREQUENCY = 5_000;
const DEFAULT_RESOLUTION = 8;
const MINIMUM_RESTORED_TIME = 1_735_689_600;
const SCHEDULE_INTERVAL_MILLISECONDS = 1_000;
const OVERRIDE_CHECK_INTERVAL_MILLISECONDS = 200;
const TIME_SAVE_INTERVAL_MILLISECONDS = 3_600_000;
const CURRENT_SCHEDULE_BUFFER_BYTES = 4_095;

export interface FakeEspTopics {
  readonly command: string;
  readonly announce: string;
  readonly response: string;
}

export interface FakeEspResponseFaults {
  readonly delayMilliseconds?: number;
  readonly drop?: boolean;
  readonly duplicateResponses?: number;
  readonly malformed?: boolean;
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
}

export interface FakeEspPinSnapshot {
  readonly attached: boolean;
  readonly outputValue: number;
  readonly lastManualValue: number;
  readonly overwritten: boolean;
  readonly overwriteExpiryMilliseconds?: number;
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
  overwriteExpiryMilliseconds: number;
}

interface ChunkAssembly {
  readonly chunks: Array<string | undefined>;
  totalChunks: number;
  lastChunkTimeMilliseconds: number;
  complete: boolean;
}

interface PendingPublication {
  readonly dueAtMilliseconds: number;
  readonly payload: string;
}

interface CommandResponse {
  readonly index: number;
  readonly response: string;
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
  private readonly pendingResponses: PendingPublication[] = [];
  private readonly chunkAssembly: ChunkAssembly = {
    chunks: Array.from<string | undefined>({ length: FAKE_ESP_MAX_CHUNKS }),
    totalChunks: 0,
    lastChunkTimeMilliseconds: 0,
    complete: false,
  };

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
  private lastScheduleUpdateMilliseconds = 0;
  private lastOverwriteCheckMilliseconds = 0;
  private lastTimeSaveMilliseconds = 0;
  private responseFaults: Required<FakeEspResponseFaults>;

  public constructor(options: FakeEspActorOptions) {
    this.transport = options.transport;
    this.clock = options.clock ?? new SystemFakeEspClock();
    this.persistence = options.persistence ?? new MemoryFakeEspPersistence();
    this.defaultDeviceName = options.defaultDeviceName ?? DEFAULT_DEVICE_NAME;
    this.firmwareVersion = options.firmwareVersion ?? FAKE_ESP_FIRMWARE_VERSION;
    this.idGenerator = options.idGenerator ?? generateDeviceId;
    this.responseFaults = normalizeResponseFaults(options.responseFaults);

    const namespace = options.namespace ?? FAKE_ESP_DEFAULT_NAMESPACE;
    assertTestNamespace(namespace);
    this.topics = {
      command: `${namespace}/command`,
      announce: `${namespace}/announce`,
      response: `${namespace}/response`,
    };

    this.bootFromPersistence();
  }

  public connect(): void {
    if (this.connected) {
      return;
    }
    this.connected = true;
    this.unsubscribe = this.transport.subscribe(this.topics.command, (topic, payload) => {
      this.receive(topic, payload);
    });
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
    return {
      attached: this.attachedPins.has(pin),
      outputValue: this.outputValues.get(pin) ?? 0,
      lastManualValue: this.lastPinValues.get(pin) ?? 0,
      overwritten: state?.isOverwritten ?? false,
      ...(state?.isOverwritten === true
        ? { overwriteExpiryMilliseconds: state.overwriteExpiryMilliseconds }
        : {}),
    };
  }

  public setResponseFaults(faults: FakeEspResponseFaults): void {
    this.responseFaults = normalizeResponseFaults(faults);
  }

  public currentEpochSeconds(): number {
    if (!this.timeInitialized) {
      return 0;
    }
    return (
      this.timeBaseEpochSeconds +
      Math.floor((this.clock.nowMilliseconds() - this.timeBaseMilliseconds) / 1_000)
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
    const now = this.clock.nowMilliseconds();
    this.checkChunkTimeout(now);

    if (
      this.timeInitialized &&
      now - this.lastTimeSaveMilliseconds > TIME_SAVE_INTERVAL_MILLISECONDS
    ) {
      this.persistedTime = { lastSavedEpochSeconds: this.currentEpochSeconds() };
      this.timeBaseEpochSeconds = this.persistedTime.lastSavedEpochSeconds;
      this.timeBaseMilliseconds = now;
      this.persistEeprom();
      this.lastTimeSaveMilliseconds = now;
    }

    if (now - this.lastOverwriteCheckMilliseconds >= OVERRIDE_CHECK_INTERVAL_MILLISECONDS) {
      this.checkOverwriteExpiries(now);
      this.lastOverwriteCheckMilliseconds = now;
    }

    if (
      this.currentSchedule.length > 0 &&
      now - this.lastScheduleUpdateMilliseconds >= SCHEDULE_INTERVAL_MILLISECONDS
    ) {
      this.lastScheduleUpdateMilliseconds = now;
      this.processScheduledOutputs();
    }

    this.flushPendingResponses(now);
  }

  private bootFromPersistence(): void {
    const snapshot = this.persistence.read();
    const restoredName = sanitizePrintableAscii(snapshot.deviceName ?? "");
    this.deviceName = restoredName.length > 0 ? restoredName : this.defaultDeviceName;
    const restoredId = sanitizePrintableAscii(snapshot.deviceId ?? "");
    this.deviceId = restoredId.length > 0 ? restoredId : this.idGenerator();
    this.frequency = validFrequency(snapshot.frequency) ? snapshot.frequency : DEFAULT_FREQUENCY;
    this.resolution = validResolution(snapshot.resolution)
      ? snapshot.resolution
      : DEFAULT_RESOLUTION;
    this.persistedTime = snapshot.time;
    this.persistEeprom();

    if (
      snapshot.time !== undefined &&
      snapshot.time.lastSavedEpochSeconds >= MINIMUM_RESTORED_TIME
    ) {
      this.timeInitialized = true;
      this.timeBaseEpochSeconds = snapshot.time.lastSavedEpochSeconds;
      this.timeBaseMilliseconds = this.clock.nowMilliseconds();
    }

    if (snapshot.schedule !== undefined && snapshot.schedule.length > 0) {
      this.processSchedule(snapshot.schedule);
    }
  }

  private receive(topic: string, message: string): void {
    if (!this.connected || topic !== this.topics.command) {
      return;
    }

    this.flushPendingResponses(this.clock.nowMilliseconds());
    if (message.startsWith("chunk:")) {
      this.handleChunk(message.slice(6));
      return;
    }
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
        scheduleHash: this.scheduleHash(),
      }),
    );
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
    const responseId = this.deviceId;
    const responseName = this.deviceName;
    const responses: CommandResponse[] = [];
    const commands = message.split(";");
    if (message.endsWith(";")) {
      commands.pop();
    }

    commands.forEach((command, index) => {
      const response = this.processCommand(command);
      if (response.length > 0) {
        responses.push({ index, response });
      }
    });

    if (responses.length > 0) {
      this.publishResponse(JSON.stringify({ id: responseId, name: responseName, responses }));
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
    const command = secondSpace === -1 ? remainder : remainder.slice(0, secondSpace);
    const args = secondSpace === -1 ? "" : remainder.slice(secondSpace + 1);
    return this.handleCommand(command, args);
  }

  private handleScheduleCommand(scheduleJson: string): string {
    if (parseJson(scheduleJson) === undefined) {
      return "E: Invalid JSON";
    }
    this.processSchedule(scheduleJson);
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
      const serverTime = arduinoToInteger(args);
      if (serverTime > 0) {
        this.timeInitialized = true;
        this.timeBaseEpochSeconds = serverTime;
        this.timeBaseMilliseconds = this.clock.nowMilliseconds();
        this.persistedTime = { lastSavedEpochSeconds: serverTime };
        this.persistEeprom();
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
    const match = /^\s*([+-]?\d+)\s+([+-]?\d+)\s+([+-]?\d+)/.exec(args);
    if (match === null) {
      return "E: Invalid arguments";
    }
    const pin = Number(match[1]);
    const value = Number(match[2]);
    const overwrite = Number(match[3]);
    if (value < 0 || value > 255 || (overwrite !== 0 && overwrite !== 1)) {
      return "E: Invalid value or overwrite parameter";
    }

    this.attachPin(pin, value);
    this.lastPinValues.set(pin, value);
    this.pinStates.set(pin, {
      lastValue: value,
      isOverwritten: overwrite === 1,
      overwriteExpiryMilliseconds:
        overwrite === 1
          ? this.clock.nowMilliseconds() + FAKE_ESP_OVERRIDE_DURATION_MILLISECONDS
          : 0,
    });
    return `s ${pin} ${value} ${overwrite}`;
  }

  private handleEditCommand(args: string): string {
    const values = args.split(" ").slice(0, 4);
    const newName = values[0] ?? "";
    const newFrequency = arduinoToInteger(values[1] ?? "");
    const newResolution = arduinoToInteger(values[2] ?? "");
    let reattach = false;

    if (newName !== this.deviceName) {
      this.deviceName = sanitizePrintableAscii(newName);
    }
    if (newFrequency !== this.frequency && newFrequency !== 0) {
      this.frequency = newFrequency;
      reattach = true;
    }
    if (
      newResolution !== this.resolution &&
      newResolution >= 1 &&
      newResolution <= 16
    ) {
      this.resolution = newResolution;
      reattach = true;
    }
    this.persistEeprom();

    if (reattach) {
      for (const pin of this.attachedPins) {
        this.outputValues.set(pin, this.lastPinValues.get(pin) ?? 0);
      }
    }
    return `${this.deviceName} ${this.frequency} ${this.resolution}`;
  }

  private handleReadCommand(args: string): string {
    const match = /^\s*([+-]?\d+)(?:\s+(\S+))?\s*$/.exec(args);
    if (match === null) {
      return "E: Invalid arguments";
    }
    if (match[2] !== undefined) {
      return "E: Metadata not supported";
    }
    const pin = Number(match[1]);
    return `r ${pin} ${this.analogValues.get(pin) ?? 0}`;
  }

  private processSchedule(schedule: string): void {
    const parsed = parseJson(schedule);
    if (parsed === undefined) {
      return;
    }
    this.persistence.writeSchedule(schedule);
    this.currentSchedule = truncateUtf8(schedule, CURRENT_SCHEDULE_BUFFER_BYTES);
    this.activeChannels = scheduleChannels(parsed).map((channel) => ({
      pin: channel.pin,
      currentValue: 0,
      type: channel.type,
    }));

    for (const channel of scheduleChannels(parsed)) {
      if (!this.attachedPins.has(channel.pin)) {
        this.attachPin(channel.pin, 0);
      }
    }
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
      const activeChannel = this.activeChannels.find((candidate) => candidate.pin === channel.pin);
      if (activeChannel === undefined) {
        continue;
      }
      if (this.pinStates.get(channel.pin)?.isOverwritten === true) {
        continue;
      }
      const targetValue = firmwareScheduledValue(channel.links, minute);
      if (activeChannel.currentValue !== targetValue) {
        const pwmValue = Math.trunc(
          (targetValue * ((1 << this.resolution) - 1)) / 100,
        );
        this.outputValues.set(channel.pin, pwmValue);
        activeChannel.currentValue = targetValue;
      }
    }
  }

  private checkOverwriteExpiries(now: number): void {
    for (const [pin, state] of this.pinStates) {
      if (!state.isOverwritten || now < state.overwriteExpiryMilliseconds) {
        continue;
      }
      state.isOverwritten = false;
      const controlledBySchedule =
        this.currentSchedule.length > 0 &&
        this.activeChannels.some((channel) => channel.pin === pin);
      if (!controlledBySchedule) {
        this.outputValues.set(pin, 0);
        this.lastPinValues.set(pin, 0);
        state.lastValue = 0;
      }
    }
  }

  private attachPin(pin: number, value: number): void {
    this.attachedPins.add(pin);
    this.outputValues.set(pin, value);
    if (!this.lastPinValues.has(pin)) {
      this.lastPinValues.set(pin, 0);
    }
  }

  private handleChunk(chunkData: string): void {
    const firstColon = chunkData.indexOf(":");
    const secondColon = chunkData.indexOf(":", firstColon + 1);
    const thirdColon = chunkData.indexOf(":", secondColon + 1);
    if (firstColon === -1 || secondColon === -1 || thirdColon === -1) {
      return;
    }

    const chunkIndex = arduinoToInteger(chunkData.slice(0, firstColon));
    const totalChunks = arduinoToInteger(chunkData.slice(firstColon + 1, secondColon));
    const data = chunkData.slice(thirdColon + 1);
    if (
      chunkIndex < 0 ||
      chunkIndex >= FAKE_ESP_MAX_CHUNKS ||
      totalChunks < 1 ||
      totalChunks > FAKE_ESP_MAX_CHUNKS ||
      chunkIndex >= totalChunks
    ) {
      return;
    }

    const now = this.clock.nowMilliseconds();
    if (
      chunkIndex === 0 ||
      this.chunkAssembly.lastChunkTimeMilliseconds === 0 ||
      now - this.chunkAssembly.lastChunkTimeMilliseconds >
        FAKE_ESP_CHUNK_TIMEOUT_MILLISECONDS
    ) {
      this.resetChunkAssembly(false);
      this.chunkAssembly.totalChunks = totalChunks;
      this.chunkAssembly.lastChunkTimeMilliseconds = now;
    }

    this.chunkAssembly.chunks[chunkIndex] = truncateUtf8(data, FAKE_ESP_CHUNK_DATA_BYTES);
    this.chunkAssembly.lastChunkTimeMilliseconds = now;
    const allReceived = Array.from({ length: totalChunks }, (_, index) =>
      this.chunkAssembly.chunks[index] !== undefined,
    ).every(Boolean);
    if (!allReceived) {
      return;
    }

    const completeMessage = this.chunkAssembly.chunks
      .slice(0, totalChunks)
      .map((chunk) => chunk ?? "")
      .join("");
    this.processCompleteMessage(completeMessage);
    this.resetChunkAssembly(true);
  }

  private checkChunkTimeout(now: number): void {
    if (
      !this.chunkAssembly.complete &&
      this.chunkAssembly.lastChunkTimeMilliseconds > 0 &&
      now - this.chunkAssembly.lastChunkTimeMilliseconds >
        FAKE_ESP_CHUNK_TIMEOUT_MILLISECONDS
    ) {
      this.resetChunkAssembly(false);
    }
  }

  private resetChunkAssembly(complete: boolean): void {
    this.chunkAssembly.chunks.fill(undefined);
    this.chunkAssembly.totalChunks = 0;
    this.chunkAssembly.complete = complete;
    this.chunkAssembly.lastChunkTimeMilliseconds = 0;
  }

  private publishResponse(payload: string): void {
    if (this.responseFaults.drop) {
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
        this.pendingResponses.push({ dueAtMilliseconds, payload: publishedPayload });
      }
    }
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
}

function assertTestNamespace(namespace: string): void {
  if (
    namespace.length === 0 ||
    namespace.endsWith("/") ||
    (namespace !== FAKE_ESP_DEFAULT_NAMESPACE &&
      !namespace.startsWith(`${FAKE_ESP_DEFAULT_NAMESPACE}/`))
  ) {
    throw new Error(
      `Fake ESP actors are restricted to ${FAKE_ESP_DEFAULT_NAMESPACE} test namespaces`,
    );
  }
}

function normalizeResponseFaults(
  faults: FakeEspResponseFaults = {},
): Required<FakeEspResponseFaults> {
  const delayMilliseconds = faults.delayMilliseconds ?? 0;
  const duplicateResponses = faults.duplicateResponses ?? 0;
  if (!Number.isSafeInteger(delayMilliseconds) || delayMilliseconds < 0) {
    throw new RangeError("Response delay must be a non-negative integer millisecond value");
  }
  if (!Number.isSafeInteger(duplicateResponses) || duplicateResponses < 0) {
    throw new RangeError("Duplicate response count must be a non-negative integer");
  }
  return {
    delayMilliseconds,
    drop: faults.drop ?? false,
    duplicateResponses,
    malformed: faults.malformed ?? false,
  };
}

function generateDeviceId(): string {
  let id = "";
  for (let index = 0; index < 8; index += 1) {
    id += Math.floor(Math.random() * 16).toString(16).toUpperCase();
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
  return value !== undefined && Number.isInteger(value) && value > 0 && value <= 40_000;
}

function validResolution(value: number | undefined): value is number {
  return value !== undefined && Number.isInteger(value) && value >= 1 && value <= 16;
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

function firmwareScheduledValue(links: readonly FirmwareLink[], minute: number): number {
  for (const link of links) {
    if (minute >= link.sourceTime && minute <= link.targetTime) {
      if (link.targetTime === link.sourceTime) {
        return link.sourcePercentage;
      }
      const progress = (minute - link.sourceTime) / (link.targetTime - link.sourceTime);
      return Math.trunc(
        link.sourcePercentage +
          (link.targetPercentage - link.sourcePercentage) * progress,
      );
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

function truncateUtf8(value: string, maximumBytes: number): string {
  const bytes = new TextEncoder().encode(value);
  if (bytes.length <= maximumBytes) {
    return value;
  }
  return new TextDecoder().decode(bytes.slice(0, maximumBytes));
}
