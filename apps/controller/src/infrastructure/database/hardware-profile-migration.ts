import {
  NODEMCU_ESP32S_V1_1_HARDWARE_MODEL,
  NODEMCU_ESP32S_V1_1_HARDWARE_PROFILE_ID,
} from "@aquarium/contracts";
import type { Migration } from "kysely/migration";

import { CONTROLLER_STORAGE_HEALTH_DEVICE_ID } from "../../application/maintenance/controller-storage-health-service.js";
import { executeSqlStatements } from "./migration-utils.js";

const upStatements = [
  `ALTER TABLE mapping_profiles ADD COLUMN hardware_profile_id TEXT NOT NULL DEFAULT '${NODEMCU_ESP32S_V1_1_HARDWARE_PROFILE_ID}'`,
  `ALTER TABLE devices ADD COLUMN reported_hardware_profile_id TEXT`,
  `ALTER TABLE devices ADD COLUMN reported_hardware_model TEXT`,
  `UPDATE devices SET
    reported_hardware_profile_id = '${NODEMCU_ESP32S_V1_1_HARDWARE_PROFILE_ID}',
    reported_hardware_model = '${NODEMCU_ESP32S_V1_1_HARDWARE_MODEL}'
    WHERE id <> '${CONTROLLER_STORAGE_HEALTH_DEVICE_ID}'`,
  "CREATE INDEX mapping_profiles_hardware_idx ON mapping_profiles(hardware_profile_id, id)",
] as const;

const downStatements = [
  "DROP INDEX IF EXISTS mapping_profiles_hardware_idx",
  "ALTER TABLE devices DROP COLUMN reported_hardware_model",
  "ALTER TABLE devices DROP COLUMN reported_hardware_profile_id",
  "ALTER TABLE mapping_profiles DROP COLUMN hardware_profile_id",
] as const;

export const hardwareProfileMigration: Migration = {
  async up(database): Promise<void> {
    await executeSqlStatements(database, upStatements);
  },
  async down(database): Promise<void> {
    await executeSqlStatements(database, downStatements);
  },
};
