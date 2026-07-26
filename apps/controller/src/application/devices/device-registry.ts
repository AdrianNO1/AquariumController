import {
  boundedTextSchema,
  canonicalUint32HashSchema,
  identifierSchema,
  nonnegativeSafeIntegerSchema,
} from "@aquarium/contracts";
import {
  CURRENT_ESP_FIRMWARE_VERSION,
  espFirmwareDiagnosticSchema,
  isCurrentEspFirmwareVersion,
  isSupportedEsp32PwmConfiguration,
  type EspAnnouncement,
} from "@aquarium/esp-protocol";
import { sql, type Kysely, type Selectable, type Transaction } from "kysely";
import { z } from "zod";

import {
  commitConditionalStateChange,
  commitStateChange,
  type DevicesTable,
  type DeviceStatus,
  type StateDatabaseSchema,
} from "../../infrastructure/database/index.js";

export const DEFAULT_ANNOUNCEMENT_PERSIST_INTERVAL_MS = 30_000;
export const DEFAULT_DEVICE_STALE_AFTER_MS = 90_000;
export const DEFAULT_DEVICE_OFFLINE_AFTER_MS = 300_000;

const registryAnnouncementSchema = z
  .strictObject({
    id: identifierSchema,
    name: boundedTextSchema,
    freq: z.number().int().min(1).max(40_000),
    res: z.number().int().min(1).max(16),
    status: boundedTextSchema,
    version: boundedTextSchema,
    scheduleHash: canonicalUint32HashSchema,
    lastError: espFirmwareDiagnosticSchema.optional(),
  })
  .superRefine((announcement, context) => {
    if (
      !isSupportedEsp32PwmConfiguration(announcement.freq, announcement.res)
    ) {
      context.addIssue({
        code: "custom",
        path: ["res"],
        message:
          "PWM frequency and resolution exceed the ESP32 LEDC source-clock limit",
      });
    }
  });

const announcementEventSchema = z.strictObject({
  announcement: registryAnnouncementSchema,
  receivedAtMs: nonnegativeSafeIntegerSchema,
});

export interface DeviceRegistryOptions {
  readonly announcementPersistIntervalMs?: number;
  readonly staleAfterMs?: number;
  readonly offlineAfterMs?: number;
}

export type DeviceRegistryUpdateReason =
  | "registered"
  | "reported_state_changed"
  | "connection_recovered"
  | "last_seen_coalesced"
  | "repeated_announcement"
  | "delayed_announcement"
  | "delayed_response_contact"
  | "response_contact"
  | "response_timeout"
  | "protocol_fault";

export interface DeviceRegistryUpdate {
  readonly changed: boolean;
  readonly deviceId: string;
  readonly reason: DeviceRegistryUpdateReason;
  readonly revision: number | null;
}

export interface DeviceStatusTransition {
  readonly deviceId: string;
  readonly from: DeviceStatus;
  readonly to: "stale" | "offline";
  readonly revision: number;
}

interface DeviceError {
  readonly code: string;
  readonly message: string;
}

/**
 * Owns persisted device discovery and liveness. Identical announcements are
 * deliberately coalesced: last-seen is committed at most once per configured
 * interval, while reported changes and recovery always commit immediately.
 */
export class DeviceRegistry {
  readonly #database: Kysely<StateDatabaseSchema>;
  readonly #announcementPersistIntervalMs: number;
  readonly #staleAfterMs: number;
  readonly #offlineAfterMs: number;
  #operationTail: Promise<void> = Promise.resolve();

  constructor(
    database: Kysely<StateDatabaseSchema>,
    options: DeviceRegistryOptions = {},
  ) {
    this.#database = database;
    this.#announcementPersistIntervalMs =
      options.announcementPersistIntervalMs ??
      DEFAULT_ANNOUNCEMENT_PERSIST_INTERVAL_MS;
    this.#staleAfterMs = options.staleAfterMs ?? DEFAULT_DEVICE_STALE_AFTER_MS;
    this.#offlineAfterMs =
      options.offlineAfterMs ?? DEFAULT_DEVICE_OFFLINE_AFTER_MS;
    assertPositiveDuration(
      this.#announcementPersistIntervalMs,
      "announcementPersistIntervalMs",
    );
    assertPositiveDuration(this.#staleAfterMs, "staleAfterMs");
    assertPositiveDuration(this.#offlineAfterMs, "offlineAfterMs");
    if (this.#announcementPersistIntervalMs >= this.#staleAfterMs) {
      throw new RangeError(
        "announcementPersistIntervalMs must be shorter than staleAfterMs",
      );
    }
    if (this.#staleAfterMs >= this.#offlineAfterMs) {
      throw new RangeError("staleAfterMs must be shorter than offlineAfterMs");
    }
  }

  async handleAnnouncement(event: {
    readonly announcement: EspAnnouncement;
    readonly receivedAtMs: number;
  }): Promise<DeviceRegistryUpdate> {
    const parsed = announcementEventSchema.parse(event);
    return this.#serialize(() => this.#applyAnnouncement(parsed));
  }

  async recordResponseContact(
    hardwareId: string,
    receivedAtMs: number,
  ): Promise<DeviceRegistryUpdate> {
    const parsedHardwareId = identifierSchema.parse(hardwareId);
    const parsedReceivedAtMs = nonnegativeSafeIntegerSchema.parse(receivedAtMs);
    return this.#serialize(() =>
      this.#applyResponseContact(parsedHardwareId, parsedReceivedAtMs),
    );
  }

  async recordResponseTimeout(
    hardwareId: string,
    observedAtMs: number,
  ): Promise<DeviceRegistryUpdate> {
    const parsedHardwareId = identifierSchema.parse(hardwareId);
    const parsedObservedAtMs = nonnegativeSafeIntegerSchema.parse(observedAtMs);
    return this.#serialize(() =>
      this.#applyResponseTimeout(parsedHardwareId, parsedObservedAtMs),
    );
  }

  async recordProtocolFault(
    hardwareId: string,
    observedAtMs: number,
    message: string,
  ): Promise<DeviceRegistryUpdate | null> {
    const parsedHardwareId = identifierSchema.safeParse(hardwareId);
    if (!parsedHardwareId.success) {
      return null;
    }
    const parsedObservedAtMs = nonnegativeSafeIntegerSchema.parse(observedAtMs);
    const parsedMessage = boundedTextSchema.parse(message);
    return this.#serialize(() =>
      this.#applyProtocolFault(
        parsedHardwareId.data,
        parsedObservedAtMs,
        parsedMessage,
      ),
    );
  }

  async isCommandEligible(deviceId: string): Promise<boolean> {
    const parsedDeviceId = identifierSchema.parse(deviceId);
    const device = await this.#database
      .selectFrom("devices")
      .select(["enabled", "status"])
      .where("id", "=", parsedDeviceId)
      .executeTakeFirst();
    return (
      device?.enabled === 1 &&
      ["online", "stale", "offline"].includes(device.status)
    );
  }

  async refreshConnectionStatuses(
    nowMs: number,
  ): Promise<readonly DeviceStatusTransition[]> {
    const parsedNowMs = nonnegativeSafeIntegerSchema.parse(nowMs);
    return this.#serialize(() => this.#applyConnectionStatuses(parsedNowMs));
  }

  async #applyAnnouncement(
    event: z.infer<typeof announcementEventSchema>,
  ): Promise<DeviceRegistryUpdate> {
    const announcement = event.announcement;
    const identity = await this.#database
      .selectFrom("devices")
      .select("id")
      .where("hardware_id", "=", announcement.id)
      .executeTakeFirst();
    const eventDeviceId = identity?.id ?? announcement.id;
    const committed = await commitConditionalStateChange(
      this.#database,
      {
        actor: "mqtt.device-registry",
        mutationType: "device.announcement",
        summary: `Processed announcement for device ${eventDeviceId}`,
        eventType: "device.announcement-processed",
        entityType: "device",
        entityId: eventDeviceId,
        occurredAtMs: event.receivedAtMs,
        retentionClass: "audit",
        payloadJson: JSON.stringify({
          schemaVersion: 1,
          reason: "announcement",
        }),
        payloadSchemaVersion: 1,
      },
      async (transaction) => {
        const existing = await transaction
          .selectFrom("devices")
          .selectAll()
          .where("hardware_id", "=", announcement.id)
          .executeTakeFirst();
        const mappingProfileId =
          existing?.mapping_profile_id ??
          (await matchingMappingProfileId(transaction, announcement.name));
        if (
          existing?.last_seen_at_ms !== null &&
          existing?.last_seen_at_ms !== undefined &&
          event.receivedAtMs < existing.last_seen_at_ms
        ) {
          return {
            changed: false,
            result: {
              deviceId: existing.id,
              reason: "delayed_announcement" as const,
            },
          };
        }
        if (existing === undefined) {
          const error = announcementError(announcement, {
            name: announcement.name,
            frequencyHz: announcement.freq,
            resolutionBits: announcement.res,
          });
          await transaction
            .insertInto("devices")
            .values({
              id: announcement.id,
              hardware_id: announcement.id,
              name: announcement.name,
              mapping_profile_id: mappingProfileId,
              reported_name: announcement.name,
              desired_pwm_frequency_hz: announcement.freq,
              desired_pwm_resolution_bits: announcement.res,
              reported_pwm_frequency_hz: announcement.freq,
              reported_pwm_resolution_bits: announcement.res,
              firmware_version: announcement.version,
              reported_schedule_hash: announcement.scheduleHash,
              status:
                announcement.status === "online" &&
                error?.code !== "firmware_outdated"
                  ? "online"
                  : "error",
              last_seen_at_ms: event.receivedAtMs,
              last_error_code: error?.code ?? null,
              last_error_message: error?.message ?? null,
              enabled: 1,
              created_at_ms: event.receivedAtMs,
              updated_at_ms: event.receivedAtMs,
              metadata_json: null,
              metadata_schema_version: null,
            })
            .executeTakeFirstOrThrow();
          return {
            changed: true,
            result: {
              deviceId: announcement.id,
              reason: "registered" as const,
            },
          };
        }
        if (existing.id !== eventDeviceId) {
          throw new Error(
            `Device identity changed concurrently for hardware ${announcement.id}`,
          );
        }
        const quarantinedForProtocolFault =
          existing.enabled === 0 &&
          existing.last_error_code === "protocol_invalid_response";
        const reportedError = announcementError(announcement, {
          name: existing.name,
          frequencyHz: existing.desired_pwm_frequency_hz,
          resolutionBits: existing.desired_pwm_resolution_bits,
        });
        const error = quarantinedForProtocolFault
          ? {
              code: existing.last_error_code,
              message:
                existing.last_error_message ??
                "Device returned a response that violated the wire protocol",
            }
          : reportedError;
        const nextStatus: DeviceStatus = quarantinedForProtocolFault
          ? "error"
          : announcement.status === "online" &&
              error?.code !== "firmware_outdated"
            ? "online"
            : "error";
        const reportedStateChanged =
          existing.mapping_profile_id !== mappingProfileId ||
          existing.reported_name !== announcement.name ||
          existing.reported_pwm_frequency_hz !== announcement.freq ||
          existing.reported_pwm_resolution_bits !== announcement.res ||
          existing.firmware_version !== announcement.version ||
          existing.reported_schedule_hash !== announcement.scheduleHash ||
          existing.status !== nextStatus ||
          existing.last_error_code !== (error?.code ?? null) ||
          existing.last_error_message !== (error?.message ?? null);
        const recovered =
          announcement.status === "online" &&
          ["stale", "offline", "unknown", "error"].includes(existing.status);
        const lastSeenDue =
          existing.last_seen_at_ms === null ||
          event.receivedAtMs - existing.last_seen_at_ms >=
            this.#announcementPersistIntervalMs;
        if (!reportedStateChanged && !lastSeenDue) {
          return {
            changed: false,
            result: {
              deviceId: existing.id,
              reason: "repeated_announcement" as const,
            },
          };
        }
        await transaction
          .updateTable("devices")
          .set({
            reported_name: announcement.name,
            mapping_profile_id: mappingProfileId,
            reported_pwm_frequency_hz: announcement.freq,
            reported_pwm_resolution_bits: announcement.res,
            firmware_version: announcement.version,
            reported_schedule_hash: announcement.scheduleHash,
            status: nextStatus,
            last_seen_at_ms: event.receivedAtMs,
            last_error_code: error?.code ?? null,
            last_error_message: error?.message ?? null,
            updated_at_ms: sql<number>`MAX(updated_at_ms, ${event.receivedAtMs})`,
          })
          .where("id", "=", existing.id)
          .executeTakeFirstOrThrow();
        return {
          changed: true,
          result: {
            deviceId: existing.id,
            reason: recovered
              ? ("connection_recovered" as const)
              : reportedStateChanged
                ? ("reported_state_changed" as const)
                : ("last_seen_coalesced" as const),
          },
        };
      },
    );
    return {
      changed: committed.changed,
      deviceId: committed.result.deviceId,
      reason: committed.result.reason,
      revision: committed.changed ? committed.revision : null,
    };
  }

  async #applyResponseContact(
    hardwareId: string,
    receivedAtMs: number,
  ): Promise<DeviceRegistryUpdate> {
    const identity = await this.#database
      .selectFrom("devices")
      .select("id")
      .where("hardware_id", "=", hardwareId)
      .executeTakeFirstOrThrow();
    const committed = await commitConditionalStateChange(
      this.#database,
      {
        actor: "mqtt.device-registry",
        mutationType: "device.response-contact",
        summary: `Recorded command response contact for device ${identity.id}`,
        eventType: "device.response-contact",
        entityType: "device",
        entityId: identity.id,
        occurredAtMs: receivedAtMs,
        retentionClass: "operational",
        payloadJson: JSON.stringify({
          schemaVersion: 1,
          reason: "response_contact",
        }),
        payloadSchemaVersion: 1,
      },
      async (transaction) => {
        const existing = await transaction
          .selectFrom("devices")
          .selectAll()
          .where("hardware_id", "=", hardwareId)
          .executeTakeFirstOrThrow();
        if (existing.id !== identity.id) {
          throw new Error(
            `Device identity changed concurrently for hardware ${hardwareId}`,
          );
        }
        if (
          existing.last_seen_at_ms !== null &&
          receivedAtMs < existing.last_seen_at_ms
        ) {
          return {
            changed: false,
            result: {
              deviceId: existing.id,
              reason: "delayed_response_contact" as const,
            },
          };
        }
        const recovered = ["stale", "offline", "unknown"].includes(
          existing.status,
        );
        const lastSeenDue =
          existing.last_seen_at_ms === null ||
          receivedAtMs - existing.last_seen_at_ms >=
            this.#announcementPersistIntervalMs;
        if (!recovered && !lastSeenDue) {
          return {
            changed: false,
            result: {
              deviceId: existing.id,
              reason: "response_contact" as const,
            },
          };
        }
        await transaction
          .updateTable("devices")
          .set({
            status: existing.status === "error" ? "error" : "online",
            last_seen_at_ms: receivedAtMs,
            updated_at_ms: sql<number>`MAX(updated_at_ms, ${receivedAtMs})`,
          })
          .where("id", "=", existing.id)
          .executeTakeFirstOrThrow();
        return {
          changed: true,
          result: {
            deviceId: existing.id,
            reason: "response_contact" as const,
          },
        };
      },
    );
    return {
      changed: committed.changed,
      deviceId: committed.result.deviceId,
      reason: committed.result.reason,
      revision: committed.changed ? committed.revision : null,
    };
  }

  async #applyResponseTimeout(
    hardwareId: string,
    observedAtMs: number,
  ): Promise<DeviceRegistryUpdate> {
    const identity = await this.#database
      .selectFrom("devices")
      .select("id")
      .where("hardware_id", "=", hardwareId)
      .executeTakeFirstOrThrow();
    const committed = await commitConditionalStateChange(
      this.#database,
      {
        actor: "mqtt.device-registry",
        mutationType: "device.response-timeout",
        summary: `Marked device ${identity.id} offline after a response timeout`,
        eventType: "device.response-timeout",
        entityType: "device",
        entityId: identity.id,
        occurredAtMs: observedAtMs,
        retentionClass: "critical",
        payloadJson: JSON.stringify({
          schemaVersion: 1,
          status: "offline",
          excluded: false,
        }),
        payloadSchemaVersion: 1,
      },
      async (transaction) => {
        const existing = await transaction
          .selectFrom("devices")
          .selectAll()
          .where("hardware_id", "=", hardwareId)
          .executeTakeFirstOrThrow();
        if (
          existing.enabled !== 1 ||
          existing.status === "error" ||
          existing.status === "unknown" ||
          existing.status === "offline"
        ) {
          return {
            changed: false,
            result: { deviceId: existing.id },
          };
        }
        await transaction
          .updateTable("devices")
          .set({
            status: "offline",
            updated_at_ms: sql<number>`MAX(updated_at_ms, ${observedAtMs})`,
          })
          .where("id", "=", existing.id)
          .executeTakeFirstOrThrow();
        return { changed: true, result: { deviceId: existing.id } };
      },
    );
    return {
      changed: committed.changed,
      deviceId: committed.result.deviceId,
      reason: "response_timeout",
      revision: committed.changed ? committed.revision : null,
    };
  }

  async #applyProtocolFault(
    hardwareId: string,
    observedAtMs: number,
    message: string,
  ): Promise<DeviceRegistryUpdate | null> {
    const identity = await this.#database
      .selectFrom("devices")
      .select("id")
      .where("hardware_id", "=", hardwareId)
      .executeTakeFirst();
    if (identity === undefined) {
      return null;
    }
    const committed = await commitConditionalStateChange(
      this.#database,
      {
        actor: "mqtt.device-registry",
        mutationType: "device.protocol-quarantine",
        summary: `Quarantined device ${identity.id} after an invalid response`,
        eventType: "device.protocol-quarantined",
        entityType: "device",
        entityId: identity.id,
        occurredAtMs: observedAtMs,
        retentionClass: "critical",
        payloadJson: JSON.stringify({
          schemaVersion: 1,
          code: "protocol_invalid_response",
          excluded: true,
        }),
        payloadSchemaVersion: 1,
      },
      async (transaction) => {
        const existing = await transaction
          .selectFrom("devices")
          .selectAll()
          .where("hardware_id", "=", hardwareId)
          .executeTakeFirstOrThrow();
        if (
          existing.enabled === 0 &&
          existing.status === "error" &&
          existing.last_error_code === "protocol_invalid_response" &&
          existing.last_error_message === message
        ) {
          return {
            changed: false,
            result: { deviceId: existing.id },
          };
        }
        await transaction
          .updateTable("devices")
          .set({
            enabled: 0,
            status: "error",
            last_error_code: "protocol_invalid_response",
            last_error_message: message,
            updated_at_ms: sql<number>`MAX(updated_at_ms, ${observedAtMs})`,
          })
          .where("id", "=", existing.id)
          .executeTakeFirstOrThrow();
        return { changed: true, result: { deviceId: existing.id } };
      },
    );
    return {
      changed: committed.changed,
      deviceId: committed.result.deviceId,
      reason: "protocol_fault",
      revision: committed.changed ? committed.revision : null,
    };
  }

  async #applyConnectionStatuses(
    nowMs: number,
  ): Promise<readonly DeviceStatusTransition[]> {
    const devices = await this.#database
      .selectFrom("devices")
      .selectAll()
      .where("enabled", "=", 1)
      .where("last_seen_at_ms", "is not", null)
      .where("status", "in", ["online", "stale"])
      .orderBy("id")
      .execute();
    const transitions: DeviceStatusTransition[] = [];

    for (const device of devices) {
      if (device.last_seen_at_ms === null || nowMs < device.last_seen_at_ms) {
        continue;
      }
      const ageMs = nowMs - device.last_seen_at_ms;
      const nextStatus =
        ageMs >= this.#offlineAfterMs
          ? "offline"
          : ageMs >= this.#staleAfterMs
            ? "stale"
            : null;
      if (nextStatus === null || device.status === nextStatus) {
        continue;
      }
      const committed = await this.#commitStatusTransition(
        device,
        nextStatus,
        nowMs,
      );
      transitions.push({
        deviceId: device.id,
        from: device.status,
        to: nextStatus,
        revision: committed,
      });
    }
    return transitions;
  }

  async #commitStatusTransition(
    device: Selectable<DevicesTable>,
    nextStatus: "stale" | "offline",
    nowMs: number,
  ): Promise<number> {
    const committed = await commitStateChange(
      this.#database,
      {
        actor: "runtime.device-health",
        mutationType: "device.connection-status",
        summary: `Marked device ${device.id} ${nextStatus}`,
        eventType: `device.connection-${nextStatus}`,
        entityType: "device",
        entityId: device.id,
        occurredAtMs: nowMs,
        retentionClass: nextStatus === "offline" ? "critical" : "operational",
        payloadJson: JSON.stringify({
          schemaVersion: 1,
          from: device.status,
          to: nextStatus,
          lastSeenAtMs: device.last_seen_at_ms,
        }),
        payloadSchemaVersion: 1,
      },
      async (transaction) => {
        const update = await transaction
          .updateTable("devices")
          .set({
            status: nextStatus,
            updated_at_ms: sql<number>`MAX(updated_at_ms, ${nowMs})`,
          })
          .where("id", "=", device.id)
          .where("status", "=", device.status)
          .executeTakeFirst();
        if (update.numUpdatedRows !== 1n) {
          throw new Error(
            `Device ${device.id} changed concurrently during health transition`,
          );
        }
      },
    );
    return committed.revision;
  }

  #serialize<Result>(operation: () => Promise<Result>): Promise<Result> {
    const result = this.#operationTail.then(operation, operation);
    this.#operationTail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

async function matchingMappingProfileId(
  transaction: Transaction<StateDatabaseSchema>,
  deviceName: string,
): Promise<string | null> {
  const profiles = await transaction
    .selectFrom("mapping_profiles")
    .select(["id", "device_name_prefix"])
    .orderBy("id", "asc")
    .execute();
  const matches = profiles.filter((profile) =>
    deviceName.startsWith(profile.device_name_prefix),
  );
  if (matches.length > 1) {
    throw new Error(
      `Device ${deviceName} matches multiple mapping profile prefixes`,
    );
  }
  return matches[0]?.id ?? null;
}

function announcementError(
  announcement: z.infer<typeof registryAnnouncementSchema>,
  desired: {
    readonly name: string;
    readonly frequencyHz: number;
    readonly resolutionBits: number;
  },
): DeviceError | null {
  if (announcement.status !== "online") {
    return {
      code: "device_reported_status",
      message: `Device reported status ${announcement.status}`,
    };
  }
  if (!isCurrentEspFirmwareVersion(announcement.version)) {
    return {
      code: "firmware_outdated",
      message: `Firmware ${announcement.version} is outdated; install ${CURRENT_ESP_FIRMWARE_VERSION}`,
    };
  }
  if (
    announcement.name !== desired.name ||
    announcement.freq !== desired.frequencyHz ||
    announcement.res !== desired.resolutionBits
  ) {
    return {
      code: "configuration_mismatch",
      message: "Reported configuration differs from desired configuration",
    };
  }
  if (announcement.lastError?.active === true) {
    return {
      code: `firmware_${announcement.lastError.code}`,
      message: announcement.lastError.message,
    };
  }
  return null;
}

function assertPositiveDuration(value: number, field: string): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new RangeError(`${field} must be a positive safe integer`);
  }
}
