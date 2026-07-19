import type { Migration } from "kysely/migration";

import { executeSqlStatements } from "./migration-utils.js";

const addOperatorConcurrencyStatements = [
  `CREATE TABLE operator_concurrency (
    singleton_key INTEGER PRIMARY KEY NOT NULL CHECK (singleton_key = 1),
    last_operator_revision INTEGER NOT NULL CHECK (
      last_operator_revision BETWEEN 0 AND 9007199254740991
    )
  ) STRICT`,
  `INSERT INTO operator_concurrency (
    singleton_key,
    last_operator_revision
  )
  SELECT 1, COALESCE(MAX(revision), 0)
  FROM state_revisions`,
] as const;

const dropOperatorConcurrencyStatements = [
  "DROP TABLE IF EXISTS operator_concurrency",
] as const;

export const operatorConcurrencyMigration: Migration = {
  async up(database): Promise<void> {
    await executeSqlStatements(database, addOperatorConcurrencyStatements);
  },
  async down(database): Promise<void> {
    await executeSqlStatements(database, dropOperatorConcurrencyStatements);
  },
};
