import type { Migration } from "kysely/migration";

import { executeSqlStatements } from "./migration-utils.js";

const addStateEventDeleteCountStatements = [
  `ALTER TABLE retention_runs
  ADD COLUMN state_events_deleted INTEGER NOT NULL DEFAULT 0
  CHECK (state_events_deleted >= 0)`,
] as const;

const dropStateEventDeleteCountStatements = [
  "ALTER TABLE retention_runs DROP COLUMN state_events_deleted",
] as const;

export const eventsRetentionMigration: Migration = {
  async up(database): Promise<void> {
    await executeSqlStatements(database, addStateEventDeleteCountStatements);
  },
  async down(database): Promise<void> {
    await executeSqlStatements(database, dropStateEventDeleteCountStatements);
  },
};
