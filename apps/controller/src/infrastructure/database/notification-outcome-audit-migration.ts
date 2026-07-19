import type { Migration } from "kysely/migration";

import { executeSqlStatements } from "./migration-utils.js";

const addNotificationOutcomeAuditStatements = [
  `ALTER TABLE notification_deliveries
  ADD COLUMN outcome_audit_recorded_at_ms INTEGER
  CHECK (
    outcome_audit_recorded_at_ms IS NULL OR
    (
      status IN ('delivered', 'failed', 'outcome_unknown') AND
      completed_at_ms IS NOT NULL AND
      outcome_audit_recorded_at_ms BETWEEN completed_at_ms AND 8640000000000000
    )
  )`,
  `CREATE INDEX notification_deliveries_pending_audit_idx
  ON notification_deliveries(completed_at_ms, id)
  WHERE
    status IN ('delivered', 'failed', 'outcome_unknown') AND
    outcome_audit_recorded_at_ms IS NULL`,
] as const;

const dropNotificationOutcomeAuditStatements = [
  "DROP INDEX IF EXISTS notification_deliveries_pending_audit_idx",
  "ALTER TABLE notification_deliveries DROP COLUMN outcome_audit_recorded_at_ms",
] as const;

export const notificationOutcomeAuditMigration: Migration = {
  async up(database): Promise<void> {
    await executeSqlStatements(database, addNotificationOutcomeAuditStatements);
  },
  async down(database): Promise<void> {
    await executeSqlStatements(
      database,
      dropNotificationOutcomeAuditStatements,
    );
  },
};
