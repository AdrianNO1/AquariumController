import { sql } from "kysely";
import type { Migration } from "kysely/migration";

type MigrationDatabase = Parameters<Migration["up"]>[0];

export async function executeSqlStatements(
  database: MigrationDatabase,
  statements: readonly string[],
): Promise<void> {
  for (const statement of statements) {
    await sql.raw(statement).execute(database);
  }
}
