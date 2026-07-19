import type { Kysely } from "kysely";
import { afterEach, describe, expect, it } from "vitest";

import {
  openEventsDatabase,
  type EventsDatabaseSchema,
} from "../database/index.js";
import {
  DEFAULT_RETENTION_POLICIES,
  seedDefaultRetentionPolicies,
} from "./retention-policies.js";

const openDatabases: Kysely<EventsDatabaseSchema>[] = [];

afterEach(async () => {
  await Promise.all(
    openDatabases.splice(0).map((database) => database.destroy()),
  );
});

describe("default retention policies", () => {
  it("seeds every explicit class once with a live budget below ten GiB", async () => {
    const database = await openEventsDatabase({ filename: ":memory:" });
    openDatabases.push(database);

    await expect(
      seedDefaultRetentionPolicies(database, 1_000),
    ).resolves.toEqual(
      DEFAULT_RETENTION_POLICIES.map((policy) => policy.retentionClass),
    );
    const rows = await database
      .selectFrom("retention_policies")
      .selectAll()
      .orderBy("priority")
      .execute();
    expect(rows).toEqual(
      DEFAULT_RETENTION_POLICIES.map((policy) => ({
        retention_class: policy.retentionClass,
        retain_for_ms: policy.retainForMs,
        byte_budget: policy.byteBudget,
        archive_before_delete: policy.archiveBeforeDelete ? 1 : 0,
        priority: policy.priority,
        enabled: 1,
        updated_at_ms: 1_000,
      })),
    );
    expect(
      rows.reduce((total, policy) => total + policy.byte_budget, 0),
    ).toBeLessThan(10 * 1_024 * 1_024 * 1_024);
  });

  it("preserves an existing operator policy and rejects invalid time", async () => {
    const database = await openEventsDatabase({ filename: ":memory:" });
    openDatabases.push(database);
    await database
      .insertInto("retention_policies")
      .values({
        retention_class: "critical",
        retain_for_ms: 123_456,
        byte_budget: 654_321,
        archive_before_delete: 0,
        priority: 99,
        enabled: 0,
        updated_at_ms: 5,
      })
      .executeTakeFirstOrThrow();

    const inserted = await seedDefaultRetentionPolicies(database, 2_000);

    expect(inserted).not.toContain("critical");
    await expect(
      database
        .selectFrom("retention_policies")
        .selectAll()
        .where("retention_class", "=", "critical")
        .executeTakeFirstOrThrow(),
    ).resolves.toMatchObject({
      retain_for_ms: 123_456,
      byte_budget: 654_321,
      enabled: 0,
      updated_at_ms: 5,
    });
    await expect(seedDefaultRetentionPolicies(database, -1)).rejects.toThrow(
      "seed time",
    );
  });
});
