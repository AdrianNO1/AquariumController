import type { Migration } from "kysely/migration";

import { CONTROL_AREA_DEFINITIONS } from "./control-area-definitions.js";
import { executeSqlStatements } from "./migration-utils.js";

const createControlAreasStatements = [
  `CREATE TABLE control_areas (
    slug TEXT PRIMARY KEY NOT NULL COLLATE BINARY,
    type_key TEXT NOT NULL COLLATE BINARY UNIQUE,
    label TEXT NOT NULL COLLATE BINARY UNIQUE,
    display_order INTEGER NOT NULL UNIQUE CHECK (display_order >= 0),
    created_at_ms INTEGER NOT NULL CHECK (created_at_ms >= 0),
    updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= created_at_ms),
    CHECK (length(slug) BETWEEN 1 AND 64),
    CHECK (length(type_key) BETWEEN 1 AND 64),
    CHECK (length(label) BETWEEN 1 AND 256)
  ) STRICT`,
] as const;

const dropControlAreasStatements = ["DROP TABLE control_areas"] as const;

export const controlAreaMigration: Migration = {
  async up(database): Promise<void> {
    await executeSqlStatements(database, createControlAreasStatements);
    await database
      .insertInto("control_areas")
      .values(
        CONTROL_AREA_DEFINITIONS.map((area, displayOrder) => ({
          slug: area.slug,
          type_key: area.typeKey,
          label: area.label,
          display_order: displayOrder,
          created_at_ms: 0,
          updated_at_ms: 0,
        })),
      )
      .execute();
  },
  async down(database): Promise<void> {
    await executeSqlStatements(database, dropControlAreasStatements);
  },
};
