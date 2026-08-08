import type { Migration } from "kysely/migration";

import { executeSqlStatements } from "./migration-utils.js";

const upStatements = [
  `ALTER TABLE firmware_update_requests
    ADD COLUMN transition_seconds INTEGER NOT NULL DEFAULT 5
    CHECK (transition_seconds BETWEEN 0 AND 60)`,
  `ALTER TABLE firmware_rollout_policy
    ADD COLUMN transition_seconds INTEGER NOT NULL DEFAULT 5
    CHECK (transition_seconds BETWEEN 0 AND 60)`,
] as const;

const downStatements = [
  "ALTER TABLE firmware_rollout_policy DROP COLUMN transition_seconds",
  "ALTER TABLE firmware_update_requests DROP COLUMN transition_seconds",
] as const;

export const otaTransitionMigration: Migration = {
  async up(database): Promise<void> {
    await executeSqlStatements(database, upStatements);
  },
  async down(database): Promise<void> {
    await executeSqlStatements(database, downStatements);
  },
};
