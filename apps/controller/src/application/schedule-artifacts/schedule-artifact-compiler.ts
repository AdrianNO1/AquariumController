import {
  boundedTextSchema,
  canonicalUint32HashSchema,
  hardwareProfileIdSchema,
  identifierSchema,
  isAllowedPwmPin,
  nonnegativeSafeIntegerSchema,
} from "@aquarium/contracts";
import {
  compileFirmwareSchedule,
  scheduleGraphFromPoints,
  validateScheduleGraph,
  type FirmwareChannelKind,
  type ValidatedScheduleGraph,
} from "@aquarium/domain";
import {
  LEGACY_LIGHT_CHANNEL_TYPE,
  LEGACY_MAX_SYNC_TIME,
  LEGACY_PUMP_CHANNEL_TYPE,
  calculateLegacyScheduleHash,
  serializeLegacyScheduleCore,
  serializeLegacyScheduleDocument,
  utf8ByteLength,
  type LegacyScheduleCore,
} from "@aquarium/esp-protocol";

import {
  DEVICE_SCHEDULE_ARTIFACT_SCHEMA_VERSION,
  type CompiledDeviceScheduleArtifact,
  type DeviceScheduleProjection,
  type NormalizedScheduleChannelProjection,
} from "./types.js";

export class ScheduleArtifactCompilationError extends Error {
  override readonly name = "ScheduleArtifactCompilationError";

  constructor(
    readonly code:
      | "invalid_projection"
      | "invalid_schedule_graph"
      | "invalid_mapping"
      | "schedule_capacity",
    message: string,
  ) {
    super(message);
  }
}

export interface CompiledScheduleArtifactWithCore extends CompiledDeviceScheduleArtifact {
  readonly core: LegacyScheduleCore;
}

export function compileDeviceScheduleArtifact(
  projection: DeviceScheduleProjection,
): CompiledScheduleArtifactWithCore {
  identifierSchema.parse(projection.deviceId);
  nonnegativeSafeIntegerSchema.parse(projection.sourceStateRevision);
  if (projection.firmwareVersion !== null) {
    boundedTextSchema.parse(projection.firmwareVersion);
  }
  if (projection.reportedScheduleHash !== null) {
    canonicalUint32HashSchema.parse(projection.reportedScheduleHash);
  }
  const hardwareProfileId = hardwareProfileIdSchema.parse(
    projection.hardwareProfileId,
  );

  const orderedChannels = [...projection.channels].sort(
    (left, right) =>
      left.displayOrder - right.displayOrder ||
      compareIdentifiers(left.mappingId, right.mappingId),
  );
  const mappingIds = new Set<string>();
  const channelIds = new Set<string>();
  for (const channel of orderedChannels) {
    identifierSchema.parse(channel.mappingId);
    identifierSchema.parse(channel.channelId);
    nonnegativeSafeIntegerSchema.parse(channel.displayOrder);
    boundedTextSchema.parse(channel.channelKind);
    if (mappingIds.has(channel.mappingId)) {
      throw new ScheduleArtifactCompilationError(
        "invalid_mapping",
        `Mapping ${channel.mappingId} is duplicated in the device projection`,
      );
    }
    if (channelIds.has(channel.channelId)) {
      throw new ScheduleArtifactCompilationError(
        "invalid_mapping",
        `Channel ${channel.channelId} is mapped more than once`,
      );
    }
    if (!isAllowedPwmPin(hardwareProfileId, channel.pin)) {
      throw new ScheduleArtifactCompilationError(
        "invalid_mapping",
        `GPIO${channel.pin} is not allowed by hardware profile ${hardwareProfileId}`,
      );
    }
    mappingIds.add(channel.mappingId);
    channelIds.add(channel.channelId);
  }

  try {
    const compiled = compileFirmwareSchedule(
      orderedChannels.map((channel) => ({
        pin: channel.pin,
        kind: firmwareKindForChannel(channel.channelKind),
        graph: validatedGraph(channel),
        throttlePercent: channel.throttlePercentage,
        outputGain: projection.outputGain,
      })),
    );
    const core: LegacyScheduleCore = {
      c: compiled.channels.map((channel) => ({
        o: channel.pin,
        t:
          channel.kind === "pump"
            ? LEGACY_PUMP_CHANNEL_TYPE
            : LEGACY_LIGHT_CHANNEL_TYPE,
        l: channel.links.map((link) => ({
          s: { t: link.source.minute, p: link.source.percent },
          d: { t: link.target.minute, p: link.target.percent },
        })),
      })),
    };
    const payloadJson = serializeLegacyScheduleCore(core);
    serializeLegacyScheduleDocument(core, LEGACY_MAX_SYNC_TIME);
    const desiredScheduleHash = canonicalUint32HashSchema.parse(
      calculateLegacyScheduleHash(core),
    );
    return Object.freeze({
      core: Object.freeze(core),
      payloadJson,
      payloadSchemaVersion: DEVICE_SCHEDULE_ARTIFACT_SCHEMA_VERSION,
      byteCount: utf8ByteLength(payloadJson),
      desiredScheduleHash,
    });
  } catch (error) {
    if (error instanceof ScheduleArtifactCompilationError) throw error;
    if (error instanceof RangeError && error.message.includes("4095")) {
      throw new ScheduleArtifactCompilationError(
        "schedule_capacity",
        error.message,
      );
    }
    throw new ScheduleArtifactCompilationError(
      "invalid_projection",
      error instanceof Error ? error.message : String(error),
    );
  }
}

function validatedGraph(
  channel: NormalizedScheduleChannelProjection,
): ValidatedScheduleGraph {
  const points = [...channel.points].sort(
    (left, right) =>
      left.position - right.position || compareIdentifiers(left.id, right.id),
  );
  const ids = new Set<string>();
  const minutes = new Set<number>();
  for (const [index, point] of points.entries()) {
    identifierSchema.parse(point.id);
    if (point.position !== index) {
      throw new ScheduleArtifactCompilationError(
        "invalid_schedule_graph",
        `Channel ${channel.channelId} schedule positions must be contiguous from zero`,
      );
    }
    if (ids.has(point.id) || minutes.has(point.minuteOfDay)) {
      throw new ScheduleArtifactCompilationError(
        "invalid_schedule_graph",
        `Channel ${channel.channelId} schedule has duplicate point identifiers or minutes`,
      );
    }
    ids.add(point.id);
    minutes.add(point.minuteOfDay);
  }
  const validated = validateScheduleGraph(
    scheduleGraphFromPoints(
      points.map((point) => ({
        minute: point.minuteOfDay,
        percent: point.percentage,
      })),
    ),
  );
  if (!validated.ok) {
    throw new ScheduleArtifactCompilationError(
      "invalid_schedule_graph",
      `Channel ${channel.channelId} schedule is invalid: ${validated.issues
        .map((issue) => issue.code)
        .join(", ")}`,
    );
  }
  return validated.graph;
}

function firmwareKindForChannel(channelKind: string): FirmwareChannelKind {
  return channelKind === "pump" ? "pump" : "light";
}

function compareIdentifiers(left: string, right: string): number {
  return left === right ? 0 : left < right ? -1 : 1;
}
