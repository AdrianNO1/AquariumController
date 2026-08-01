import { sql } from "kysely";
import type { Migration } from "kysely/migration";

export const controlAreaThrottleMigration: Migration = {
  async up(database): Promise<void> {
    await sql`
      INSERT INTO throttles (
        id,
        type_key,
        percentage,
        created_at_ms,
        updated_at_ms
      )
      SELECT
        'throttle-' || area.type_key,
        area.type_key,
        100.0,
        area.created_at_ms,
        area.updated_at_ms
      FROM control_areas AS area
      WHERE NOT EXISTS (
        SELECT 1
        FROM throttles AS throttle
        WHERE throttle.type_key = area.type_key
      )
      ORDER BY area.display_order
    `.execute(database);
  },
  async down(): Promise<void> {
    // This is a data repair. The inserted multipliers become ordinary user
    // configuration and cannot be distinguished safely during a downgrade.
  },
};
