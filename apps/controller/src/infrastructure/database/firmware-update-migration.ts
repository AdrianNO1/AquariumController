import type { Migration } from "kysely/migration";

import { executeSqlStatements } from "./migration-utils.js";

const upStatements = [
  `ALTER TABLE devices ADD COLUMN output_state_json TEXT CHECK (
    output_state_json IS NULL OR json_valid(output_state_json)
  )`,
  `ALTER TABLE devices ADD COLUMN ota_status_json TEXT CHECK (
    ota_status_json IS NULL OR json_valid(ota_status_json)
  )`,
  `CREATE TABLE firmware_update_requests (
    device_id TEXT PRIMARY KEY NOT NULL REFERENCES devices(id) ON UPDATE CASCADE ON DELETE CASCADE,
    target_version TEXT NOT NULL COLLATE BINARY,
    mode TEXT NOT NULL CHECK (mode IN ('immediate', 'when_off')),
    status TEXT NOT NULL CHECK (status IN (
      'pending', 'waiting_for_device', 'waiting_for_off', 'accepted',
      'downloading', 'verifying', 'rebooting', 'probation', 'succeeded',
      'failed', 'usb_required'
    )),
    progress INTEGER NOT NULL DEFAULT 0 CHECK (progress BETWEEN 0 AND 100),
    operation_id TEXT REFERENCES control_operations(id) ON UPDATE CASCADE ON DELETE SET NULL,
    error_message TEXT,
    requested_at_ms INTEGER NOT NULL CHECK (requested_at_ms >= 0),
    updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= requested_at_ms),
    CHECK (length(target_version) BETWEEN 1 AND 31),
    CHECK (error_message IS NULL OR length(error_message) BETWEEN 1 AND 256)
  ) STRICT`,
  `CREATE TABLE firmware_rollout_policy (
    singleton_key INTEGER PRIMARY KEY NOT NULL CHECK (singleton_key = 1),
    target_version TEXT NOT NULL COLLATE BINARY,
    mode TEXT NOT NULL CHECK (mode IN ('immediate', 'when_off')),
    enabled INTEGER NOT NULL CHECK (enabled IN (0, 1)),
    requested_at_ms INTEGER NOT NULL CHECK (requested_at_ms >= 0),
    updated_at_ms INTEGER NOT NULL CHECK (updated_at_ms >= requested_at_ms),
    CHECK (length(target_version) BETWEEN 1 AND 31)
  ) STRICT`,
  `INSERT INTO firmware_rollout_policy (
    singleton_key, target_version, mode, enabled, requested_at_ms, updated_at_ms
  ) VALUES (1, '5.0.0', 'when_off', 0, 0, 0)`,
] as const;

const downStatements = [
  "DROP TABLE firmware_update_requests",
  "DROP TABLE firmware_rollout_policy",
  "ALTER TABLE devices DROP COLUMN ota_status_json",
  "ALTER TABLE devices DROP COLUMN output_state_json",
] as const;

export const firmwareUpdateMigration: Migration = {
  async up(database): Promise<void> {
    await executeSqlStatements(database, upStatements);
  },
  async down(database): Promise<void> {
    await executeSqlStatements(database, downStatements);
  },
};
