import type { Migration } from "kysely/migration";

import { executeSqlStatements } from "./migration-utils.js";

const addChannelColorStatements = [
  `ALTER TABLE channels
  ADD COLUMN color TEXT NOT NULL DEFAULT '#6f5bd5'
  CHECK (
    length(color) = 7 AND
    substr(color, 1, 1) = '#' AND
    substr(color, 2) NOT GLOB '*[^0-9a-f]*'
  )`,
  `UPDATE channels
  SET color = CASE (
    (
      SELECT COUNT(*) - 1
      FROM channels AS preceding
      WHERE
        preceding.kind = channels.kind AND
        (
          preceding.display_order < channels.display_order OR
          (
            preceding.display_order = channels.display_order AND
            preceding.id <= channels.id
          )
        )
    ) % 12
  )
    WHEN 0 THEN '#6f5bd5'
    WHEN 1 THEN '#a747a9'
    WHEN 2 THEN '#3c66db'
    WHEN 3 THEN '#13a4c7'
    WHEN 4 THEN '#80909a'
    WHEN 5 THEN '#dc5450'
    WHEN 6 THEN '#2aa7a0'
    WHEN 7 THEN '#e0953b'
    WHEN 8 THEN '#5caf62'
    WHEN 9 THEN '#d46a9a'
    WHEN 10 THEN '#7b74d8'
    ELSE '#bc6c3e'
  END`,
] as const;

const dropChannelColorStatements = [
  "ALTER TABLE channels DROP COLUMN color",
] as const;

export const channelColorMigration: Migration = {
  async up(database): Promise<void> {
    await executeSqlStatements(database, addChannelColorStatements);
  },
  async down(database): Promise<void> {
    await executeSqlStatements(database, dropChannelColorStatements);
  },
};
