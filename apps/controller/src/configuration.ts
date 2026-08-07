import { z } from "zod";
import { join, resolve } from "node:path";

import { identifierSchema } from "@aquarium/contracts";

import { validateWebhookAlertNotifierOptions } from "./infrastructure/notifications/webhook-alert-notifier.js";

const PRODUCTION_MQTT_CONFIRMATION = "ENABLE_PRODUCTION_AQUARIUM_MQTT";

const environmentSchema = z
  .object({
    AQUARIUM_HOST: z.string().min(1).default("127.0.0.1"),
    AQUARIUM_PORT: z.coerce.number().int().min(1).max(65_535).default(3001),
    AQUARIUM_SSE_REPLAY_LIMIT: z.coerce
      .number()
      .int()
      .min(1)
      .max(10_000)
      .default(1_000),
    AQUARIUM_WEB_ROOT: z.string().min(1).optional(),
    AQUARIUM_FIRMWARE_BASE_URL: z.string().url().optional(),
    AQUARIUM_FIRMWARE_DIRECTORY: z.string().min(1).optional(),
    AQUARIUM_DATA_DIRECTORY: z.string().min(1).optional(),
    AQUARIUM_STATE_DB_PATH: z.string().min(1).optional(),
    AQUARIUM_EVENTS_DB_PATH: z.string().min(1).optional(),
    AQUARIUM_ARCHIVE_DIRECTORY: z.string().min(1).optional(),
    AQUARIUM_BACKUP_DIRECTORY: z.string().min(1).optional(),
    AQUARIUM_BACKUP_FRESHNESS_THRESHOLD_MS: z.coerce
      .number()
      .int()
      .min(60_000)
      .max(2_592_000_000)
      .default(129_600_000),
    AQUARIUM_RETENTION_STALE_RUN_AFTER_MS: z.coerce
      .number()
      .int()
      .min(60_000)
      .max(604_800_000)
      .default(21_600_000),
    AQUARIUM_STORAGE_HEALTH_INTERVAL_MS: z.coerce
      .number()
      .int()
      .min(10_000)
      .max(86_400_000)
      .default(300_000),
    AQUARIUM_STORAGE_MINIMUM_FREE_BYTES: z.coerce
      .number()
      .int()
      .min(1)
      .max(Number.MAX_SAFE_INTEGER)
      .default(1_073_741_824),
    AQUARIUM_STORAGE_MAXIMUM_PROJECTED_YEAR_BYTES: z.coerce
      .number()
      .int()
      .min(1)
      .max(Number.MAX_SAFE_INTEGER)
      .default(10_737_418_240),
    AQUARIUM_ALERT_WEBHOOK_URL: z.string().min(1).optional(),
    AQUARIUM_ALERT_WEBHOOK_KEY: z.string().min(1).optional(),
    AQUARIUM_ALERT_WEBHOOK_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .min(1)
      .max(60_000)
      .optional(),
    AQUARIUM_ALERT_WEBHOOK_AUTH_HEADER_NAME: z.string().min(1).optional(),
    AQUARIUM_ALERT_WEBHOOK_AUTH_HEADER_VALUE: z.string().min(1).optional(),
    AQUARIUM_RUNTIME_MODE: z
      .enum(["development", "test", "production"])
      .default("development"),
    AQUARIUM_MQTT_ENABLED: z.enum(["true", "false"]).default("false"),
    AQUARIUM_MQTT_BROKER_URL: z.string().url().optional(),
    AQUARIUM_MQTT_USERNAME: z.string().min(1).max(128).optional(),
    AQUARIUM_MQTT_PASSWORD: z.string().min(1).max(512).optional(),
    AQUARIUM_MQTT_TOPIC_NAMESPACE: z.enum(["test", "production"]).optional(),
    AQUARIUM_MQTT_RESPONSE_TIMEOUT_MS: z.coerce
      .number()
      .int()
      .min(100)
      .max(60_000)
      .default(5_000),
    AQUARIUM_MQTT_DISCOVERY_INTERVAL_MS: z.coerce
      .number()
      .int()
      .min(1_000)
      .max(3_600_000)
      .default(60_000),
    AQUARIUM_DEVICE_ANNOUNCEMENT_PERSIST_INTERVAL_MS: z.coerce
      .number()
      .int()
      .min(1_000)
      .max(3_600_000)
      .default(30_000),
    AQUARIUM_DEVICE_STALE_AFTER_MS: z.coerce
      .number()
      .int()
      .min(2_000)
      .max(86_400_000)
      .default(90_000),
    AQUARIUM_DEVICE_OFFLINE_AFTER_MS: z.coerce
      .number()
      .int()
      .min(3_000)
      .max(604_800_000)
      .default(300_000),
    AQUARIUM_DEVICE_HEALTH_SWEEP_INTERVAL_MS: z.coerce
      .number()
      .int()
      .min(500)
      .max(60_000)
      .default(5_000),
    AQUARIUM_PRODUCTION_MQTT_CONFIRMATION: z.string().optional(),
    NODE_ENV: z.string().optional(),
  })
  .superRefine((environment, context) => {
    if (
      environment.AQUARIUM_DEVICE_ANNOUNCEMENT_PERSIST_INTERVAL_MS >=
      environment.AQUARIUM_DEVICE_STALE_AFTER_MS
    ) {
      context.addIssue({
        code: "custom",
        message:
          "Announcement persistence interval must be shorter than the stale threshold",
        path: ["AQUARIUM_DEVICE_ANNOUNCEMENT_PERSIST_INTERVAL_MS"],
      });
    }
    if (
      environment.AQUARIUM_DEVICE_STALE_AFTER_MS >=
      environment.AQUARIUM_DEVICE_OFFLINE_AFTER_MS
    ) {
      context.addIssue({
        code: "custom",
        message:
          "Device stale threshold must be shorter than offline threshold",
        path: ["AQUARIUM_DEVICE_STALE_AFTER_MS"],
      });
    }
    if (
      environment.AQUARIUM_DEVICE_HEALTH_SWEEP_INTERVAL_MS >=
      environment.AQUARIUM_DEVICE_STALE_AFTER_MS
    ) {
      context.addIssue({
        code: "custom",
        message:
          "Device health sweep interval must be shorter than stale threshold",
        path: ["AQUARIUM_DEVICE_HEALTH_SWEEP_INTERVAL_MS"],
      });
    }
    if (environment.AQUARIUM_RUNTIME_MODE === "production") {
      for (const key of [
        "AQUARIUM_STATE_DB_PATH",
        "AQUARIUM_EVENTS_DB_PATH",
        "AQUARIUM_ARCHIVE_DIRECTORY",
        "AQUARIUM_BACKUP_DIRECTORY",
      ] as const) {
        if (environment[key] === undefined) {
          context.addIssue({
            code: "custom",
            message: `Production requires an explicit ${key}`,
            path: [key],
          });
        }
      }
      if (environment.AQUARIUM_FIRMWARE_BASE_URL === undefined) {
        context.addIssue({
          code: "custom",
          message:
            "Production requires an ESP-reachable AQUARIUM_FIRMWARE_BASE_URL",
          path: ["AQUARIUM_FIRMWARE_BASE_URL"],
        });
      }
    }

    if (environment.AQUARIUM_FIRMWARE_BASE_URL !== undefined) {
      const firmwareUrl = new URL(environment.AQUARIUM_FIRMWARE_BASE_URL);
      if (firmwareUrl.protocol !== "http:") {
        context.addIssue({
          code: "custom",
          message: "ESP32 firmware delivery currently requires local HTTP",
          path: ["AQUARIUM_FIRMWARE_BASE_URL"],
        });
      }
    }

    if (
      (environment.AQUARIUM_MQTT_USERNAME === undefined) !==
      (environment.AQUARIUM_MQTT_PASSWORD === undefined)
    ) {
      context.addIssue({
        code: "custom",
        message: "MQTT username and password must be configured together",
        path: ["AQUARIUM_MQTT_USERNAME"],
      });
    }

    if (environment.AQUARIUM_MQTT_ENABLED === "false") {
      return;
    }

    if (
      environment.AQUARIUM_MQTT_DISCOVERY_INTERVAL_MS >=
      environment.AQUARIUM_DEVICE_STALE_AFTER_MS
    ) {
      context.addIssue({
        code: "custom",
        message: "MQTT discovery interval must be shorter than stale threshold",
        path: ["AQUARIUM_MQTT_DISCOVERY_INTERVAL_MS"],
      });
    }

    if (environment.AQUARIUM_MQTT_BROKER_URL === undefined) {
      context.addIssue({
        code: "custom",
        message: "MQTT requires an explicit AQUARIUM_MQTT_BROKER_URL",
        path: ["AQUARIUM_MQTT_BROKER_URL"],
      });
    } else {
      const brokerUrl = new URL(environment.AQUARIUM_MQTT_BROKER_URL);
      if (!["mqtt:", "mqtts:"].includes(brokerUrl.protocol)) {
        context.addIssue({
          code: "custom",
          message: "MQTT broker URLs must use mqtt:// or mqtts://",
          path: ["AQUARIUM_MQTT_BROKER_URL"],
        });
      }
      if (brokerUrl.username.length > 0 || brokerUrl.password.length > 0) {
        context.addIssue({
          code: "custom",
          message:
            "MQTT credentials must use the dedicated username and password settings, not URL userinfo",
          path: ["AQUARIUM_MQTT_BROKER_URL"],
        });
      }
    }
    if (environment.AQUARIUM_MQTT_TOPIC_NAMESPACE === undefined) {
      context.addIssue({
        code: "custom",
        message: "MQTT requires an explicit AQUARIUM_MQTT_TOPIC_NAMESPACE",
        path: ["AQUARIUM_MQTT_TOPIC_NAMESPACE"],
      });
    }

    const productionRequested =
      environment.AQUARIUM_RUNTIME_MODE === "production" ||
      environment.AQUARIUM_MQTT_TOPIC_NAMESPACE === "production";
    if (productionRequested) {
      if (
        environment.AQUARIUM_RUNTIME_MODE !== "production" ||
        environment.AQUARIUM_MQTT_TOPIC_NAMESPACE !== "production"
      ) {
        context.addIssue({
          code: "custom",
          message:
            "Production MQTT requires both production runtime mode and production topic namespace",
          path: ["AQUARIUM_MQTT_TOPIC_NAMESPACE"],
        });
      }
      if (
        environment.AQUARIUM_PRODUCTION_MQTT_CONFIRMATION !==
        PRODUCTION_MQTT_CONFIRMATION
      ) {
        context.addIssue({
          code: "custom",
          message: "Production MQTT requires the explicit safety confirmation",
          path: ["AQUARIUM_PRODUCTION_MQTT_CONFIRMATION"],
        });
      }
      if (environment.NODE_ENV === "test") {
        context.addIssue({
          code: "custom",
          message: "Production MQTT is prohibited while running tests",
          path: ["AQUARIUM_RUNTIME_MODE"],
        });
      }
      if (
        environment.AQUARIUM_MQTT_USERNAME === undefined ||
        environment.AQUARIUM_MQTT_PASSWORD === undefined
      ) {
        context.addIssue({
          code: "custom",
          message: "Production MQTT requires explicit credentials",
          path: ["AQUARIUM_MQTT_USERNAME"],
        });
      }
      return;
    }

    if (
      environment.AQUARIUM_RUNTIME_MODE === "test" ||
      environment.AQUARIUM_RUNTIME_MODE === "development"
    ) {
      if (environment.AQUARIUM_MQTT_TOPIC_NAMESPACE !== "test") {
        context.addIssue({
          code: "custom",
          message:
            "Development and test MQTT must use the test topic namespace",
          path: ["AQUARIUM_MQTT_TOPIC_NAMESPACE"],
        });
      }

      if (environment.AQUARIUM_MQTT_BROKER_URL !== undefined) {
        const brokerHost = new URL(environment.AQUARIUM_MQTT_BROKER_URL)
          .hostname;
        if (!isLoopbackHost(brokerHost)) {
          context.addIssue({
            code: "custom",
            message:
              "Development and test MQTT brokers must use a loopback host",
            path: ["AQUARIUM_MQTT_BROKER_URL"],
          });
        }
      }
    }
  });

export interface DisabledMqttConfiguration {
  readonly enabled: false;
}

export interface EnabledMqttConfiguration {
  readonly enabled: true;
  readonly brokerUrl: string;
  readonly username?: string;
  readonly password?: string;
  readonly topicNamespace: "test" | "production";
  readonly protocolVersion: 4;
  readonly qos: 0;
  readonly retain: false;
  readonly responseTimeoutMs: number;
  readonly discoveryIntervalMs: number;
}

export interface ControllerConfiguration {
  readonly runtimeMode: "development" | "test" | "production";
  readonly server: {
    readonly host: string;
    readonly port: number;
    readonly webRoot: string | null;
  };
  readonly realtime: {
    readonly maxReplayEvents: number;
  };
  readonly firmware: {
    readonly baseUrl: string;
    readonly directory: string;
  };
  readonly mqtt: DisabledMqttConfiguration | EnabledMqttConfiguration;
  readonly deviceRegistry: {
    readonly announcementPersistIntervalMs: number;
    readonly staleAfterMs: number;
    readonly offlineAfterMs: number;
    readonly healthSweepIntervalMs: number;
  };
  readonly storage: {
    readonly stateDatabaseFile: string;
    readonly eventsDatabaseFile: string;
    readonly archiveDirectory: string;
    readonly backupDirectory: string;
    readonly backupFreshnessThresholdMs: number;
    readonly retentionStaleRunAfterMs: number;
    readonly healthCheckIntervalMs: number;
    readonly minimumFilesystemFreeBytes: number;
    readonly maximumProjectedStorageBytesAfterOneYear: number;
  };
  readonly alerting: {
    readonly webhook: AlertWebhookConfiguration | null;
  };
}

export interface AlertWebhookConfiguration {
  readonly url: string;
  readonly destinationKey: string;
  readonly timeoutMs: number;
  readonly authHeader?: {
    readonly name: string;
    readonly value: string;
  };
}

export function parseControllerConfiguration(
  environment: NodeJS.ProcessEnv,
): ControllerConfiguration {
  const parsed = environmentSchema.parse(environment);
  const server = {
    host: parsed.AQUARIUM_HOST,
    port: parsed.AQUARIUM_PORT,
    webRoot:
      parsed.AQUARIUM_WEB_ROOT === undefined
        ? null
        : resolve(parsed.AQUARIUM_WEB_ROOT),
  };
  const dataDirectory = resolve(parsed.AQUARIUM_DATA_DIRECTORY ?? ".data");
  const realtime = {
    maxReplayEvents: parsed.AQUARIUM_SSE_REPLAY_LIMIT,
  };
  const firmwareBaseUrl =
    parsed.AQUARIUM_FIRMWARE_BASE_URL ??
    `http://127.0.0.1:${parsed.AQUARIUM_PORT}`;
  const firmware = {
    baseUrl: firmwareBaseUrl.replace(/\/+$/u, ""),
    directory: resolve(
      parsed.AQUARIUM_FIRMWARE_DIRECTORY ?? "firmware/esp32/artifacts",
    ),
  };
  const storage = {
    stateDatabaseFile: resolve(
      parsed.AQUARIUM_STATE_DB_PATH ?? join(dataDirectory, "state.db"),
    ),
    eventsDatabaseFile: resolve(
      parsed.AQUARIUM_EVENTS_DB_PATH ?? join(dataDirectory, "events.db"),
    ),
    archiveDirectory: resolve(
      parsed.AQUARIUM_ARCHIVE_DIRECTORY ?? join(dataDirectory, "archives"),
    ),
    backupDirectory: resolve(
      parsed.AQUARIUM_BACKUP_DIRECTORY ?? join(dataDirectory, "backups"),
    ),
    backupFreshnessThresholdMs: parsed.AQUARIUM_BACKUP_FRESHNESS_THRESHOLD_MS,
    retentionStaleRunAfterMs: parsed.AQUARIUM_RETENTION_STALE_RUN_AFTER_MS,
    healthCheckIntervalMs: parsed.AQUARIUM_STORAGE_HEALTH_INTERVAL_MS,
    minimumFilesystemFreeBytes: parsed.AQUARIUM_STORAGE_MINIMUM_FREE_BYTES,
    maximumProjectedStorageBytesAfterOneYear:
      parsed.AQUARIUM_STORAGE_MAXIMUM_PROJECTED_YEAR_BYTES,
  };
  const deviceRegistry = {
    announcementPersistIntervalMs:
      parsed.AQUARIUM_DEVICE_ANNOUNCEMENT_PERSIST_INTERVAL_MS,
    staleAfterMs: parsed.AQUARIUM_DEVICE_STALE_AFTER_MS,
    offlineAfterMs: parsed.AQUARIUM_DEVICE_OFFLINE_AFTER_MS,
    healthSweepIntervalMs: parsed.AQUARIUM_DEVICE_HEALTH_SWEEP_INTERVAL_MS,
  };
  const webhookSupplementaryValues = [
    parsed.AQUARIUM_ALERT_WEBHOOK_KEY,
    parsed.AQUARIUM_ALERT_WEBHOOK_TIMEOUT_MS,
    parsed.AQUARIUM_ALERT_WEBHOOK_AUTH_HEADER_NAME,
    parsed.AQUARIUM_ALERT_WEBHOOK_AUTH_HEADER_VALUE,
  ];
  if (
    parsed.AQUARIUM_ALERT_WEBHOOK_URL === undefined &&
    webhookSupplementaryValues.some((value) => value !== undefined)
  ) {
    throw new TypeError(
      "Alert webhook settings require AQUARIUM_ALERT_WEBHOOK_URL",
    );
  }

  const authHeaderName = parsed.AQUARIUM_ALERT_WEBHOOK_AUTH_HEADER_NAME;
  const authHeaderValue = parsed.AQUARIUM_ALERT_WEBHOOK_AUTH_HEADER_VALUE;
  if ((authHeaderName === undefined) !== (authHeaderValue === undefined)) {
    throw new TypeError(
      "Alert webhook authentication header name and value must be configured together",
    );
  }
  const authHeader =
    authHeaderName === undefined || authHeaderValue === undefined
      ? undefined
      : { name: authHeaderName, value: authHeaderValue };

  let webhook: AlertWebhookConfiguration | null = null;
  if (parsed.AQUARIUM_ALERT_WEBHOOK_URL !== undefined) {
    const validated = validateWebhookAlertNotifierOptions({
      url: parsed.AQUARIUM_ALERT_WEBHOOK_URL,
      runtime: parsed.AQUARIUM_RUNTIME_MODE,
      ...(parsed.AQUARIUM_ALERT_WEBHOOK_TIMEOUT_MS === undefined
        ? {}
        : { timeoutMs: parsed.AQUARIUM_ALERT_WEBHOOK_TIMEOUT_MS }),
      ...(authHeader === undefined ? {} : { authHeader }),
    });
    webhook = {
      url: validated.url.toString(),
      destinationKey: identifierSchema.parse(
        parsed.AQUARIUM_ALERT_WEBHOOK_KEY ?? "primary",
      ),
      timeoutMs: validated.timeoutMs,
      ...(validated.authHeader === undefined
        ? {}
        : { authHeader: validated.authHeader }),
    };
  }
  const alerting = { webhook };

  if (parsed.AQUARIUM_MQTT_ENABLED === "false") {
    return {
      runtimeMode: parsed.AQUARIUM_RUNTIME_MODE,
      server,
      realtime,
      firmware,
      storage,
      deviceRegistry,
      alerting,
      mqtt: { enabled: false },
    };
  }

  if (
    parsed.AQUARIUM_MQTT_BROKER_URL === undefined ||
    parsed.AQUARIUM_MQTT_TOPIC_NAMESPACE === undefined
  ) {
    throw new Error("Validated MQTT configuration is incomplete");
  }

  return {
    runtimeMode: parsed.AQUARIUM_RUNTIME_MODE,
    server,
    realtime,
    firmware,
    storage,
    deviceRegistry,
    alerting,
    mqtt: {
      enabled: true,
      brokerUrl: parsed.AQUARIUM_MQTT_BROKER_URL,
      ...(parsed.AQUARIUM_MQTT_USERNAME !== undefined &&
      parsed.AQUARIUM_MQTT_PASSWORD !== undefined
        ? {
            username: parsed.AQUARIUM_MQTT_USERNAME,
            password: parsed.AQUARIUM_MQTT_PASSWORD,
          }
        : {}),
      topicNamespace: parsed.AQUARIUM_MQTT_TOPIC_NAMESPACE,
      protocolVersion: 4,
      qos: 0,
      retain: false,
      responseTimeoutMs: parsed.AQUARIUM_MQTT_RESPONSE_TIMEOUT_MS,
      discoveryIntervalMs: parsed.AQUARIUM_MQTT_DISCOVERY_INTERVAL_MS,
    },
  };
}

function isLoopbackHost(host: string): boolean {
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]";
}
