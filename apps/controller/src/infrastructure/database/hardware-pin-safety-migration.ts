import {
  hardwareProfileById,
  NODEMCU_ESP32S_V1_1_HARDWARE_PROFILE_ID,
} from "@aquarium/contracts";
import type { Migration } from "kysely/migration";

import { executeSqlStatements } from "./migration-utils.js";

const allowedPwmPins = hardwareProfileById(
  NODEMCU_ESP32S_V1_1_HARDWARE_PROFILE_ID,
).pwmPins.join(", ");

const upStatements = [
  `UPDATE pin_mappings
    SET enabled = 0
    WHERE enabled = 1
      AND pin NOT IN (${allowedPwmPins})
      AND mapping_profile_id IN (
        SELECT id
        FROM mapping_profiles
        WHERE hardware_profile_id = '${NODEMCU_ESP32S_V1_1_HARDWARE_PROFILE_ID}'
      )`,
] as const;

export const hardwarePinSafetyMigration: Migration = {
  async up(database): Promise<void> {
    await executeSqlStatements(database, upStatements);
  },
  async down(): Promise<void> {
    // This is a safety repair. Previously active unsupported mappings cannot
    // be distinguished from mappings that were already disabled, so a
    // downgrade must not re-enable either group.
  },
};
