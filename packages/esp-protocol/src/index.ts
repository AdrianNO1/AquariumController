import { z } from "zod";

import {
  LEGACY_CHUNK_DATA_BYTES,
  LEGACY_CHUNK_THRESHOLD_BYTES,
  LEGACY_COMMANDS_PER_DEVICE_PER_BATCH,
  LEGACY_MAX_CHUNKS,
  utf8ByteLength,
} from "./limits.js";

export * from "./limits.js";
export * from "./schedule.js";

export const espAnnouncementSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  freq: z.number().int().positive(),
  res: z.number().int().min(1).max(16),
  status: z.string().min(1),
  version: z.string().min(1),
  scheduleHash: z.string().regex(/^\d+$/),
});

export type EspAnnouncement = z.infer<typeof espAnnouncementSchema>;

export const espCommandResponseSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  responses: z.array(
    z.object({
      index: z.number().int().nonnegative(),
      response: z.string(),
    }),
  ),
});

export type EspCommandResponse = z.infer<typeof espCommandResponseSchema>;

export interface EspTopicSet {
  readonly command: string;
  readonly announce: string;
  readonly response: string;
}

export interface LegacyCommandBatch {
  readonly commands: readonly string[];
  readonly originalIndexes: readonly number[];
  readonly payload: string;
}

export function createEspTopicSet(testMode: boolean): EspTopicSet {
  const prefix = testMode ? "test/aquarium" : "aquarium";

  return {
    command: `${prefix}/command`,
    announce: `${prefix}/announce`,
    response: `${prefix}/response`,
  };
}

export function encodeLegacyMessage(payload: string): readonly string[] {
  if (payload.length === 0) {
    throw new TypeError("Cannot publish an empty legacy ESP payload");
  }
  if (payload.includes("\0")) {
    throw new TypeError("Legacy ESP payloads cannot contain null bytes");
  }
  if (utf8ByteLength(payload) <= LEGACY_CHUNK_THRESHOLD_BYTES) {
    return [payload];
  }

  const dataChunks = splitUtf8(payload, LEGACY_CHUNK_DATA_BYTES);
  if (dataChunks.length > LEGACY_MAX_CHUNKS) {
    throw new RangeError(
      `Payload needs ${dataChunks.length} chunks; deployed firmware supports at most ${LEGACY_MAX_CHUNKS}`,
    );
  }

  return dataChunks.map((data, index) => {
    const isLast = index === dataChunks.length - 1 ? 1 : 0;
    return `chunk:${index}:${dataChunks.length}:${isLast}:${data}`;
  });
}

export function batchLegacyCommands(
  commands: readonly string[],
): readonly LegacyCommandBatch[] {
  const batches: LegacyCommandBatch[] = [];
  let currentCommands: string[] = [];
  let currentIndexes: number[] = [];
  let deviceCounts = new Map<string, number>();

  const flush = (): void => {
    if (currentCommands.length === 0) {
      return;
    }
    batches.push({
      commands: currentCommands,
      originalIndexes: currentIndexes,
      payload: currentCommands.join(";"),
    });
    currentCommands = [];
    currentIndexes = [];
    deviceCounts = new Map<string, number>();
  };

  commands.forEach((rawCommand, originalIndex) => {
    const command = rawCommand.trim();
    if (command.length === 0 || command.includes(";")) {
      throw new TypeError(`Invalid legacy command at index ${originalIndex}`);
    }

    const [target, operation] = command.split(/\s+/, 3);
    if (target === undefined || operation === undefined) {
      throw new TypeError(
        `Legacy command at index ${originalIndex} requires a target and operation`,
      );
    }

    const targetCount = deviceCounts.get(target) ?? 0;
    if (targetCount >= LEGACY_COMMANDS_PER_DEVICE_PER_BATCH) {
      flush();
    }

    currentCommands.push(command);
    currentIndexes.push(originalIndex);
    deviceCounts.set(target, (deviceCounts.get(target) ?? 0) + 1);
  });

  flush();
  return batches;
}

function splitUtf8(value: string, maximumBytes: number): string[] {
  const chunks: string[] = [];
  let chunk = "";
  let chunkBytes = 0;

  for (const character of value) {
    const characterBytes = utf8ByteLength(character);
    if (chunkBytes + characterBytes > maximumBytes) {
      chunks.push(chunk);
      chunk = character;
      chunkBytes = characterBytes;
    } else {
      chunk += character;
      chunkBytes += characterBytes;
    }
  }

  if (chunk.length > 0) {
    chunks.push(chunk);
  }

  return chunks;
}
