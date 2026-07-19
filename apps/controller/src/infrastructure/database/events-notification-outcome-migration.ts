import type { Migration } from "kysely/migration";

import { executeSqlStatements } from "./migration-utils.js";

const addNotificationOutcomeIdempotencyStatements = [
  `CREATE UNIQUE INDEX interactions_notification_delivery_operation_idx
  ON interactions(operation_id)
  WHERE
    kind = 'alert.notification-delivery' AND
    operation_id IS NOT NULL`,
] as const;

const dropNotificationOutcomeIdempotencyStatements = [
  "DROP INDEX IF EXISTS interactions_notification_delivery_operation_idx",
] as const;

export const eventsNotificationOutcomeMigration: Migration = {
  async up(database): Promise<void> {
    await executeSqlStatements(
      database,
      addNotificationOutcomeIdempotencyStatements,
    );
  },
  async down(database): Promise<void> {
    await executeSqlStatements(
      database,
      dropNotificationOutcomeIdempotencyStatements,
    );
  },
};
