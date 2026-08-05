import { sql } from "kysely";
import type { Migration } from "kysely/migration";

import { executeSqlStatements } from "./migration-utils.js";

const createAreaScopedChannels = `CREATE TABLE channels_replacement (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL COLLATE BINARY,
  kind TEXT NOT NULL,
  throttle_id TEXT NOT NULL REFERENCES throttles(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  display_order INTEGER NOT NULL CHECK (display_order >= 0),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
  color TEXT NOT NULL DEFAULT '#6f5bd5' CHECK (
    length(color) = 7 AND
    substr(color, 1, 1) = '#' AND
    substr(color, 2) NOT GLOB '*[^0-9a-f]*'
  ),
  UNIQUE (kind, name),
  CHECK (length(id) > 0),
  CHECK (length(name) > 0),
  CHECK (length(kind) > 0)
) STRICT`;

const createGloballyScopedChannels = `CREATE TABLE channels_replacement (
  id TEXT PRIMARY KEY NOT NULL,
  name TEXT NOT NULL COLLATE BINARY UNIQUE,
  kind TEXT NOT NULL,
  throttle_id TEXT NOT NULL REFERENCES throttles(id) ON UPDATE CASCADE ON DELETE RESTRICT,
  display_order INTEGER NOT NULL CHECK (display_order >= 0),
  enabled INTEGER NOT NULL DEFAULT 1 CHECK (enabled IN (0, 1)),
  created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
  updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
  color TEXT NOT NULL DEFAULT '#6f5bd5' CHECK (
    length(color) = 7 AND
    substr(color, 1, 1) = '#' AND
    substr(color, 2) NOT GLOB '*[^0-9a-f]*'
  ),
  CHECK (length(id) > 0),
  CHECK (length(name) > 0),
  CHECK (length(kind) > 0)
) STRICT`;

const replaceChannelsStatements = [
  `INSERT INTO channels_replacement (
    id,
    name,
    kind,
    throttle_id,
    display_order,
    enabled,
    created_at_ms,
    updated_at_ms,
    color
  )
  SELECT
    id,
    name,
    kind,
    throttle_id,
    display_order,
    enabled,
    created_at_ms,
    updated_at_ms,
    color
  FROM channels`,
  "DROP TABLE channels",
  "ALTER TABLE channels_replacement RENAME TO channels",
  "CREATE INDEX channels_throttle_order_idx ON channels(throttle_id, display_order)",
] as const;

async function assertForeignKeysRemainValid(
  database: Parameters<Migration["up"]>[0],
): Promise<void> {
  const result = await sql<{
    readonly table: string;
    readonly rowid: number | null;
    readonly parent: string;
    readonly fkid: number;
  }>`PRAGMA foreign_key_check`.execute(database);
  if (result.rows.length > 0) {
    throw new Error(
      `Channel-name scope migration introduced ${result.rows.length} foreign-key violation(s)`,
    );
  }
}

async function replaceChannels(
  database: Parameters<Migration["up"]>[0],
  createStatement: string,
): Promise<void> {
  await executeSqlStatements(database, [
    createStatement,
    ...replaceChannelsStatements,
  ]);
  await assertForeignKeysRemainValid(database);
}

export const channelNameScopeMigration: Migration = {
  async up(database): Promise<void> {
    await replaceChannels(database, createAreaScopedChannels);
  },
  async down(database): Promise<void> {
    await replaceChannels(database, createGloballyScopedChannels);
  },
};
