import {
  gainSchema,
  identifierSchema,
  percentageSchema,
} from "@aquarium/contracts";
import {
  scheduleGraphFromPoints,
  validateScheduleGraph,
  type SchedulePoint,
} from "@aquarium/domain";
import { isSupportedEspFirmwareVersion } from "@aquarium/esp-protocol";
import { sql, type Kysely } from "kysely";
import { z } from "zod";

import type {
  ActiveOutputProjection,
  ActiveOutputProjectionReader,
  ActiveScheduledOutput,
  InvalidScheduledOutputDiagnostic,
} from "../../application/scheduling/output-refresh-scheduler.js";
import type { StateDatabaseSchema } from "./types.js";

const projectionRowSchema = z.strictObject({
  deviceId: identifierSchema,
  mappingId: identifierSchema,
  channelId: identifierSchema,
  pin: z.number().int().min(0).max(63),
  throttlePercent: percentageSchema,
  outputGain: gainSchema,
  firmwareVersion: z.string().min(1).nullable(),
  scheduleId: identifierSchema.nullable(),
  pointPosition: z.number().int().nonnegative().nullable(),
  pointMinute: z.number().int().min(0).max(1_439).nullable(),
  pointPercent: percentageSchema.nullable(),
});

interface MutableScheduledOutput {
  readonly deviceId: string;
  readonly mappingId: string;
  readonly channelId: string;
  readonly pin: number;
  readonly throttlePercent: number;
  readonly outputGain: number;
  readonly points: SchedulePoint[];
}

/** Reads one transactionally consistent, normalized refresh projection. */
export class RefreshProjectionRepository implements ActiveOutputProjectionReader {
  constructor(private readonly database: Kysely<StateDatabaseSchema>) {}

  async readActiveOutputs(): Promise<ActiveOutputProjection> {
    const rows = await this.database
      .selectFrom("devices as device")
      .innerJoin(
        "mapping_profiles as profile",
        "profile.id",
        "device.mapping_profile_id",
      )
      .innerJoin(
        "pin_mappings as mapping",
        "mapping.mapping_profile_id",
        "profile.id",
      )
      .innerJoin("channels as channel", "channel.id", "mapping.channel_id")
      .innerJoin("throttles as throttle", "throttle.id", "channel.throttle_id")
      .leftJoin("schedules as schedule", "schedule.channel_id", "channel.id")
      .leftJoin("schedule_points as point", "point.schedule_id", "schedule.id")
      .select([
        "device.id as deviceId",
        "mapping.id as mappingId",
        "channel.id as channelId",
        "mapping.pin as pin",
        "throttle.percentage as throttlePercent",
        "profile.output_gain as outputGain",
        "device.firmware_version as firmwareVersion",
        "schedule.id as scheduleId",
        "point.position as pointPosition",
        "point.minute_of_day as pointMinute",
        "point.percentage as pointPercent",
      ])
      .where("device.enabled", "=", 1)
      .where("device.status", "in", ["online", "stale", "offline"])
      .where("mapping.enabled", "=", 1)
      .where("channel.enabled", "=", 1)
      .where((expression) =>
        expression.or([
          expression("schedule.id", "is", null),
          expression("schedule.enabled", "=", 1),
        ]),
      )
      .orderBy(
        sql<number>`CASE ${sql.ref("device.status")}
          WHEN 'online' THEN 0
          WHEN 'stale' THEN 1
          ELSE 2
        END`,
        "asc",
      )
      .orderBy("device.id", "asc")
      .orderBy("mapping.display_order", "asc")
      .orderBy("mapping.pin", "asc")
      .orderBy("point.position", "asc")
      .execute();

    const grouped = new Map<string, MutableScheduledOutput>();
    for (const rawRow of rows) {
      const row = projectionRowSchema.parse(rawRow);
      if (
        row.firmwareVersion === null ||
        !isSupportedEspFirmwareVersion(row.firmwareVersion)
      ) {
        continue;
      }
      const key = `${row.deviceId}\0${row.mappingId}`;
      let output = grouped.get(key);
      if (output === undefined) {
        output = {
          deviceId: row.deviceId,
          mappingId: row.mappingId,
          channelId: row.channelId,
          pin: row.pin,
          throttlePercent: row.throttlePercent,
          outputGain: row.outputGain,
          points: [],
        };
        grouped.set(key, output);
      }
      const pointFields = [
        row.pointPosition,
        row.pointMinute,
        row.pointPercent,
      ];
      const presentPointFields = pointFields.filter(
        (field) => field !== null,
      ).length;
      if (
        presentPointFields !== 0 &&
        presentPointFields !== pointFields.length
      ) {
        throw new TypeError(
          `Schedule point projection is incomplete for mapping ${row.mappingId}`,
        );
      }
      if (row.pointMinute !== null && row.pointPercent !== null) {
        if (row.scheduleId === null) {
          throw new TypeError(
            `Mapping ${row.mappingId} projected a point without a schedule`,
          );
        }
        output.points.push({
          minute: row.pointMinute,
          percent: row.pointPercent,
        });
      }
    }

    const outputs: ActiveScheduledOutput[] = [];
    const diagnostics: InvalidScheduledOutputDiagnostic[] = [];
    for (const output of grouped.values()) {
      const validation = validateScheduleGraph(
        scheduleGraphFromPoints(output.points),
      );
      if (!validation.ok) {
        diagnostics.push({
          code: "invalid_schedule",
          deviceId: output.deviceId,
          mappingId: output.mappingId,
          channelId: output.channelId,
          issues: validation.issues,
        });
        continue;
      }
      outputs.push({
        deviceId: output.deviceId,
        mappingId: output.mappingId,
        channelId: output.channelId,
        pin: output.pin,
        throttlePercent: output.throttlePercent,
        outputGain: output.outputGain,
        schedule: validation.graph,
      });
    }
    return { outputs, diagnostics };
  }
}
