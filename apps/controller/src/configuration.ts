import { z } from "zod";
import { join, resolve } from "node:path";

const PRODUCTION_MQTT_CONFIRMATION = "ENABLE_PRODUCTION_AQUARIUM_MQTT";

const environmentSchema = z
  .object({
    AQUARIUM_HOST: z.string().min(1).default("127.0.0.1"),
    AQUARIUM_PORT: z.coerce.number().int().min(1).max(65_535).default(3001),
    AQUARIUM_DATA_DIRECTORY: z.string().min(1).optional(),
    AQUARIUM_STATE_DB_PATH: z.string().min(1).optional(),
    AQUARIUM_EVENTS_DB_PATH: z.string().min(1).optional(),
    AQUARIUM_ARCHIVE_DIRECTORY: z.string().min(1).optional(),
    AQUARIUM_BACKUP_DIRECTORY: z.string().min(1).optional(),
    AQUARIUM_RUNTIME_MODE: z
      .enum(["development", "test", "production"])
      .default("development"),
    AQUARIUM_MQTT_ENABLED: z.enum(["true", "false"]).default("false"),
    AQUARIUM_MQTT_BROKER_URL: z.string().url().optional(),
    AQUARIUM_MQTT_TOPIC_NAMESPACE: z.enum(["test", "production"]).optional(),
    AQUARIUM_PRODUCTION_MQTT_CONFIRMATION: z.string().optional(),
    AQUARIUM_TEST_DOCKER_BROKER_HOST: z.string().min(1).optional(),
    NODE_ENV: z.string().optional(),
  })
  .superRefine((environment, context) => {
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
    }

    if (environment.AQUARIUM_MQTT_ENABLED === "false") {
      return;
    }

    if (environment.AQUARIUM_MQTT_BROKER_URL === undefined) {
      context.addIssue({
        code: "custom",
        message: "MQTT requires an explicit AQUARIUM_MQTT_BROKER_URL",
        path: ["AQUARIUM_MQTT_BROKER_URL"],
      });
    } else if (
      !["mqtt:", "mqtts:"].includes(
        new URL(environment.AQUARIUM_MQTT_BROKER_URL).protocol,
      )
    ) {
      context.addIssue({
        code: "custom",
        message: "MQTT broker URLs must use mqtt:// or mqtts://",
        path: ["AQUARIUM_MQTT_BROKER_URL"],
      });
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
        const allowedDockerHost = environment.AQUARIUM_TEST_DOCKER_BROKER_HOST;
        if (!isLoopbackHost(brokerHost) && brokerHost !== allowedDockerHost) {
          context.addIssue({
            code: "custom",
            message:
              "Development and test MQTT brokers must be loopback or the explicitly named test Docker host",
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
  readonly topicNamespace: "test" | "production";
  readonly protocolVersion: 4;
  readonly qos: 0;
  readonly retain: false;
}

export interface ControllerConfiguration {
  readonly runtimeMode: "development" | "test" | "production";
  readonly server: {
    readonly host: string;
    readonly port: number;
  };
  readonly mqtt: DisabledMqttConfiguration | EnabledMqttConfiguration;
  readonly storage: {
    readonly stateDatabaseFile: string;
    readonly eventsDatabaseFile: string;
    readonly archiveDirectory: string;
    readonly backupDirectory: string;
  };
}

export function parseControllerConfiguration(
  environment: NodeJS.ProcessEnv,
): ControllerConfiguration {
  const parsed = environmentSchema.parse(environment);
  const server = {
    host: parsed.AQUARIUM_HOST,
    port: parsed.AQUARIUM_PORT,
  };
  const dataDirectory = resolve(parsed.AQUARIUM_DATA_DIRECTORY ?? ".data");
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
  };

  if (parsed.AQUARIUM_MQTT_ENABLED === "false") {
    return {
      runtimeMode: parsed.AQUARIUM_RUNTIME_MODE,
      server,
      storage,
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
    storage,
    mqtt: {
      enabled: true,
      brokerUrl: parsed.AQUARIUM_MQTT_BROKER_URL,
      topicNamespace: parsed.AQUARIUM_MQTT_TOPIC_NAMESPACE,
      protocolVersion: 4,
      qos: 0,
      retain: false,
    },
  };
}

function isLoopbackHost(host: string): boolean {
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]";
}
