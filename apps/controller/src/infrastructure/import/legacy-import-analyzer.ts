import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

import {
  parseJsonDocument,
  type JsonValue,
  type ParsedJsonDocument,
} from "./strict-json.js";

export const LEGACY_IMPORTER_VERSION = "legacy-json-v1";

const CORE_FILES = ["links.json", "channels.json", "throttle.json"] as const;
const SKIPPED_FILES = [
  "temporaryoverwritesliders.json",
  "device_memory.json",
  "espstatuses.json",
  "homepagedata.json",
] as const;
const LEGACY_FILES = [...CORE_FILES, ...SKIPPED_FILES] as const;

type LegacyFileName = (typeof LEGACY_FILES)[number];

export const LEGACY_TYPE_KEYS = [
  "light",
  "pump",
  "testlight",
  "bad",
  "loft",
  "biljard",
  "frag",
  "qt1",
  "qt2",
  "qt3",
  "qt4",
] as const;

export type LegacyTypeKey = (typeof LEGACY_TYPE_KEYS)[number];
export type LegacyImportIssueSeverity = "error" | "warning";

export interface LegacyImportIssue {
  readonly severity: LegacyImportIssueSeverity;
  readonly code: string;
  readonly sourceFile: string;
  readonly sourcePath: string;
  readonly message: string;
  readonly details?: JsonValue;
}

export interface LegacyImportFileSummary {
  readonly fileName: LegacyFileName;
  readonly disposition: "core" | "skipped";
  readonly sha256: string | null;
  readonly byteCount: number;
  readonly rootRecordCount: number;
  readonly nestedRecordCount: number | null;
  readonly parsed: boolean;
}

export interface LegacyImportNormalizedCounts {
  readonly throttles: number;
  readonly channels: number;
  readonly schedules: number;
  readonly schedulePoints: number;
  readonly mappingProfiles: number;
  readonly pinMappings: number;
}

export interface LegacyImportReport {
  readonly schemaVersion: 1;
  readonly importerVersion: string;
  readonly sourceFingerprint: string;
  readonly valid: boolean;
  readonly canCommit: boolean;
  readonly errorCount: number;
  readonly warningCount: number;
  readonly files: readonly LegacyImportFileSummary[];
  readonly normalizedCounts: LegacyImportNormalizedCounts;
  readonly issues: readonly LegacyImportIssue[];
}

interface LegacySchedulePoint {
  readonly minuteOfDay: number;
  readonly percentage: number;
}

export interface LegacyThrottlePlan {
  readonly typeKey: LegacyTypeKey;
  readonly percentage: number;
  readonly provenance: "legacy-file" | "legacy-default";
}

export interface LegacyChannelPlan {
  readonly name: string;
  readonly kind: LegacyTypeKey;
  readonly displayOrder: number;
  readonly points: readonly LegacySchedulePoint[];
}

export interface LegacyMappingPlan {
  readonly channelName: string;
  readonly pin: number;
  readonly displayOrder: number;
}

export interface LegacyMappingProfilePlan {
  readonly name: string;
  readonly deviceNamePrefix: string;
  readonly outputGain: number;
  readonly displayOrder: number;
  readonly mappings: readonly LegacyMappingPlan[];
}

export interface LegacyImportPlan {
  readonly throttles: readonly LegacyThrottlePlan[];
  readonly channels: readonly LegacyChannelPlan[];
  readonly mappingProfiles: readonly LegacyMappingProfilePlan[];
}

interface LegacyAnalysis {
  readonly report: LegacyImportReport;
  readonly plan: LegacyImportPlan;
}

interface ReadLegacyFile {
  readonly fileName: LegacyFileName;
  readonly disposition: "core" | "skipped";
  readonly sha256: string | null;
  readonly byteCount: number;
  readonly document: ParsedJsonDocument | null;
  readonly readFailure:
    "missing" | "invalid-utf8" | "invalid-json" | "read-error" | null;
  readonly failureMessage: string | null;
}

interface ParsedPoint {
  readonly minuteOfDay: number;
  readonly percentage: number;
  readonly x: number | null;
  readonly y: number | null;
}

interface ParsedSegment {
  readonly source: ParsedPoint;
  readonly target: ParsedPoint;
}

interface FileRecordCounts {
  readonly root: number;
  readonly nested: number | null;
}

const TYPE_SET = new Set<string>(LEGACY_TYPE_KEYS);
const THROTTLE_FILE_KEYS: Readonly<Record<LegacyTypeKey, string>> = {
  light: "lightthrottle",
  pump: "pumpthrottle",
  testlight: "testlightthrottle",
  bad: "badthrottle",
  loft: "loftthrottle",
  biljard: "biljardthrottle",
  frag: "fragthrottle",
  qt1: "qt1throttle",
  qt2: "qt2throttle",
  qt3: "qt3throttle",
  qt4: "qt4throttle",
};

const SKIPPED_REASONS: Readonly<
  Record<(typeof SKIPPED_FILES)[number], string>
> = {
  "temporaryoverwritesliders.json":
    "Expired browser-authored actuator state is not imported as an active override.",
  "device_memory.json":
    "Experimental runtime memory is unreferenced by the retained control model.",
  "espstatuses.json":
    "The stale experimental switch, sensor, and DSL snapshot is deferred.",
  "homepagedata.json":
    "Sketch5/WIP codegroups, switches, timers, and sensors are deferred; DSL text is never executed.",
};

const EXPECTED_SUFFIXES = [
  "Uv",
  "Violet",
  "Royal Blue",
  "Blue",
  "White",
  "Red",
] as const;

export async function analyzeLegacyDirectory(
  sourceDirectory: string,
): Promise<LegacyImportReport> {
  return (await analyzeLegacySource(sourceDirectory)).report;
}

export async function analyzeLegacySource(
  sourceDirectory: string,
): Promise<LegacyAnalysis> {
  if (sourceDirectory.trim().length === 0) {
    throw new TypeError("Legacy import source directory must not be empty");
  }

  const files = await Promise.all(
    LEGACY_FILES.map((fileName) =>
      readLegacyFile(sourceDirectory, fileName, isCoreFile(fileName)),
    ),
  );
  const issues: LegacyImportIssue[] = [];

  for (const file of files) {
    appendFileReadIssues(file, issues);
    if (file.document !== null) {
      for (const duplicate of file.document.duplicateKeys) {
        issues.push({
          severity: "error",
          code: "duplicate-json-key",
          sourceFile: file.fileName,
          sourcePath: duplicate.objectPath,
          message: `Duplicate JSON key ${JSON.stringify(duplicate.key)} at byte offset ${duplicate.offset}.`,
          details: { key: duplicate.key, offset: duplicate.offset },
        });
      }
    }
  }

  const linksFile = findFile(files, "links.json");
  const channelsFile = findFile(files, "channels.json");
  const throttleFile = findFile(files, "throttle.json");
  const channels = parseLinks(linksFile.document?.value ?? null, issues);
  const mappingProfiles = parseMappingProfiles(
    channelsFile.document?.value ?? null,
    issues,
  );
  const throttles = parseThrottles(
    throttleFile.document?.value ?? null,
    issues,
  );

  appendCrossFileIssues(channels, mappingProfiles, issues);
  appendSkippedFileIssues(files, issues);

  const sortedIssues = [...issues].sort(compareIssues);
  const fileSummaries = files.map((file) => summarizeFile(file));
  const plan: LegacyImportPlan = { throttles, channels, mappingProfiles };
  const normalizedCounts: LegacyImportNormalizedCounts = {
    throttles: throttles.length,
    channels: channels.length,
    schedules: channels.length,
    schedulePoints: channels.reduce(
      (total, channel) => total + channel.points.length,
      0,
    ),
    mappingProfiles: mappingProfiles.length,
    pinMappings: mappingProfiles.reduce(
      (total, profile) => total + profile.mappings.length,
      0,
    ),
  };
  const errorCount = sortedIssues.filter(
    (issue) => issue.severity === "error",
  ).length;
  const warningCount = sortedIssues.length - errorCount;
  const sourceFingerprint = fingerprintFiles(files);

  return {
    plan,
    report: {
      schemaVersion: 1,
      importerVersion: LEGACY_IMPORTER_VERSION,
      sourceFingerprint,
      valid: errorCount === 0,
      canCommit: errorCount === 0,
      errorCount,
      warningCount,
      files: fileSummaries,
      normalizedCounts,
      issues: sortedIssues,
    },
  };
}

async function readLegacyFile(
  sourceDirectory: string,
  fileName: LegacyFileName,
  core: boolean,
): Promise<ReadLegacyFile> {
  const disposition = core ? "core" : "skipped";
  let bytes: Buffer;
  try {
    bytes = await readFile(join(sourceDirectory, fileName));
  } catch (error) {
    const missing = hasErrorCode(error, "ENOENT");
    return {
      fileName,
      disposition,
      sha256: null,
      byteCount: 0,
      document: null,
      readFailure: missing ? "missing" : "read-error",
      failureMessage:
        error instanceof Error ? error.message : "Unknown read error",
    };
  }

  const sha256 = createHash("sha256").update(bytes).digest("hex");
  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return {
      fileName,
      disposition,
      sha256,
      byteCount: bytes.byteLength,
      document: null,
      readFailure: "invalid-utf8",
      failureMessage: "The file is not valid UTF-8.",
    };
  }

  if (source.startsWith("\uFEFF")) {
    return {
      fileName,
      disposition,
      sha256,
      byteCount: bytes.byteLength,
      document: null,
      readFailure: "invalid-utf8",
      failureMessage:
        "UTF-8 BOM is not accepted by the strict legacy importer.",
    };
  }

  try {
    const document = parseJsonDocument(source, fileName);
    z.json().parse(document.value);
    return {
      fileName,
      disposition,
      sha256,
      byteCount: bytes.byteLength,
      document,
      readFailure: null,
      failureMessage: null,
    };
  } catch (error) {
    return {
      fileName,
      disposition,
      sha256,
      byteCount: bytes.byteLength,
      document: null,
      readFailure: "invalid-json",
      failureMessage: error instanceof Error ? error.message : "Invalid JSON",
    };
  }
}

function appendFileReadIssues(
  file: ReadLegacyFile,
  issues: LegacyImportIssue[],
): void {
  if (file.readFailure === null) return;
  const optionalMissing =
    file.disposition === "skipped" && file.readFailure === "missing";
  issues.push({
    severity: optionalMissing ? "warning" : "error",
    code: optionalMissing ? "skipped-file-missing" : file.readFailure,
    sourceFile: file.fileName,
    sourcePath: "$",
    message: optionalMissing
      ? "Optional deferred legacy file is absent; there is no skipped-file checksum to audit."
      : readFailureMessage(file),
  });
}

function parseLinks(
  value: JsonValue | null,
  issues: LegacyImportIssue[],
): LegacyChannelPlan[] {
  if (value === null) return [];
  if (!isJsonObject(value)) {
    addShapeIssue(
      issues,
      "links.json",
      "$",
      "The links root must be an object.",
    );
    return [];
  }

  const channels: LegacyChannelPlan[] = [];
  let coordinateCount = 0;
  let coordinateMismatchCount = 0;

  for (const [displayOrder, [channelName, record]] of Object.entries(
    value,
  ).entries()) {
    const channelPath = appendJsonPath("$", channelName);
    if (channelName.length === 0) {
      addShapeIssue(
        issues,
        "links.json",
        channelPath,
        "Schedule/channel names must not be empty.",
      );
      continue;
    }
    if (!isJsonObject(record)) {
      addShapeIssue(
        issues,
        "links.json",
        channelPath,
        "Each channel must be an object.",
      );
      continue;
    }
    appendUnknownFieldIssues(
      record,
      ["type", "links"],
      "links.json",
      channelPath,
      issues,
    );

    const kindValue = record.type;
    const linksValue = record.links;
    let kind: LegacyTypeKey | null = null;
    if (typeof kindValue !== "string" || !TYPE_SET.has(kindValue)) {
      issues.push({
        severity: "error",
        code: "unknown-schedule-type",
        sourceFile: "links.json",
        sourcePath: `${channelPath}.type`,
        message: `Unknown schedule type ${JSON.stringify(kindValue)}.`,
      });
    } else {
      kind = kindValue as LegacyTypeKey;
    }

    if (!Array.isArray(linksValue)) {
      addShapeIssue(
        issues,
        "links.json",
        `${channelPath}.links`,
        "The links field must be an array.",
      );
      continue;
    }
    if (linksValue.length === 0) {
      issues.push({
        severity: "error",
        code: "empty-schedule",
        sourceFile: "links.json",
        sourcePath: `${channelPath}.links`,
        message: "Schedules must contain at least one segment.",
      });
      continue;
    }

    const segments: ParsedSegment[] = [];
    for (const [segmentIndex, segmentValue] of linksValue.entries()) {
      const segmentPath = `${channelPath}.links[${segmentIndex}]`;
      const segment = parseSegment(segmentValue, segmentPath, issues);
      if (segment !== null) {
        segments.push(segment);
        coordinateCount += countCoordinates(segment);
      }
    }

    if (segments.length !== linksValue.length || segments.length === 0) {
      continue;
    }
    const firstSegment = segments[0];
    if (firstSegment === undefined) continue;
    coordinateMismatchCount += validateScheduleGraph(
      channelName,
      channelPath,
      segments,
      issues,
    );
    if (kind !== null) {
      channels.push({
        name: channelName,
        kind,
        displayOrder,
        points: [
          toSchedulePoint(firstSegment.source),
          ...segments.map((segment) => toSchedulePoint(segment.target)),
        ],
      });
    }
  }

  if (coordinateCount > 0) {
    issues.push({
      severity: "warning",
      code: "editor-coordinates-discarded",
      sourceFile: "links.json",
      sourcePath: "$",
      message:
        "Legacy x/y presentation coordinates are discarded and will be recomputed from minute/percentage values.",
      details: {
        coordinateCount,
        inconsistentEndpointCount: coordinateMismatchCount,
      },
    });
  }
  return channels;
}

function parseSegment(
  value: JsonValue,
  path: string,
  issues: LegacyImportIssue[],
): ParsedSegment | null {
  if (!isJsonObject(value)) {
    addShapeIssue(
      issues,
      "links.json",
      path,
      "Each schedule segment must be an object.",
    );
    return null;
  }
  appendUnknownFieldIssues(
    value,
    ["source", "target"],
    "links.json",
    path,
    issues,
  );
  const source = parsePoint(value.source, `${path}.source`, issues);
  const target = parsePoint(value.target, `${path}.target`, issues);
  return source === null || target === null ? null : { source, target };
}

function parsePoint(
  value: JsonValue | undefined,
  path: string,
  issues: LegacyImportIssue[],
): ParsedPoint | null {
  if (!isJsonObject(value)) {
    addShapeIssue(
      issues,
      "links.json",
      path,
      "Schedule endpoints must be objects.",
    );
    return null;
  }
  appendUnknownFieldIssues(
    value,
    ["time", "percentage", "x", "y"],
    "links.json",
    path,
    issues,
  );
  const time = value.time;
  const percentage = value.percentage;
  if (!isIntegerInRange(time, 0, 1439)) {
    issues.push({
      severity: "error",
      code: "invalid-schedule-minute",
      sourceFile: "links.json",
      sourcePath: `${path}.time`,
      message: "Schedule time must be an integer from 0 through 1439.",
    });
  }
  if (!isFiniteNumberInRange(percentage, 0, 100)) {
    issues.push({
      severity: "error",
      code: "invalid-schedule-percentage",
      sourceFile: "links.json",
      sourcePath: `${path}.percentage`,
      message:
        "Schedule percentage must be a finite number from 0 through 100.",
    });
  }
  const x = parseOptionalCoordinate(value.x, `${path}.x`, issues);
  const y = parseOptionalCoordinate(value.y, `${path}.y`, issues);
  if (
    !isIntegerInRange(time, 0, 1439) ||
    !isFiniteNumberInRange(percentage, 0, 100) ||
    x === undefined ||
    y === undefined
  ) {
    return null;
  }
  return { minuteOfDay: time, percentage, x, y };
}

function parseOptionalCoordinate(
  value: JsonValue | undefined,
  path: string,
  issues: LegacyImportIssue[],
): number | null | undefined {
  if (value === undefined) return null;
  if (typeof value === "number" && Number.isFinite(value)) return value;
  addShapeIssue(
    issues,
    "links.json",
    path,
    "Editor coordinates must be finite numbers when present.",
  );
  return undefined;
}

function validateScheduleGraph(
  channelName: string,
  channelPath: string,
  segments: readonly ParsedSegment[],
  issues: LegacyImportIssue[],
): number {
  const first = segments[0];
  const last = segments.at(-1);
  if (first === undefined || last === undefined) {
    throw new Error(
      "Internal importer error: cannot validate an empty schedule.",
    );
  }
  let coordinateMismatchCount = 0;
  const authoritativePoints = [
    {
      point: first.source,
      path: `${channelPath}.links[0].source`,
    },
    ...segments.map((segment, index) => ({
      point: segment.target,
      path: `${channelPath}.links[${index}].target`,
    })),
  ];
  for (const endpoint of authoritativePoints) {
    if (hasInconsistentEditorCoordinate(endpoint.point)) {
      coordinateMismatchCount += 1;
      issues.push({
        severity: "warning",
        code: "inconsistent-editor-coordinate",
        sourceFile: "links.json",
        sourcePath: endpoint.path,
        message: `${channelName} has x/y values inconsistent with its authoritative minute/percentage; the coordinates will be recomputed.`,
      });
    }
  }
  for (const [index, segment] of segments.entries()) {
    if (segment.target.minuteOfDay === segment.source.minuteOfDay) {
      issues.push({
        severity: "error",
        code: "zero-duration-segment",
        sourceFile: "links.json",
        sourcePath: `${channelPath}.links[${index}]`,
        message: `${channelName} has a zero-duration segment at minute ${segment.source.minuteOfDay}.`,
      });
    } else if (segment.target.minuteOfDay < segment.source.minuteOfDay) {
      issues.push({
        severity: "error",
        code: "reversed-segment",
        sourceFile: "links.json",
        sourcePath: `${channelPath}.links[${index}]`,
        message: `${channelName} has a segment whose target precedes its source.`,
      });
    }

    const next = segments[index + 1];
    if (next === undefined) continue;
    if (next.source.minuteOfDay > segment.target.minuteOfDay) {
      issues.push({
        severity: "error",
        code: "schedule-gap",
        sourceFile: "links.json",
        sourcePath: `${channelPath}.links[${index + 1}]`,
        message: `${channelName} has a gap between minutes ${segment.target.minuteOfDay} and ${next.source.minuteOfDay}.`,
      });
    } else if (next.source.minuteOfDay < segment.target.minuteOfDay) {
      issues.push({
        severity: "error",
        code: "schedule-overlap",
        sourceFile: "links.json",
        sourcePath: `${channelPath}.links[${index + 1}]`,
        message: `${channelName} has overlapping adjacent segments.`,
      });
    } else if (next.source.percentage !== segment.target.percentage) {
      issues.push({
        severity: "error",
        code: "schedule-discontinuity",
        sourceFile: "links.json",
        sourcePath: `${channelPath}.links[${index + 1}].source.percentage`,
        message: `${channelName} changes percentage discontinuously at minute ${next.source.minuteOfDay}.`,
      });
    }

    if (
      next.source.minuteOfDay === segment.target.minuteOfDay &&
      next.source.percentage === segment.target.percentage &&
      (next.source.x !== segment.target.x || next.source.y !== segment.target.y)
    ) {
      coordinateMismatchCount += 1;
      issues.push({
        severity: "warning",
        code: "inconsistent-editor-coordinate",
        sourceFile: "links.json",
        sourcePath: `${channelPath}.links[${index + 1}].source`,
        message: `${channelName} has inconsistent x/y values for the same authoritative endpoint; the coordinates will be recomputed.`,
      });
    }
  }

  if (first.source.minuteOfDay !== 0) {
    issues.push({
      severity: "error",
      code: "schedule-start-minute",
      sourceFile: "links.json",
      sourcePath: `${channelPath}.links[0].source.time`,
      message: `${channelName} starts at minute ${first.source.minuteOfDay}, not 0.`,
    });
  }
  if (last.target.minuteOfDay !== 1439) {
    issues.push({
      severity: "error",
      code: "schedule-end-minute",
      sourceFile: "links.json",
      sourcePath: `${channelPath}.links[${segments.length - 1}].target.time`,
      message: `${channelName} ends at minute ${last.target.minuteOfDay}, not 1439.`,
    });
  }
  if (first.source.percentage !== last.target.percentage) {
    issues.push({
      severity: "error",
      code: "schedule-wrap-mismatch",
      sourceFile: "links.json",
      sourcePath: channelPath,
      message: `${channelName} does not wrap to its starting percentage.`,
    });
  }
  return coordinateMismatchCount;
}

function parseMappingProfiles(
  value: JsonValue | null,
  issues: LegacyImportIssue[],
): LegacyMappingProfilePlan[] {
  if (value === null) return [];
  if (!isJsonObject(value)) {
    addShapeIssue(
      issues,
      "channels.json",
      "$",
      "The channels root must be an object.",
    );
    return [];
  }
  const profiles: LegacyMappingProfilePlan[] = [];

  for (const [displayOrder, [prefix, rows]] of Object.entries(
    value,
  ).entries()) {
    const profilePath = appendJsonPath("$", prefix);
    if (!Array.isArray(rows)) {
      addShapeIssue(
        issues,
        "channels.json",
        profilePath,
        "Each mapping profile must be an array.",
      );
      continue;
    }
    if (prefix.length === 0) {
      issues.push({
        severity: rows.length === 0 ? "warning" : "error",
        code:
          rows.length === 0
            ? "empty-mapping-prefix-skipped"
            : "empty-mapping-prefix",
        sourceFile: "channels.json",
        sourcePath: profilePath,
        message:
          rows.length === 0
            ? "The empty zero-row mapping prefix is skipped."
            : "An empty mapping prefix with rows would match every device and cannot be imported.",
      });
      continue;
    }

    const mappings: LegacyMappingPlan[] = [];
    const pins = new Set<number>();
    const channelNames = new Set<string>();
    for (const [mappingIndex, row] of rows.entries()) {
      const mappingPath = `${profilePath}[${mappingIndex}]`;
      if (!isJsonObject(row)) {
        addShapeIssue(
          issues,
          "channels.json",
          mappingPath,
          "Each pin mapping must be an object.",
        );
        continue;
      }
      appendUnknownFieldIssues(
        row,
        ["channel", "pin"],
        "channels.json",
        mappingPath,
        issues,
      );
      const channelName = row.channel;
      const pin = row.pin;
      if (typeof channelName !== "string" || channelName.length === 0) {
        addShapeIssue(
          issues,
          "channels.json",
          `${mappingPath}.channel`,
          "Mapped channel names must be nonempty strings.",
        );
      }
      if (!isIntegerInRange(pin, 0, 63)) {
        issues.push({
          severity: "error",
          code: "invalid-mapping-pin",
          sourceFile: "channels.json",
          sourcePath: `${mappingPath}.pin`,
          message: "Mapping pins must be integers from 0 through 63.",
        });
      }
      if (
        typeof channelName !== "string" ||
        channelName.length === 0 ||
        !isIntegerInRange(pin, 0, 63)
      ) {
        continue;
      }
      if (pins.has(pin)) {
        issues.push({
          severity: "error",
          code: "duplicate-profile-pin",
          sourceFile: "channels.json",
          sourcePath: `${mappingPath}.pin`,
          message: `${prefix} maps pin ${pin} more than once.`,
        });
      }
      if (channelNames.has(channelName)) {
        issues.push({
          severity: "error",
          code: "duplicate-profile-channel",
          sourceFile: "channels.json",
          sourcePath: `${mappingPath}.channel`,
          message: `${prefix} maps channel ${JSON.stringify(channelName)} more than once.`,
        });
      }
      pins.add(pin);
      channelNames.add(channelName);
      mappings.push({ channelName, pin, displayOrder: mappingIndex });
    }

    const outputGain = prefix === "mainLys" ? 0.7 : 1;
    if (outputGain !== 1) {
      issues.push({
        severity: "warning",
        code: "legacy-output-gain-materialized",
        sourceFile: "channels.json",
        sourcePath: profilePath,
        message:
          "The legacy mainLys host gain is materialized explicitly as output_gain 0.7.",
        details: { outputGain },
      });
    }
    profiles.push({
      name: prefix,
      deviceNamePrefix: prefix,
      outputGain,
      displayOrder,
      mappings,
    });
  }

  for (const [leftIndex, left] of profiles.entries()) {
    for (const right of profiles.slice(leftIndex + 1)) {
      if (
        left.deviceNamePrefix.startsWith(right.deviceNamePrefix) ||
        right.deviceNamePrefix.startsWith(left.deviceNamePrefix)
      ) {
        issues.push({
          severity: "error",
          code: "overlapping-mapping-prefixes",
          sourceFile: "channels.json",
          sourcePath: "$",
          message: `Mapping prefixes ${JSON.stringify(left.deviceNamePrefix)} and ${JSON.stringify(right.deviceNamePrefix)} overlap.`,
          details: {
            prefixes: [left.deviceNamePrefix, right.deviceNamePrefix],
          },
        });
      }
    }
  }
  return profiles;
}

function parseThrottles(
  value: JsonValue | null,
  issues: LegacyImportIssue[],
): LegacyThrottlePlan[] {
  const object = isJsonObject(value) ? value : null;
  if (value !== null && object === null) {
    addShapeIssue(
      issues,
      "throttle.json",
      "$",
      "The throttle root must be an object.",
    );
  }
  if (object !== null) {
    const allowedKeys = new Set(Object.values(THROTTLE_FILE_KEYS));
    for (const key of Object.keys(object)) {
      if (!allowedKeys.has(key)) {
        issues.push({
          severity: "error",
          code: "unknown-core-field",
          sourceFile: "throttle.json",
          sourcePath: appendJsonPath("$", key),
          message: `Unknown throttle field ${JSON.stringify(key)}.`,
        });
      }
    }
  }

  return LEGACY_TYPE_KEYS.map((typeKey) => {
    const legacyKey = THROTTLE_FILE_KEYS[typeKey];
    const percentage = object?.[legacyKey];
    if (percentage === undefined) {
      issues.push({
        severity: "warning",
        code: "legacy-throttle-default-materialized",
        sourceFile: "throttle.json",
        sourcePath: appendJsonPath("$", legacyKey),
        message: `Missing ${typeKey} throttle is materialized as 100 with legacy-default provenance.`,
        details: { typeKey, percentage: 100, provenance: "legacy-default" },
      });
      return { typeKey, percentage: 100, provenance: "legacy-default" };
    }
    if (!isFiniteNumberInRange(percentage, 0, 100)) {
      issues.push({
        severity: "error",
        code: "invalid-throttle",
        sourceFile: "throttle.json",
        sourcePath: appendJsonPath("$", legacyKey),
        message: `${legacyKey} must be a finite number from 0 through 100.`,
      });
      return { typeKey, percentage: 100, provenance: "legacy-default" };
    }
    return { typeKey, percentage, provenance: "legacy-file" };
  });
}

function appendCrossFileIssues(
  channels: readonly LegacyChannelPlan[],
  profiles: readonly LegacyMappingProfilePlan[],
  issues: LegacyImportIssue[],
): void {
  const channelNames = new Set(channels.map((channel) => channel.name));
  const mappedNames = new Set<string>();
  for (const profile of profiles) {
    for (const mapping of profile.mappings) {
      const path = `${appendJsonPath("$", profile.deviceNamePrefix)}[${mapping.displayOrder}].channel`;
      mappedNames.add(mapping.channelName);
      if (!channelNames.has(mapping.channelName)) {
        issues.push({
          severity: "error",
          code: "mapping-references-missing-channel",
          sourceFile: "channels.json",
          sourcePath: path,
          message: `${profile.name} maps missing channel ${JSON.stringify(mapping.channelName)}.`,
          details: { profile: profile.name, channelName: mapping.channelName },
        });
      }
    }
  }

  for (const channel of channels) {
    if (!mappedNames.has(channel.name)) {
      issues.push({
        severity: "warning",
        code: "orphan-schedule-preserved",
        sourceFile: "links.json",
        sourcePath: appendJsonPath("$", channel.name),
        message: `Unmapped schedule ${JSON.stringify(channel.name)} is preserved.`,
      });
    }
  }

  const caseGroups = new Map<string, string[]>();
  for (const channel of channels) {
    const key = channel.name.toLowerCase();
    const names = caseGroups.get(key) ?? [];
    names.push(channel.name);
    caseGroups.set(key, names);
  }
  for (const names of caseGroups.values()) {
    if (new Set(names).size < 2) continue;
    issues.push({
      severity: "warning",
      code: "case-distinct-channel-names-preserved",
      sourceFile: "links.json",
      sourcePath: "$",
      message: `Case-distinct channels ${names.map((name) => JSON.stringify(name)).join(" and ")} are preserved under SQLite BINARY identity.`,
      details: { names },
    });
  }

  for (const prefix of ["Loft", "Qt2", "Qt3", "Qt4"] as const) {
    for (const suffix of EXPECTED_SUFFIXES) {
      const channelName = `${prefix} ${suffix}`;
      if (!channelNames.has(channelName)) {
        issues.push({
          severity: "warning",
          code: "canonical-route-channel-missing",
          sourceFile: "links.json",
          sourcePath: appendJsonPath("$", channelName),
          message: `Canonical route channel ${JSON.stringify(channelName)} is absent and is not invented by import.`,
        });
      }
    }
  }
}

function appendSkippedFileIssues(
  files: readonly ReadLegacyFile[],
  issues: LegacyImportIssue[],
): void {
  for (const fileName of SKIPPED_FILES) {
    const file = findFile(files, fileName);
    if (file.document === null) continue;
    const counts = countFileRecords(file.fileName, file.document.value);
    issues.push({
      severity: "warning",
      code: "skipped-legacy-file",
      sourceFile: file.fileName,
      sourcePath: "$",
      message: SKIPPED_REASONS[fileName],
      details: {
        sha256: file.sha256,
        byteCount: file.byteCount,
        rootRecordCount: counts.root,
        nestedRecordCount: counts.nested,
        importerVersion: LEGACY_IMPORTER_VERSION,
      },
    });
  }
}

function summarizeFile(file: ReadLegacyFile): LegacyImportFileSummary {
  const counts =
    file.document === null
      ? { root: 0, nested: null }
      : countFileRecords(file.fileName, file.document.value);
  return {
    fileName: file.fileName,
    disposition: file.disposition,
    sha256: file.sha256,
    byteCount: file.byteCount,
    rootRecordCount: counts.root,
    nestedRecordCount: counts.nested,
    parsed: file.document !== null,
  };
}

function countFileRecords(
  fileName: LegacyFileName,
  value: JsonValue,
): FileRecordCounts {
  if (Array.isArray(value)) {
    return { root: value.length, nested: null };
  }
  if (!isJsonObject(value)) return { root: 1, nested: null };
  const root = Object.keys(value).length;
  if (fileName === "links.json") {
    return {
      root,
      nested: Object.values(value).reduce<number>((total, record) => {
        return (
          total +
          (isJsonObject(record) && Array.isArray(record.links)
            ? record.links.length
            : 0)
        );
      }, 0),
    };
  }
  if (fileName === "channels.json") {
    return {
      root,
      nested: Object.values(value).reduce<number>(
        (total, rows) => total + (Array.isArray(rows) ? rows.length : 0),
        0,
      ),
    };
  }
  if (fileName === "temporaryoverwritesliders.json") {
    if (Array.isArray(value.values)) {
      return { root, nested: value.values.length };
    }
    if (isJsonObject(value.values)) {
      return { root, nested: Object.keys(value.values).length };
    }
  }
  if (fileName === "homepagedata.json" || fileName === "espstatuses.json") {
    return {
      root,
      nested: Object.values(value).reduce<number>((total, item) => {
        if (Array.isArray(item)) return total + item.length;
        if (isJsonObject(item)) return total + Object.keys(item).length;
        return total;
      }, 0),
    };
  }
  return { root, nested: null };
}

function fingerprintFiles(files: readonly ReadLegacyFile[]): string {
  const hash = createHash("sha256");
  hash.update(`${LEGACY_IMPORTER_VERSION}\0`);
  for (const file of files) {
    hash.update(file.fileName);
    hash.update("\0");
    hash.update(file.sha256 ?? `missing:${file.readFailure ?? "none"}`);
    hash.update("\0");
  }
  return hash.digest("hex");
}

function appendUnknownFieldIssues(
  object: Readonly<Record<string, JsonValue>>,
  allowed: readonly string[],
  sourceFile: string,
  path: string,
  issues: LegacyImportIssue[],
): void {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(object)) {
    if (!allowedSet.has(key)) {
      issues.push({
        severity: "error",
        code: "unknown-core-field",
        sourceFile,
        sourcePath: appendJsonPath(path, key),
        message: `Unknown core field ${JSON.stringify(key)}.`,
      });
    }
  }
  for (const key of allowed) {
    if (!(key in object) && key !== "x" && key !== "y") {
      issues.push({
        severity: "error",
        code: "missing-core-field",
        sourceFile,
        sourcePath: appendJsonPath(path, key),
        message: `Required core field ${JSON.stringify(key)} is missing.`,
      });
    }
  }
}

function addShapeIssue(
  issues: LegacyImportIssue[],
  sourceFile: string,
  sourcePath: string,
  message: string,
): void {
  issues.push({
    severity: "error",
    code: "invalid-core-shape",
    sourceFile,
    sourcePath,
    message,
  });
}

function compareIssues(
  left: LegacyImportIssue,
  right: LegacyImportIssue,
): number {
  const severity = severityOrder(left.severity) - severityOrder(right.severity);
  if (severity !== 0) return severity;
  const file = fileOrder(left.sourceFile) - fileOrder(right.sourceFile);
  if (file !== 0) return file;
  return (
    compareText(left.sourcePath, right.sourcePath) ||
    compareText(left.code, right.code) ||
    compareText(left.message, right.message)
  );
}

function readFailureMessage(file: ReadLegacyFile): string {
  switch (file.readFailure) {
    case "missing":
      return "Required legacy file is missing.";
    case "invalid-utf8":
    case "invalid-json":
      return file.failureMessage ?? "Legacy file is malformed.";
    case "read-error":
      return "Legacy file could not be read.";
    case null:
      return "Legacy file could not be read.";
  }
}

function compareText(left: string, right: string): number {
  if (left < right) return -1;
  if (left > right) return 1;
  return 0;
}

function severityOrder(severity: LegacyImportIssueSeverity): number {
  return severity === "error" ? 0 : 1;
}

function fileOrder(fileName: string): number {
  const index = LEGACY_FILES.indexOf(fileName as LegacyFileName);
  return index === -1 ? LEGACY_FILES.length : index;
}

function findFile<T extends LegacyFileName>(
  files: readonly ReadLegacyFile[],
  fileName: T,
): ReadLegacyFile {
  const file = files.find((candidate) => candidate.fileName === fileName);
  if (file === undefined)
    throw new Error(`Internal importer error: missing ${fileName}`);
  return file;
}

function isCoreFile(fileName: LegacyFileName): boolean {
  return (CORE_FILES as readonly string[]).includes(fileName);
}

function isJsonObject(
  value: JsonValue | undefined,
): value is Readonly<Record<string, JsonValue>> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isIntegerInRange(
  value: JsonValue | undefined,
  minimum: number,
  maximum: number,
): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= minimum &&
    value <= maximum
  );
}

function isFiniteNumberInRange(
  value: JsonValue | undefined,
  minimum: number,
  maximum: number,
): value is number {
  return (
    typeof value === "number" &&
    Number.isFinite(value) &&
    value >= minimum &&
    value <= maximum
  );
}

function toSchedulePoint(point: ParsedPoint): LegacySchedulePoint {
  return { minuteOfDay: point.minuteOfDay, percentage: point.percentage };
}

function countCoordinates(segment: ParsedSegment): number {
  return [
    segment.source.x,
    segment.source.y,
    segment.target.x,
    segment.target.y,
  ].filter((coordinate) => coordinate !== null).length;
}

function hasInconsistentEditorCoordinate(point: ParsedPoint): boolean {
  const expectedX = (point.minuteOfDay / 1439) * 930;
  const expectedY = (100 - point.percentage) * 2.5;
  return (
    (point.x !== null && Math.abs(point.x - expectedX) > 0.51) ||
    (point.y !== null && Math.abs(point.y - expectedY) > 0.51)
  );
}

function appendJsonPath(path: string, key: string): string {
  return `${path}[${JSON.stringify(key)}]`;
}

function hasErrorCode(error: unknown, expectedCode: string): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === expectedCode
  );
}
