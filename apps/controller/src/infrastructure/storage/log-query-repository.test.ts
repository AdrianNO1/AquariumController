import { createHash } from "node:crypto";

import type { LogFilter } from "@aquarium/contracts";
import { sql, type Kysely } from "kysely";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { LogsService } from "../../application/logs/log-service.js";
import {
  openEventsDatabase,
  type EventsDatabaseSchema,
} from "../database/index.js";
import {
  createSensitiveKeyRedactor,
  InteractionRepository,
  type InteractionLogInput,
  type StoredInteraction,
} from "./interaction-repository.js";
import {
  CorruptStoredInteractionError,
  LogQueryRepository,
} from "./log-query-repository.js";

let database: Kysely<EventsDatabaseSchema>;

beforeEach(async () => {
  database = await openEventsDatabase({ filename: ":memory:" });
});

afterEach(async () => {
  await database.destroy();
});

async function insertInteraction(
  overrides: Partial<InteractionLogInput> = {},
): Promise<StoredInteraction> {
  return new InteractionRepository(database).log({
    occurredAtMs: 100,
    direction: "internal",
    kind: "test-event",
    severity: "info",
    outcome: "succeeded",
    byteCount: 10,
    retentionClass: "operational",
    ...overrides,
  });
}

describe("LogQueryRepository filters", () => {
  it("applies every filter with inclusive times, exact case, and parameterized values", async () => {
    const first = await insertInteraction({
      occurredAtMs: 100,
      direction: "inbound",
      kind: "Alpha",
      severity: "warning",
      deviceId: "Device-A",
      operationId: "operation-a",
      correlationId: "correlation-a",
      outcome: "failed",
      retentionClass: "audit",
    });
    const second = await insertInteraction({
      occurredAtMs: 200,
      direction: "outbound",
      kind: "alpha",
      severity: "error",
      deviceId: "device-a",
      operationId: "operation-b",
      correlationId: "correlation-b",
      outcome: "timed_out",
      retentionClass: "critical",
    });
    const injectionKind = "x' OR 1=1 --";
    const third = await insertInteraction({
      occurredAtMs: 300,
      direction: "internal",
      kind: injectionKind,
      severity: "critical",
      deviceId: "device-c",
      operationId: "operation-c",
      correlationId: "correlation-c",
      outcome: "outcome_unknown",
      retentionClass: "raw",
    });
    const repository = new LogQueryRepository(database);
    const matchingIds = async (filters: LogFilter): Promise<number[]> =>
      (await repository.readBatch({ filters, limit: 100 })).map(
        (entry) => entry.id,
      );

    await expect(matchingIds({ startAtMs: 200 })).resolves.toEqual([
      third.id,
      second.id,
    ]);
    await expect(matchingIds({ endAtMs: 200 })).resolves.toEqual([
      second.id,
      first.id,
    ]);
    await expect(
      matchingIds({ startAtMs: 200, endAtMs: 200 }),
    ).resolves.toEqual([second.id]);
    await expect(matchingIds({ direction: "inbound" })).resolves.toEqual([
      first.id,
    ]);
    await expect(matchingIds({ kind: "Alpha" })).resolves.toEqual([first.id]);
    await expect(matchingIds({ kind: "alpha" })).resolves.toEqual([second.id]);
    await expect(matchingIds({ kind: injectionKind })).resolves.toEqual([
      third.id,
    ]);
    await expect(matchingIds({ severity: "critical" })).resolves.toEqual([
      third.id,
    ]);
    await expect(matchingIds({ deviceId: "Device-A" })).resolves.toEqual([
      first.id,
    ]);
    await expect(matchingIds({ deviceId: "device-a" })).resolves.toEqual([
      second.id,
    ]);
    await expect(matchingIds({ operationId: "operation-b" })).resolves.toEqual([
      second.id,
    ]);
    await expect(
      matchingIds({ correlationId: "correlation-c" }),
    ).resolves.toEqual([third.id]);
    await expect(matchingIds({ outcome: "failed" })).resolves.toEqual([
      first.id,
    ]);
    await expect(matchingIds({ retentionClass: "critical" })).resolves.toEqual([
      second.id,
    ]);
  });

  it("uses both timestamp and id for a stable descending cursor boundary", async () => {
    const first = await insertInteraction({ occurredAtMs: 500 });
    const second = await insertInteraction({ occurredAtMs: 500 });
    const third = await insertInteraction({ occurredAtMs: 500 });
    const older = await insertInteraction({ occurredAtMs: 499 });
    const repository = new LogQueryRepository(database);

    const page = await repository.readBatch({ filters: {}, limit: 2 });
    expect(page.map((item) => item.id)).toEqual([third.id, second.id]);
    const continued = await repository.readBatch({
      filters: {},
      after: { occurredAtMs: 500, id: second.id },
      limit: 2,
    });
    expect(continued.map((item) => item.id)).toEqual([first.id, older.id]);
  });
});

describe("LogQueryRepository integrity boundary", () => {
  it("rejects checksum mismatches, duplicate keys, and malformed JSON", async () => {
    const stored = await insertInteraction({
      kind: "corrupt-target",
      payload: { safe: true },
      payloadSchemaVersion: 1,
    });
    const repository = new LogQueryRepository(database);
    await database
      .updateTable("interactions")
      .set({ payload_sha256: "0".repeat(64) })
      .where("id", "=", stored.id)
      .executeTakeFirstOrThrow();
    await expect(
      repository.readBatch({
        filters: { kind: "corrupt-target" },
        limit: 1,
      }),
    ).rejects.toThrow(/checksum does not match/u);

    const duplicateJson = '{"safe":true,"safe":false}';
    await database
      .updateTable("interactions")
      .set({
        payload_json: duplicateJson,
        payload_sha256: createHash("sha256")
          .update(duplicateJson, "utf8")
          .digest("hex"),
      })
      .where("id", "=", stored.id)
      .executeTakeFirstOrThrow();
    await expect(
      repository.readBatch({
        filters: { kind: "corrupt-target" },
        limit: 1,
      }),
    ).rejects.toThrow(/duplicate keys/u);

    await sql`PRAGMA ignore_check_constraints = ON`.execute(database);
    const malformedJson = '{"safe":';
    await database
      .updateTable("interactions")
      .set({
        payload_json: malformedJson,
        payload_sha256: createHash("sha256")
          .update(malformedJson, "utf8")
          .digest("hex"),
      })
      .where("id", "=", stored.id)
      .executeTakeFirstOrThrow();
    await sql`PRAGMA ignore_check_constraints = OFF`.execute(database);
    await expect(
      repository.readBatch({
        filters: { kind: "corrupt-target" },
        limit: 1,
      }),
    ).rejects.toThrow(/payload JSON is invalid/u);
  });

  it("exports only validated payload data already redacted before persistence", async () => {
    const interactionRepository = new InteractionRepository(database, {
      redactPayload: createSensitiveKeyRedactor(),
    });
    await interactionRepository.log({
      occurredAtMs: 100,
      direction: "outbound",
      kind: "redacted-event",
      severity: "info",
      outcome: "succeeded",
      byteCount: 20,
      retentionClass: "audit",
      payload: { token: "private-token", safe: "visible" },
      payloadSchemaVersion: 1,
    });
    const chunks: string[] = [];
    const metadata = await new LogsService(new LogQueryRepository(database), {
      now: () => new Date("2026-07-13T00:00:00.000Z"),
    }).export(
      { filters: {}, format: "ndjson", maxRows: 10 },
      {
        async write(chunk): Promise<void> {
          chunks.push(chunk);
        },
      },
    );
    const exported = chunks.join("");
    expect(exported).not.toContain("private-token");
    expect(exported).toContain('"token":"[REDACTED]"');
    expect(exported).toContain('"safe":"visible"');
    expect(metadata).toMatchObject({ rowCount: 1, truncated: false });
  });

  it("fails loudly before writing a corrupt row to an NDJSON export", async () => {
    const stored = await insertInteraction({
      payload: { value: 1 },
      payloadSchemaVersion: 1,
    });
    await database
      .updateTable("interactions")
      .set({ payload_sha256: "f".repeat(64) })
      .where("id", "=", stored.id)
      .executeTakeFirstOrThrow();
    const chunks: string[] = [];
    await expect(
      new LogsService(new LogQueryRepository(database)).export(
        { filters: {}, format: "ndjson", maxRows: 10 },
        {
          async write(chunk): Promise<void> {
            chunks.push(chunk);
          },
        },
      ),
    ).rejects.toBeInstanceOf(CorruptStoredInteractionError);
    expect(chunks).toEqual([]);
  });
});

describe("LogQueryRepository page boundary", () => {
  it("returns a full 100-row service page with a one-row look-ahead", async () => {
    await database
      .insertInto("interactions")
      .values(
        Array.from({ length: 101 }, (_, index) => ({
          occurred_at_ms: 1_000 + index,
          direction: "internal" as const,
          kind: "bulk-event",
          severity: "info" as const,
          outcome: "succeeded" as const,
          byte_count: 1,
          retention_class: "operational" as const,
        })),
      )
      .execute();
    const response = await new LogsService(
      new LogQueryRepository(database),
    ).list({ filters: {}, pageSize: 100 });
    expect(response.items).toHaveLength(100);
    expect(response.items[0]?.occurredAtMs).toBe(1_100);
    expect(response.items.at(-1)?.occurredAtMs).toBe(1_001);
    expect(response.summary).toMatchObject({
      returnedCount: 100,
      totalByteCount: 100,
      firstOccurredAtMs: 1_100,
      lastOccurredAtMs: 1_001,
    });
    expect(response.hasMore).toBe(true);
    expect(response.nextCursor).not.toBeNull();
  });
});
